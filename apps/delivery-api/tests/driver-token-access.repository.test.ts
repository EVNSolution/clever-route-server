import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';

describe('PrismaDriverTokenAccessRepository', () => {
  test('resolves a route token only from the account-to-route assignment', async () => {
    const { prisma } = createPrismaHarness({
      account: { status: 'ACTIVE', tokenVersion: 2 },
      routePlan: {
        driver: {
          accountId: 'account-id',
          authSubject: 'driver-driver-id',
          id: 'driver-id',
          status: 'ACTIVE'
        },
        id: 'route-plan-id',
        shop: { id: 'shop-id', shopDomain: 'dev1.tomatonofood.com' }
      }
    });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(repository.resolveDriverRouteAccess({
      accountId: 'account-id',
      routePlanId: 'route-plan-id',
      tokenVersion: 2
    })).resolves.toEqual({
      accountId: 'account-id',
      driverId: 'driver-id',
      routePlanId: 'route-plan-id',
      shopDomain: 'dev1.tomatonofood.com',
      shopId: 'shop-id'
    });

    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith({
      select: {
        driver: {
          select: { accountId: true, authSubject: true, id: true, status: true }
        },
        id: true,
        shop: { select: { id: true, shopDomain: true } }
      },
      where: {
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        id: 'route-plan-id',
        status: { in: ['READY', 'IN_PROGRESS', 'DRAFT', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED'] }
      }
    });
  });

  test('rejects a route token when the assignment belongs to another account', async () => {
    const { prisma } = createPrismaHarness({
      account: { status: 'ACTIVE', tokenVersion: 2 },
      routePlan: {
        driver: {
          accountId: 'other-account-id',
          authSubject: 'driver-driver-id',
          id: 'driver-id',
          status: 'ACTIVE'
        },
        id: 'route-plan-id',
        shop: { id: 'shop-id', shopDomain: 'dev1.tomatonofood.com' }
      }
    });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(repository.resolveDriverRouteAccess({
      accountId: 'account-id',
      routePlanId: 'route-plan-id',
      tokenVersion: 2
    })).resolves.toBeNull();
  });

  test('rejects a route token after the route is completed or cancelled', async () => {
    const { prisma } = createPrismaHarness({
      account: { status: 'ACTIVE', tokenVersion: 2 },
      routePlan: null
    });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(repository.resolveDriverRouteAccess({
      accountId: 'account-id',
      routePlanId: 'route-plan-id',
      tokenVersion: 2
    })).resolves.toBeNull();
  });

  test('resolves the same completed assignment only for completion retry authentication', async () => {
    const routePlan = {
      driver: {
        accountId: 'account-id',
        authSubject: 'driver-driver-id',
        id: 'driver-id',
        status: 'ACTIVE' as const
      },
      id: 'route-plan-id',
      shop: { id: 'shop-id', shopDomain: 'dev1.tomatonofood.com' }
    };
    const { prisma } = createPrismaHarness({
      account: { status: 'ACTIVE', tokenVersion: 2 },
      routePlan
    });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(repository.resolveDriverRouteAccess({
      accountId: 'account-id',
      routePlanId: 'route-plan-id',
      tokenVersion: 2
    }, { allowCompleted: true })).resolves.toMatchObject({
      accountId: 'account-id',
      driverId: 'driver-id',
      routePlanId: 'route-plan-id'
    });

    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'route-plan-id',
        status: { in: ['READY', 'IN_PROGRESS', 'DRAFT', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED', 'COMPLETED'] }
      }
    }));
  });

  test('accepts an active linked driver token only when the token version still matches', async () => {
    const { prisma } = createPrismaHarness({ tokenVersion: 3 });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(
      repository.isDriverAccessTokenActive({
        driverId: 'driver-id',
        shopDomain: 'https://Dev1.TomatonoFood.com/driver',
        tokenVersion: 3
      })
    ).resolves.toBe(true);

    expect(prisma.driver.findFirst).toHaveBeenCalledWith({
      select: { tokenVersion: true },
      where: {
        authSubject: { not: null },
        id: 'driver-id',
        shop: { shopDomain: 'dev1.tomatonofood.com' },
        status: 'ACTIVE'
      }
    });
  });

  test('rejects older tokens after relogin increments the driver token version', async () => {
    const { prisma } = createPrismaHarness({ tokenVersion: 4 });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(
      repository.isDriverAccessTokenActive({
        driverId: 'driver-id',
        shopDomain: 'example.myshopify.com',
        tokenVersion: 3
      })
    ).resolves.toBe(false);
  });

  test('rejects tokens for drivers no longer linked to the app', async () => {
    const { prisma } = createPrismaHarness({ driver: null });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(
      repository.isDriverAccessTokenActive({
        driverId: 'driver-id',
        shopDomain: 'example.myshopify.com',
        tokenVersion: 0
      })
    ).resolves.toBe(false);
  });

  test('accepts an active account token only while its token version matches', async () => {
    const { prisma } = createPrismaHarness({ account: { status: 'ACTIVE', tokenVersion: 2 } });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(repository.isDriverAccountAccessTokenActive({
      accountId: 'account-id',
      tokenVersion: 2
    })).resolves.toBe(true);
    await expect(repository.isDriverAccountAccessTokenActive({
      accountId: 'account-id',
      tokenVersion: 1
    })).resolves.toBe(false);

    expect(prisma.driverAccount.findUnique).toHaveBeenCalledWith({
      select: { status: true, tokenVersion: true },
      where: { id: 'account-id' }
    });
  });
});

function createPrismaHarness(input: {
  account?: { status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'; tokenVersion: number } | null;
  driver?: { tokenVersion: number } | null;
  routePlan?: {
    driver: {
      accountId: string | null;
      authSubject: string | null;
      id: string;
      status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
    } | null;
    id: string;
    shop: { id: string; shopDomain: string };
  } | null;
  tokenVersion?: number;
} = {}): {
  prisma: {
    driver: {
      findFirst: ReturnType<typeof vi.fn>;
    };
    driverAccount: {
      findUnique: ReturnType<typeof vi.fn>;
    };
    routePlan: {
      findFirst: ReturnType<typeof vi.fn>;
    };
  };
} {
  const driver =
    input.driver === undefined ? { tokenVersion: input.tokenVersion ?? 0 } : input.driver;

  return {
    prisma: {
      driver: {
        findFirst: vi.fn(() => Promise.resolve(driver))
      },
      driverAccount: {
        findUnique: vi.fn(() => Promise.resolve(input.account ?? null))
      },
      routePlan: {
        findFirst: vi.fn(() => Promise.resolve(input.routePlan ?? null))
      }
    }
  };
}
