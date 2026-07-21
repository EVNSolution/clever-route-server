import { describe, expect, test } from 'vitest';

import {
  appendRouteTrackingGeometryPosition,
  buildRouteTrackingGeometryDocument
} from '../src/modules/route-tracking/route-tracking.geometry.js';

describe('route tracking geometry projection', () => {
  test('keeps a route-scoped geometry with more than 1000 GPS samples without a count cap', () => {
    const positions = Array.from({ length: 1_205 }, (_, index) => position({
      eventId: `event-${index}`,
      latitude: 37.5 + (index % 2 === 0 ? 0 : 0.001),
      longitude: 126.9 + index * 0.0001,
      occurredAt: new Date(Date.parse('2026-07-21T00:00:00.000Z') + index * 30_000).toISOString()
    }));

    const geometry = buildRouteTrackingGeometryDocument(positions);

    expect(geometry.sourcePointCount).toBe(1_205);
    expect(geometry.coordinates).toHaveLength(1_205);
    expect(geometry.samples).toHaveLength(1_205);
  });

  test('compresses a straight route tail while preserving source record count and latest endpoint', () => {
    const positions = [
      position({ eventId: 'event-1', latitude: 37.5, longitude: 126.9, occurredAt: '2026-07-21T00:00:00.000Z' }),
      position({ eventId: 'event-2', latitude: 37.5, longitude: 126.901, occurredAt: '2026-07-21T00:00:30.000Z' }),
      position({ eventId: 'event-3', latitude: 37.5, longitude: 126.902, occurredAt: '2026-07-21T00:01:00.000Z' })
    ];

    const geometry = buildRouteTrackingGeometryDocument(positions);

    expect(geometry.sourcePointCount).toBe(3);
    expect(geometry.coordinates).toEqual([[126.9, 37.5], [126.902, 37.5]]);
    expect(geometry.samples.map((sample) => sample.eventId)).toEqual(['event-1', 'event-3']);
  });

  test('does not simplify across a delayed GPS gap', () => {
    const beforeGap = buildRouteTrackingGeometryDocument([
      position({ eventId: 'event-1', latitude: 37.5, longitude: 126.9, occurredAt: '2026-07-21T00:00:00.000Z' }),
      position({ eventId: 'event-2', latitude: 37.5, longitude: 126.901, occurredAt: '2026-07-21T00:00:30.000Z' })
    ]);
    const afterGap = appendRouteTrackingGeometryPosition(beforeGap, position({
      eventId: 'event-3',
      latitude: 37.5,
      longitude: 126.902,
      occurredAt: '2026-07-21T00:05:00.000Z'
    }));

    expect(afterGap.coordinates).toHaveLength(3);
    expect(afterGap.samples.map((sample) => sample.eventId)).toEqual(['event-1', 'event-2', 'event-3']);
  });
});

function position(overrides: Partial<ReturnType<typeof positionDefaults>> = {}) {
  return { ...positionDefaults(), ...overrides };
}

function positionDefaults() {
  return {
    driverId: '00000000-0000-0000-0000-000000000001',
    eventId: '00000000-0000-0000-0000-000000000002',
    latitude: 37.5,
    longitude: 126.9,
    occurredAt: '2026-07-21T00:00:00.000Z',
    receivedAt: '2026-07-21T00:00:01.000Z',
    routePlanId: '00000000-0000-0000-0000-000000000003'
  };
}
