import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverSelfServiceRepository } from '../src/modules/driver/driver-self-service.repository.js';
import {
  DriverAccountDeletionActiveRouteError,
  DriverSelfServiceScopeError
} from '../src/modules/driver/driver-self-service.types.js';
import { ROUTE_DRIVER_VISIBLE_STATUSES } from '../src/modules/route-plans/route-plan-lifecycle.js';

const routePlanId = '11111111-1111-4111-8111-111111111111';
const nextRoutePlanId = '22222222-2222-4222-8222-222222222222';
const anyStringMatcher: unknown = expect.any(String);

describe('PrismaDriverSelfServiceRepository', () => {
  test('lists route history only for the token driver and shop with date/status filters', async () => {
    const { prisma } = createPrismaHarness({ routePlans: [routePlanRecord()] });
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    const result = await repository.listDriverRoutes({
      cursor: null,
      driverId: 'driver-id',
      from: new Date('2026-05-01T00:00:00.000Z'),
      shopDomain: 'Example.myshopify.com',
      shopId: 'shop-id',
      status: 'completed',
      to: new Date('2026-05-31T00:00:00.000Z')
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      select: { id: true, shopDomain: true },
      where: { id: 'shop-id' }
    });
    expect(prisma.driver.findFirst).toHaveBeenCalledWith({
      select: { displayName: true, id: true, phone: true, status: true },
      where: { id: 'driver-id', shopId: 'shop-id', status: 'ACTIVE' }
    });
    expect(prisma.routePlan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: routeHistoryIncludeMatcher('driver-id'),
      orderBy: [{ planDate: 'asc' }, { id: 'asc' }],
      take: 104,
      where: routePlanWhereMatcher({
        driverId: 'driver-id',
        planDate: { gte: new Date('2026-05-01T00:00:00.000Z'), lte: new Date('2026-05-31T00:00:00.000Z') },
        shopId: 'shop-id',
        status: { in: [...ROUTE_DRIVER_VISIBLE_STATUSES] }
      })
    }));
    expect(result.routes).toEqual([
      {
        completedAt: '2026-05-19T08:30:00.000Z',
        completedStopCount: 1,
        deliveryDate: '2026-05-19',
        failedStopCount: 1,
        name: 'Tuesday AM Route',
        routePlanId,
        shopDomain: 'example.myshopify.com',
        companyDisplayName: 'Tomatono Toronto',
        status: 'completed',
        stopCount: 3,
        timezone: 'America/Toronto'
      }
    ]);
    expect(result.pageInfo).toEqual({ endCursor: anyStringMatcher, hasNextPage: false });
  });


  test('resolves driver profiles for Woo customer domains', async () => {
    const { prisma } = createPrismaHarness({ shopDomain: 'dev1.tomatonofood.com' });
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    await expect(repository.getDriverProfile({
      driverId: 'driver-id',
      shopDomain: 'https://Dev1.TomatonoFood.com/driver',
      shopId: 'shop-id'
    })).resolves.toEqual({
      driver: { displayName: 'Minji Kim', id: 'driver-id', phone: '+14165550123', status: 'ACTIVE' }
    });
    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      select: { id: true, shopDomain: true },
      where: { id: 'shop-id' }
    });
  });

  test('returns a next page cursor and composes cursor predicates', async () => {
    const firstPage = Array.from({ length: 26 }, (_, index) => routePlanRecord({
      id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
    }));
    const { prisma } = createPrismaHarness({ routePlans: firstPage });
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    const first = await repository.listDriverRoutes({
      cursor: null,
      driverId: 'driver-id',
      from: null,
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id',
      status: null,
      to: null
    });

    expect(first.routes).toHaveLength(25);
    expect(first.pageInfo.hasNextPage).toBe(true);
    expect(first.pageInfo.endCursor).toEqual(anyStringMatcher);

    await repository.listDriverRoutes({
      cursor: first.pageInfo.endCursor,
      driverId: 'driver-id',
      from: null,
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id',
      status: null,
      to: null
    });

    expect(prisma.routePlan.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: routePlanWhereMatcher({
        OR: [
          { planDate: { gt: new Date('2026-05-19T00:00:00.000Z') } },
          {
            id: { gt: '00000024-1111-4111-8111-111111111111' },
            planDate: new Date('2026-05-19T00:00:00.000Z')
          }
        ]
      })
    }));
  });

  test('continues raw pagination until a filtered route-history page has matches', async () => {
    const pendingBatch = Array.from({ length: 104 }, (_, index) => routePlanRecord({
      driverEvents: [],
      id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
      routeStops: [{ deliveryStop: { status: 'ASSIGNED' } }]
    }));
    const { prisma } = createPrismaHarness({ routePlans: [] });
    prisma.routePlan.findMany
      .mockResolvedValueOnce(pendingBatch)
      .mockResolvedValueOnce([routePlanRecord({ id: nextRoutePlanId })]);
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    const result = await repository.listDriverRoutes({
      cursor: null,
      driverId: 'driver-id',
      from: null,
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id',
      status: 'completed',
      to: null
    });

    expect(result.routes).toHaveLength(1);
    expect(result.pageInfo.hasNextPage).toBe(false);
    expect(prisma.routePlan.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.routePlan.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: routePlanWhereMatcher({
        OR: [
          { planDate: { gt: new Date('2026-05-19T00:00:00.000Z') } },
          {
            id: { gt: '00000103-1111-4111-8111-111111111111' },
            planDate: new Date('2026-05-19T00:00:00.000Z')
          }
        ]
      })
    }));
  });

  test('falls back to a valid server timezone when route constraints are missing or invalid', async () => {
    const { prisma } = createPrismaHarness({ routePlans: [routePlanRecord({ constraints: { timezone: 'Mars/Base' } })] });
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    const result = await repository.listDriverRoutes({
      cursor: null,
      driverId: 'driver-id',
      from: null,
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id',
      status: null,
      to: null
    });

    expect(result.routes[0]?.timezone).toBe('UTC');
  });

  test('rejects self-service scope when the token driver is not active in the token shop', async () => {
    const { prisma } = createPrismaHarness({ driver: null });
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    await expect(repository.getDriverProfile({
      driverId: 'driver-id',
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id'
    }))
      .rejects.toThrow(DriverSelfServiceScopeError);
    expect(prisma.routePlan.findMany).not.toHaveBeenCalled();
  });

  test('records route feedback only after route ownership is verified', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    const result = await repository.submitRouteFeedback({
      driverId: 'driver-id',
      reviewNote: 'Use west entrance next time.',
      routePlanId,
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id',
      submittedAt: new Date('2026-05-19T08:45:00.000Z')
    });

    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        driverId: 'driver-id',
        id: routePlanId,
        shopId: 'shop-id',
        status: { in: [...ROUTE_DRIVER_VISIBLE_STATUSES] }
      }
    });
    expect(prisma.driverRouteFeedback.create).toHaveBeenCalledWith({
      data: {
        driverId: 'driver-id',
        reviewNote: 'Use west entrance next time.',
        routePlanId,
        shopId: 'shop-id',
        submittedAt: new Date('2026-05-19T08:45:00.000Z')
      }
    });
    expect(result).toEqual({
      feedbackId: 'feedback-id',
      reviewNote: 'Use west entrance next time.',
      routePlanId,
      submittedAt: '2026-05-19T08:45:00.000Z'
    });
  });

  test('does not persist route feedback for another driver route', async () => {
    const { prisma } = createPrismaHarness({ routePlanScope: null });
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    await expect(repository.submitRouteFeedback({
      driverId: 'driver-id',
      reviewNote: 'Use west entrance next time.',
      routePlanId,
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id',
      submittedAt: new Date('2026-05-19T08:45:00.000Z')
    })).rejects.toThrow(DriverSelfServiceScopeError);
    expect(prisma.driverRouteFeedback.create).not.toHaveBeenCalled();
  });

  test('updates displayName without changing other driver fields', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    const result = await repository.updateDriverProfile({
      displayName: 'Mina Kang',
      driverId: 'driver-id',
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id'
    });

    expect(prisma.driver.update).toHaveBeenCalledWith({
      data: { displayName: 'Mina Kang' },
      select: { displayName: true, id: true, phone: true, status: true },
      where: { id: 'driver-id' }
    });
    expect(result.driver).toEqual({ displayName: 'Mina Kang', id: 'driver-id', phone: '+14165550123', status: 'ACTIVE' });
  });

  test('creates an account deletion request without mutating the driver', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    const result = await repository.requestAccountDeletion({
      driverId: 'driver-id',
      reason: 'No longer driving',
      requestedAt: new Date('2026-05-19T09:00:00.000Z'),
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id'
    });

    expect(prisma.driverAccountDeletionRequest.create).toHaveBeenCalledWith({
      data: {
        driverId: 'driver-id',
        driverDisplayName: 'Minji Kim',
        driverPhone: '+14165550123',
        reason: 'No longer driving',
        requestedAt: new Date('2026-05-19T09:00:00.000Z'),
        shopDomain: 'example.myshopify.com',
        shopId: 'shop-id',
        status: 'REQUESTED'
      }
    });
    expect(prisma.driver.update).not.toHaveBeenCalled();
    expect(result).toEqual({ duplicate: false, requestId: 'deletion-request-id', status: 'REQUESTED' });
  });

  test('creates one global account deletion request without Store ownership', async () => {
    const { prisma } = createPrismaHarness({ activeAccountRoute: null });
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    const result = await repository.requestGlobalAccountDeletion({
      accountId: 'account-id',
      reason: 'Delete my account',
      requestedAt: new Date('2026-07-27T09:00:00.000Z'),
      tokenVersion: 3
    });

    expect(prisma.driverAccount.findFirst).toHaveBeenCalledWith({
      select: { name: true, phone: true },
      where: { id: 'account-id', status: 'ACTIVE', tokenVersion: 3 }
    });
    expect(prisma.driverAccountDeletionRequest.create).toHaveBeenCalledWith({
      data: {
        accountId: 'account-id',
        driverDisplayName: 'Jiin',
        driverPhone: '+14165550123',
        reason: 'Delete my account',
        requestedAt: new Date('2026-07-27T09:00:00.000Z'),
        shopDomain: null,
        status: 'REQUESTED'
      }
    });
    expect(result).toEqual({ duplicate: false, requestId: 'deletion-request-id', status: 'REQUESTED' });
  });

  test('returns an existing global deletion request and blocks only a new request during an active route', async () => {
    const existingHarness = createPrismaHarness({
      deletionRequest: { id: 'existing-request-id', status: 'REQUESTED' }
    });
    const existingRepository = new PrismaDriverSelfServiceRepository(existingHarness.prisma as never);

    await expect(existingRepository.requestGlobalAccountDeletion({
      accountId: 'account-id',
      reason: null,
      requestedAt: new Date('2026-07-27T09:00:00.000Z'),
      tokenVersion: 3
    })).resolves.toEqual({ duplicate: true, requestId: 'existing-request-id', status: 'REQUESTED' });
    expect(existingHarness.prisma.routePlan.findFirst).not.toHaveBeenCalled();

    const activeHarness = createPrismaHarness({ activeAccountRoute: { id: routePlanId } });
    const activeRepository = new PrismaDriverSelfServiceRepository(activeHarness.prisma as never);
    await expect(activeRepository.requestGlobalAccountDeletion({
      accountId: 'account-id',
      reason: null,
      requestedAt: new Date('2026-07-27T09:00:00.000Z'),
      tokenVersion: 3
    })).rejects.toThrow(DriverAccountDeletionActiveRouteError);
    expect(activeHarness.prisma.driverAccountDeletionRequest.create).not.toHaveBeenCalled();
  });

  test('returns zero-money earnings from completed scoped route work only', async () => {
    const { prisma } = createPrismaHarness({
      routePlans: [
        routePlanRecord(),
        routePlanRecord({ id: nextRoutePlanId, routeStops: [{ deliveryStop: { status: 'DELIVERED' } }] })
      ]
    });
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    const result = await repository.getDriverEarnings({
      driverId: 'driver-id',
      period: '2026-05',
      shopDomain: 'example.myshopify.com',
      shopId: 'shop-id'
    });

    expect(prisma.routePlan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        driverId: 'driver-id',
        planDate: { gte: new Date('2026-05-01T00:00:00.000Z'), lt: new Date('2026-06-01T00:00:00.000Z') },
        shopId: 'shop-id',
        status: { in: [...ROUTE_DRIVER_VISIBLE_STATUSES] }
      }
    }));
    expect(result).toEqual({
      currency: 'CAD',
      items: [],
      period: '2026-05',
      summary: {
        adjustments: 0,
        completedRoutes: 2,
        completedStops: 2,
        estimatedPayout: 0,
        grossAmount: 0
      }
    });
  });
});

function createPrismaHarness(input: {
  activeAccountRoute?: { id: string } | null;
  deletionRequest?: { id: string; status: 'REQUESTED' } | null;
  driver?: { displayName: string; id: string; phone: string | null; status: 'ACTIVE' } | null;
  routePlanScope?: { id: string } | null;
  routePlans?: ReturnType<typeof routePlanRecord>[];
  shopDomain?: string;
} = {}) {
  const driver = input.driver === undefined
    ? { displayName: 'Minji Kim', id: 'driver-id', phone: '+14165550123', status: 'ACTIVE' as const }
    : input.driver;
  const routePlanScope = input.routePlanScope === undefined ? { id: routePlanId } : input.routePlanScope;
  const routePlans = input.routePlans ?? [routePlanRecord()];
  const activeAccountRoute = input.activeAccountRoute ?? null;
  const deletionRequest = input.deletionRequest ?? null;

  return {
    prisma: {
      driver: {
        findFirst: vi.fn(() => Promise.resolve(driver)),
        update: vi.fn(() => Promise.resolve({ displayName: 'Mina Kang', id: 'driver-id', phone: '+14165550123', status: 'ACTIVE' }))
      },
      driverAccount: {
        findFirst: vi.fn(() => Promise.resolve({ name: 'Jiin', phone: '+14165550123' }))
      },
      driverAccountDeletionRequest: {
        create: vi.fn(() => Promise.resolve({ id: 'deletion-request-id', status: 'REQUESTED' })),
        findUnique: vi.fn(() => Promise.resolve(deletionRequest))
      },
      driverRouteFeedback: {
        create: vi.fn((args: { data: { reviewNote: string; routePlanId: string; submittedAt: Date } }) => Promise.resolve({
          id: 'feedback-id',
          reviewNote: args.data.reviewNote,
          routePlanId: args.data.routePlanId,
          submittedAt: args.data.submittedAt
        }))
      },
      routePlan: {
        findFirst: vi.fn((args: { where?: { driver?: { accountId?: string } } }) => Promise.resolve(
          args.where?.driver?.accountId === undefined ? routePlanScope : activeAccountRoute
        )),
        findMany: vi.fn(() => Promise.resolve(routePlans))
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id', shopDomain: input.shopDomain ?? 'example.myshopify.com' }))
      }
    }
  };
}

function routePlanWhereMatcher(expected: Record<string, unknown>): unknown {
  return expect.objectContaining(expected);
}

function routeHistoryIncludeMatcher(driverId: string): unknown {
  const driverEventsMatcher: unknown = expect.objectContaining({
    where: { driverId, eventType: { in: ['ROUTE_STARTED', 'ROUTE_COMPLETED'] } }
  });

  return expect.objectContaining({
    driverEvents: driverEventsMatcher
  });
}

function routePlanRecord(input: {
  constraints?: unknown;
  driverEvents?: { eventType: string; occurredAt: Date }[];
  id?: string;
  routeStops?: { deliveryStop: { status: string } }[];
  status?: string;
} = {}) {
  return {
    constraints: input.constraints ?? { companyDisplayName: 'Tomatono Toronto', timezone: 'America/Toronto' },
    driverEvents: input.driverEvents ?? [{ eventType: 'ROUTE_COMPLETED', occurredAt: new Date('2026-05-19T08:30:00.000Z') }],
    id: input.id ?? routePlanId,
    name: 'Tuesday AM Route',
    planDate: new Date('2026-05-19T00:00:00.000Z'),
    routeStops: input.routeStops ?? [
      { deliveryStop: { status: 'DELIVERED' } },
      { deliveryStop: { status: 'FAILED' } },
      { deliveryStop: { status: 'ASSIGNED' } }
    ],
    shop: { shopDomain: 'example.myshopify.com' },
    status: input.status ?? 'PUBLISHED'
  };
}
