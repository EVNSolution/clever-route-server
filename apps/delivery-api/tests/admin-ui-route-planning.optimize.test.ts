import { describe, expect, test } from 'vitest';

import { buildRouteOptimizeNotice } from '../src/routes/admin-ui-route-planning.js';

describe('buildRouteOptimizeNotice', () => {
  test('labels VROOM optimizer results distinctly from legacy route_engine and clever fallback', () => {
    expect(
      buildRouteOptimizeNotice({
        missingCoordinateStops: 0,
        source: 'vroom',
        stops: [],
      }),
    ).toBe('VROOM optimized sequence saved.');
    expect(
      buildRouteOptimizeNotice({
        missingCoordinateStops: 2,
        source: 'vroom',
        stops: [],
      }),
    ).toBe('VROOM optimized sequence saved; 2 stop(s) without coordinates stayed at the end.');
  });
});
