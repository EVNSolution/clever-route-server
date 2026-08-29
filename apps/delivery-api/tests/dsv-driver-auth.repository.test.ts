import { describe, expect, test, vi } from 'vitest';

import { PrismaDsvDriverAuthRepository } from '../src/modules/dsv/dsv-driver-auth.repository.js';

describe('Prisma DSV driver auth repository', () => {
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
        inviteCode: null,
        inviteCodeExpiresAt: null,
      },
      where: { accountId: null, id: matchingDriver.id, status: 'ACTIVE' },
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
    const prisma = {
      driverAccountSession: {
        findUnique: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve({
            account,
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
    const repository = new PrismaDsvDriverAuthRepository(prisma as never);

    const result = await repository.refresh({ refreshToken: ' refresh-token ' });

    const findInput = prisma.driverAccountSession.findUnique.mock.calls[0]?.[0] as {
      where: { refreshTokenHash: string };
    };
    const updateInput = prisma.driverAccountSession.update.mock.calls[0]?.[0] as {
      data: { lastUsedAt: Date };
      where: { id: string };
    };
    expect(findInput.where.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/u);
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
    const prisma = {
      driver: {
        findMany: vi.fn(() => Promise.resolve([{ id: 'driver-id', phone: '010-1234-5678' }])),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
      driverAccount: { findUniqueOrThrow: vi.fn(() => Promise.resolve(linkedAccount)) },
      driverAccountSession: {
        findUnique: vi.fn(() => Promise.resolve({ account: unlinkedAccount, expiresAt, id: 'session-id', revokedAt: null })),
        update: vi.fn(() => Promise.resolve({ id: 'session-id' })),
      },
    };
    const repository = new PrismaDsvDriverAuthRepository(prisma as never);

    const result = await repository.refresh({ refreshToken: 'refresh-token' });

    expect(prisma.driver.updateMany).toHaveBeenCalledWith({
      data: {
        accountId: 'account-id',
        authSubject: 'driver-driver-id',
        inviteCode: null,
        inviteCodeExpiresAt: null,
      },
      where: { accountId: null, id: 'driver-id' },
    });
    expect(result.account.connectionStatus).toBe('LINKED');
  });
});
