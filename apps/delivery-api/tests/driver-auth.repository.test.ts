import { scrypt } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverAuthRepository } from '../src/modules/driver/driver-auth.repository.js';

const anyDateMatcher: unknown = expect.any(Date);
const anyStringMatcher: unknown = expect.any(String);

describe('PrismaDriverAuthRepository', () => {
  test('reads and updates only an active matching account version', async () => {
    const { prisma } = createPrismaHarness({
      account: accountFixture({ name: null, tokenVersion: 2 }),
      updatedAccount: accountFixture({ name: 'Jiin', tokenVersion: 2 })
    });
    const repository = new PrismaDriverAuthRepository(prisma as never);

    await expect(repository.getAccountProfile({ accountId: 'account-id', tokenVersion: 2 }))
      .resolves.toEqual({ name: null, phone: '+14165550123' });
    await expect(repository.updateAccountProfile({ accountId: 'account-id', name: 'Jiin', tokenVersion: 2 }))
      .resolves.toEqual({ name: 'Jiin', phone: '+14165550123' });

    expect(prisma.driverAccount.findFirst).toHaveBeenCalledWith({
      select: { name: true, phone: true },
      where: { id: 'account-id', status: 'ACTIVE', tokenVersion: 2 }
    });
    expect(prisma.driverAccount.updateMany).toHaveBeenCalledWith({
      data: { name: 'Jiin' },
      where: { id: 'account-id', status: 'ACTIVE', tokenVersion: 2 }
    });
  });

  test('creates one phone account, links matching drivers, and stores a refresh session', async () => {
    const { prisma, transaction } = createPrismaHarness();
    const repository = new PrismaDriverAuthRepository(prisma as never);

    const session = await repository.verifyInvite({
      displayName: '  Minji Kim  ',
      inviteCode: 'ABC123',
      phone: '+14165550123',
      pin: '012345'
    });

    expect(transaction.driverAccount.create).toHaveBeenCalledWith({
      data: {
        phone: '+14165550123',
        pinHash: anyStringMatcher,
        pinSalt: anyStringMatcher
      }
    });
    expect(transaction.driver.update).toHaveBeenCalledWith({
      data: {
        accountId: 'account-id',
        authSubject: 'driver-driver-id',
        displayName: 'Minji Kim',
        inviteCode: null,
        inviteCodeExpiresAt: null,
        phone: '+14165550123'
      },
      where: { id: 'driver-id' }
    });
    expect(prisma.driverAccountSession.create).toHaveBeenCalledWith({
      data: {
        accountId: 'account-id',
        expiresAt: anyDateMatcher,
        refreshTokenHash: anyStringMatcher
      }
    });
    expect(session).toEqual({
      accountId: 'account-id',
      expiresAt: anyDateMatcher,
      kind: 'account',
      refreshToken: anyStringMatcher,
      tokenVersion: 0
    });
  });

  test('logs in with the account PIN and clears failed attempts', async () => {
    const pinSalt = 'test-salt';
    const pinHash = await derivePin('012345', pinSalt);
    const { prisma } = createPrismaHarness({
      account: accountFixture({ pinHash, pinSalt })
    });
    const repository = new PrismaDriverAuthRepository(prisma as never);

    const session = await repository.loginWithPin({ phone: '+14165550123', pin: '012345' });

    expect(prisma.driverAccount.update).toHaveBeenCalledWith({
      data: { failedPinAttempts: 0, pinLockedUntil: null },
      where: { id: 'account-id' }
    });
    expect(session).toMatchObject({ accountId: 'account-id', kind: 'account', tokenVersion: 0 });
  });

  test('locks the account for fifteen minutes after the fifth failed PIN attempt', async () => {
    const pinSalt = 'test-salt';
    const pinHash = await derivePin('012345', pinSalt);
    const { prisma } = createPrismaHarness({
      account: accountFixture({ failedPinAttempts: 4, pinHash, pinSalt })
    });
    const repository = new PrismaDriverAuthRepository(prisma as never);

    await expect(repository.loginWithPin({ phone: '+14165550123', pin: '999999' }))
      .rejects.toThrow('Invalid phone or PIN');

    expect(prisma.driverAccount.update).toHaveBeenNthCalledWith(1, {
      data: { failedPinAttempts: { increment: 1 } },
      select: { failedPinAttempts: true },
      where: { id: 'account-id' }
    });
    expect(prisma.driverAccount.update).toHaveBeenNthCalledWith(2, {
      data: { pinLockedUntil: anyDateMatcher },
      where: { id: 'account-id' }
    });
    expect(prisma.driverAccountSession.create).not.toHaveBeenCalled();
  });

  test('refreshes an active account session without rotating its refresh token', async () => {
    const { prisma } = createPrismaHarness({ accountRefreshSession: accountSessionFixture() });
    const repository = new PrismaDriverAuthRepository(prisma as never);

    const session = await repository.refreshSession({ refreshToken: 'stored-refresh-token' });

    expect(prisma.driverAccountSession.update).toHaveBeenCalledWith({
      data: { lastUsedAt: anyDateMatcher },
      where: { id: 'account-session-id' }
    });
    expect(session).toEqual({
      accountId: 'account-id',
      expiresAt: new Date('2100-01-01T00:00:00.000Z'),
      kind: 'account',
      refreshToken: 'stored-refresh-token',
      tokenVersion: 0
    });
    expect(prisma.driverSession.findUnique).not.toHaveBeenCalled();
  });
});

function createPrismaHarness(input: {
  account?: ReturnType<typeof accountFixture> | null;
  accountRefreshSession?: ReturnType<typeof accountSessionFixture> | null;
  updatedAccount?: ReturnType<typeof accountFixture> | null;
} = {}) {
  const account = input.account === undefined ? null : input.account;
  const accountRefreshSession = input.accountRefreshSession === undefined ? null : input.accountRefreshSession;
  const updatedAccount = input.updatedAccount === undefined ? account : input.updatedAccount;
  const accountProfile = account === null ? null : { name: account.name, phone: account.phone };
  const updatedAccountProfile = updatedAccount === null ? null : { name: updatedAccount.name, phone: updatedAccount.phone };
  const transaction = {
    driver: {
      findMany: vi.fn(() => Promise.resolve([{ id: 'driver-id' }])),
      update: vi.fn(() => Promise.resolve({ id: 'driver-id' }))
    },
    driverAccount: {
      create: vi.fn(() => Promise.resolve(accountFixture()))
    }
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    driver: {
      findFirst: vi.fn(() => Promise.resolve(driverFixture())),
      findMany: vi.fn(() => Promise.resolve([driverFixture()])),
      update: vi.fn(() => Promise.resolve(driverFixture()))
    },
    driverAccount: {
      findFirst: vi.fn()
        .mockResolvedValueOnce(accountProfile)
        .mockResolvedValue(updatedAccountProfile),
      findUnique: vi.fn(() => Promise.resolve(account)),
      update: vi.fn((query: { data?: { failedPinAttempts?: { increment: number } } }) =>
        Promise.resolve(
          query.data?.failedPinAttempts === undefined
            ? account ?? accountFixture()
            : { failedPinAttempts: (account?.failedPinAttempts ?? 0) + query.data.failedPinAttempts.increment }
        )
      ),
      updateMany: vi.fn(() => Promise.resolve({ count: account === null ? 0 : 1 }))
    },
    driverAccountSession: {
      create: vi.fn(() => Promise.resolve({ id: 'account-session-id' })),
      findUnique: vi.fn(() => Promise.resolve(accountRefreshSession)),
      update: vi.fn(() => Promise.resolve({ id: 'account-session-id' }))
    },
    driverSession: {
      findUnique: vi.fn(() => Promise.resolve(null)),
      update: vi.fn()
    }
  };
  return { prisma, transaction };
}

function accountFixture(overrides: Partial<{
  failedPinAttempts: number;
  name: string | null;
  pinHash: string;
  pinLockedUntil: Date | null;
  pinSalt: string;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  tokenVersion: number;
}> = {}) {
  return {
    createdAt: new Date('2026-07-14T00:00:00.000Z'),
    failedPinAttempts: overrides.failedPinAttempts ?? 0,
    id: 'account-id',
    name: overrides.name ?? null,
    phone: '+14165550123',
    pinHash: overrides.pinHash ?? 'hash',
    pinLockedUntil: overrides.pinLockedUntil ?? null,
    pinSalt: overrides.pinSalt ?? 'salt',
    status: overrides.status ?? 'ACTIVE',
    tokenVersion: overrides.tokenVersion ?? 0,
    updatedAt: new Date('2026-07-14T00:00:00.000Z')
  };
}

function accountSessionFixture() {
  return {
    account: accountFixture(),
    accountId: 'account-id',
    createdAt: new Date('2026-07-14T00:00:00.000Z'),
    expiresAt: new Date('2100-01-01T00:00:00.000Z'),
    id: 'account-session-id',
    lastUsedAt: null,
    refreshTokenHash: 'stored-hash',
    revokedAt: null
  };
}

function driverFixture() {
  return {
    accountId: null,
    authSubject: null,
    createdAt: new Date('2026-07-14T00:00:00.000Z'),
    displayName: '+14165550123',
    id: 'driver-id',
    inviteCode: 'ABC123',
    inviteCodeExpiresAt: new Date('2100-01-01T00:00:00.000Z'),
    lastSeenAt: null,
    phone: '+14165550123',
    shop: { shopDomain: 'example.myshopify.com' },
    shopId: 'shop-id',
    status: 'ACTIVE' as const,
    tokenVersion: 0,
    tokensInvalidatedAt: null,
    updatedAt: new Date('2026-07-14T00:00:00.000Z')
  };
}

function derivePin(pin: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString('base64url'));
    });
  });
}
