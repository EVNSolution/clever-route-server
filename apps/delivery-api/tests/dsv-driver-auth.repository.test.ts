import { describe, expect, test, vi } from 'vitest';

import { PrismaDsvDriverAuthRepository } from '../src/modules/dsv/dsv-driver-auth.repository.js';
import { fingerprintResidentNumberFront } from '../src/modules/dsv/dsv-driver-identity.js';

describe('Prisma DSV driver auth repository', () => {
  test('creates an unlinked account without querying drivers when resident identity is null', async () => {
    const account = {
      id: 'account-id',
      loginId: 'driver.without-resident',
      name: '양우진',
      phone: '01012345678',
      tokenVersion: 0,
    };
    const candidate = {
      displayName: '양우진',
      id: 'driver-id',
      phone: '010-1234-5678',
      shop: { shopDomain: 'dsv-production.local' },
    };
    const transaction = {
      driver: {
        findMany: vi.fn(() => Promise.resolve([candidate])),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
      driverAccount: {
        create: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve(account);
        }),
      },
      driverAccountSession: {
        create: vi.fn(() => Promise.resolve({ id: 'session-id' })),
      },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
    };
    const repository = new PrismaDsvDriverAuthRepository(
      prisma as never,
      'identity-secret-that-is-at-least-32-characters',
    );

    const result = await repository.register({
      loginId: account.loginId,
      name: account.name,
      password: 'temporary-password',
      phone: account.phone,
      residentNumberFront: null,
    });

    const createInput = transaction.driverAccount.create.mock.calls[0]?.[0] as {
      data: { residentNumberFrontFingerprint: string | null };
    };
    expect(createInput.data.residentNumberFrontFingerprint).toBeNull();
    expect(transaction.driver.findMany).not.toHaveBeenCalled();
    expect(transaction.driver.updateMany).not.toHaveBeenCalled();
    expect(result.account.connectionStatus).toBe('UNLINKED');
  });

  test('links a production driver whose stored phone contains separators', async () => {
    const identitySecret = 'identity-secret-that-is-at-least-32-characters';
    const account = {
      id: 'account-id',
      loginId: 'yang.woojin.temp.260803',
      name: '양우진',
      phone: '01012345678',
      tokenVersion: 0,
    };
    const candidate = {
      displayName: '양우진',
      id: 'driver-id',
      phone: '010-1234-5678',
      shop: { shopDomain: 'dsv-production.local' },
    };
    const transaction = {
      driver: {
        findMany: vi.fn(() => Promise.resolve([candidate])),
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
    const repository = new PrismaDsvDriverAuthRepository(prisma as never, identitySecret);

    const result = await repository.register({
      loginId: account.loginId,
      name: account.name,
      password: 'temporary-password',
      phone: '01012345678',
      residentNumberFront: '9001011',
    });

    expect(transaction.driver.findMany).toHaveBeenCalledWith({
      include: { shop: { select: { shopDomain: true } } },
      where: {
        accountId: null,
        displayName: '양우진',
        dsvProfile: {
          is: {
            residentNumberFrontFingerprint: fingerprintResidentNumberFront(
              '9001011',
              identitySecret,
            ),
          },
        },
        status: 'ACTIVE',
      },
    });
    expect(transaction.driver.updateMany).toHaveBeenCalledWith({
      data: {
        accountId: account.id,
        authSubject: 'driver-driver-id',
        inviteCode: null,
        inviteCodeExpiresAt: null,
      },
      where: { accountId: null, id: candidate.id },
    });
    expect(result.account).toMatchObject({
      connectionStatus: 'LINKED',
      linkedDrivers: [{ driverId: candidate.id, name: '양우진' }],
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
    const repository = new PrismaDsvDriverAuthRepository(
      prisma as never,
      'identity-secret-that-is-at-least-32-characters',
    );

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
});
