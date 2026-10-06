import { visibleDsvRouteWhere } from '../src/modules/dsv/dsv-test-visibility.js';
import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';

describe('PrismaDriverTokenAccessRepository', () => {
  test('preserves review account access to its own active route', async () => {
    const { prisma } = createPrismaHarness({
      account: { status: 'ACTIVE', tokenVersion: 2 },
      routePlan: {
        driver: {
          account: { isStoreReviewAccount: true }, accountId: 'review-account-id',
          authSubject: 'driver-review-driver-id', id: 'review-driver-id', isStoreReviewData: true,
          status: 'ACTIVE',
        },
        id: 'review-route-plan-id', isStoreReviewData: true,
        routeGroupingChildVersions: [{ publishedAt: null }],
        shop: { id: 'shop-id', shopDomain: 'review.example' }, status: 'IN_PROGRESS',
      },
    });
    const repository = new PrismaDriverTokenAccessRepository(prisma as never);

    await expect(repository.resolveDriverRouteAccess({
      accountId: 'review-account-id', routePlanId: 'review-route-plan-id', tokenVersion: 2,
    })).resolves.toEqual({
      accountId: 'review-account-id', driverId: 'review-driver-id',
      routePlanId: 'review-route-plan-id', shopDomain: 'review.example', shopId: 'shop-id',
    });
  });

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
        routeGroupingChildVersions: [{ publishedAt: new Date('2026-05-11T12:00:00.000Z') }],
        shop: { id: 'shop-id', shopDomain: 'dev1.tomatonofood.com' },
        status: 'READY',
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
        assignmentGeneration: true,
        deliveryWorkCompletedAt: true,
        deliveryWorkCompletedGeneration: true,
        deliveryWorkCompletedVersionId: true,
        driver: {
          select: { account: { select: { isStoreReviewAccount: true } }, accountId: true, authSubject: true, id: true, isStoreReviewData: true, status: true }
        },
        id: true,
        driverNavigationUntil: true,
        isStoreReviewData: true,
        routeGroupingChildVersions: {
          orderBy: { updatedAt: 'desc' },
          select: { publishedAt: true },
          take: 1,
          where: { status: 'CURRENT', supersededAt: null }
        },
        shop: { select: { appId: true, id: true, shopDomain: true } },
        status: true,
      },
      where: {
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        id: 'route-plan-id',
        ...visibleDsvRouteWhere(),
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
        routeGroupingChildVersions: [{ publishedAt: new Date('2026-05-11T12:00:00.000Z') }],
        shop: { id: 'shop-id', shopDomain: 'dev1.tomatonofood.com' },
        status: 'READY',
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

  test('keeps token access through navigation grace and rejects it at the exact expiry boundary', async () => {
    const routePlan = {
      assignmentGeneration: 4n,
      deliveryWorkCompletedAt: new Date('2026-10-01T16:00:00.000Z'),
      deliveryWorkCompletedGeneration: 4n,
      deliveryWorkCompletedVersionId: '22222222-2222-4222-8222-222222222222',
      driverNavigationUntil: new Date('2026-10-01T18:00:00.000Z'),
      driver: {
        accountId: 'account-id', authSubject: 'driver-driver-id', id: 'driver-id', status: 'ACTIVE' as const
      },
      id: 'route-plan-id',
      routeGroupingChildVersions: [{ publishedAt: new Date('2026-10-01T15:00:00.000Z') }],
      shop: { appId: 'clever-route-kfood', id: 'shop-id', shopDomain: '7hrud1-xq.myshopify.com' },
      status: 'IN_PROGRESS'
    };
    const before = new PrismaDriverTokenAccessRepository(createPrismaHarness({
      account: { status: 'ACTIVE', tokenVersion: 2 }, routePlan
    }).prisma as never, () => new Date('2026-10-01T17:59:59.999Z'));
    const atBoundary = new PrismaDriverTokenAccessRepository(createPrismaHarness({
      account: { status: 'ACTIVE', tokenVersion: 2 }, routePlan
    }).prisma as never, () => new Date('2026-10-01T18:00:00.000Z'));
    const foreignTenant = new PrismaDriverTokenAccessRepository(createPrismaHarness({
      account: { status: 'ACTIVE', tokenVersion: 2 },
      routePlan: { ...routePlan, shop: { ...routePlan.shop, appId: 'clever-route-dsv' } }
    }).prisma as never, () => new Date('2026-10-01T18:00:00.000Z'));

    await expect(before.resolveDriverRouteAccess({
      accountId: 'account-id', routePlanId: 'route-plan-id', tokenVersion: 2
    })).resolves.toMatchObject({ routePlanId: 'route-plan-id' });
    await expect(atBoundary.resolveDriverRouteAccess({
      accountId: 'account-id', routePlanId: 'route-plan-id', tokenVersion: 2
    })).resolves.toBeNull();
    await expect(atBoundary.resolveDriverRouteAccess({
      accountId: 'account-id', routePlanId: 'route-plan-id', tokenVersion: 2
    }, { allowCompleted: true })).resolves.toBeNull();
    const finalized = new PrismaDriverTokenAccessRepository(createPrismaHarness({
      account: { status: 'ACTIVE', tokenVersion: 2 }, routePlan: { ...routePlan, status: 'COMPLETED' }
    }).prisma as never, () => new Date('2026-10-01T18:00:00.000Z'));
    await expect(finalized.resolveDriverRouteAccess({
      accountId: 'account-id', routePlanId: 'route-plan-id', tokenVersion: 2
    }, { allowCompleted: true })).resolves.toBeNull();
    await expect(foreignTenant.resolveDriverRouteAccess({
      accountId: 'account-id', routePlanId: 'route-plan-id', tokenVersion: 2
    })).resolves.toMatchObject({ routePlanId: 'route-plan-id' });
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
      routeGroupingChildVersions: [],
      shop: { id: 'shop-id', shopDomain: 'dev1.tomatonofood.com' },
      status: 'COMPLETED',
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
        ...visibleDsvRouteWhere(),
        status: { in: ['READY', 'IN_PROGRESS', 'DRAFT', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED', 'COMPLETED', 'INCOMPLETE'] }
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
        isStoreReviewData: false,
        id: 'driver-id',
        shop: { shopDomain: 'dev1.tomatonofood.com' },
        status: 'ACTIVE'
      }
    });
  });

  test('rejects a cached ready-route token before Dispatch but preserves an active route', async () => {
    const baseRoutePlan = {
      driver: {
        accountId: 'account-id',
        authSubject: 'driver-driver-id',
        id: 'driver-id',
        status: 'ACTIVE' as const,
      },
      id: 'route-plan-id',
      routeGroupingChildVersions: [{ publishedAt: null }],
      shop: { id: 'shop-id', shopDomain: 'dev1.tomatonofood.com' },
    };
    const readyRepository = new PrismaDriverTokenAccessRepository(createPrismaHarness({
      account: { status: 'ACTIVE', tokenVersion: 2 },
      routePlan: { ...baseRoutePlan, status: 'READY' },
    }).prisma as never);
    const activeRepository = new PrismaDriverTokenAccessRepository(createPrismaHarness({
      account: { status: 'ACTIVE', tokenVersion: 2 },
      routePlan: { ...baseRoutePlan, status: 'IN_PROGRESS' },
    }).prisma as never);

    await expect(readyRepository.resolveDriverRouteAccess({
      accountId: 'account-id', routePlanId: 'route-plan-id', tokenVersion: 2,
    })).resolves.toBeNull();
    await expect(activeRepository.resolveDriverRouteAccess({
      accountId: 'account-id', routePlanId: 'route-plan-id', tokenVersion: 2,
    })).resolves.toMatchObject({ routePlanId: 'route-plan-id' });
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
    assignmentGeneration?: bigint;
    deliveryWorkCompletedAt?: Date | null;
    deliveryWorkCompletedGeneration?: bigint | null;
    deliveryWorkCompletedVersionId?: string | null;
    driver: {
      account?: { isStoreReviewAccount: boolean };
      accountId: string | null;
      authSubject: string | null;
      id: string;
      isStoreReviewData?: boolean;
      status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
    } | null;
    id: string;
    driverNavigationUntil?: Date | null;
    isStoreReviewData?: boolean;
    routeGroupingChildVersions?: Array<{ publishedAt: Date | null }>;
    shop: { appId?: string; id: string; shopDomain: string };
    status?: string;
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
