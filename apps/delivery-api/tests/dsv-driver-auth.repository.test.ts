import { scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { describe, expect, test, vi } from 'vitest';

import { PrismaDsvDriverAuthRepository } from '../src/modules/dsv/dsv-driver-auth.repository.js';

describe('Prisma DSV driver auth repository', () => {
  test('rechecks the password under the shared account lock before creating a login session', async () => {
    const passwordAfterReset = ['new', 'credential', 'after', 'reset'].join('-');
    const passwordBeforeReset = ['old', 'credential', 'before', 'reset'].join('-');
    const saltAfterReset = ['unit', 'reset', 'salt'].join(':');
    const transaction = {
      $queryRaw: vi.fn(() => Promise.resolve([{ lock: '' }])),
      driverAccount: {
        findUnique: vi.fn(async () => ({
          drivers: [],
          id: 'account-id',
          loginId: 'driver.login',
          name: 'Synthetic Driver',
          passwordHash: await passwordHash(passwordAfterReset, saltAfterReset),
          passwordLockedUntil: null,
          passwordSalt: saltAfterReset,
          phone: '01012345678',
          status: 'ACTIVE',
          tokenVersion: 2,
        })),
        update: vi.fn(() => Promise.resolve({ failedPasswordAttempts: 1 })),
      },
      driverAccountSession: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
      driverAccount: { findUnique: vi.fn(() => Promise.resolve({ id: 'account-id' })) },
    };
    const repository = new PrismaDsvDriverAuthRepository(prisma as never);

    await expect(repository.login({ loginId: 'driver.login', password: passwordBeforeReset }))
      .rejects.toThrow('Invalid login ID or password');

    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.driverAccount.findUnique.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(transaction.driverAccountSession.create).not.toHaveBeenCalled();
  });

  test('direct signup links only exact active name and phone matches and needs no invite', async () => {
    const account = {
      id: 'account-id',
      loginId: 'direct.driver',
      name: '임지인',
      phone: '01012345678',
      tokenVersion: 0,
    };
    const matchingDriver = {
      displayName: account.name,
      id: 'matching-driver-id',
      phone: '010-1234-5678',
      shop: { shopDomain: 'dsv-production.local' },
    };
    const differentPhoneDriver = {
      displayName: account.name,
      id: 'different-phone-driver-id',
      phone: '010-9999-9999',
      shop: { shopDomain: 'dsv-production.local' },
    };
    const transaction = {
      dsvDriverProfile: {
        update: vi.fn(() => Promise.resolve({ driverId: matchingDriver.id })),
      },
      driver: {
        findMany: vi.fn(() => Promise.resolve([matchingDriver, differentPhoneDriver])),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
      driverAccount: {
        create: vi.fn(() => Promise.resolve(account)),
      },
      driverAccountSession: {
        create: vi.fn(() => Promise.resolve({ id: 'session-id' })),
      },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
    };
    const repository = new PrismaDsvDriverAuthRepository(prisma as never);

    const result = await repository.register({
      loginId: account.loginId,
      name: account.name,
      password: 'temporary-password',
      phone: account.phone,
    });

    expect(transaction.driver.findMany).toHaveBeenCalledWith({
      include: { shop: { select: { shopDomain: true } } },
      where: {
        accountId: null,
        isStoreReviewData: false,
        displayName: account.name,
        dsvProfile: { isNot: null },
        status: 'ACTIVE',
      },
    });
    expect(transaction.driver.updateMany).toHaveBeenCalledTimes(1);
    expect(transaction.driver.updateMany).toHaveBeenCalledWith({
      data: {
        accountId: account.id,
        authSubject: 'driver-matching-driver-id',
        displayName: account.name,
        inviteCode: null,
        inviteCodeExpiresAt: null,
        phone: account.phone,
      },
      where: { accountId: null, id: matchingDriver.id, isStoreReviewData: false, status: 'ACTIVE' },
    });
    expect(transaction.dsvDriverProfile.update).toHaveBeenCalledWith({
      data: { lookupName: account.name },
      where: { driverId: matchingDriver.id },
    });
    expect(result.account).toMatchObject({
      connectionStatus: 'LINKED',
      linkedDrivers: [{ driverId: matchingDriver.id, name: account.name }],
    });
  });

  test('restores an active DSV account from its refresh session', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const account = {
      drivers: [{
        displayName: '양우진',
        id: 'driver-id',
        phone: '01012345678',
        shop: { shopDomain: 'dsv-production.local' },
      }],
      id: 'account-id',
      loginId: 'woojin',
      name: '양우진',
      phone: '01012345678',
      status: 'ACTIVE',
      tokenVersion: 1,
    };
    const transaction = {
      $queryRaw: vi.fn(() => Promise.resolve([{ lock: '' }])),
      driverAccountSession: {
        findUnique: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve({
            account,
            accountId: account.id,
            expiresAt,
            id: 'session-id',
            revokedAt: null,
          });
        }),
        update: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve({ id: 'session-id' });
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
      driverAccountSession: {
        findUnique: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve({ accountId: account.id, id: 'session-id' });
        }),
      },
    };
    const repository = new PrismaDsvDriverAuthRepository(prisma as never);

    const result = await repository.refresh({ refreshToken: ' refresh-token ' });

    const findInput = prisma.driverAccountSession.findUnique.mock.calls[0]?.[0] as {
      where: { refreshTokenHash: string };
    };
    const updateInput = transaction.driverAccountSession.update.mock.calls[0]?.[0] as {
      data: { lastUsedAt: Date };
      where: { id: string };
    };
    expect(findInput.where.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(updateInput.data.lastUsedAt).toBeInstanceOf(Date);
    expect(updateInput.where).toEqual({ id: 'session-id' });
    expect(result).toMatchObject({
      account: { connectionStatus: 'LINKED', loginId: 'woojin' },
      accountId: 'account-id',
      expiresAt,
      refreshToken: 'refresh-token',
      tokenVersion: 1,
    });
  });

  test('rechecks refresh revocation under the shared account lock', async () => {
    const transaction = {
      $queryRaw: vi.fn(() => Promise.resolve([{ lock: '' }])),
      driverAccountSession: {
        findUnique: vi.fn(() => Promise.resolve({
          account: { status: 'ACTIVE' },
          accountId: 'account-id',
          expiresAt: new Date(Date.now() + 60_000),
          id: 'session-id',
          revokedAt: new Date(),
        })),
        update: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
      driverAccountSession: {
        findUnique: vi.fn(() => Promise.resolve({ accountId: 'account-id', id: 'session-id' })),
      },
    };
    const repository = new PrismaDsvDriverAuthRepository(prisma as never);

    await expect(repository.refresh({ refreshToken: 'revoked-during-reset' }))
      .rejects.toThrow('Invalid or expired refresh token');

    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.driverAccountSession.update).not.toHaveBeenCalled();
  });

  test('retries safe exact-match linking while refreshing an unlinked session', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const unlinkedAccount = {
      drivers: [],
      id: 'account-id',
      loginId: 'driver.login',
      name: '정재연',
      phone: '01012345678',
      status: 'ACTIVE',
      tokenVersion: 1,
    };
    const linkedAccount = {
      ...unlinkedAccount,
      drivers: [{
        displayName: '정재연',
        id: 'driver-id',
        phone: '010-1234-5678',
        shop: { shopDomain: 'dsv-production.local' },
      }],
    };
    const transaction = {
      $queryRaw: vi.fn(() => Promise.resolve([{ lock: '' }])),
      dsvDriverProfile: {
        update: vi.fn(() => Promise.resolve({ driverId: 'driver-id' })),
      },
      driver: {
        findMany: vi.fn(() => Promise.resolve([{ id: 'driver-id', phone: '010-1234-5678' }])),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
      driverAccount: { findUniqueOrThrow: vi.fn(() => Promise.resolve(linkedAccount)) },
      driverAccountSession: {
        findUnique: vi.fn(() => Promise.resolve({
          account: unlinkedAccount,
          accountId: unlinkedAccount.id,
          expiresAt,
          id: 'session-id',
          revokedAt: null,
        })),
        update: vi.fn(() => Promise.resolve({ id: 'session-id' })),
      },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
      driverAccountSession: {
        findUnique: vi.fn(() => Promise.resolve({ accountId: unlinkedAccount.id, id: 'session-id' })),
      },
    };
    const repository = new PrismaDsvDriverAuthRepository(prisma as never);

    const result = await repository.refresh({ refreshToken: 'refresh-token' });

    expect(transaction.driver.updateMany).toHaveBeenCalledWith({
      data: {
        accountId: 'account-id',
        authSubject: 'driver-driver-id',
        displayName: unlinkedAccount.name,
        inviteCode: null,
        inviteCodeExpiresAt: null,
        phone: unlinkedAccount.phone,
      },
      where: { accountId: null, id: 'driver-id', isStoreReviewData: false },
    });
    expect(transaction.dsvDriverProfile.update).toHaveBeenCalledWith({
      data: { lookupName: unlinkedAccount.name },
      where: { driverId: 'driver-id' },
    });
    expect(result.account.connectionStatus).toBe('LINKED');
  });
});

async function passwordHash(password: string, salt: string): Promise<string> {
  const derived = await promisify(scrypt)(password, salt, 64) as Buffer;
  return derived.toString('base64url');
}
