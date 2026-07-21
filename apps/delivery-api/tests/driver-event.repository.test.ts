import { Prisma } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';

import {
  DriverEventContextError,
  DriverEventRouteNotInProgressError,
  DriverEventScopeError,
  PrismaDriverEventRepository
} from '../src/modules/driver/driver-event.repository.js';

const occurredAt = new Date('2026-06-01T05:54:16.000Z');
const serverReceivedAt = new Date('2026-06-01T06:00:00.000Z');

describe('PrismaDriverEventRepository', () => {
  test('records driver events for Woo customer-domain shops', async () => {
    const { prisma } = createPrismaHarness({ routePlan: { id: 'route-plan-id', status: 'IN_PROGRESS' } });
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
      shopDomain: 'https://Dev1.TomatonoFood.com/admin',
      shopId: 'shop-id'
    })).resolves.toEqual({ duplicate: false, eventId: 'driver-event-id' });

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
    expect(prisma.routeTrackingGeometry.upsert).toHaveBeenCalledOnce();
  });

  test('rejects location updates unless the route is in progress before writing the event', async () => {
    const { prisma } = createPrismaHarness({ routePlan: { id: 'route-plan-id', status: 'READY' } });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'LOCATION_UPDATED',
      routePlanId: 'route-plan-id'
    }))).rejects.toBeInstanceOf(DriverEventRouteNotInProgressError);

    expect(prisma.driverEvent.create).not.toHaveBeenCalled();
    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith({
      select: { id: true, status: true },
      where: {
        driverId: 'driver-id',
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        id: 'route-plan-id',
        shopId: 'shop-id',
        status: { in: ['IN_PROGRESS', 'READY', 'DRAFT', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED'] }
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

  test('uses the server receipt time to update future ETAs when STOP_ARRIVED is recorded', async () => {
    const { prisma } = createPrismaHarness({
      routeEtaStops: [
        {
          deliveryStop: { serviceMinutes: 5 },
          deliveryStopId: 'stop-id',
          distanceFromPreviousMeters: 1000,
          durationFromPreviousSeconds: 600,
          estimatedArrivalAt: new Date('2026-06-01T05:50:00.000Z'),
          sequence: 1
        },
        {
          deliveryStop: { serviceMinutes: 5 },
          deliveryStopId: 'stop-2',
          distanceFromPreviousMeters: 2000,
          durationFromPreviousSeconds: 900,
          estimatedArrivalAt: new Date('2026-06-01T06:10:00.000Z'),
          sequence: 2
        }
      ]
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    const result = await repository.recordDriverEvent(baseInput({
      deliveryStopId: 'stop-id',
      eventType: 'STOP_ARRIVED',
      occurredAt: new Date('2026-06-01T05:54:16.000Z'),
      routePlanId: 'route-plan-id'
    }));

    expect(result).toEqual({
      duplicate: false,
      etaUpdate: {
        actualArrivalAt: '2026-06-01T06:00:00.000Z',
        deliveryStopId: 'stop-id',
        delaySeconds: 600,
        previousEstimatedArrivalAt: '2026-06-01T05:50:00.000Z',
        serverReceivedAt: '2026-06-01T06:00:00.000Z',
        trigger: 'STOP_ARRIVED',
        updatedStops: [
          { deliveryStopId: 'stop-2', estimatedArrivalAt: '2026-06-01T06:20:00.000Z', sequence: 2 }
        ]
      },
      eventId: 'driver-event-id'
    });
    expect(prisma.deliveryStop.updateMany).toHaveBeenCalledWith({
      data: { status: 'ARRIVED' },
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
    expect(prisma.routePlanStop.update).toHaveBeenCalledWith({
      data: { estimatedArrivalAt: new Date('2026-06-01T06:20:00.000Z') },
      where: {
        routePlanId_deliveryStopId: {
          deliveryStopId: 'stop-2',
          routePlanId: 'route-plan-id'
        }
      }
    });
  });

  test('reports a stop sequence deviation without rejecting the owned stop event', async () => {
    const { prisma } = createPrismaHarness({
      routeSequenceStops: [
        { deliveryStop: { status: 'ASSIGNED' }, deliveryStopId: 'stop-id', sequence: 1 },
        { deliveryStop: { status: 'ASSIGNED' }, deliveryStopId: 'stop-2', sequence: 2 }
      ],
      routeEtaStops: [
        {
          deliveryStop: { serviceMinutes: 5 },
          deliveryStopId: 'stop-id',
          distanceFromPreviousMeters: 1000,
          durationFromPreviousSeconds: 600,
          estimatedArrivalAt: new Date('2026-06-01T05:50:00.000Z'),
          sequence: 1
        },
        {
          deliveryStop: { serviceMinutes: 5 },
          deliveryStopId: 'stop-2',
          distanceFromPreviousMeters: 2000,
          durationFromPreviousSeconds: 900,
          estimatedArrivalAt: new Date('2026-06-01T06:10:00.000Z'),
          sequence: 2
        }
      ]
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: 'stop-2',
      eventType: 'STOP_ARRIVED',
      routePlanId: 'route-plan-id'
    }))).resolves.toEqual(expect.objectContaining({
      duplicate: false,
      eventId: 'driver-event-id',
      sequenceDeviation: {
        expectedDeliveryStopId: 'stop-id',
        expectedSequence: 1,
        selectedDeliveryStopId: 'stop-2',
        selectedSequence: 2
      }
    }));
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

  test('moves a ready route to in progress when the driver starts it', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverEventRepository(prisma as never);

    await repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_STARTED',
      routePlanId: 'route-plan-id'
    }));

    expect(prisma.routePlan.updateMany).toHaveBeenCalledWith({
      data: { status: 'IN_PROGRESS' },
      where: {
        driverId: 'driver-id',
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        id: 'route-plan-id',
        shopId: 'shop-id',
        status: { in: ['READY', 'DRAFT', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED'] }
      }
    });
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
    expect(prisma.routePlan.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        driverId: 'driver-id',
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        id: 'foreign-route-plan-id',
        shopId: 'shop-id',
        status: { in: ['IN_PROGRESS', 'READY', 'DRAFT', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED'] }
      }
    });
  });

  test('moves the route to completed when the driver completes it', async () => {
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

    expect(prisma.routePlan.updateMany).toHaveBeenCalledWith({
      data: { status: 'COMPLETED' },
      where: {
        driverId: 'driver-id',
        id: 'route-plan-id',
        shopId: 'shop-id',
        status: { not: 'CANCELLED' }
      }
    });
  });

  test('moves an in-progress route back to ready when the driver releases the session', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverEventRepository(prisma as never);

    await repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_PAUSED',
      routePlanId: 'route-plan-id'
    }));

    expect(prisma.routePlan.updateMany).toHaveBeenCalledWith({
      data: { status: 'READY' },
      where: {
        driverId: 'driver-id',
        id: 'route-plan-id',
        shopId: 'shop-id',
        status: 'IN_PROGRESS'
      }
    });
  });

  test('treats explicit driver completion as authoritative even when a stop is not terminal', async () => {
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

    expect(prisma.routePlan.updateMany).toHaveBeenCalledWith({
      data: { status: 'COMPLETED' },
      where: {
        driverId: 'driver-id',
        id: 'route-plan-id',
        shopId: 'shop-id',
        status: { not: 'CANCELLED' }
      }
    });
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

  test('allows an explicitly completed zero-stop child route to complete', async () => {
    const { prisma } = createPrismaHarness({ routeStops: [] });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_COMPLETED',
      routePlanId: 'route-plan-id'
    }))).resolves.toEqual({ duplicate: false, eventId: 'driver-event-id' });

    expect(prisma.driverEvent.create).toHaveBeenCalledOnce();
    expect(prisma.routePlan.updateMany).toHaveBeenCalledWith({
      data: { status: 'COMPLETED' },
      where: {
        driverId: 'driver-id',
        id: 'route-plan-id',
        shopId: 'shop-id',
        status: { not: 'CANCELLED' }
      }
    });
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

  test('acknowledges a recorded completion retry before completed-route validation', async () => {
    const { prisma } = createPrismaHarness({
      existingEvent: {
        eventType: 'ROUTE_COMPLETED',
        id: 'recorded-completion-id',
        routePlanId: 'route-plan-id'
      },
      routePlan: null
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      clientEventId: 'route-completed-client-id',
      deliveryStopId: null,
      eventType: 'ROUTE_COMPLETED',
      routePlanId: 'route-plan-id'
    }))).resolves.toEqual({ duplicate: true, eventId: 'recorded-completion-id' });

    expect(prisma.driverEvent.findUnique).toHaveBeenCalledWith({
      select: { eventType: true, id: true, routePlanId: true },
      where: {
        driverId_clientEventId: {
          clientEventId: 'route-completed-client-id',
          driverId: 'driver-id'
        }
      }
    });
    expect(prisma.driverEvent.create).not.toHaveBeenCalled();
    expect(prisma.routePlan.findFirst).not.toHaveBeenCalled();
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
    shopId: 'shop-id',
    ...overrides
  };
}

function createPrismaHarness(input: {
  completionEvent?: { id: string } | null;
  driverEventCreateError?: Error;
  existingEvent?: { eventType: string; id: string; routePlanId: string | null } | null;
  routePlan?: { id: string; status?: string } | null;
  routePlanStop?: { id: string } | null;
  routeEtaStops?: Array<{
    deliveryStop: { serviceMinutes: number | null };
    deliveryStopId: string;
    distanceFromPreviousMeters: number | null;
    durationFromPreviousSeconds: number | null;
    estimatedArrivalAt: Date | null;
    sequence: number;
  }>;
  routeSequenceStops?: Array<{
    deliveryStop: { status: string };
    deliveryStopId: string;
    sequence: number;
  }>;
  routeStops?: { deliveryStop: { status: string } }[];
} = {}) {
  let createdEventType: string | null = null;
  const createDriverEvent = vi.fn((args: { data: { eventType: string } }) => {
    if (input.driverEventCreateError !== undefined) {
      throw input.driverEventCreateError;
    }
    createdEventType = args.data.eventType;
    return Promise.resolve({ createdAt: serverReceivedAt, id: 'driver-event-id' });
  });
  const prisma: {
    $queryRaw: ReturnType<typeof vi.fn>;
    $transaction: ReturnType<typeof vi.fn>;
    deliveryStop: { updateMany: ReturnType<typeof vi.fn> };
    driver: { findUnique: ReturnType<typeof vi.fn> };
    driverEvent: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
    routePlan: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    routePlanGeometryCache: { findFirst: ReturnType<typeof vi.fn> };
    routePlanStop: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    routeTrackingGeometry: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
    shop: { findUnique: ReturnType<typeof vi.fn> };
  } = {} as never;
  Object.assign(prisma, {
    $queryRaw: vi.fn(() => Promise.resolve([])),
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
      )),
      findUnique: vi.fn(() => Promise.resolve(input.existingEvent ?? null))
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
    routePlanGeometryCache: {
      findFirst: vi.fn(() => Promise.resolve(null))
    },
    routePlanStop: {
      findFirst: vi.fn(() => Promise.resolve(input.routePlanStop === undefined ? { id: 'route-plan-stop-id' } : input.routePlanStop)),
      findMany: vi.fn((args: { select?: { deliveryStop?: { select?: { status?: boolean } } } }) => (
        args.select?.deliveryStop?.select?.status === true
          ? Promise.resolve(input.routeSequenceStops ?? [
              { deliveryStop: { status: 'ASSIGNED' }, deliveryStopId: 'stop-id', sequence: 1 }
            ])
          : Promise.resolve(input.routeEtaStops ?? [
              {
                deliveryStop: { serviceMinutes: 5 },
                deliveryStopId: 'stop-id',
                distanceFromPreviousMeters: 1000,
                durationFromPreviousSeconds: 600,
                estimatedArrivalAt: null,
                sequence: 1
              }
            ])
      )),
      update: vi.fn(() => Promise.resolve({ id: 'route-plan-stop-id' }))
    },
    routeTrackingGeometry: {
      findUnique: vi.fn(() => Promise.resolve(null)),
      upsert: vi.fn(() => Promise.resolve({ id: 'route-tracking-geometry-id' }))
    },
    shop: {
      findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
    }
  });

  return { prisma };
}
