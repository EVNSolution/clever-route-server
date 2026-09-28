import { describe, expect, test } from 'vitest';

import {
  buildDsvEtaRepairStopUpdates, DsvEtaRepairRefusal,
  validateDsvEtaAppliedCacheSet, validateDsvEtaRepairGeometry,
  validateDsvEtaRepairPlanSchema, type DsvEtaRepairPlan
} from '../src/modules/dsv/dsv-eta-repair.js';
import type { RoutePlanRouteResult } from '../src/modules/route-plans/route-plan.types.js';

const routeVersionId = 'version-current';
const plannedStartAt = new Date('2026-09-09T00:00:00.000Z');
const calculatedAt = new Date('2026-09-28T06:00:00.000Z');

function fixture(status: 'COMPLETED' | 'IN_PROGRESS' | 'READY') {
  const stops = [1, 2].map((sequence) => ({
    deliveryStopId: `stop-${sequence}`,
    deliveryStop: { serviceMinutes: 5, status: status === 'COMPLETED' || (status === 'IN_PROGRESS' && sequence === 1) ? 'DELIVERED' : 'PENDING' },
    id: `route-stop-${sequence}`,
    sequence,
    updatedAt: new Date('2026-09-10T00:00:00.000Z')
  }));
  const events = status === 'READY' ? [] : [
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
  test('keeps the original v1 single-cache audit invariant and checks v2 cache actions', () => {
    const route = { shapeSignature: 'current', beforeCacheIds: ['old'], cacheAction: 'CREATE' } as DsvEtaRepairPlan['routes'][number];
    const caches = [{ id: 'new', shapeSignature: 'current' }, { id: 'old', shapeSignature: 'stale' }];
    expect(() => validateDsvEtaAppliedCacheSet(route, caches, 'dsv_eta_missing_duration_repair_v1'))
      .toThrowError(new DsvEtaRepairRefusal('POSTCHECK_CACHE_SET_CHANGED'));
    expect(validateDsvEtaAppliedCacheSet(route, caches, 'dsv_eta_missing_duration_repair_v2').id).toBe('new');
    expect(() => validateDsvEtaAppliedCacheSet({ ...route, cacheAction: 'REUSE' }, caches, 'dsv_eta_missing_duration_repair_v2'))
      .toThrowError(new DsvEtaRepairRefusal('POSTCHECK_CACHE_SET_CHANGED'));
    expect(validateDsvEtaAppliedCacheSet({ ...route, cacheAction: 'REUSE' }, [{ id: 'old', shapeSignature: 'current' }], 'dsv_eta_missing_duration_repair_v2').id)
      .toBe('old');
  });

  test('preserves v1 semantics and requires an explicit cache baseline for v2', () => {
    const base = {
      generatedAt: calculatedAt.toISOString(), sourceRevision: 'a'.repeat(40),
      scope: { shopId: 'shop-1', shopDomain: 'dsv-demo.local', routePlanIds: ['route-1'], plannedStarts: { 'route-1': plannedStartAt.toISOString() } },
      routes: [{
        beforeFingerprint: 'before', executionFingerprint: 'execution', geometry: fixture('COMPLETED').geometry,
        plannedStartAt: plannedStartAt.toISOString(), plannedStartSource: 'REVIEWED_OVERRIDE' as const,
        routePlanId: 'route-1', shapeSignature: 'shape', status: 'COMPLETED' as const,
        stops: [{ before: { etaStatus: 'FAILED' } }]
      }]
    } as unknown as DsvEtaRepairPlan;
    const v1 = { ...base, schema: 'dsv_eta_missing_duration_repair_v1' } as DsvEtaRepairPlan;
    expect(() => validateDsvEtaRepairPlanSchema(v1)).not.toThrow();
    expect(() => validateDsvEtaRepairPlanSchema({ ...v1, routes: [{ ...v1.routes[0]!, cacheAction: 'REUSE' }] }))
      .toThrowError(new DsvEtaRepairRefusal('PLAN_V1_SEMANTICS_CHANGED'));
    expect(() => validateDsvEtaRepairPlanSchema({ ...v1, routes: [{ ...v1.routes[0]!, status: 'READY' }] }))
      .toThrowError(new DsvEtaRepairRefusal('PLAN_V1_SEMANTICS_CHANGED'));
    const v2 = { ...v1, schema: 'dsv_eta_missing_duration_repair_v2', routes: [{ ...v1.routes[0]!, cacheAction: 'CREATE' }] } as DsvEtaRepairPlan;
    expect(() => validateDsvEtaRepairPlanSchema(v2))
      .toThrowError(new DsvEtaRepairRefusal('PLAN_CACHE_BASELINE_MISSING'));
    expect(() => validateDsvEtaRepairPlanSchema({ ...v2, routes: [{ ...v2.routes[0]!, beforeCacheIds: [] }] })).not.toThrow();
  });

  test('rejects incomplete cache totals and coordinates before reuse or creation', () => {
    const { route, geometry } = fixture('READY');
    expect(() => validateDsvEtaRepairGeometry(route, geometry)).not.toThrow();
    expect(() => validateDsvEtaRepairGeometry(route, {
      ...geometry, routeMetrics: { distanceMeters: null, durationSeconds: 1200 }
    })).toThrowError(new DsvEtaRepairRefusal('GEOMETRY_INCOMPLETE'));
    expect(() => validateDsvEtaRepairGeometry(route, {
      ...geometry, routeGeometry: { type: 'LineString', coordinates: [[0, 0], [128, 38]] }
    })).toThrowError(new DsvEtaRepairRefusal('GEOMETRY_INCOMPLETE'));
  });

  test('reconstructs assigned READY routes without progress events from the reviewed planned start', () => {
    const { route, geometry } = fixture('READY');
    const updates = buildDsvEtaRepairStopUpdates(route, geometry, routeVersionId, plannedStartAt, calculatedAt);
    expect(updates.map((stop) => stop.estimatedArrivalAt)).toEqual([
      '2026-09-09T00:10:00.000Z',
      '2026-09-09T00:25:00.000Z'
    ]);
    expect(updates.every((stop) => stop.etaSource === 'DSV_ETA_REPAIR_PLANNED')).toBe(true);
  });

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
