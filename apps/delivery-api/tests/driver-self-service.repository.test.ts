import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverSelfServiceRepository } from '../src/modules/driver/driver-self-service.repository.js';
import { DriverSelfServiceScopeError } from '../src/modules/driver/driver-self-service.types.js';

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
      status: 'completed',
      to: new Date('2026-05-31T00:00:00.000Z')
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      select: { id: true, shopDomain: true },
      where: { shopDomain: 'example.myshopify.com' }
    });
    expect(prisma.driver.findFirst).toHaveBeenCalledWith({
      select: { displayName: true, id: true, phone: true, status: true },
      where: { id: 'driver-id', shopId: 'shop-id', status: 'ACTIVE' }
    });
    expect(prisma.routePlan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: routeHistoryIncludeMatcher('driver-id'),
      orderBy: [{ planDate: 'asc' }, { id: 'asc' }],
      take: 26,
      where: routePlanWhereMatcher({
        driverId: 'driver-id',
        planDate: { gte: new Date('2026-05-01T00:00:00.000Z'), lte: new Date('2026-05-31T00:00:00.000Z') },
        shopId: 'shop-id',
        status: { in: ['COMPLETED'] }
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

  test('falls back to a valid server timezone when route constraints are missing or invalid', async () => {
    const { prisma } = createPrismaHarness({ routePlans: [routePlanRecord({ constraints: { timezone: 'Mars/Base' } })] });
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    const result = await repository.listDriverRoutes({
      cursor: null,
      driverId: 'driver-id',
      from: null,
      shopDomain: 'example.myshopify.com',
      status: null,
      to: null
    });

    expect(result.routes[0]?.timezone).toBe('UTC');
  });

  test('rejects self-service scope when the token driver is not active in the token shop', async () => {
    const { prisma } = createPrismaHarness({ driver: null });
    const repository = new PrismaDriverSelfServiceRepository(prisma as never);

    await expect(repository.getDriverProfile({ driverId: 'driver-id', shopDomain: 'example.myshopify.com' }))
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
      submittedAt: new Date('2026-05-19T08:45:00.000Z')
    });

    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        driverId: 'driver-id',
        id: routePlanId,
        shopId: 'shop-id',
        status: { in: ['OPTIMIZED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'] }
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
      shopDomain: 'example.myshopify.com'
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
      shopDomain: 'example.myshopify.com'
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
    expect(result).toEqual({ requestId: 'deletion-request-id', status: 'REQUESTED' });
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
      shopDomain: 'example.myshopify.com'
    });

    expect(prisma.routePlan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        driverId: 'driver-id',
        planDate: { gte: new Date('2026-05-01T00:00:00.000Z'), lt: new Date('2026-06-01T00:00:00.000Z') },
        shopId: 'shop-id',
        status: 'COMPLETED'
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
  driver?: { displayName: string; id: string; phone: string | null; status: 'ACTIVE' } | null;
  routePlanScope?: { id: string } | null;
  routePlans?: ReturnType<typeof routePlanRecord>[];
} = {}) {
  const driver = input.driver === undefined
    ? { displayName: 'Minji Kim', id: 'driver-id', phone: '+14165550123', status: 'ACTIVE' as const }
    : input.driver;
  const routePlanScope = input.routePlanScope === undefined ? { id: routePlanId } : input.routePlanScope;
  const routePlans = input.routePlans ?? [routePlanRecord()];

  return {
    prisma: {
      driver: {
        findFirst: vi.fn(() => Promise.resolve(driver)),
        update: vi.fn(() => Promise.resolve({ displayName: 'Mina Kang', id: 'driver-id', phone: '+14165550123', status: 'ACTIVE' }))
      },
      driverAccountDeletionRequest: {
        create: vi.fn(() => Promise.resolve({ id: 'deletion-request-id', status: 'REQUESTED' }))
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
        findFirst: vi.fn(() => Promise.resolve(routePlanScope)),
        findMany: vi.fn(() => Promise.resolve(routePlans))
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id', shopDomain: 'example.myshopify.com' }))
      }
    }
  };
}

function routePlanWhereMatcher(expected: Record<string, unknown>): unknown {
  return expect.objectContaining(expected);
}

function routeHistoryIncludeMatcher(driverId: string): unknown {
  const driverEventsMatcher: unknown = expect.objectContaining({
    where: { driverId, eventType: 'ROUTE_COMPLETED' }
  });

  return expect.objectContaining({
    driverEvents: driverEventsMatcher
  });
}

function routePlanRecord(input: {
  constraints?: unknown;
  id?: string;
  routeStops?: { deliveryStop: { status: string } }[];
  status?: string;
} = {}) {
  return {
    constraints: input.constraints ?? { companyDisplayName: 'Tomatono Toronto', timezone: 'America/Toronto' },
    driverEvents: [{ occurredAt: new Date('2026-05-19T08:30:00.000Z') }],
    id: input.id ?? routePlanId,
    name: 'Tuesday AM Route',
    planDate: new Date('2026-05-19T00:00:00.000Z'),
    routeStops: input.routeStops ?? [
      { deliveryStop: { status: 'DELIVERED' } },
      { deliveryStop: { status: 'FAILED' } },
      { deliveryStop: { status: 'ASSIGNED' } }
    ],
    shop: { shopDomain: 'example.myshopify.com' },
    status: input.status ?? 'COMPLETED'
  };
}
