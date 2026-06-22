import { describe, expect, test } from 'vitest';

import { parseRefreshRouteGeometryArgs, summarizeRouteGeometry } from '../src/scripts/refresh-route-geometry-cache.js';
import type { RoutePlanDetail } from '../src/modules/route-plans/route-plan.types.js';

describe('refresh route geometry script', () => {
  test('parses route plan and shop arguments with explicit apply', () => {
    expect(parseRefreshRouteGeometryArgs([
      '--shop-domain', 'tomatonofood.com',
      '--route-plan-id', 'route-plan-id',
      '--apply'
    ])).toEqual({
      apply: true,
      routePlanId: 'route-plan-id',
      shopDomain: 'tomatonofood.com'
    });
  });

  test('requires explicit apply and summarizes current cache without mutating by default', () => {
    expect(parseRefreshRouteGeometryArgs([
      '--shop-domain', 'tomatonofood.com',
      '--route-plan-id', 'route-plan-id'
    ])).toEqual({
      apply: false,
      routePlanId: 'route-plan-id',
      shopDomain: 'tomatonofood.com'
    });
  });

  test('summarizes geometry coordinate count and longest segment for refresh evidence', () => {
    const detail = {
      routeGeometry: {
        type: 'LineString',
        coordinates: [
          [-79.3832, 43.6532],
          [-79.3822, 43.6542],
          [-79.3812, 43.6552]
        ]
      },
      routeGeometryGeneratedAt: '2026-06-22T00:00:00.000Z',
      routeGeometrySource: 'EXPLICIT_REFRESH',
      routeGeometryStatus: 'fresh',
      routeMetrics: { distanceMeters: 300, durationSeconds: 90 }
    } as RoutePlanDetail;

    expect(summarizeRouteGeometry(detail)).toMatchObject({
      coordinateCount: 3,
      distanceMeters: 300,
      generatedAt: '2026-06-22T00:00:00.000Z',
      source: 'EXPLICIT_REFRESH',
      status: 'fresh'
    });
    expect(summarizeRouteGeometry(detail).maxSegmentMeters).toBeGreaterThan(0);
  });
});
