import { describe, expect, test, vi } from 'vitest';

import {
  appendRouteTrackingGeometryPosition,
  buildRouteTrackingGeometryDocument,
  persistRouteTrackingGeometryPosition,
  pruneRouteTrackingGeometryDocument
} from '../src/modules/route-tracking/route-tracking.geometry.js';
import type { RouteTrackingGeometryPositionInput } from '../src/modules/route-tracking/route-tracking.geometry.js';

describe('route tracking geometry projection', () => {
  test('queues durable road matching in the same transaction after geometry changes', async () => {
    const routeTrackingRoadMatchJob = {
      create: vi.fn(() => Promise.resolve({ id: 'job-1' })),
      findUnique: vi.fn(() => Promise.resolve(null)),
      update: vi.fn(),
    };
    const prisma = {
      $queryRaw: vi.fn(() => Promise.resolve([{ locked: true }])),
      driverEvent: { findMany: vi.fn(() => Promise.resolve([])) },
      routeTrackingGeometry: {
        findUnique: vi.fn(() => Promise.resolve(null)),
        upsert: vi.fn(() => Promise.resolve(null)),
      },
      routeTrackingRoadMatchJob,
    } as unknown as Parameters<typeof persistRouteTrackingGeometryPosition>[0];

    await persistRouteTrackingGeometryPosition(prisma, position());

    const expectedNextAttemptAt: unknown = expect.any(Date);
    expect(routeTrackingRoadMatchJob.create).toHaveBeenCalledWith({ data: {
      nextAttemptAt: expectedNextAttemptAt,
      routePlanId: position().routePlanId,
      targetLastInputOccurredAt: new Date(position().occurredAt),
      targetSourcePointCount: 1,
    } });
  });

  test('projects the advisory lock to a supported scalar before Prisma reads it', async () => {
    let lockSql = '';
    const prisma = {
      $queryRaw: (query: { strings: readonly string[] }) => {
        lockSql = query.strings.join('?');
        return Promise.resolve([{ locked: true }]);
      },
      driverEvent: { findMany: () => Promise.resolve([]) },
      routeTrackingGeometry: {
        findUnique: () => Promise.resolve(null),
        upsert: () => Promise.resolve(null)
      },
      routeTrackingRoadMatchJob: roadMatchJobDelegate(),
    } as unknown as Parameters<typeof persistRouteTrackingGeometryPosition>[0];

    await persistRouteTrackingGeometryPosition(prisma, position());

    expect(lockSql).toContain('SELECT TRUE AS "locked" FROM pg_advisory_xact_lock');
  });

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
    const firstAfterGap = appendRouteTrackingGeometryPosition(beforeGap, position({
      eventId: 'event-3',
      latitude: 37.5,
      longitude: 126.902,
      occurredAt: '2026-07-21T00:05:00.000Z'
    }));
    const afterGap = appendRouteTrackingGeometryPosition(firstAfterGap, position({
      eventId: 'event-4',
      latitude: 37.5,
      longitude: 126.9021,
      occurredAt: '2026-07-21T00:05:06.000Z'
    }));

    expect(afterGap.coordinates).toHaveLength(4);
    expect(afterGap.samples.map((sample) => sample.eventId)).toEqual(['event-1', 'event-2', 'event-3', 'event-4']);
    expect(afterGap.samples.find((sample) => sample.eventId === 'event-3')?.gapBefore).toBe(true);
  });

  test('preserves a slow right-angle turn instead of collapsing cumulative short steps', () => {
    const metersToLatitude = (meters: number) => meters / 111_320;
    const metersToLongitude = (meters: number) => meters / (111_320 * Math.cos(43.65 * Math.PI / 180));
    const positions = Array.from({ length: 121 }, (_, index) => {
      const eastMeters = Math.min(index, 60) * 2.5;
      const northMeters = Math.max(0, index - 60) * 2.5;
      return position({
        eventId: `turn-${index}`,
        latitude: 43.65 + metersToLatitude(northMeters),
        longitude: -79.4 + metersToLongitude(eastMeters),
        occurredAt: new Date(Date.parse('2026-09-17T13:00:00.000Z') + index * 6_000).toISOString()
      });
    });

    const geometry = buildRouteTrackingGeometryDocument(positions);

    expect(geometry.sourcePointCount).toBe(121);
    expect(geometry.coordinates.length).toBeGreaterThan(2);
    expect(geometry.coordinates.some(([longitude, latitude]) => (
      Math.abs(longitude - (-79.4 + metersToLongitude(150))) < 0.00001
      && Math.abs(latitude - 43.65) < 0.00001
    ))).toBe(true);
  });

  test('does not classify a real low-speed circle as stationary GPS jitter', () => {
    const latitude = 43.65;
    const metersToLatitude = (meters: number) => meters / 111_320;
    const metersToLongitude = (meters: number) => meters / (111_320 * Math.cos(latitude * Math.PI / 180));
    const positions = Array.from({ length: 7 }, (_, index) => {
      const angle = index * Math.PI / 3;
      return position({
        accuracyMeters: 20,
        eventId: `circle-${index}`,
        latitude: latitude + metersToLatitude(Math.sin(angle) * 10),
        longitude: -79.4 + metersToLongitude(Math.cos(angle) * 10),
        occurredAt: new Date(Date.parse('2026-09-17T13:00:00.000Z') + index * 6_000).toISOString()
      });
    });

    const geometry = buildRouteTrackingGeometryDocument(positions);

    expect(geometry.coordinates.length).toBeGreaterThan(3);
    expect(new Set(geometry.coordinates.map((coordinate) => coordinate.join(','))).size).toBeGreaterThan(3);
  });

  test('preserves a narrow low-speed hairpin despite GPS accuracy wider than the lane spacing', () => {
    const latitude = 43.65;
    const metersToLatitude = (meters: number) => meters / 111_320;
    const metersToLongitude = (meters: number) => meters / (111_320 * Math.cos(latitude * Math.PI / 180));
    const meters: Array<[number, number]> = [[0, 0], [10, 0], [20, 0], [20, 5], [10, 5], [0, 5]];
    const geometry = buildRouteTrackingGeometryDocument(meters.map(([east, north], index) => position({
      accuracyMeters: 20,
      eventId: `hairpin-${index}`,
      latitude: latitude + metersToLatitude(north),
      longitude: -79.4 + metersToLongitude(east),
      occurredAt: new Date(Date.parse('2026-09-17T13:00:00.000Z') + index * 6_000).toISOString()
    })));

    expect(geometry.coordinates.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...geometry.coordinates.map(([longitude]) => longitude)))
      .toBeGreaterThan(-79.4 + metersToLongitude(19));
  });

  test('keeps true acquisition-gap semantics after compressing frequent straight samples', () => {
    const positions = Array.from({ length: 101 }, (_, index) => position({
      eventId: `continuous-${index}`,
      longitude: 126.9 + index * 0.00001,
      occurredAt: new Date(Date.parse('2026-09-17T13:00:00.000Z') + index * 6_000).toISOString()
    }));

    const geometry = buildRouteTrackingGeometryDocument(positions);

    expect(geometry.sourcePointCount).toBe(101);
    expect(geometry.samples.every((sample) => sample.gapBefore === false)).toBe(true);
    expect(geometry.samples.at(-1)?.sourceIndex).toBe(100);
    expect(pruneRouteTrackingGeometryDocument(
      geometry,
      new Date('2026-09-17T12:59:00.000Z')
    ).sourcePointCount).toBe(101);
  });

  test('does not resurrect expired GPS geometry from a late location event', async () => {
    const upsert = vi.fn(() => Promise.resolve(null));
    const prisma = {
      $queryRaw: vi.fn(() => Promise.resolve([{ locked: true }])),
      driverEvent: { findMany: vi.fn(() => Promise.resolve([])) },
      routeTrackingGeometry: { findUnique: vi.fn(() => Promise.resolve(null)), upsert }
    } as unknown as Parameters<typeof persistRouteTrackingGeometryPosition>[0];

    await expect(persistRouteTrackingGeometryPosition(prisma, position({
      occurredAt: '2026-01-01T00:00:00.000Z',
      receivedAt: '2026-08-25T00:00:00.000Z'
    }))).resolves.toEqual({ coordinates: [], samples: [], sourcePointCount: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });

  test('prunes expired points while retaining recent active-route geometry', () => {
    const document = buildRouteTrackingGeometryDocument([
      position({ eventId: 'old', occurredAt: '2026-01-01T00:00:00.000Z', receivedAt: '2026-01-01T00:00:01.000Z' }),
      position({ eventId: 'recent', longitude: 126.91, occurredAt: '2026-08-24T00:00:00.000Z', receivedAt: '2026-08-24T00:00:01.000Z' })
    ]);

    expect(pruneRouteTrackingGeometryDocument(document, new Date('2026-05-27T00:00:00.000Z'))).toEqual({
      coordinates: [[126.91, 37.5]],
      samples: [expect.objectContaining({ eventId: 'recent' })],
      sourcePointCount: 1
    });
  });

  test('excludes expired source events when rebuilding out-of-order geometry', async () => {
    const findMany = vi.fn(() => Promise.resolve([{
      createdAt: new Date('2026-08-24T23:00:01.000Z'),
      driverId: position().driverId,
      id: position().eventId,
      latitude: 37.5,
      longitude: 126.9,
      occurredAt: new Date('2026-08-24T23:00:00.000Z'),
      routePlanId: position().routePlanId
    }]));
    const prisma = {
      $queryRaw: vi.fn(() => Promise.resolve([{ locked: true }])),
      driverEvent: { findMany },
      routeTrackingGeometry: {
        findUnique: vi.fn(() => Promise.resolve({ lastOccurredAt: new Date('2026-08-25T00:00:00.000Z') })),
        upsert: vi.fn(() => Promise.resolve(null))
      },
      routeTrackingRoadMatchJob: roadMatchJobDelegate(),
    } as unknown as Parameters<typeof persistRouteTrackingGeometryPosition>[0];

    await persistRouteTrackingGeometryPosition(prisma, position({
      occurredAt: '2026-08-24T23:30:00.000Z',
      receivedAt: '2026-08-25T00:00:00.000Z'
    }));

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ occurredAt: { gte: new Date('2026-05-27T00:00:00.000Z') } }) as unknown
    }));
  });
});

function position(overrides: Partial<RouteTrackingGeometryPositionInput> = {}): RouteTrackingGeometryPositionInput {
  return { ...positionDefaults(), ...overrides };
}

function roadMatchJobDelegate() {
  return {
    create: vi.fn(() => Promise.resolve({ id: 'job-1' })),
    findUnique: vi.fn(() => Promise.resolve(null)),
    update: vi.fn(),
  };
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
