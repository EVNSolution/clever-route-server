import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverRouteSessionRepository } from '../src/modules/driver/driver-route-session.repository.js';
import { DriverRouteSessionScopeError } from '../src/modules/driver/driver-route-session.types.js';

const startedAt = new Date('2026-06-15T12:00:00.000Z');

const assignedRoute = {
  status: 'ASSIGNED_ROUTE' as const,
  route: {
    deliveryDate: '2026-06-15',
    id: 'route-plan-id',
    name: 'Monday Route',
    routeGeometry: null,
    routeMapPreview: null,
    routeMetrics: null,
    routeStopPoints: [],
    shopDomain: 'dev1.tomatonofood.com',
    stops: [],
    timezone: 'America/Toronto'
  }
};

type ActiveRoutePlanTestRecord = {
  driverEvents: { id: string; occurredAt: Date }[];
  id: string;
  routeStops: {
    deliveryStop: { id: string; status: string };
    id: string;
    sequence: number;
  }[];
};

type StartedEventRecord = {
  id: string;
  occurredAt: Date;
  routePlan: ActiveRoutePlanTestRecord;
  routePlanId: string;
};

const activeRoutePlan: ActiveRoutePlanTestRecord = {
  driverEvents: [{ id: 'route-started-event-id', occurredAt: startedAt }],
  id: 'route-plan-id',
  routeStops: [
    {
      deliveryStop: { id: 'stop-1', status: 'DELIVERED' },
      id: 'route-stop-1',
      sequence: 1
    },
    {
      deliveryStop: { id: 'stop-2', status: 'ASSIGNED' },
      id: 'route-stop-2',
      sequence: 2
    }
  ]
};

describe('PrismaDriverRouteSessionRepository', () => {
  test('restores an active route session from an IN_PROGRESS route plan', async () => {
    const { assignedRouteService, prisma } = createHarness();
    const repository = new PrismaDriverRouteSessionRepository(prisma as never, assignedRouteService);

    const result = await repository.getActiveRouteSession({
      driverId: 'driver-id',
      shopDomain: 'https://Dev1.TomatonoFood.com/app'
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: { appId_shopDomain: { appId: 'clever', shopDomain: 'dev1.tomatonofood.com' } }
    });
    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        driverId: 'driver-id',
        shopId: 'shop-id',
        status: 'IN_PROGRESS'
      }
    }));
    expect(assignedRouteService.getAssignedRoute).toHaveBeenCalledWith({
      driverId: 'driver-id',
      routeContext: 'route-plan-id',
      shopDomain: 'dev1.tomatonofood.com'
    });
    expect(result).toEqual({
      status: 'ACTIVE_SESSION',
      route: assignedRoute.route,
      session: {
        currentDeliveryStopId: 'stop-2',
        currentRoutePlanStopId: 'route-stop-2',
        lastEventId: 'route-started-event-id',
        lastResumedAt: null,
        navigationStepIndex: 2,
        routePlanId: 'route-plan-id',
        sessionId: null,
        source: 'BEST_EFFORT_ROUTE_STATE',
        startedAt: startedAt.toISOString(),
        status: 'ACTIVE'
      }
    });
  });

  test('falls back to latest ROUTE_STARTED event when route status has not been promoted yet', async () => {
    const { assignedRouteService, prisma } = createHarness({
      inProgressRoute: null,
      startedEvents: [
        {
          id: 'started-event-id',
          occurredAt: startedAt,
          routePlan: {
            ...activeRoutePlan,
            driverEvents: []
          },
          routePlanId: 'route-plan-id'
        }
      ]
    });
    const repository = new PrismaDriverRouteSessionRepository(prisma as never, assignedRouteService);

    const result = await repository.getActiveRouteSession({
      driverId: 'driver-id',
      shopDomain: 'dev1.tomatonofood.com'
    });

    expect(JSON.stringify(prisma.driverEvent.findMany.mock.calls)).toContain('"eventType":"ROUTE_STARTED"');
    expect(JSON.stringify(prisma.driverEvent.findMany.mock.calls)).toContain('"driverId":"driver-id"');
    expect(JSON.stringify(prisma.driverEvent.findMany.mock.calls)).toContain('"shopId":"shop-id"');
    expect(JSON.stringify(prisma.driverEvent.findMany.mock.calls)).toContain('"ASSIGNED"');
    expect(JSON.stringify(prisma.driverEvent.findMany.mock.calls)).toContain('"IN_PROGRESS"');
    expect(JSON.stringify(prisma.driverEvent.findMany.mock.calls)).toContain('"OPTIMIZED"');
    expect(result).toMatchObject({
      status: 'ACTIVE_SESSION',
      session: {
        lastEventId: 'started-event-id',
        navigationStepIndex: 2,
        routePlanId: 'route-plan-id',
        startedAt: startedAt.toISOString()
      }
    });
  });

  test('returns no active session when the started route was later completed', async () => {
    const { assignedRouteService, prisma } = createHarness({
      completionEvent: { id: 'completion-event-id' },
      inProgressRoute: null,
      startedEvents: [
        {
          id: 'started-event-id',
          occurredAt: startedAt,
          routePlan: activeRoutePlan,
          routePlanId: 'route-plan-id'
        }
      ]
    });
    const repository = new PrismaDriverRouteSessionRepository(prisma as never, assignedRouteService);

    await expect(repository.getActiveRouteSession({
      driverId: 'driver-id',
      shopDomain: 'dev1.tomatonofood.com'
    })).resolves.toEqual({ status: 'NO_ACTIVE_SESSION' });
    expect(assignedRouteService.getAssignedRoute).not.toHaveBeenCalled();
  });

  test('keeps pickup as the current step until a terminal stop exists', async () => {
    const { assignedRouteService, prisma } = createHarness({
      inProgressRoute: {
        ...activeRoutePlan,
        routeStops: [
          {
            deliveryStop: { id: 'stop-1', status: 'ASSIGNED' },
            id: 'route-stop-1',
            sequence: 1
          }
        ]
      }
    });
    const repository = new PrismaDriverRouteSessionRepository(prisma as never, assignedRouteService);

    const result = await repository.getActiveRouteSession({
      driverId: 'driver-id',
      shopDomain: 'dev1.tomatonofood.com'
    });

    expect(result).toMatchObject({
      status: 'ACTIVE_SESSION',
      session: {
        currentDeliveryStopId: null,
        currentRoutePlanStopId: null,
        navigationStepIndex: 0
      }
    });
  });

  test('rejects token context outside the driver shop scope', async () => {
    const { assignedRouteService, prisma } = createHarness({ driver: null });
    const repository = new PrismaDriverRouteSessionRepository(prisma as never, assignedRouteService);

    await expect(repository.getActiveRouteSession({
      driverId: 'foreign-driver-id',
      shopDomain: 'dev1.tomatonofood.com'
    })).rejects.toBeInstanceOf(DriverRouteSessionScopeError);
  });
});

function createHarness(input: {
  completionEvent?: { id: string } | null;
  driver?: { id: string } | null;
  inProgressRoute?: ActiveRoutePlanTestRecord | null;
  startedEvents?: StartedEventRecord[];
} = {}) {
  const assignedRouteService = {
    getAssignedRoute: vi.fn(() => Promise.resolve(assignedRoute))
  };
  const prisma = {
    driver: {
      findFirst: vi.fn(() => Promise.resolve(input.driver === undefined ? { id: 'driver-id' } : input.driver))
    },
    driverEvent: {
      findFirst: vi.fn(() => Promise.resolve(input.completionEvent ?? null)),
      findMany: vi.fn(() => Promise.resolve(input.startedEvents ?? []))
    },
    routePlan: {
      findFirst: vi.fn(() => Promise.resolve(input.inProgressRoute === undefined ? activeRoutePlan : input.inProgressRoute))
    },
    shop: {
      findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
    }
  };

  return { assignedRouteService, prisma };
}
