import { describe, expect, test, vi } from 'vitest';

import type { RouteTrackingRoadMatchProvider } from '../src/modules/route-tracking/route-tracking.road-match.js';
import { PrismaRouteTrackingService } from '../src/modules/route-tracking/route-tracking.service.js';
import type { RouteTrackingRoadMatchedPathV1 } from '../src/modules/route-tracking/route-tracking.types.js';

describe('PrismaRouteTrackingService', () => {
  test('returns full-route GPS history, current driver stage, and durable stop outcomes', async () => {
    const driverEvent = {
      findFirst: vi.fn(() => Promise.resolve({
        createdAt: new Date('2026-07-20T04:03:01.000Z'),
        deliveryStopId: 'stop-current',
        driverId: 'driver-1',
        eventType: 'STOP_ARRIVED',
        id: 'progress-1',
        occurredAt: new Date('2026-07-20T04:03:00.000Z'),
        routePlanId: 'route-1'
      })),
      findMany: vi.fn((input: unknown) => {
        void input;
        return Promise.resolve([
          {
            createdAt: new Date('2026-07-20T04:02:01.000Z'),
            driverId: 'driver-1',
            id: 'position-2',
            latitude: '37.52',
            longitude: '126.94',
            occurredAt: new Date('2026-07-20T04:02:00.000Z'),
            routePlanId: 'route-1'
          },
          {
            createdAt: new Date('2026-07-20T04:01:01.000Z'),
            driverId: 'driver-1',
            id: 'position-1',
            latitude: '37.51',
            longitude: '126.93',
            occurredAt: new Date('2026-07-20T04:01:00.000Z'),
            routePlanId: 'route-1'
          }
        ]);
      })
    };
    const routePlanStop = {
      findMany: vi.fn(() => Promise.resolve([
        { deliveryStop: { status: 'DELIVERED' }, deliveryStopId: 'stop-completed' },
        { deliveryStop: { status: 'FAILED' }, deliveryStopId: 'stop-failed' },
        { deliveryStop: { status: 'PENDING' }, deliveryStopId: 'stop-current' }
      ]))
    };
    const routeTrackingGeometry = { findUnique: vi.fn(() => Promise.resolve(null)) };
    const service = new PrismaRouteTrackingService({ driverEvent, routePlanStop, routeTrackingGeometry } as never);

    const snapshot = await service.getRouteTrackingSnapshot({
      now: new Date('2026-07-20T04:02:30.000Z'),
      routePlanId: 'route-1'
    });

    expect(driverEvent.findMany.mock.calls[0]?.[0]).not.toHaveProperty('take');
    expect(snapshot.recentPositions.map((position) => position.eventId)).toEqual(['position-1', 'position-2']);
    expect(snapshot.latestPosition?.eventId).toBe('position-2');
    expect(snapshot.progress).toEqual({
      completedStopIds: ['stop-completed'],
      currentStage: 'AT_STOP',
      currentStopId: 'stop-current',
      failedStopIds: ['stop-failed'],
      latestEvent: {
        deliveryStopId: 'stop-current',
        driverId: 'driver-1',
        eventId: 'progress-1',
        eventType: 'STOP_ARRIVED',
        occurredAt: '2026-07-20T04:03:00.000Z',
        receivedAt: '2026-07-20T04:03:01.000Z',
        routePlanId: 'route-1',
        schemaVersion: 'route_tracking.v1'
      }
    });
    expect(snapshot.status).toBe('LIVE');
  });

  test('reads the full compressed route geometry without scanning raw GPS events or applying a point cap', async () => {
    const pointCount = 1_205;
    const coordinates = Array.from({ length: pointCount }, (_, index) => [126.9 + index * 0.0001, 37.5]);
    const sampleMetadata = coordinates.map((_, index) => ({
      driverId: 'driver-1',
      eventId: `position-${index}`,
      occurredAt: new Date(Date.parse('2026-07-20T04:00:00.000Z') + index * 30_000).toISOString(),
      receivedAt: new Date(Date.parse('2026-07-20T04:00:01.000Z') + index * 30_000).toISOString()
    }));
    const driverEvent = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findMany: vi.fn(() => Promise.resolve([]))
    };
    const routePlanStop = { findMany: vi.fn(() => Promise.resolve([])) };
    const routeTrackingGeometry = {
      findUnique: vi.fn(() => Promise.resolve({
        firstOccurredAt: new Date(sampleMetadata[0]!.occurredAt),
        geometry: { coordinates, type: 'LineString' },
        geometryPointCount: pointCount,
        lastDriverId: 'driver-1',
        lastEventId: sampleMetadata.at(-1)!.eventId,
        lastLatitude: 37.5,
        lastLongitude: coordinates.at(-1)![0],
        lastOccurredAt: new Date(sampleMetadata.at(-1)!.occurredAt),
        lastReceivedAt: new Date(sampleMetadata.at(-1)!.receivedAt),
        routePlanId: 'route-1',
        sampleMetadata,
        sourcePointCount: 1_500
      }))
    };
    const service = new PrismaRouteTrackingService({ driverEvent, routePlanStop, routeTrackingGeometry } as never);

    const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

    expect(snapshot.recordedPath?.geometryPointCount).toBe(pointCount);
    expect(snapshot.recordedPath?.sourcePointCount).toBe(1_500);
    expect(snapshot.recentPositions).toHaveLength(pointCount);
    expect(driverEvent.findMany).not.toHaveBeenCalled();
  });

  test('includes cached road-matched path and refreshes stale road-match cache asynchronously', async () => {
    const sampleMetadata = [
      {
        driverId: 'driver-1',
        eventId: 'position-1',
        occurredAt: '2026-07-20T04:01:00.000Z',
        receivedAt: '2026-07-20T04:01:01.000Z'
      },
      {
        driverId: 'driver-1',
        eventId: 'position-2',
        occurredAt: '2026-07-20T04:02:00.000Z',
        receivedAt: '2026-07-20T04:02:01.000Z'
      }
    ];
    const staleGeometry = {
      firstOccurredAt: new Date(sampleMetadata[0]!.occurredAt),
      geometry: { coordinates: [[126.9, 37.5], [126.91, 37.51]], type: 'LineString' },
      geometryPointCount: 2,
      lastDriverId: 'driver-1',
      lastEventId: 'position-2',
      lastLatitude: 37.51,
      lastLongitude: 126.91,
      lastOccurredAt: new Date(sampleMetadata.at(-1)!.occurredAt),
      lastReceivedAt: new Date(sampleMetadata.at(-1)!.receivedAt),
      roadMatchedCoverage: 'korea',
      roadMatchedGeometry: { coordinates: [[[126.9, 37.5], [126.905, 37.505]]], type: 'MultiLineString' },
      roadMatchedLastInputOccurredAt: new Date('2026-07-20T04:01:00.000Z'),
      roadMatchedLastPosition: { latitude: 37.505, longitude: 126.905, occurredAt: '2026-07-20T04:01:00.000Z' },
      roadMatchedPointCount: 2,
      roadMatchedSchemaVersion: 'route_tracking_road_match.v1',
      roadMatchedSourcePointCount: 1,
      roadMatchedUncertainGeometry: null,
      roadMatchedWatermark: 'route_tracking_road_match.v1:korea:1:2:2026-07-20T04:01:00.000Z:old',
      routePlanId: 'route-1',
      sampleMetadata,
      sourcePointCount: 2
    };
    const driverEvent = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findMany: vi.fn(() => Promise.resolve([]))
    };
    const routePlanStop = { findMany: vi.fn(() => Promise.resolve([])) };
    const routeTrackingGeometry = {
      findUnique: vi.fn(() => Promise.resolve(staleGeometry)),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
    };
    const matchedPath: RouteTrackingRoadMatchedPathV1 = {
      coverage: 'korea',
      inputPointCount: 2,
      lastInputOccurredAt: '2026-07-20T04:02:00.000Z',
      lastMatchedPosition: { latitude: 37.51, longitude: 126.91, occurredAt: '2026-07-20T04:02:00.000Z' },
      matchedGeometry: { coordinates: [[[126.9, 37.5], [126.91, 37.51]]], type: 'MultiLineString' },
      matchedPointCount: 2,
      schemaVersion: 'route_tracking_road_match.v1',
      uncertainGeometry: null,
      watermark: 'route_tracking_road_match.v1:korea:2:2:2026-07-20T04:02:00.000Z:new'
    };
    const match = vi.fn(() => Promise.resolve(matchedPath));
    const roadMatchProvider: RouteTrackingRoadMatchProvider = { match };
    const service = new PrismaRouteTrackingService(
      { driverEvent, routePlanStop, routeTrackingGeometry } as never,
      { roadMatchProvider }
    );

    const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

    expect(snapshot.roadMatchedPath?.watermark).toBe('route_tracking_road_match.v1:korea:1:2:2026-07-20T04:01:00.000Z:old');
    await vi.waitFor(() => expect(routeTrackingGeometry.updateMany).toHaveBeenCalledTimes(1));
    expect(match).toHaveBeenCalledWith({
      coordinates: [[126.9, 37.5], [126.91, 37.51]],
      samples: sampleMetadata,
      sourcePointCount: 2
    });
    expect((routeTrackingGeometry.updateMany.mock.calls as unknown as Array<[unknown]>)[0]![0]).toMatchObject({
      where: {
        routePlanId: 'route-1',
        OR: [
          { roadMatchedSourcePointCount: null },
          { roadMatchedSourcePointCount: { lte: 2 } }
        ]
      }
    });
  });

  test('keeps base snapshot available when asynchronous road matching fails', async () => {
    const sampleMetadata = [
      { driverId: 'driver-1', eventId: 'position-1', occurredAt: '2026-07-20T04:01:00.000Z', receivedAt: '2026-07-20T04:01:01.000Z' },
      { driverId: 'driver-1', eventId: 'position-2', occurredAt: '2026-07-20T04:02:00.000Z', receivedAt: '2026-07-20T04:02:01.000Z' }
    ];
    const driverEvent = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findMany: vi.fn(() => Promise.resolve([]))
    };
    const routePlanStop = { findMany: vi.fn(() => Promise.resolve([])) };
    const routeTrackingGeometry = {
      findUnique: vi.fn(() => Promise.resolve({
        firstOccurredAt: new Date(sampleMetadata[0]!.occurredAt),
        geometry: { coordinates: [[126.9, 37.5], [126.91, 37.51]], type: 'LineString' },
        geometryPointCount: 2,
        lastDriverId: 'driver-1',
        lastEventId: 'position-2',
        lastLatitude: 37.51,
        lastLongitude: 126.91,
        lastOccurredAt: new Date(sampleMetadata.at(-1)!.occurredAt),
        lastReceivedAt: new Date(sampleMetadata.at(-1)!.receivedAt),
        routePlanId: 'route-1',
        sampleMetadata,
        sourcePointCount: 2
      })),
      updateMany: vi.fn(() => Promise.resolve({ count: 0 }))
    };
    const roadMatchProvider = { match: vi.fn(() => Promise.reject(new Error('OSRM unavailable'))) };
    const service = new PrismaRouteTrackingService(
      { driverEvent, routePlanStop, routeTrackingGeometry } as never,
      { roadMatchProvider }
    );

    const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

    expect(snapshot.recordedPath?.geometryPointCount).toBe(2);
    expect(snapshot.roadMatchedPath).toBeNull();
    expect(snapshot.latestPosition?.eventId).toBe('position-2');
    await vi.waitFor(() => expect(roadMatchProvider.match).toHaveBeenCalledTimes(1));
    expect(routeTrackingGeometry.updateMany).not.toHaveBeenCalled();
  });
});
