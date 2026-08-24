import { describe, expect, test, vi } from 'vitest';

import {
  appendRouteTrackingGeometryPosition,
  buildRouteTrackingGeometryDocument,
  persistRouteTrackingGeometryPosition,
  pruneRouteTrackingGeometryDocument
} from '../src/modules/route-tracking/route-tracking.geometry.js';

describe('route tracking geometry projection', () => {
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
      }
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
    const afterGap = appendRouteTrackingGeometryPosition(beforeGap, position({
      eventId: 'event-3',
      latitude: 37.5,
      longitude: 126.902,
      occurredAt: '2026-07-21T00:05:00.000Z'
    }));

    expect(afterGap.coordinates).toHaveLength(3);
    expect(afterGap.samples.map((sample) => sample.eventId)).toEqual(['event-1', 'event-2', 'event-3']);
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
      }
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
