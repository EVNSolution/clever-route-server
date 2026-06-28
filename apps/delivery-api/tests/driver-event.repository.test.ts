import { Prisma } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';

import {
  DriverEventContextError,
  DriverEventScopeError,
  PrismaDriverEventRepository
} from '../src/modules/driver/driver-event.repository.js';

const occurredAt = new Date('2026-06-01T05:54:16.000Z');

describe('PrismaDriverEventRepository', () => {
  test('records driver events for Woo customer-domain shops', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent({
      clientEventId: 'client-event-id',
      deliveryStopId: 'stop-id',
      driverId: 'driver-id',
      eventType: 'LOCATION_UPDATED',
      latitude: '43.6532',
      longitude: '-79.3832',
      occurredAt,
      payload: { source: 'driver-app' },
      routePlanId: 'route-plan-id',
      shopDomain: 'https://Dev1.TomatonoFood.com/admin'
    })).resolves.toEqual({ duplicate: false, eventId: 'driver-event-id' });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { appId_shopDomain: { appId: 'clever', shopDomain: 'dev1.tomatonofood.com' } } });
    expect(prisma.driverEvent.create).toHaveBeenCalledWith({
      data: {
        clientEventId: 'client-event-id',
        deliveryStopId: 'stop-id',
        driverId: 'driver-id',
        eventType: 'LOCATION_UPDATED',
        latitude: '43.6532',
        longitude: '-79.3832',
        occurredAt,
        payload: { source: 'driver-app' },
        routePlanId: 'route-plan-id',
        shopId: 'shop-id'
      }
    });
  });

  test('updates the matching stop when STOP_DELIVERED is recorded', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: 'stop-id',
      eventType: 'STOP_DELIVERED',
      routePlanId: 'route-plan-id'
    }))).resolves.toEqual({ duplicate: false, eventId: 'driver-event-id' });

    expect(prisma.driverEvent.create).toHaveBeenCalledOnce();
    expect(prisma.deliveryStop.updateMany).toHaveBeenCalledWith({
      data: { status: 'DELIVERED' },
      where: {
        id: 'stop-id',
        routePlanStops: {
          some: {
            routePlan: {
              driverId: 'driver-id',
              id: 'route-plan-id',
              shopId: 'shop-id'
            },
            routePlanId: 'route-plan-id'
          }
        },
        shopId: 'shop-id'
      }
    });
    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('updates the matching stop when STOP_FAILED is recorded', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverEventRepository(prisma as never);

    await repository.recordDriverEvent(baseInput({
      deliveryStopId: 'stop-id',
      eventType: 'STOP_FAILED',
      routePlanId: 'route-plan-id'
    }));

    expect(prisma.deliveryStop.updateMany).toHaveBeenCalledWith({
      data: { status: 'FAILED' },
      where: {
        id: 'stop-id',
        routePlanStops: {
          some: {
            routePlan: {
              driverId: 'driver-id',
              id: 'route-plan-id',
              shopId: 'shop-id'
            },
            routePlanId: 'route-plan-id'
          }
        },
        shopId: 'shop-id'
      }
    });
    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('rejects terminal stop events without route and stop context before writing the event', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'STOP_DELIVERED',
      routePlanId: null
    }))).rejects.toBeInstanceOf(DriverEventContextError);

    expect(prisma.driverEvent.create).not.toHaveBeenCalled();
    expect(prisma.deliveryStop.updateMany).not.toHaveBeenCalled();
    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('rejects terminal stop events outside the authenticated route/stop scope', async () => {
    const { prisma } = createPrismaHarness({ routePlanStop: null });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: 'foreign-stop-id',
      eventType: 'STOP_DELIVERED',
      routePlanId: 'route-plan-id'
    }))).rejects.toBeInstanceOf(DriverEventScopeError);

    expect(prisma.driverEvent.create).not.toHaveBeenCalled();
    expect(prisma.deliveryStop.updateMany).not.toHaveBeenCalled();
  });

  test('records route start without changing persisted route lifecycle', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverEventRepository(prisma as never);

    await repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_STARTED',
      routePlanId: 'route-plan-id'
    }));

    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('rejects route start events outside the authenticated route scope before writing', async () => {
    const { prisma } = createPrismaHarness({ routePlan: null });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_STARTED',
      routePlanId: 'foreign-route-plan-id'
    }))).rejects.toBeInstanceOf(DriverEventScopeError);

    expect(prisma.driverEvent.create).not.toHaveBeenCalled();
    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('records route completion without changing persisted route lifecycle', async () => {
    const { prisma } = createPrismaHarness({
      routeStops: [
        { deliveryStop: { status: 'DELIVERED' } },
        { deliveryStop: { status: 'FAILED' } }
      ]
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_COMPLETED',
      routePlanId: 'route-plan-id'
    }));

    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('does not complete a route when ROUTE_COMPLETED arrives before all stops are terminal', async () => {
    const { prisma } = createPrismaHarness({
      routeStops: [
        { deliveryStop: { status: 'DELIVERED' } },
        { deliveryStop: { status: 'ASSIGNED' } }
      ]
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_COMPLETED',
      routePlanId: 'route-plan-id'
    }));

    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('keeps route lifecycle unchanged when final terminal stop arrives after route completion event', async () => {
    const { prisma } = createPrismaHarness({
      completionEvent: { id: 'route-completed-event-id' },
      routeStops: [
        { deliveryStop: { status: 'DELIVERED' } },
        { deliveryStop: { status: 'FAILED' } }
      ]
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await repository.recordDriverEvent(baseInput({
      deliveryStopId: 'stop-id',
      eventType: 'STOP_FAILED',
      routePlanId: 'route-plan-id'
    }));

    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('records zero-stop ROUTE_COMPLETED events without marking the route completed', async () => {
    const { prisma } = createPrismaHarness({ routeStops: [] });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_COMPLETED',
      routePlanId: 'route-plan-id'
    }))).resolves.toEqual({ duplicate: false, eventId: 'driver-event-id' });

    expect(prisma.driverEvent.create).toHaveBeenCalledOnce();
    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('acknowledges duplicate client events without repeating state transitions', async () => {
    const { prisma } = createPrismaHarness({
      driverEventCreateError: new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        clientVersion: 'test',
        code: 'P2002'
      })
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      clientEventId: 'already-seen-client-id',
      deliveryStopId: 'stop-id',
      eventType: 'STOP_DELIVERED',
      routePlanId: 'route-plan-id'
    }))).resolves.toEqual({ duplicate: true, eventId: 'already-seen-client-id' });

    expect(prisma.deliveryStop.updateMany).not.toHaveBeenCalled();
    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });
});

function baseInput(overrides: Partial<Parameters<PrismaDriverEventRepository['recordDriverEvent']>[0]> = {}) {
  return {
    clientEventId: 'client-event-id',
    deliveryStopId: 'stop-id',
    driverId: 'driver-id',
    eventType: 'LOCATION_UPDATED',
    latitude: '43.6532',
    longitude: '-79.3832',
    occurredAt,
    payload: { source: 'driver-app' },
    routePlanId: 'route-plan-id',
    shopDomain: 'dev1.tomatonofood.com',
    ...overrides
  };
}

function createPrismaHarness(input: {
  completionEvent?: { id: string } | null;
  driverEventCreateError?: Error;
  routePlan?: { id: string } | null;
  routePlanStop?: { id: string } | null;
  routeStops?: { deliveryStop: { status: string } }[];
} = {}) {
  let createdEventType: string | null = null;
  const createDriverEvent = vi.fn((args: { data: { eventType: string } }) => {
    if (input.driverEventCreateError !== undefined) {
      throw input.driverEventCreateError;
    }
    createdEventType = args.data.eventType;
    return Promise.resolve({ id: 'driver-event-id' });
  });
  const prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    deliveryStop: { updateMany: ReturnType<typeof vi.fn> };
    driver: { findUnique: ReturnType<typeof vi.fn> };
    driverEvent: { create: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    routePlan: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    routePlanStop: { findFirst: ReturnType<typeof vi.fn> };
    shop: { findUnique: ReturnType<typeof vi.fn> };
  } = {} as never;
  Object.assign(prisma, {
    $transaction: vi.fn((callback: (transaction: unknown) => unknown) => Promise.resolve(callback(prisma))),
    deliveryStop: {
      updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
    },
    driver: {
      findUnique: vi.fn(() => Promise.resolve({ id: 'driver-id', shopId: 'shop-id' }))
    },
    driverEvent: {
      create: createDriverEvent,
      findFirst: vi.fn(() => Promise.resolve(
        input.completionEvent ?? (createdEventType === 'ROUTE_COMPLETED' ? { id: 'driver-event-id' } : null)
      ))
    },
    routePlan: {
      findFirst: vi.fn((args: { select?: { routeStops?: unknown } }) => {
        const routePlan = input.routePlan === undefined ? { id: 'route-plan-id' } : input.routePlan;
        if (routePlan === null) {
          return Promise.resolve(null);
        }
        if (args.select?.routeStops !== undefined) {
          return Promise.resolve({
            id: routePlan.id,
            routeStops: input.routeStops ?? [{ deliveryStop: { status: 'DELIVERED' } }]
          });
        }

        return Promise.resolve(routePlan);
      }),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
    },
    routePlanStop: {
      findFirst: vi.fn(() => Promise.resolve(input.routePlanStop === undefined ? { id: 'route-plan-stop-id' } : input.routePlanStop))
    },
    shop: {
      findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
    }
  });

  return { prisma };
}
