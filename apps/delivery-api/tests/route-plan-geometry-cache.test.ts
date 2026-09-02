import { describe, expect, test } from 'vitest';

import {
  applyCachedRouteGeometry,
  computeRouteShapeSignature,
  routeGeometryCacheCreateData
} from '../src/modules/route-plans/route-plan-geometry-cache.js';
import type { RoutePlanDetail } from '../src/modules/route-plans/route-plan.types.js';

describe('route geometry cache metadata', () => {
  test('marks newly generated OSRM route geometry cache rows as full overview', () => {
    const data = routeGeometryCacheCreateData({
      generatedAt: new Date('2026-06-22T00:00:00.000Z'),
      geometry: {
        type: 'LineString',
        coordinates: [
          [-79.3832, 43.6532],
          [-79.2571, 43.7764]
        ]
      },
      metrics: { distanceMeters: 1000, durationSeconds: 600 },
      provider: 'osrm',
      routePlanId: '00000000-0000-0000-0000-000000000001',
      shapeSignature: 'shape-signature',
      source: 'EXPLICIT_REFRESH',
      stopPoints: []
    });

    expect(data.overview).toBe('full');
  });

  test('calculates estimated arrivals from the scheduled start, OSRM legs, and stop times', () => {
    const detail = routeDetail('2026-07-16T12:00:00.000Z');
    const result = applyCachedRouteGeometry(detail, {
      generatedAt: '2026-07-16T11:00:00.000Z',
      geometry: {
        type: 'LineString',
        coordinates: [[-79.38, 43.65], [-79.25, 43.77], [-79.33, 43.85]]
      },
      metrics: { distanceMeters: 30000, durationSeconds: 1500 },
      provider: 'osrm',
      providerVersion: null,
      shapeSignature: computeRouteShapeSignature(detail),
      source: 'SNAPSHOT',
      stopPoints: [
        routeStopPoint('stop-1', 1, 600, 10000),
        routeStopPoint('stop-2', 2, 900, 20000)
      ]
    });

    expect(result.stops[0]).toMatchObject({
      distanceFromPreviousMeters: 10000,
      durationFromPreviousSeconds: 600,
      estimatedArrivalAt: '2026-07-16T12:10:00.000Z'
    });
    expect(result.stops[1]).toMatchObject({
      distanceFromPreviousMeters: 20000,
      durationFromPreviousSeconds: 900,
      estimatedArrivalAt: '2026-07-16T12:30:00.000Z'
    });
  });

  test('preserves persisted arrivals while enriching stops with cached OSRM leg data', () => {
    const detail = routeDetail('2026-07-16T12:00:00.000Z');
    detail.routePlan.status = 'IN_PROGRESS';
    detail.stops[0]!.estimatedArrivalAt = '2026-07-16T13:05:00.000Z';

    const result = applyCachedRouteGeometry(detail, {
      generatedAt: '2026-07-16T11:00:00.000Z',
      geometry: {
        type: 'LineString',
        coordinates: [[-79.38, 43.65], [-79.25, 43.77], [-79.33, 43.85]]
      },
      metrics: { distanceMeters: 30000, durationSeconds: 1500 },
      provider: 'osrm',
      providerVersion: null,
      shapeSignature: computeRouteShapeSignature(detail),
      source: 'SNAPSHOT',
      stopPoints: [
        routeStopPoint('stop-1', 1, 600, 10000),
        routeStopPoint('stop-2', 2, 900, 20000)
      ]
    });

    expect(result.stops[0]).toMatchObject({
      distanceFromPreviousMeters: 10000,
      durationFromPreviousSeconds: 600,
      estimatedArrivalAt: '2026-07-16T13:05:00.000Z'
    });
    expect(result.stops[1]).toMatchObject({
      distanceFromPreviousMeters: 20000,
      durationFromPreviousSeconds: 900,
      estimatedArrivalAt: null
    });
  });

  test('keeps estimated arrivals null until a complete scheduled start exists', () => {
    const detail = routeDetail(null);
    const result = applyCachedRouteGeometry(detail, {
      generatedAt: '2026-07-16T11:00:00.000Z',
      geometry: null,
      metrics: { distanceMeters: 10000, durationSeconds: 600 },
      provider: 'osrm',
      providerVersion: null,
      shapeSignature: computeRouteShapeSignature(detail),
      source: 'SNAPSHOT',
      stopPoints: [routeStopPoint('stop-1', 1, 600, 10000)]
    });

    expect(result.routePlan.scheduledStartAt).toBeNull();
    expect(result.stops.every((stop) => stop.estimatedArrivalAt === null)).toBe(true);
  });
});

function routeDetail(scheduledStartAt: string | null): RoutePlanDetail {
  return {
    routePlan: {
      createdAt: '2026-07-16T10:00:00.000Z',
      deliveryAreas: [],
      deliveryDays: [],
      depot: { latitude: 43.65, longitude: -79.38 },
      id: 'route-plan-id',
      missingCoordinates: 0,
      name: 'Route #1',
      planDate: '2026-07-16',
      routeEndMode: 'END_AT_LAST_STOP',
      scheduledStartAt,
      status: 'READY',
      stopsCount: 2,
      updatedAt: '2026-07-16T10:00:00.000Z'
    },
    routeGeometry: null,
    routeMetrics: null,
    routeStopPoints: [],
    stops: [
      routeStop('stop-1', 1, 5),
      routeStop('stop-2', 2, 7)
    ]
  };
}

function routeStop(deliveryStopId: string, sequence: number, serviceMinutes: number): RoutePlanDetail['stops'][number] {
  return {
    address: { address1: null, address2: null, city: null, countryCode: null, postalCode: null, province: null },
    attributes: [],
    coordinates: { latitude: 43.65 + sequence / 100, longitude: -79.38 - sequence / 100 },
    deliveryArea: null,
    deliveryDay: null,
    deliveryStopId,
    financialStatus: null,
    fulfillmentStatus: null,
    orderId: `order-${sequence}`,
    orderName: `#${sequence}`,
    paymentStatus: null,
    recipientName: null,
    sequence,
    serviceMinutes,
    shopifyOrderGid: `gid://shopify/Order/${sequence}`,
    status: 'PENDING'
  };
}

function routeStopPoint(deliveryStopId: string, sequence: number, duration: number, distance: number) {
  return {
    deliveryStopId,
    distanceFromPreviousMeters: distance,
    durationFromPreviousSeconds: duration,
    inputCoordinates: [-79.38, 43.65] as [number, number],
    name: null,
    sequence,
    shopifyOrderGid: `gid://shopify/Order/${sequence}`,
    snapDistanceMeters: 0,
    snappedCoordinates: [-79.38, 43.65] as [number, number]
  };
}
