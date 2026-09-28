import { describe, expect, test } from 'vitest';

import { buildDsvEtaRepairStopUpdates, DsvEtaRepairRefusal } from '../src/modules/dsv/dsv-eta-repair.js';
import type { RoutePlanRouteResult } from '../src/modules/route-plans/route-plan.types.js';

const routeVersionId = 'version-current';
const plannedStartAt = new Date('2026-09-09T00:00:00.000Z');
const calculatedAt = new Date('2026-09-28T06:00:00.000Z');

function fixture(status: 'COMPLETED' | 'IN_PROGRESS') {
  const stops = [1, 2].map((sequence) => ({
    deliveryStopId: `stop-${sequence}`,
    deliveryStop: { serviceMinutes: 5, status: status === 'COMPLETED' || sequence === 1 ? 'DELIVERED' : 'PENDING' },
    id: `route-stop-${sequence}`,
    sequence,
    updatedAt: new Date('2026-09-10T00:00:00.000Z')
  }));
  const events = [
    {
      createdAt: new Date('2026-09-09T01:00:01.000Z'),
      deliveryStopId: 'stop-1',
      driverId: 'driver-1',
      eventType: 'STOP_DELIVERED',
      id: 'event-1',
      occurredAt: new Date('2026-09-09T01:00:00.000Z'),
      routeVersionId
    },
    ...(status === 'COMPLETED' ? [{
      createdAt: new Date('2026-09-09T02:00:01.000Z'),
      deliveryStopId: 'stop-2',
      driverId: 'driver-1',
      eventType: 'STOP_DELIVERED',
      id: 'event-2',
      occurredAt: new Date('2026-09-09T02:00:00.000Z'),
      routeVersionId
    }] : [])
  ];
  const route = {
    driverEvents: events,
    driverId: 'driver-1',
    id: 'route-1',
    routeStops: stops,
    status
  } as unknown as Parameters<typeof buildDsvEtaRepairStopUpdates>[0];
  const geometry = {
    routeGeometry: { type: 'LineString', coordinates: [[127, 37], [128, 38]] },
    routeMetrics: { distanceMeters: 2000, durationSeconds: 1200 },
    routeStopPoints: stops.map((stop) => ({
      deliveryStopId: stop.deliveryStopId,
      distanceFromPreviousMeters: 1000,
      durationFromPreviousSeconds: 600,
      sequence: stop.sequence
    }))
  } as RoutePlanRouteResult;
  return { geometry, route };
}

describe('DSV missing duration ETA repair', () => {
  test('reconstructs completed route forecasts without copying completion events into ETA', () => {
    const { route, geometry } = fixture('COMPLETED');
    const updates = buildDsvEtaRepairStopUpdates(route, geometry, routeVersionId, plannedStartAt, calculatedAt);
    expect(updates).toHaveLength(2);
    expect(updates.map((stop) => stop.estimatedArrivalAt)).toEqual([
      '2026-09-09T00:10:00.000Z',
      '2026-09-09T01:10:00.000Z'
    ]);
    expect(updates[1]?.estimatedArrivalAt).not.toBe('2026-09-09T02:00:00.000Z');
    expect(updates.map((stop) => stop.etaStatus)).toEqual(['READY', 'READY']);
    expect(updates.map((stop) => stop.etaSource)).toEqual([
      'DSV_ETA_REPAIR_PLANNED', 'DSV_ETA_REPAIR_EVENT_REPLAY'
    ]);
    expect(updates.every((stop) => stop.etaCalculatedAt === calculatedAt.toISOString())).toBe(true);
  });

  test('predicts remaining stops after the latest current-version event without changing order', () => {
    const { route, geometry } = fixture('IN_PROGRESS');
    const updates = buildDsvEtaRepairStopUpdates(route, geometry, routeVersionId, plannedStartAt, calculatedAt);
    expect(updates.map((stop) => [stop.deliveryStopId, stop.sequence])).toEqual([['stop-1', 1], ['stop-2', 2]]);
    expect(updates[1]?.estimatedArrivalAt).toBe('2026-09-09T01:10:00.000Z');
  });

  test('refuses to replay another driver\'s progress event', () => {
    const { route, geometry } = fixture('IN_PROGRESS');
    route.driverEvents[0]!.driverId = 'other-driver';
    expect(() => buildDsvEtaRepairStopUpdates(route, geometry, routeVersionId, plannedStartAt, calculatedAt))
      .toThrowError(new DsvEtaRepairRefusal('CURRENT_EVENTS_UNUSABLE'));
  });
});
