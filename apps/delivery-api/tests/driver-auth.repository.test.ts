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

function createPrismaHarness(input: { exactDriver?: DriverFixture | null; legacyPhone?: string } = {}): {
  prisma: {
    driver: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    driverSession: {
      create: ReturnType<typeof vi.fn>;
    };
  };
} {
  const driver = createDriverFixture({ phone: '+14165550123' });
  const exactDriver = input.exactDriver === undefined ? driver : input.exactDriver;
  const legacyDriver = createDriverFixture({ phone: input.legacyPhone ?? '01089216198' });

  return {
    prisma: {
      driver: {
        findFirst: vi.fn(() => Promise.resolve(exactDriver)),
        findMany: vi.fn(() => Promise.resolve([legacyDriver])),
        update: vi.fn(() => Promise.resolve({ ...driver, displayName: 'Minji Kim' }))
      },
      driverSession: {
        create: vi.fn(() => Promise.resolve({ id: 'session-id' }))
      }
    }
  };
}

type DriverFixture = {
  authSubject: string | null;
  displayName: string;
  id: string;
  phone: string;
  shop: { shopDomain: string };
  tokenVersion: number;
};

function createDriverFixture(input: { phone: string }): DriverFixture {
  return {
    authSubject: null,
    displayName: input.phone,
    id: 'driver-id',
    phone: input.phone,
    shop: { shopDomain: 'example.myshopify.com' },
    tokenVersion: 2
  };
}
