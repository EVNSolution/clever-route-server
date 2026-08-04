import { describe, expect, test } from 'vitest';

import { cutCustomerScopedRouteGeometry } from '../src/modules/dsv/dsv-customer-route-geometry.js';

describe('DSV customer route geometry cutter', () => {
  test('cuts route geometry from the assigned vehicle position to the last customer stop', () => {
    const cut = cutCustomerScopedRouteGeometry({
      coordinates: [
        [126.9, 37.5],
        [126.91, 37.5],
        [126.92, 37.5],
        [126.93, 37.5],
      ],
      end: [126.925, 37.5],
      start: [126.905, 37.5],
    });

    expect(cut).toEqual([
      [126.905, 37.5],
      [126.91, 37.5],
      [126.92, 37.5],
      [126.925, 37.5],
    ]);
  });

  test('omits routes when vehicle position cannot be safely snapped before the customer stop', () => {
    expect(cutCustomerScopedRouteGeometry({
      coordinates: [[126.9, 37.5], [126.91, 37.5]],
      end: [126.91, 37.5],
      start: [127.2, 37.8],
    })).toBeNull();

    expect(cutCustomerScopedRouteGeometry({
      coordinates: [[126.9, 37.5], [126.91, 37.5], [126.92, 37.5]],
      end: [126.91, 37.5],
      start: [126.915, 37.5],
    })).toBeNull();
  });
});
