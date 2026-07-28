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
      findMany: vi.fn((input: { where?: { eventType?: string } }) => {
        if (input.where?.eventType === 'STOP_ARRIVED') {
          return Promise.resolve([
            {
              createdAt: new Date('2026-07-20T04:01:06.000Z'),
              deliveryStopId: 'stop-completed',
              driverId: 'driver-1',
              eventType: 'STOP_ARRIVED',
              id: 'arrival-nearest',
              latitude: null,
              longitude: null,
              occurredAt: new Date('2026-07-20T04:01:05.000Z'),
              routePlanId: 'route-1'
            },
            {
              createdAt: new Date('2026-07-20T04:03:01.000Z'),
              deliveryStopId: 'stop-current',
              driverId: 'driver-1',
              eventType: 'STOP_ARRIVED',
              id: 'arrival-direct',
              latitude: '37.53',
              longitude: '126.95',
              occurredAt: new Date('2026-07-20T04:03:00.000Z'),
              routePlanId: 'route-1'
            },
            {
              createdAt: new Date('2026-07-20T05:00:01.000Z'),
              deliveryStopId: 'stop-failed',
              driverId: 'driver-1',
              eventType: 'STOP_ARRIVED',
              id: 'arrival-without-nearby-gps',
              latitude: null,
              longitude: null,
              occurredAt: new Date('2026-07-20T05:00:00.000Z'),
              routePlanId: 'route-1'
            }
          ]);
        }
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
        { deliveryStop: { status: 'DELIVERED' }, deliveryStopId: 'stop-completed', sequence: 1 },
        { deliveryStop: { status: 'FAILED' }, deliveryStopId: 'stop-failed', sequence: 2 },
        { deliveryStop: { status: 'PENDING' }, deliveryStopId: 'stop-current', sequence: 3 }
      ]))
    };
    const routeTrackingGeometry = { findUnique: vi.fn(() => Promise.resolve(null)) };
    const service = new PrismaRouteTrackingService({ driverEvent, routePlanStop, routeTrackingGeometry } as never);

    const snapshot = await service.getRouteTrackingSnapshot({
      now: new Date('2026-07-20T04:02:30.000Z'),
      routePlanId: 'route-1'
    });

    expect(driverEvent.findMany.mock.calls[0]?.[0]).not.toHaveProperty('take');
    expect((driverEvent.findFirst.mock.calls as unknown as Array<[{ where: { eventType: { in: string[] } } }]>)[0]![0].where.eventType.in)
      .not.toContain('PICKUP_COMPLETED');
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
    expect(snapshot.stopArrivals).toEqual([
      {
        deliveryStopId: 'stop-completed',
        driverId: 'driver-1',
        eventId: 'arrival-nearest',
        latitude: 37.51,
        longitude: 126.93,
        occurredAt: '2026-07-20T04:01:05.000Z',
        positionAgeMs: 5_000,
        positionSource: 'nearest_location',
        receivedAt: '2026-07-20T04:01:06.000Z',
        routePlanId: 'route-1',
        schemaVersion: 'route_tracking_arrival.v1',
        stopSequence: 1
      },
      {
        deliveryStopId: 'stop-current',
        driverId: 'driver-1',
        eventId: 'arrival-direct',
        latitude: 37.53,
        longitude: 126.95,
        occurredAt: '2026-07-20T04:03:00.000Z',
        positionAgeMs: 0,
        positionSource: 'event',
        receivedAt: '2026-07-20T04:03:01.000Z',
        routePlanId: 'route-1',
        schemaVersion: 'route_tracking_arrival.v1',
        stopSequence: 3
      },
      {
        deliveryStopId: 'stop-failed',
        driverId: 'driver-1',
        eventId: 'arrival-without-nearby-gps',
        latitude: null,
        longitude: null,
        occurredAt: '2026-07-20T05:00:00.000Z',
        positionAgeMs: 3_480_000,
        positionSource: 'unavailable',
        receivedAt: '2026-07-20T05:00:01.000Z',
        routePlanId: 'route-1',
        schemaVersion: 'route_tracking_arrival.v1',
        stopSequence: 2
      }
    ]);
    expect(snapshot.status).toBe('LIVE');
  });

  test('keeps fallback live GPS history before the first stop arrival', async () => {
    const driverEvent = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findMany: vi.fn((input: { where?: { eventType?: string; driverId?: unknown } }) => (
        input.where?.eventType === 'STOP_ARRIVED'
          ? Promise.resolve([])
          : Promise.resolve([{
              createdAt: new Date('2026-07-20T04:00:01.000Z'),
              driverId: 'driver-1',
              id: 'live-before-arrival',
              latitude: '37.5',
              longitude: '126.9',
              occurredAt: new Date('2026-07-20T04:00:00.000Z'),
              routePlanId: 'route-1'
            }])
      ))
    };
    const service = new PrismaRouteTrackingService({
      driverEvent,
      routePlanStop: { findMany: vi.fn(() => Promise.resolve([])) },
      routeTrackingGeometry: { findUnique: vi.fn(() => Promise.resolve(null)) }
    } as never);

    const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

    expect(driverEvent.findMany.mock.calls[1]?.[0].where?.driverId).toBeUndefined();
    expect(snapshot.latestPosition?.eventId).toBe('live-before-arrival');
    expect(snapshot.recentPositions).toHaveLength(1);
    expect(snapshot.stopArrivals).toEqual([]);
  });

  test('preserves nullable-driver admin stop progress in the snapshot', async () => {
    const driverEvent = {
      findFirst: vi.fn((input: { where?: { OR?: unknown } }) => Promise.resolve(
        input.where?.OR
          ? null
          : {
              createdAt: new Date('2026-07-20T04:05:01.000Z'),
              deliveryStopId: 'stop-admin-delivered',
              driverId: null,
              eventType: 'STOP_DELIVERED',
              id: 'admin-progress-1',
              occurredAt: new Date('2026-07-20T04:05:00.000Z'),
              routePlanId: 'route-1'
            }
      )),
      findMany: vi.fn((input: { where?: { eventType?: string } }) => (
        input.where?.eventType === 'STOP_ARRIVED'
          ? Promise.resolve([])
          : Promise.resolve([])
      ))
    };
    const routePlanStop = { findMany: vi.fn(() => Promise.resolve([
      { deliveryStop: { status: 'DELIVERED' }, deliveryStopId: 'stop-admin-delivered', sequence: 1 }
    ])) };
    const service = new PrismaRouteTrackingService({
      driverEvent,
      routePlanStop,
      routeTrackingGeometry: { findUnique: vi.fn(() => Promise.resolve(null)) }
    } as never);

    const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

    expect(snapshot.progress).toEqual({
      completedStopIds: ['stop-admin-delivered'],
      currentStage: 'READY',
      currentStopId: null,
      failedStopIds: [],
      latestEvent: {
        deliveryStopId: 'stop-admin-delivered',
        driverId: null,
        eventId: 'admin-progress-1',
        eventType: 'STOP_DELIVERED',
        occurredAt: '2026-07-20T04:05:00.000Z',
        receivedAt: '2026-07-20T04:05:01.000Z',
        routePlanId: 'route-1',
        schemaVersion: 'route_tracking.v1'
      }
    });
    expect(snapshot.stopArrivals).toEqual([]);
  });

  test('keeps the active driver stop when a newer admin stop outcome is recorded', async () => {
    const driverEvent = {
      findFirst: vi.fn((input: { where?: { OR?: unknown } }) => Promise.resolve(
        input.where?.OR
          ? {
              createdAt: new Date('2026-07-20T04:04:01.000Z'),
              deliveryStopId: 'stop-driver-current',
              driverId: 'driver-1',
              eventType: 'STOP_ARRIVED',
              id: 'driver-arrived',
              occurredAt: new Date('2026-07-20T04:04:00.000Z'),
              routePlanId: 'route-1'
            }
          : {
              createdAt: new Date('2026-07-20T04:05:01.000Z'),
              deliveryStopId: 'stop-admin-delivered',
              driverId: null,
              eventType: 'STOP_DELIVERED',
              id: 'admin-progress-1',
              occurredAt: new Date('2026-07-20T04:05:00.000Z'),
              routePlanId: 'route-1'
            }
      )),
      findMany: vi.fn(() => Promise.resolve([]))
    };
    const routePlanStop = { findMany: vi.fn(() => Promise.resolve([
      { deliveryStop: { status: 'DELIVERED' }, deliveryStopId: 'stop-admin-delivered', sequence: 1 },
      { deliveryStop: { status: 'PENDING' }, deliveryStopId: 'stop-driver-current', sequence: 2 }
    ])) };
    const service = new PrismaRouteTrackingService({
      driverEvent,
      routePlanStop,
      routeTrackingGeometry: { findUnique: vi.fn(() => Promise.resolve(null)) }
    } as never);

    const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

    expect(snapshot.progress.currentStage).toBe('AT_STOP');
    expect(snapshot.progress.currentStopId).toBe('stop-driver-current');
    expect(snapshot.progress.latestEvent?.eventId).toBe('admin-progress-1');
    expect(snapshot.progress.completedStopIds).toEqual(['stop-admin-delivered']);
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
      findMany: vi.fn((input: { where?: { eventType?: string } }) => {
        void input;
        return Promise.resolve([]);
      })
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
    expect(driverEvent.findMany).toHaveBeenCalledTimes(1);
    expect(driverEvent.findMany.mock.calls[0]?.[0].where?.eventType).toBe('STOP_ARRIVED');
  });

  test('uses only bounded raw GPS windows to place arrivals omitted by compressed geometry', async () => {
    const arrivalOccurredAt = new Date('2026-07-20T04:05:00.000Z');
    const driverEvent = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findMany: vi.fn((input: { where?: { eventType?: string; OR?: unknown[] } }) => (
        input.where?.eventType === 'STOP_ARRIVED'
          ? Promise.resolve([{
              createdAt: new Date('2026-07-20T04:05:01.000Z'),
              deliveryStopId: 'stop-1',
              driverId: 'driver-1',
              eventType: 'STOP_ARRIVED',
              id: 'arrival-1',
              latitude: null,
              longitude: null,
              occurredAt: arrivalOccurredAt,
              routePlanId: 'route-1'
            }])
          : Promise.resolve([
              {
                createdAt: new Date('2026-07-20T04:05:01.000Z'),
                driverId: 'other-driver',
                id: 'wrong-driver-position',
                latitude: '37.6',
                longitude: '127.1',
                occurredAt: new Date('2026-07-20T04:05:00.000Z'),
                routePlanId: 'route-1'
              },
              {
                createdAt: new Date('2026-07-20T04:05:03.000Z'),
                driverId: 'driver-1',
                id: 'near-arrival-position',
                latitude: '37.51',
                longitude: '126.93',
                occurredAt: new Date('2026-07-20T04:05:02.000Z'),
                routePlanId: 'route-1'
              }
            ])
      ))
    };
    const routePlanStop = { findMany: vi.fn(() => Promise.resolve([
      { deliveryStop: { status: 'PENDING' }, deliveryStopId: 'stop-1', sequence: 1 }
    ])) };
    const sampleMetadata = ['04:00:00', '04:10:00'].map((time, index) => ({
      driverId: 'driver-1',
      eventId: `compressed-${index + 1}`,
      occurredAt: `2026-07-20T${time}.000Z`,
      receivedAt: `2026-07-20T${time}.500Z`
    }));
    const routeTrackingGeometry = { findUnique: vi.fn(() => Promise.resolve({
      firstOccurredAt: new Date(sampleMetadata[0]!.occurredAt),
      geometry: { coordinates: [[126.9, 37.5], [126.96, 37.56]], type: 'LineString' },
      geometryPointCount: 2,
      lastDriverId: 'driver-1',
      lastEventId: 'compressed-2',
      lastLatitude: 37.56,
      lastLongitude: 126.96,
      lastOccurredAt: new Date(sampleMetadata[1]!.occurredAt),
      lastReceivedAt: new Date(sampleMetadata[1]!.receivedAt),
      routePlanId: 'route-1',
      sampleMetadata,
      sourcePointCount: 20
    })) };
    const service = new PrismaRouteTrackingService({ driverEvent, routePlanStop, routeTrackingGeometry } as never);

    const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

    expect(driverEvent.findMany).toHaveBeenCalledTimes(2);
    expect(driverEvent.findMany.mock.calls[1]?.[0].where?.OR).toHaveLength(1);
    expect(snapshot.stopArrivals?.[0]).toMatchObject({
      eventId: 'arrival-1',
      latitude: 37.51,
      longitude: 126.93,
      positionAgeMs: 2_000,
      positionSource: 'nearest_location',
      stopSequence: 1
    });
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
