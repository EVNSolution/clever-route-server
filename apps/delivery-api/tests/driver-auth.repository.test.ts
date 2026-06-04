import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverAuthRepository } from '../src/modules/driver/driver-auth.repository.js';

const anyDateMatcher: unknown = expect.any(Date);
const anyStringMatcher: unknown = expect.any(String);

describe('PrismaDriverAuthRepository', () => {
  test('stores the registration display name when an invite is verified', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverAuthRepository(prisma as never);

    const session = await repository.verifyInvite({
      displayName: '  Minji Kim  ',
      inviteCode: 'ABC123',
      phone: '+14165550123'
    });

    expect(prisma.driver.findFirst).toHaveBeenCalledWith({
      include: { shop: { select: { shopDomain: true } } },
      where: {
        phone: '+14165550123',
        inviteCode: 'ABC123',
        status: 'ACTIVE',
        inviteCodeExpiresAt: { gt: anyDateMatcher }
      }
    });
    expect(prisma.driver.update).toHaveBeenCalledWith({
      data: {
        authSubject: 'driver-driver-id',
        displayName: 'Minji Kim',
        inviteCode: null,
        inviteCodeExpiresAt: null,
        phone: '+14165550123'
      },
      where: { id: 'driver-id' }
    });
    expect(prisma.driverSession.create).toHaveBeenCalledWith({
      data: {
        driverId: 'driver-id',
        expiresAt: anyDateMatcher,
        refreshTokenHash: anyStringMatcher
      }
    });
    expect(session).toEqual({
      driverId: 'driver-id',
      expiresAt: anyDateMatcher,
      refreshToken: anyStringMatcher,
      shopDomain: 'example.myshopify.com',
      tokenVersion: 2
    });
  });

  test('refreshes an active driver session without rotating the stored refresh token', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverAuthRepository(prisma as never);

    const session = await repository.refreshSession({ refreshToken: 'stored-refresh-token' });

    expect(prisma.driverSession.findUnique).toHaveBeenCalledWith({
      include: { driver: { include: { shop: { select: { shopDomain: true } } } } },
      where: { refreshTokenHash: anyStringMatcher }
    });
    expect(prisma.driverSession.update).toHaveBeenCalledWith({
      data: { lastUsedAt: anyDateMatcher },
      where: { id: 'session-id' }
    });
    expect(session).toEqual({
      driverId: 'driver-id',
      expiresAt: new Date('2026-06-15T00:00:00.000Z'),
      refreshToken: 'stored-refresh-token',
      shopDomain: 'example.myshopify.com',
      tokenVersion: 2
    });
  });

  test('rejects expired, revoked, missing, or inactive-driver refresh sessions', async () => {
    for (const session of [
      null,
      createDriverSessionFixture({ expiresAt: new Date('2020-01-01T00:00:00.000Z') }),
      createDriverSessionFixture({ revokedAt: new Date('2026-05-01T00:00:00.000Z') }),
      createDriverSessionFixture({ driverStatus: 'INACTIVE' })
    ]) {
      const { prisma } = createPrismaHarness({ refreshSession: session });
      const repository = new PrismaDriverAuthRepository(prisma as never);

      await expect(repository.refreshSession({ refreshToken: 'stored-refresh-token' })).rejects.toThrow('Invalid or expired refresh token');
      expect(prisma.driverSession.update).not.toHaveBeenCalled();
    }
  });

  test('matches legacy national phone rows against E.164 invite verification and repairs the stored phone', async () => {
    const { prisma } = createPrismaHarness({ exactDriver: null, legacyPhone: '010-8921-6198' });
    const repository = new PrismaDriverAuthRepository(prisma as never);

    await repository.verifyInvite({
      displayName: null,
      inviteCode: 'FACE12',
      phone: '+821089216198'
    });

    expect(prisma.driver.findMany).toHaveBeenCalledWith({
      include: { shop: { select: { shopDomain: true } } },
      where: {
        inviteCode: 'FACE12',
        status: 'ACTIVE',
        inviteCodeExpiresAt: { gt: anyDateMatcher }
      }
    });
    expect(prisma.driver.update).toHaveBeenCalledWith({
      data: {
        authSubject: 'driver-driver-id',
        inviteCode: null,
        inviteCodeExpiresAt: null,
        phone: '+821089216198'
      },
      where: { id: 'driver-id' }
    });
  });
});

function createPrismaHarness(input: { exactDriver?: DriverFixture | null; legacyPhone?: string; refreshSession?: DriverSessionFixture | null } = {}): {
  prisma: {
    driver: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    driverSession: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
} {
  const driver = createDriverFixture({ phone: '+14165550123' });
  const exactDriver = input.exactDriver === undefined ? driver : input.exactDriver;
  const legacyDriver = createDriverFixture({ phone: input.legacyPhone ?? '01089216198' });
  const refreshSession = input.refreshSession === undefined ? createDriverSessionFixture() : input.refreshSession;

  return {
    prisma: {
      driver: {
        findFirst: vi.fn(() => Promise.resolve(exactDriver)),
        findMany: vi.fn(() => Promise.resolve([legacyDriver])),
        update: vi.fn(() => Promise.resolve({ ...driver, displayName: 'Minji Kim' }))
      },
      driverSession: {
        create: vi.fn(() => Promise.resolve({ id: 'session-id' })),
        findUnique: vi.fn(() => Promise.resolve(refreshSession)),
        update: vi.fn(() => Promise.resolve({ id: 'session-id' }))
      }
    }
  };
}

type DriverSessionFixture = {
  driver: DriverFixture;
  expiresAt: Date;
  id: string;
  revokedAt: Date | null;
};

type DriverFixture = {
  authSubject: string | null;
  displayName: string;
  id: string;
  phone: string;
  shop: { shopDomain: string };
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  tokenVersion: number;
};

function createDriverSessionFixture(input: { driverStatus?: DriverFixture['status']; expiresAt?: Date; revokedAt?: Date | null } = {}): DriverSessionFixture {
  return {
    driver: {
      ...createDriverFixture({ phone: '+14165550123' }),
      status: input.driverStatus ?? 'ACTIVE'
    },
    expiresAt: input.expiresAt ?? new Date('2026-06-15T00:00:00.000Z'),
    id: 'session-id',
    revokedAt: input.revokedAt ?? null
  };
}

function createDriverFixture(input: { phone: string }): DriverFixture {
  return {
    authSubject: null,
    displayName: input.phone,
    id: 'driver-id',
    phone: input.phone,
    shop: { shopDomain: 'example.myshopify.com' },
    status: 'ACTIVE',
    tokenVersion: 2
  };
}
