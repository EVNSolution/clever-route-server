import { Prisma } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';

import {
  DriverEventContextError,
  DriverEventEtaStaleConflictError,
  DriverEventExecutionConflictError,
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

  test('rejects stop execution events unless the route is in progress', async () => {
    const { prisma } = createPrismaHarness({ routePlan: { id: 'route-plan-id', status: 'READY' } });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: 'stop-id',
      eventType: 'STOP_DELIVERED',
      routePlanId: 'route-plan-id'
    }))).rejects.toBeInstanceOf(DriverEventRouteNotInProgressError);

    expect(prisma.driverEvent.create).not.toHaveBeenCalled();
    expect(prisma.deliveryStop.updateMany).not.toHaveBeenCalled();
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
        etaCalculatedAt: '2026-06-01T06:00:00.000Z',
        etaFailureCode: null,
        etaFailureMessage: null,
        etaSource: 'STOP_ARRIVED',
        etaStatus: 'READY',
        inputRouteVersionId: null,
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

  test('persists ETA status and input route version when ETA ownership columns exist', async () => {
    const { prisma } = createPrismaHarness({
      etaOwnershipColumnsExist: true,
      routeEtaInputVersionId: '11111111-1111-4111-8111-111111111111',
      routeEtaStops: [
        {
          deliveryStop: { serviceMinutes: 5 },
          deliveryStopId: '22222222-2222-4222-8222-222222222222',
          distanceFromPreviousMeters: 1000,
          durationFromPreviousSeconds: 600,
          estimatedArrivalAt: null,
          sequence: 1
        }
      ]
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    const result = await repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_STARTED',
      routePlanId: '33333333-3333-4333-8333-333333333333'
    }));

    expect(result.etaUpdate).toEqual(expect.objectContaining({
      etaCalculatedAt: '2026-06-01T06:00:00.000Z',
      etaFailureCode: null,
      etaFailureMessage: null,
      etaSource: 'ROUTE_STARTED',
      etaStatus: 'READY',
      inputRouteVersionId: '11111111-1111-4111-8111-111111111111',
      trigger: 'ROUTE_STARTED'
    }));
    const etaPersistenceQueries = prisma.$queryRaw.mock.calls.filter(([query]) =>
      sqlText(query).includes('UPDATE route_plan_stops')
    );
    expect(etaPersistenceQueries).toHaveLength(1);
    expect(sqlText(etaPersistenceQueries[0]?.[0])).toContain('"etaStatus"');
    expect(sqlText(etaPersistenceQueries[0]?.[0])).toContain('"etaInputRouteVersionId"');
    expect(sqlText(etaPersistenceQueries[0]?.[0])).toContain('"etaSource"');
    expect(sqlText(etaPersistenceQueries[0]?.[0])).toContain('"shopId"');
    expect(sqlText(etaPersistenceQueries[0]?.[0])).toContain('current_route_version.status = \'CURRENT\'');
    expect(sqlText(etaPersistenceQueries[0]?.[0])).toContain('"etaInputRouteVersionId" IS NULL');
    expect(prisma.routePlanStop.update).not.toHaveBeenCalled();
  });

  test('persists the current route version on driver events when the optional column exists', async () => {
    const { prisma } = createPrismaHarness({
      driverEventRouteVersionColumnExists: true,
      routeEtaInputVersionId: '11111111-1111-4111-8111-111111111111'
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_PAUSED',
      routePlanId: '33333333-3333-4333-8333-333333333333'
    }));

    const createArgs = prisma.driverEvent.create.mock.calls[0]?.[0] as {
      data: { routePlanId: string | null; routeVersionId?: string | null; shopId: string };
    } | undefined;
    expect(createArgs?.data).toMatchObject({
      routePlanId: '33333333-3333-4333-8333-333333333333',
      routeVersionId: '11111111-1111-4111-8111-111111111111',
      shopId: 'shop-id'
    });
  });

  test('treats null-owner ETA writes as stale when the current version changes after calculation', async () => {
    const { prisma } = createPrismaHarness({
      etaOwnershipColumnsExist: true,
      routeEtaInputVersionId: '11111111-1111-4111-8111-111111111111',
      routeEtaPersistenceRows: [],
      routeEtaStops: [
        {
          deliveryStop: { serviceMinutes: 5 },
          deliveryStopId: '22222222-2222-4222-8222-222222222222',
          distanceFromPreviousMeters: 1000,
          durationFromPreviousSeconds: 600,
          estimatedArrivalAt: null,
          sequence: 1
        }
      ]
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_STARTED',
      routePlanId: '33333333-3333-4333-8333-333333333333'
    }))).rejects.toBeInstanceOf(DriverEventEtaStaleConflictError);

    expect(prisma.$queryRaw.mock.calls.some(([query]) => sqlText(query).includes('UPDATE route_plan_stops'))).toBe(true);
    expect(prisma.routePlanStop.update).not.toHaveBeenCalled();
  });

  test('persists ETAs for legacy routes without a route grouping child version', async () => {
    const { prisma } = createPrismaHarness({
      etaOwnershipColumnsExist: true,
      routeEtaInputVersionId: null,
      routeEtaStops: [
        {
          deliveryStop: { serviceMinutes: 5 },
          deliveryStopId: '22222222-2222-4222-8222-222222222222',
          distanceFromPreviousMeters: 1000,
          durationFromPreviousSeconds: 600,
          estimatedArrivalAt: null,
          sequence: 1
        }
      ]
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    const result = await repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_STARTED',
      routePlanId: '33333333-3333-4333-8333-333333333333'
    }));

    expect(result.duplicate).toBe(false);
    expect(result.eventId).toBe('driver-event-id');
    expect(result.etaUpdate?.inputRouteVersionId).toBeNull();
    expect(result.etaUpdate?.trigger).toBe('ROUTE_STARTED');

    const etaPersistenceQueries = prisma.$queryRaw.mock.calls.filter(([query]) =>
      sqlText(query).includes('UPDATE route_plan_stops')
    );
    expect(etaPersistenceQueries).toHaveLength(1);
    const queryText = sqlText(etaPersistenceQueries[0]?.[0]);
    expect(queryText).toContain('"etaInputRouteVersionId" = NULL');
    expect(queryText).toContain('"etaInputRouteVersionId" IS NULL');
    expect(queryText).toContain('NOT EXISTS');
    expect(queryText).toContain('FROM route_grouping_child_versions');
    expect(queryText).not.toContain('current_route_version.id =');
    expect(prisma.routePlanStop.update).not.toHaveBeenCalled();
  });

  test('treats legacy ETA writes as stale when a route version appears before persistence', async () => {
    const { prisma } = createPrismaHarness({
      etaOwnershipColumnsExist: true,
      routeEtaInputVersionId: null,
      routeEtaPersistenceRows: [],
      routeEtaStops: [
        {
          deliveryStop: { serviceMinutes: 5 },
          deliveryStopId: '22222222-2222-4222-8222-222222222222',
          distanceFromPreviousMeters: 1000,
          durationFromPreviousSeconds: 600,
          estimatedArrivalAt: null,
          sequence: 1
        }
      ]
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_STARTED',
      routePlanId: '33333333-3333-4333-8333-333333333333'
    }))).rejects.toBeInstanceOf(DriverEventEtaStaleConflictError);

    const etaPersistenceQueries = prisma.$queryRaw.mock.calls.filter(([query]) =>
      sqlText(query).includes('UPDATE route_plan_stops')
    );
    expect(etaPersistenceQueries).toHaveLength(1);
    expect(sqlText(etaPersistenceQueries[0]?.[0])).toContain('NOT EXISTS');
    expect(prisma.routePlanStop.update).not.toHaveBeenCalled();
  });

  test('records FAILED ETA state with null estimates when route leg durations are unavailable', async () => {
    const { prisma } = createPrismaHarness({
      etaOwnershipColumnsExist: true,
      routeEtaInputVersionId: '11111111-1111-4111-8111-111111111111',
      routeEtaStops: [
        {
          deliveryStop: { serviceMinutes: 5 },
          deliveryStopId: '22222222-2222-4222-8222-222222222222',
          distanceFromPreviousMeters: null,
          durationFromPreviousSeconds: null,
          estimatedArrivalAt: null,
          sequence: 1
        }
      ]
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    const result = await repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_STARTED',
      routePlanId: '33333333-3333-4333-8333-333333333333'
    }));

    expect(result.etaUpdate).toEqual(expect.objectContaining({
      etaFailureCode: 'ETA_INPUT_DURATION_UNAVAILABLE',
      etaFailureMessage: 'ETA could not be calculated because route leg durations are unavailable.',
      etaSource: 'ROUTE_STARTED',
      etaStatus: 'FAILED',
      updatedStops: [
        {
          deliveryStopId: '22222222-2222-4222-8222-222222222222',
          estimatedArrivalAt: null,
          sequence: 1
        }
      ]
    }));
    expect(prisma.$queryRaw.mock.calls.some(([query]) =>
      sqlText(query).includes('"etaStatus" = ') && sqlText(query).includes('"etaFailureCode"')
    )).toBe(true);
    expect(prisma.driverEvent.create).toHaveBeenCalledOnce();
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

  test('rejects route start when another in-progress route owns an overlapping stop', async () => {
    const { prisma } = createPrismaHarness({
      conflictingRoutePlanStop: { deliveryStopId: 'stop-id', routePlanId: 'other-route-plan-id' }
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      deliveryStopId: null,
      eventType: 'ROUTE_STARTED',
      routePlanId: 'route-plan-id'
    }))).rejects.toBeInstanceOf(DriverEventExecutionConflictError);

    const routeExecutionLockQueries = prisma.$queryRaw.mock.calls.filter(([query]) =>
      sqlText(query).includes('pg_advisory_xact_lock')
    );
    expect(routeExecutionLockQueries).toHaveLength(1);
    expect(prisma.driverEvent.create).not.toHaveBeenCalled();
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

  test('acknowledges matching duplicate client events after a unique constraint race', async () => {
    const { prisma } = createPrismaHarness({
      existingEvent: {
        deliveryStopId: 'stop-id',
        eventType: 'STOP_DELIVERED',
        id: 'recorded-stop-delivered-id',
        routePlanId: 'route-plan-id'
      },
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
    }))).resolves.toEqual({ duplicate: true, eventId: 'recorded-stop-delivered-id' });

    expect(prisma.deliveryStop.updateMany).not.toHaveBeenCalled();
    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('rejects conflicting client events after a unique constraint race', async () => {
    const { prisma } = createPrismaHarness({
      existingEvent: {
        deliveryStopId: 'other-stop-id',
        eventType: 'STOP_DELIVERED',
        id: 'conflicting-event-id',
        routePlanId: 'route-plan-id'
      },
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
    }))).rejects.toBeInstanceOf(DriverEventContextError);

    expect(prisma.deliveryStop.updateMany).not.toHaveBeenCalled();
    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('resolves and memoizes schema capability checks before entering transactions', async () => {
    const { operations, prisma } = createPrismaHarness({ driverEventRouteVersionColumnExists: true });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await repository.recordDriverEvent(baseInput({
      clientEventId: 'gps-client-event-id-1',
      deliveryStopId: null,
      eventType: 'LOCATION_UPDATED',
      routePlanId: 'route-plan-id'
    }));
    await repository.recordDriverEvent(baseInput({
      clientEventId: 'gps-client-event-id-2',
      deliveryStopId: null,
      eventType: 'LOCATION_UPDATED',
      routePlanId: 'route-plan-id'
    }));

    const driverEventColumnChecks = prisma.$queryRaw.mock.calls.filter(([query]) => {
      const text = sqlText(query);
      return text.includes('information_schema.columns') && text.includes("table_name = 'driver_events'");
    });
    expect(driverEventColumnChecks).toHaveLength(1);
    expect(operations.indexOf('schema:driver_events')).toBeLessThan(operations.indexOf('transaction'));
    expect(operations.indexOf('schema:route_plan_stops')).toBeLessThan(operations.indexOf('transaction'));
  });

  test('retries schema capability checks after a rejected probe', async () => {
    const { prisma } = createPrismaHarness({
      driverEventRouteVersionColumnExists: true,
      schemaCapabilityFailures: 1
    });
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent(baseInput({
      clientEventId: 'gps-client-event-id-1',
      deliveryStopId: null,
      eventType: 'LOCATION_UPDATED',
      routePlanId: 'route-plan-id'
    }))).rejects.toThrow('schema capability probe failed');
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await expect(repository.recordDriverEvent(baseInput({
      clientEventId: 'gps-client-event-id-2',
      deliveryStopId: null,
      eventType: 'LOCATION_UPDATED',
      routePlanId: 'route-plan-id'
    }))).resolves.toEqual({ duplicate: false, eventId: 'driver-event-id' });

    const driverEventColumnChecks = prisma.$queryRaw.mock.calls.filter(([query]) => {
      const text = sqlText(query);
      return text.includes('information_schema.columns') && text.includes("table_name = 'driver_events'");
    });
    expect(driverEventColumnChecks).toHaveLength(2);
  });

  test('acknowledges a recorded completion retry before completed-route validation', async () => {
    const { prisma } = createPrismaHarness({
      existingEvent: {
        deliveryStopId: null,
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
      select: { deliveryStopId: true, eventType: true, id: true, routePlanId: true },
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
  conflictingRoutePlanStop?: { deliveryStopId: string; routePlanId: string } | null;
  completionEvent?: { id: string } | null;
  driverEventCreateError?: Error;
  driverEventRouteVersionColumnExists?: boolean;
  etaOwnershipColumnsExist?: boolean;
  existingEvent?: { deliveryStopId: string | null; eventType: string; id: string; routePlanId: string | null } | null;
  routePlan?: { id: string; status?: string } | null;
  routeEtaInputVersionId?: string | null;
  routeEtaPersistenceRows?: Array<{ id: string }>;
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
  schemaCapabilityFailures?: number;
} = {}) {
  let createdEventType: string | null = null;
  let schemaCapabilityFailuresRemaining = input.schemaCapabilityFailures ?? 0;
  const operations: string[] = [];
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
    $queryRaw: vi.fn((query: unknown) => {
      const text = sqlText(query);
      if (text.includes('information_schema.columns')) {
        operations.push(text.includes("table_name = 'driver_events'")
          ? 'schema:driver_events'
          : 'schema:route_plan_stops');
        if (schemaCapabilityFailuresRemaining > 0) {
          schemaCapabilityFailuresRemaining -= 1;
          return Promise.reject(new Error('schema capability probe failed'));
        }
        if (text.includes("table_name = 'driver_events'")) {
          return Promise.resolve(input.driverEventRouteVersionColumnExists === true
            ? [{ column_name: 'routeVersionId' }]
            : []);
        }
        return Promise.resolve(input.etaOwnershipColumnsExist === true
          ? [
              { column_name: 'etaStatus' },
              { column_name: 'etaInputRouteVersionId' },
              { column_name: 'etaSource' },
              { column_name: 'etaCalculatedAt' },
              { column_name: 'etaFailureCode' },
              { column_name: 'etaFailureMessage' }
            ]
          : []);
      }
      if (text.includes('UPDATE route_plan_stops')) {
        return Promise.resolve(input.routeEtaPersistenceRows ?? [{ id: 'route-plan-stop-id' }]);
      }
      if (text.includes('FROM route_grouping_child_versions')) {
        return Promise.resolve(input.routeEtaInputVersionId === undefined || input.routeEtaInputVersionId === null
          ? []
          : [{ id: input.routeEtaInputVersionId }]);
      }
      return Promise.resolve([]);
    }),
    $transaction: vi.fn((callback: (transaction: unknown) => unknown) => {
      operations.push('transaction');
      return Promise.resolve(callback(prisma));
    }),
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
        const routePlan = input.routePlan === undefined ? { id: 'route-plan-id', status: 'IN_PROGRESS' } : input.routePlan;
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
      findFirst: vi.fn((args: { where?: { routePlan?: { status?: string } } }) => Promise.resolve(
        args.where?.routePlan?.status === 'IN_PROGRESS'
          ? input.conflictingRoutePlanStop ?? null
          : input.routePlanStop === undefined ? { id: 'route-plan-stop-id' } : input.routePlanStop
      )),
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

  return { operations, prisma };
}

function sqlText(query: unknown): string {
  const sql = query as { sql?: string; strings?: string[] };
  return sql.sql ?? sql.strings?.join('') ?? String(query);
}
