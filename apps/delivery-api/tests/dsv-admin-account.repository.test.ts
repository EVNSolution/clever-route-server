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
  mustChangePassword: boolean;
  passwordHash: string;
  passwordSalt: string;
  previousPasswordHash: string | null;
  previousPasswordSalt: string | null;
  scopes: string[];
  status: 'ACTIVE' | 'DISABLED';
  updatedAt: Date;
};

const auditContext = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  requestId: 'req-admin-security',
  shopId: '99999999-9999-4999-8999-999999999999',
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
      mustChangePassword: false,
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
      mustChangePassword: true,
      scopes: dsvOperatorScopes,
      status: 'ACTIVE',
    });
    expect(created.account).not.toHaveProperty('passwordHash');
    expect(await repository.authenticate({ loginId: 'dsv-admin', password: created.temporaryPassword })).toMatchObject({
      mustChangePassword: true,
      scopes: ['dsv:session:read'],
    });
    expect(await repository.list()).toHaveLength(1);

    const reset = await repository.resetPassword({ accountId: created.account.id });
    expect(reset.temporaryPassword).not.toBe(created.temporaryPassword);
    expect(reset.account.mustChangePassword).toBe(true);
    expect(await repository.authenticate({ loginId: 'dsv-admin', password: created.temporaryPassword })).toBeNull();
    expect(await repository.authenticate({ loginId: 'dsv-admin', password: reset.temporaryPassword })).not.toBeNull();

    const disabled = await repository.setStatus({ accountId: created.account.id, status: 'DISABLED', ...auditContext });
    expect(disabled.status).toBe('DISABLED');
    expect(await repository.authenticate({ loginId: 'dsv-admin', password: reset.temporaryPassword })).toBeNull();
    await repository.delete({ accountId: created.account.id, ...auditContext });
    expect(await repository.list()).toHaveLength(0);
  });

  test('deletes only disabled managed administrator accounts', async () => {
    const fake = createPrisma();
    const repository = new PrismaDsvAdminAccountRepository(fake.prisma);
    const created = await repository.create({ loginId: 'operator' });

    await expect(repository.delete({ accountId: created.account.id, ...auditContext })).rejects.toMatchObject({
      code: 'ADMIN_ACCOUNT_DELETE_REQUIRES_DISABLED',
    });
    await repository.setStatus({ accountId: created.account.id, status: 'DISABLED', ...auditContext });
    await expect(repository.delete({ accountId: created.account.id, ...auditContext })).resolves.toBeUndefined();
    await expect(repository.delete({ accountId: created.account.id, ...auditContext })).rejects.toMatchObject({
      code: 'ADMIN_ACCOUNT_NOT_FOUND',
    });
  });

  test('revokes a managed account session idempotently and audits security changes', async () => {
    const fake = createPrisma();
    const repository = new PrismaDsvAdminAccountRepository(fake.prisma);
    const created = await repository.create({ loginId: 'operator' });
    const identity = await repository.authenticate({ loginId: 'operator', password: created.temporaryPassword });
    expect(identity).not.toBeNull();

    await expect(repository.revokeSession({ accountId: created.account.id, ...auditContext })).resolves.toEqual({ revoked: true });
    await expect(repository.revokeSession({ accountId: created.account.id, ...auditContext })).resolves.toEqual({ revoked: false });
    await repository.setStatus({ accountId: created.account.id, status: 'DISABLED', ...auditContext });
    await repository.delete({ accountId: created.account.id, ...auditContext });

    expect(fake.auditEvents.map((event) => event.eventType)).toEqual([
      'DSV_ADMIN_ACCOUNT_SESSION_REVOKED',
      'DSV_ADMIN_ACCOUNT_SESSION_REVOKED',
      'DSV_ADMIN_ACCOUNT_DISABLED',
      'DSV_ADMIN_ACCOUNT_DELETED',
    ]);
    expect(fake.auditEvents[0]).toMatchObject({
      actorId: auditContext.actorId,
      entityId: created.account.id,
      redactedDiff: { sessionRevoked: true },
      requestId: auditContext.requestId,
      shopId: auditContext.shopId,
    });
    expect(fake.auditEvents[1]).toMatchObject({ redactedDiff: { sessionRevoked: false } });
  });
});

function createPrisma(): {
  account: Account | null;
  auditEvents: Array<Record<string, unknown>>;
  prisma: DsvAdminAccountPrismaClient;
} {
  const state: { accounts: Account[] } = { accounts: [] };
  const auditEvents: Array<Record<string, unknown>> = [];
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
        mustChangePassword: data.mustChangePassword ?? false,
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
    delete: ({ where }: { where: { id: string } }) => {
      const index = state.accounts.findIndex((account) => account.id === where.id);
      if (index < 0) throw new Error('account not found');
      const [deleted] = state.accounts.splice(index, 1);
      return Promise.resolve(deleted);
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
  const transaction = {
    dsvAdminAccount: delegate,
    dsvAuditEvent: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
        return Promise.resolve({ id: `audit-${auditEvents.length}` });
      },
    },
  };
  const result = {
    get account() {
      return state.accounts[0] ?? null;
    },
    auditEvents,
    prisma: {
      ...transaction,
      $transaction: (callback: (tx: typeof transaction) => unknown) => callback(transaction),
    } as unknown as DsvAdminAccountPrismaClient,
  };
  return result;
}

function matches(account: Account, where: Partial<Account>): boolean {
  return Object.entries(where).every(([key, value]) => {
    const actual = account[key as keyof Account];
    if (typeof value === 'object' && value !== null && 'not' in value) return actual !== value.not;
    return actual === value;
  });
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
