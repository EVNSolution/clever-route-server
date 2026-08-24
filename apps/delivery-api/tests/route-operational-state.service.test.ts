import { describe, expect, test, vi } from 'vitest';
import { PrismaRouteOperationalStateService } from '../src/modules/route-tracking/route-operational-state.service.js';

describe('route operational state', () => {
  test('computes Kitchener proximity from the persisted location and active stops', async () => {
    const state = await createState({ accuracyMeters: 12, receivedAt: '2026-08-24T07:59:30.000Z' });
    expect(state?.physicalPosition).toEqual(expect.objectContaining({
      accuracyMeters: 12, freshness: 'FRESH', nearestStopSequence: 11, proximityThresholdMeters: 75,
      reliableForProximity: true, withinProximityThreshold: true
    }));
    expect(state?.physicalPosition?.distanceMeters).toBeGreaterThan(0);
    expect(state?.physicalPosition?.distanceMeters).toBeLessThan(20);
  });

  test('does not claim proximity for stale geometry', async () => {
    const state = await createState({
      accuracyMeters: 10,
      occurredAt: '2026-08-24T07:50:00.000Z',
      receivedAt: '2026-08-24T07:59:59.000Z'
    });
    expect(state?.physicalPosition).toEqual(expect.objectContaining({
      accuracyMeters: 10, freshness: 'STALE', reliableForProximity: false, withinProximityThreshold: null
    }));
  });

  test.each([
    ['2026-08-24T07:58:00.000Z', 'FRESH'],
    ['2026-08-24T07:55:00.000Z', 'AGING'],
    ['2026-08-24T07:54:59.999Z', 'STALE'],
    ['2026-08-24T08:00:00.001Z', 'UNKNOWN']
  ] as const)('uses captured-at freshness at the exact boundary: %s => %s', async (occurredAt, freshness) => {
    const state = await createState({ accuracyMeters: 10, occurredAt, receivedAt: '2026-08-24T08:00:00.000Z' });
    expect(state?.physicalPosition?.freshness).toBe(freshness);
    expect(state?.physicalPosition?.reliableForProximity).toBe(freshness === 'FRESH' || freshness === 'AGING');
    expect(state?.physicalPosition?.withinProximityThreshold).toBe(freshness === 'FRESH' || freshness === 'AGING' ? true : null);
  });

  test('reports measured low accuracy but suppresses the proximity conclusion', async () => {
    const state = await createState({ accuracyMeters: 150, receivedAt: '2026-08-24T07:59:30.000Z' });
    expect(state?.physicalPosition).toEqual(expect.objectContaining({
      accuracyMeters: 150, nearestStopSequence: 11, reliableForProximity: false, withinProximityThreshold: null
    }));
  });

  test('projects device progress only from the active lease while sync health carries conflict severity', async () => {
    const now = new Date('2026-08-24T08:00:00.000Z');
    const prisma = { driverEvent: { findMany: vi.fn().mockResolvedValue([]) }, routePlan: { findMany: vi.fn().mockResolvedValue([{
      constraints: {}, driverId: 'driver-id', id: 'route-id', shopId: 'shop-id', status: 'IN_PROGRESS', trackingGeometry: null,
      driverRouteSessionLeases: [{ syncSession: { heartbeats: [{ completedStopCount: 10, currentStopSequence: 11, locallyFinished: false, totalStopCount: 20 }] } }],
      routeStops: []
    }]) } };
    const syncHealth = { state: 'BLOCKED' };
    const state = await new PrismaRouteOperationalStateService(
      prisma as never,
      { getActiveSyncHealthForRoutePlans: vi.fn().mockResolvedValue(new Map([['route-id', syncHealth]])) } as never,
      { listActiveForRoutePlans: vi.fn().mockResolvedValue(new Map([['route-id', [{ severity: 'WARNING', openedAt: '2026-08-24T07:00:00.000Z' }, { severity: 'CRITICAL', openedAt: '2026-08-24T07:30:00.000Z' }]]])) } as never,
      () => now
    ).get('route-id');
    expect(state?.deviceProgress).toMatchObject({ completedStopCount: 10, currentStopSequence: 11 });
    expect(state?.syncHealth).toBe(syncHealth);
  });

  test('batches Kitchener, unknown evidence, and completed unresolved routes with bounded reads', async () => {
    const now = new Date('2026-08-24T08:00:00.000Z');
    const routePlanFindMany = vi.fn().mockResolvedValue([
      routeRecord({
        driverRouteSessionLeases: [{ syncSession: { heartbeats: [{ completedStopCount: 10, currentStopSequence: 11, locallyFinished: false, totalStopCount: 20 }] } }],
        id: 'kitchener',
        routeStops: [
          stop(1, 'DELIVERED'),
          stop(11, 'PENDING', 43.4517, -80.4926)
        ],
        trackingGeometry: geometry('event-kitchener', '2026-08-24T07:59:30.000Z')
      }),
      routeRecord({
        id: 'unknown',
        routeStops: [stop(11, 'PENDING', 43.4517, -80.4926)],
        trackingGeometry: geometry('event-unknown', '2026-08-24T07:50:00.000Z')
      }),
      routeRecord({ id: 'completed', routeStops: [stop(1, 'DELIVERED'), stop(2, 'PENDING')], status: 'COMPLETED' })
    ]);
    const driverEventFindMany = vi.fn().mockResolvedValue([
      { id: 'event-kitchener', payload: { accuracyMeters: 9 } },
      { id: 'event-unknown', payload: { accuracyMeters: 150 } }
    ]);
    const listActiveForRoutePlans = vi.fn().mockResolvedValue(new Map([
      ['completed', [{ acknowledgedAt: null, id: 'alert-id', lastObservedAt: now.toISOString(), openedAt: now.toISOString(), resolvedAt: null, routePlanId: 'completed', severity: 'CRITICAL', type: 'ROUTE_COMPLETION_INCOMPLETE' }]]
    ]));
    const getActiveSyncHealthForRoutePlans = vi.fn().mockResolvedValue(new Map([
      ['kitchener', { state: 'BLOCKED' }]
    ]));
    const states = await new PrismaRouteOperationalStateService(
      { driverEvent: { findMany: driverEventFindMany }, routePlan: { findMany: routePlanFindMany } } as never,
      { getActiveSyncHealthForRoutePlans } as never,
      { listActiveForRoutePlans } as never,
      () => now
    ).getMany(['kitchener', 'unknown', 'completed']);

    expect(states.get('kitchener')).toMatchObject({
      deviceProgress: { currentStopSequence: 11 },
      physicalPosition: { nearestStopSequence: 11, reliableForProximity: true, withinProximityThreshold: true },
      serverProgress: { resolvedStopCount: 1 },
      syncHealth: { state: 'BLOCKED' }
    });
    expect(states.get('unknown')).toMatchObject({
      deviceProgress: null,
      physicalPosition: { freshness: 'STALE', reliableForProximity: false, withinProximityThreshold: null },
      syncHealth: null
    });
    expect(states.get('completed')).toMatchObject({
      activeAlerts: [{ type: 'ROUTE_COMPLETION_INCOMPLETE' }],
      routeStatus: 'COMPLETED',
      serverProgress: { resolvedStopCount: 1, totalStopCount: 2 }
    });
    expect(routePlanFindMany).toHaveBeenCalledOnce();
    expect(driverEventFindMany).toHaveBeenCalledOnce();
    expect(listActiveForRoutePlans).toHaveBeenCalledOnce();
    expect(getActiveSyncHealthForRoutePlans).toHaveBeenCalledOnce();
  });
});

async function createState(input: { accuracyMeters: number; occurredAt?: string; receivedAt: string }) {
  const now = new Date('2026-08-24T08:00:00.000Z');
  const prisma = {
    driverEvent: { findMany: vi.fn().mockResolvedValue([{ id: 'event-id', payload: { accuracyMeters: input.accuracyMeters } }]) },
    routePlan: { findMany: vi.fn().mockResolvedValue([{
      constraints: { operationalHealth: { maxGpsAccuracyMeters: 100, proximityThresholdMeters: 75 } },
      driverId: 'driver-id', driverRouteSessionLeases: [], id: 'route-id', shopId: 'shop-id', status: 'IN_PROGRESS',
      routeStops: [{ deliveryStop: { latitude: 43.4517, longitude: -80.4926, status: 'PENDING', updatedAt: now }, sequence: 11 }],
      trackingGeometry: {
        lastEventId: 'event-id', lastLatitude: 43.4516, lastLongitude: -80.4925,
        lastOccurredAt: new Date(input.occurredAt ?? input.receivedAt), lastReceivedAt: new Date(input.receivedAt)
      }
    }]) }
  };
  const alerts = { listActiveForRoutePlans: vi.fn().mockResolvedValue(new Map()) };
  const sync = { getActiveSyncHealthForRoutePlans: vi.fn().mockResolvedValue(new Map()) };
  return new PrismaRouteOperationalStateService(prisma as never, sync as never, alerts as never, () => now).get('route-id');
}

function routeRecord(input: {
  driverRouteSessionLeases?: Array<{ syncSession: { heartbeats: Array<{ completedStopCount: number; currentStopSequence: number; locallyFinished: boolean; totalStopCount: number }> } }>;
  id: string;
  routeStops?: ReturnType<typeof stop>[];
  status?: string;
  trackingGeometry?: ReturnType<typeof geometry> | null;
}) {
  return {
    constraints: { operationalHealth: { maxGpsAccuracyMeters: 100, proximityThresholdMeters: 75 } },
    driverRouteSessionLeases: input.driverRouteSessionLeases ?? [],
    id: input.id,
    routeStops: input.routeStops ?? [],
    status: input.status ?? 'IN_PROGRESS',
    trackingGeometry: input.trackingGeometry ?? null
  };
}

function stop(sequence: number, status: string, latitude: number | null = null, longitude: number | null = null) {
  return { deliveryStop: { latitude, longitude, status, updatedAt: new Date('2026-08-24T07:55:00.000Z') }, sequence };
}

function geometry(lastEventId: string, observedAt: string) {
  return {
    lastEventId,
    lastLatitude: 43.4516,
    lastLongitude: -80.4925,
    lastOccurredAt: new Date(observedAt),
    lastReceivedAt: new Date(observedAt)
  };
}
