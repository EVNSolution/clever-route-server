import { describe, expect, test } from 'vitest';

import {
  PrismaDsvAdminAccountRepository,
  type DsvAdminAccountPrismaClient,
} from '../src/modules/dsv/dsv-admin-account.repository.js';
import { dsvAdminScopes } from '../src/modules/dsv/dsv-principal.js';

type Account = {
  createdAt: Date;
  displayName: string | null;
  failedLoginAttempts: number;
  id: string;
  lastAuthenticatedAt: Date | null;
  lockedUntil: Date | null;
  loginId: string;
  passwordHash: string;
  passwordSalt: string;
  scopes: string[];
  status: 'ACTIVE' | 'DISABLED';
  tokenVersion: number;
  updatedAt: Date;
};

describe('PrismaDsvAdminAccountRepository', () => {
  test('bootstraps and authenticates a personal administrator account', async () => {
    const fake = createPrisma();
    const repository = new PrismaDsvAdminAccountRepository(fake.prisma);
    const bootstrap = await repository.bootstrap({
      displayName: '운영 관리자',
      loginId: 'Operator',
      password: 'correct-password-2026',
    });

    expect(bootstrap.created).toBe(true);
    const identity = await repository.authenticate({
      loginId: 'operator',
      password: 'correct-password-2026',
    });
    expect(identity).toEqual({
      accountId: bootstrap.accountId,
      displayName: '운영 관리자',
      scopes: dsvAdminScopes,
      tokenVersion: 0,
    });
    expect(fake.account?.lastAuthenticatedAt).toBeInstanceOf(Date);
  });

  test('returns the same generic null result for unknown, invalid, disabled, and locked credentials', async () => {
    const fake = createPrisma();
    const repository = new PrismaDsvAdminAccountRepository(fake.prisma);
    expect(await repository.authenticate({ loginId: 'missing', password: 'wrong-password' })).toBeNull();

    await repository.bootstrap({ loginId: 'operator', password: 'correct-password-2026' });
    expect(await repository.authenticate({ loginId: 'operator', password: 'wrong-password' })).toBeNull();
    if (fake.account === null) throw new Error('account missing');
    fake.account.status = 'DISABLED';
    expect(await repository.authenticate({ loginId: 'operator', password: 'correct-password-2026' })).toBeNull();
    fake.account.status = 'ACTIVE';
    fake.account.lockedUntil = new Date(Date.now() + 60_000);
    expect(await repository.authenticate({ loginId: 'operator', password: 'correct-password-2026' })).toBeNull();
  });

  test('locks repeated failures and invalidates old sessions when the password is reset', async () => {
    const fake = createPrisma();
    const repository = new PrismaDsvAdminAccountRepository(fake.prisma);
    const bootstrap = await repository.bootstrap({ loginId: 'operator', password: 'correct-password-2026' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await repository.authenticate({ loginId: 'operator', password: 'wrong-password' })).toBeNull();
    }
    expect(fake.account?.failedLoginAttempts).toBe(5);
    expect(fake.account?.lockedUntil).toBeInstanceOf(Date);
    expect(await repository.authenticate({ loginId: 'operator', password: 'correct-password-2026' })).toBeNull();

    const reset = await repository.bootstrap({
      loginId: 'operator',
      password: 'replacement-password-2026',
      resetExisting: true,
    });
    expect(reset.reset).toBe(true);
    expect(await repository.resolveSession({ accountId: bootstrap.accountId, tokenVersion: 0 })).toBeNull();
    expect(await repository.authenticate({
      loginId: 'operator',
      password: 'replacement-password-2026',
    })).toMatchObject({ accountId: bootstrap.accountId, tokenVersion: 1 });
  });
});

function createPrisma(): {
  account: Account | null;
  prisma: DsvAdminAccountPrismaClient;
} {
  const state: { account: Account | null } = { account: null };
  const delegate = {
    create: ({ data }: { data: Partial<Account> }) => {
      state.account = {
        createdAt: new Date(),
        displayName: data.displayName ?? null,
        failedLoginAttempts: 0,
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        lastAuthenticatedAt: null,
        lockedUntil: null,
        loginId: data.loginId ?? '',
        passwordHash: data.passwordHash ?? '',
        passwordSalt: data.passwordSalt ?? '',
        scopes: data.scopes ?? [],
        status: 'ACTIVE',
        tokenVersion: 0,
        updatedAt: new Date(),
      };
      return Promise.resolve({ id: state.account.id });
    },
    findFirst: ({ where }: { where: Partial<Account> }) =>
      Promise.resolve(matches(state.account, where) ? state.account : null),
    findUnique: ({ where }: { where: Partial<Account> }) =>
      Promise.resolve(matches(state.account, where) ? state.account : null),
    update: ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
      if (state.account === null || state.account.id !== where.id) throw new Error('account not found');
      applyData(state.account, data);
      return Promise.resolve(state.account);
    },
  };
  const result = {
    get account() {
      return state.account;
    },
    prisma: { dsvAdminAccount: delegate } as unknown as DsvAdminAccountPrismaClient,
  };
  return result;
}

function matches(account: Account | null, where: Partial<Account>): boolean {
  if (account === null) return false;
  return Object.entries(where).every(([key, value]) => account[key as keyof Account] === value);
}

function applyData(account: Account, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'object' && value !== null && 'increment' in value) {
      const current = account[key as keyof Account];
      if (typeof current === 'number') {
        (account as unknown as Record<string, unknown>)[key] = current + Number((value as { increment: number }).increment);
      }
    } else {
      (account as unknown as Record<string, unknown>)[key] = value;
    }
  }
}
