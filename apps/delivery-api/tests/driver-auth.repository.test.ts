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
        inviteCodeExpiresAt: null
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
});

function createPrismaHarness(): {
  prisma: {
    driver: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    driverSession: {
      create: ReturnType<typeof vi.fn>;
    };
  };
} {
  const driver = {
    authSubject: null,
    displayName: '+14165550123',
    id: 'driver-id',
    shop: { shopDomain: 'example.myshopify.com' },
    tokenVersion: 2
  };

  return {
    prisma: {
      driver: {
        findFirst: vi.fn(() => Promise.resolve(driver)),
        update: vi.fn(() => Promise.resolve({ ...driver, displayName: 'Minji Kim' }))
      },
      driverSession: {
        create: vi.fn(() => Promise.resolve({ id: 'session-id' }))
      }
    }
  };
}
