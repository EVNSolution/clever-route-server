import { describe, expect, test } from 'vitest';

import {
  PrismaDsvAdminAccountRepository,
  type DsvAdminAccountPrismaClient,
} from '../src/modules/dsv/dsv-admin-account.repository.js';
import { dsvAdminScopes, dsvOperatorScopes } from '../src/modules/dsv/dsv-principal.js';

type Account = {
  activeSessionId: string | null;
  createdAt: Date;
  displayName: string | null;
  failedLoginAttempts: number;
  id: string;
  lastAuthenticatedAt: Date | null;
  lockedUntil: Date | null;
  loginId: string;
  passwordHash: string;
  passwordSalt: string;
  previousPasswordHash: string | null;
  previousPasswordSalt: string | null;
  scopes: string[];
  status: 'ACTIVE' | 'DISABLED';
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
    if (identity === null) throw new Error('session missing');
    expect(identity).toMatchObject({
      accountId: bootstrap.accountId,
      displayName: '운영 관리자',
      scopes: dsvAdminScopes,
    });
    expect(identity.activeSessionId).toMatch(/^[0-9a-f-]{36}$/u);
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
    expect(fake.account?.activeSessionId).toBeNull();
    await expect(repository.bootstrap({
      loginId: 'operator',
      password: 'correct-password-2026',
      resetExisting: true,
    })).rejects.toThrow(/current and previous/u);
    const authenticated = await repository.authenticate({
      loginId: 'operator',
      password: 'replacement-password-2026',
    });
    expect(authenticated).toMatchObject({ accountId: bootstrap.accountId });
    expect(authenticated?.activeSessionId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  test('keeps only the latest successful login active and invalidates it on logout', async () => {
    const fake = createPrisma();
    const repository = new PrismaDsvAdminAccountRepository(fake.prisma);
    const bootstrap = await repository.bootstrap({ loginId: 'operator', password: 'correct-password-2026' });

    const first = await repository.authenticate({ loginId: 'operator', password: 'correct-password-2026' });
    const second = await repository.authenticate({ loginId: 'operator', password: 'correct-password-2026' });
    if (first === null || second === null) throw new Error('session missing');
    expect(first.activeSessionId).not.toBe(second.activeSessionId);
    expect(await repository.resolveSession({ accountId: bootstrap.accountId, activeSessionId: first.activeSessionId })).toBeNull();
    expect(await repository.resolveSession({ accountId: bootstrap.accountId, activeSessionId: second.activeSessionId })).not.toBeNull();

    await repository.invalidateSession({ accountId: bootstrap.accountId, activeSessionId: second.activeSessionId });
    expect(await repository.resolveSession({ accountId: bootstrap.accountId, activeSessionId: second.activeSessionId })).toBeNull();
  });

  test('creates, lists, resets, and disables managed administrator accounts without exposing password material', async () => {
    const fake = createPrisma();
    const repository = new PrismaDsvAdminAccountRepository(fake.prisma);
    const created = await repository.create({ displayName: 'DSV 운영 관리자', loginId: 'Dsv-Admin' });

    expect(created.temporaryPassword).toHaveLength(24);
    expect(created.account).toMatchObject({
      displayName: 'DSV 운영 관리자',
      loginId: 'dsv-admin',
      scopes: dsvOperatorScopes,
      status: 'ACTIVE',
    });
    expect(created.account).not.toHaveProperty('passwordHash');
    expect(await repository.authenticate({ loginId: 'dsv-admin', password: created.temporaryPassword })).not.toBeNull();
    expect(await repository.list()).toHaveLength(1);

    const reset = await repository.resetPassword({ accountId: created.account.id });
    expect(reset.temporaryPassword).not.toBe(created.temporaryPassword);
    expect(await repository.authenticate({ loginId: 'dsv-admin', password: created.temporaryPassword })).toBeNull();
    expect(await repository.authenticate({ loginId: 'dsv-admin', password: reset.temporaryPassword })).not.toBeNull();

    const disabled = await repository.setStatus({ accountId: created.account.id, status: 'DISABLED' });
    expect(disabled.status).toBe('DISABLED');
    expect(await repository.authenticate({ loginId: 'dsv-admin', password: reset.temporaryPassword })).toBeNull();
    await repository.delete({ accountId: created.account.id });
    expect(await repository.list()).toHaveLength(0);
  });

  test('deletes only disabled managed administrator accounts', async () => {
    const fake = createPrisma();
    const repository = new PrismaDsvAdminAccountRepository(fake.prisma);
    const created = await repository.create({ loginId: 'operator' });

    await expect(repository.delete({ accountId: created.account.id })).rejects.toMatchObject({
      code: 'ADMIN_ACCOUNT_DELETE_REQUIRES_DISABLED',
    });
    await repository.setStatus({ accountId: created.account.id, status: 'DISABLED' });
    await expect(repository.delete({ accountId: created.account.id })).resolves.toBeUndefined();
    await expect(repository.delete({ accountId: created.account.id })).rejects.toMatchObject({
      code: 'ADMIN_ACCOUNT_NOT_FOUND',
    });
  });
});

function createPrisma(): {
  account: Account | null;
  prisma: DsvAdminAccountPrismaClient;
} {
  const state: { accounts: Account[] } = { accounts: [] };
  const delegate = {
    create: ({ data }: { data: Partial<Account> }) => {
      const account: Account = {
        activeSessionId: null,
        createdAt: new Date(),
        displayName: data.displayName ?? null,
        failedLoginAttempts: 0,
        id: `${String(state.accounts.length + 1).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        lastAuthenticatedAt: null,
        lockedUntil: null,
        loginId: data.loginId ?? '',
        passwordHash: data.passwordHash ?? '',
        passwordSalt: data.passwordSalt ?? '',
        previousPasswordHash: data.previousPasswordHash ?? null,
        previousPasswordSalt: data.previousPasswordSalt ?? null,
        scopes: data.scopes ?? [],
        status: 'ACTIVE',
        updatedAt: new Date(),
      };
      state.accounts.push(account);
      return Promise.resolve(account);
    },
    deleteMany: ({ where }: { where: Partial<Account> }) => {
      const before = state.accounts.length;
      state.accounts = state.accounts.filter((account) => !matches(account, where));
      return Promise.resolve({ count: before - state.accounts.length });
    },
    findFirst: ({ where }: { where: Partial<Account> }) =>
      Promise.resolve(state.accounts.find((account) => matches(account, where)) ?? null),
    findMany: () => Promise.resolve([...state.accounts]),
    findUnique: ({ where }: { where: Partial<Account> }) =>
      Promise.resolve(state.accounts.find((account) => matches(account, where)) ?? null),
    update: ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
      const account = state.accounts.find((candidate) => candidate.id === where.id);
      if (account === undefined) throw new Error('account not found');
      applyData(account, data);
      account.updatedAt = new Date();
      return Promise.resolve(account);
    },
    updateMany: ({ data, where }: { data: Record<string, unknown>; where: Partial<Account> }) => {
      const accounts = state.accounts.filter((account) => matches(account, where));
      for (const account of accounts) applyData(account, data);
      return Promise.resolve({ count: accounts.length });
    },
  };
  const result = {
    get account() {
      return state.accounts[0] ?? null;
    },
    prisma: { dsvAdminAccount: delegate } as unknown as DsvAdminAccountPrismaClient,
  };
  return result;
}

function matches(account: Account, where: Partial<Account>): boolean {
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
