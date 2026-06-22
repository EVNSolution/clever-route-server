import { describe, expect, test } from 'vitest';

import { routeGeometryCacheCreateData } from '../src/modules/route-plans/route-plan-geometry-cache.js';

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
});
