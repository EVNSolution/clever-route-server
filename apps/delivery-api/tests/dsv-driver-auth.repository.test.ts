import { describe, expect, test, vi } from 'vitest';

import { PrismaDsvDriverAuthRepository } from '../src/modules/dsv/dsv-driver-auth.repository.js';

describe('Prisma DSV driver auth repository', () => {
  test('consumes a secure invite and links its exact DSV driver when resident identity is null', async () => {
    const account = {
      id: 'account-id',
      loginId: 'driver.without-resident',
      name: '양우진',
      phone: '01012345678',
      tokenVersion: 0,
    };
    const candidate = {
      accountId: null,
      displayName: '양우진',
      dsvProfile: {},
      id: 'driver-id',
      phone: '010-1234-5678',
      shop: { shopDomain: 'dsv-production.local' },
      status: 'ACTIVE',
    };
    const transaction = {
      dsvDriverAccountSignupInvite: {
        findUnique: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve({
            consumedAt: null,
            driver: candidate,
            expiresAt: new Date(Date.now() + 60_000),
            id: 'invite-id',
            revokedAt: null,
          });
        }),
        updateMany: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve({ count: 1 });
        }),
      },
      driver: {
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
      signupInviteToken: 'A'.repeat(43),
    });

    const createInput = transaction.driverAccount.create.mock.calls[0]?.[0] as {
      data: { residentNumberFrontFingerprint: string | null };
    };
    expect(createInput.data.residentNumberFrontFingerprint).toBeNull();
    expect(transaction.driver.updateMany).toHaveBeenCalledWith({
      data: {
        accountId: account.id,
        authSubject: 'driver-driver-id',
        inviteCode: null,
        inviteCodeExpiresAt: null,
      },
      where: { accountId: null, id: candidate.id, status: 'ACTIVE' },
    });
    const consumeInput = transaction.dsvDriverAccountSignupInvite.updateMany.mock.calls[0]?.[0] as {
      data: { consumedAt: Date };
      where: { consumedAt: null; id: string; revokedAt: null };
    };
    expect(consumeInput.data.consumedAt).toBeInstanceOf(Date);
    expect(transaction.dsvDriverAccountSignupInvite.updateMany).toHaveBeenCalledWith({
      data: { consumedAt: consumeInput.data.consumedAt },
      where: { consumedAt: null, id: 'invite-id', revokedAt: null },
    });
    expect(result.account.connectionStatus).toBe('LINKED');
  });

  test('validates an unconsumed invite without returning the full phone number', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const prisma = {
      dsvDriverAccountSignupInvite: {
        findUnique: vi.fn((input: unknown) => {
          void input;
          return Promise.resolve({
            consumedAt: null,
            driver: {
              accountId: null,
              displayName: '양우진',
              dsvProfile: {},
              phone: '010-1234-5678',
              status: 'ACTIVE',
            },
            expiresAt,
            revokedAt: null,
          });
        }),
      },
    };
    const repository = new PrismaDsvDriverAuthRepository(
      prisma as never,
      'identity-secret-that-is-at-least-32-characters',
    );

    const result = await repository.validateSignupInvite({ token: 'A'.repeat(43) });

    expect(result).toEqual({
      driverName: '양우진',
      expiresAt: expiresAt.toISOString(),
      phoneLast4: '5678',
    });
    const findInput = prisma.dsvDriverAccountSignupInvite.findUnique.mock.calls[0]?.[0] as {
      include: unknown;
      where: { tokenHash: string };
    };
    expect(findInput.where.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(prisma.dsvDriverAccountSignupInvite.findUnique).toHaveBeenCalledWith({
      include: { driver: { include: { dsvProfile: true } } },
      where: { tokenHash: findInput.where.tokenHash },
    });
  });

  test('rejects registration when invite identity does not match the submitted driver identity', async () => {
    const candidate = {
      accountId: null,
      displayName: '양우진',
      dsvProfile: {},
      id: 'driver-id',
      phone: '010-1234-5678',
      shop: { shopDomain: 'dsv-production.local' },
      status: 'ACTIVE',
    };
    const transaction = {
      dsvDriverAccountSignupInvite: {
        findUnique: vi.fn(() => Promise.resolve({
          consumedAt: null,
          driver: candidate,
          expiresAt: new Date(Date.now() + 60_000),
          id: 'invite-id',
          revokedAt: null,
        })),
      },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction)),
    };
    const repository = new PrismaDsvDriverAuthRepository(
      prisma as never,
      'identity-secret-that-is-at-least-32-characters',
    );

    await expect(repository.register({
      loginId: 'yang.woojin',
      name: '다른 이름',
      password: 'temporary-password',
      phone: '01012345678',
      residentNumberFront: null,
      signupInviteToken: 'A'.repeat(43),
    })).rejects.toMatchObject({ name: 'DsvDriverSignupInviteError' });
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
