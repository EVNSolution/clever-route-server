import { describe, expect, test } from 'vitest';

import { routeConstraints } from '../src/modules/route-grouping/route-grouping.service.js';

const group = {
  deliverySession: 'DEFAULT',
  planDate: new Date('2026-10-16T00:00:00.000Z'),
  routeScopeKey: 'scope',
  serviceType: 'DEFAULT'
} as unknown as Parameters<typeof routeConstraints>[0];

describe('routeConstraints center timezone', () => {
  test('a new route stores the tenant center timezone once, next to the unchanged depot', () => {
    const depot = { address: 'Center', latitude: 43.7, longitude: -79.4, timezone: 'America/Toronto' };
    const constraints = routeConstraints(group, depot);
    expect(constraints).toMatchObject({ timezone: 'America/Toronto' });
    expect(constraints.depot).toEqual({ address: 'Center', latitude: 43.7, longitude: -79.4 });
  });

  test('stores no timezone when the center has none', () => {
    const depot = { address: 'Center', latitude: 43.7, longitude: -79.4, timezone: null };
    expect(routeConstraints(group, depot)).not.toHaveProperty('timezone');
    expect(routeConstraints(group, null)).not.toHaveProperty('timezone');
  });
});
