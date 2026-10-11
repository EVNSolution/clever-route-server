import { describe, expect, test, vi } from 'vitest';
import type * as RouteTrackingEventWindowModule from '../src/modules/route-tracking/route-tracking.event-window.js';

vi.mock('../src/modules/route-tracking/route-tracking.event-window.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RouteTrackingEventWindowModule>();
  return {
    ...actual,
    loadRouteTrackingEventWindow: vi.fn(() => Promise.resolve({
      anchorSource: 'PLAN_DATE',
      endExclusive: new Date('2026-07-22T00:00:00.000Z'),
      serviceDate: '2026-07-20',
      startInclusive: new Date('2026-07-20T00:00:00.000Z'),
      timezone: 'UTC',
    })),
  };
});

import { PrismaRouteTrackingService } from '../src/modules/route-tracking/route-tracking.service.js';
import { loadRouteTrackingEventWindow } from '../src/modules/route-tracking/route-tracking.event-window.js';

describe('PrismaRouteTrackingService', () => {
  test('does not expose a cached path whose final GPS sample is outside the service window', async () => {
    const inWindow = {
      createdAt: new Date('2026-07-20T04:00:01.000Z'),
      driverId: 'driver-1',
      id: 'within-window',
      latitude: '37.51',
      longitude: '126.93',
      occurredAt: new Date('2026-07-20T04:00:00.000Z'),
      routePlanId: 'route-1'
    };
    const driverEvent = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findMany: vi.fn((input: { where?: { eventType?: string } }) => Promise.resolve(
        input.where?.eventType === 'LOCATION_UPDATED' ? [inWindow] : []
      ))
    };
    const service = new PrismaRouteTrackingService({
      driverEvent,
      routePlanStop: { findMany: vi.fn(() => Promise.resolve([])) },
      routeTrackingGeometry: { findUnique: vi.fn(() => Promise.resolve({
        firstOccurredAt: new Date('2026-07-20T04:00:00.000Z'),
        lastOccurredAt: new Date('2026-07-23T04:00:00.000Z')
      })) }
    } as never);

    const snapshot = await service.getRouteTrackingSnapshot({
      now: new Date('2026-07-20T04:01:00.000Z'),
      routePlanId: 'route-1'
    });

    expect(snapshot.recentPositions.map((position) => position.eventId)).toEqual(['within-window']);
    expect(snapshot.recordedPath).toBeNull();
    expect(snapshot.roadMatchedPath).toBeNull();
  });

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
      findMany: vi.fn((input: { where?: { eventType?: string; occurredAt?: unknown } }) => {
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
    expect(driverEvent.findMany.mock.calls[1]?.[0].where?.occurredAt).toEqual({
      gte: new Date('2026-07-20T00:00:00.000Z'),
      lt: new Date('2026-07-22T00:00:00.000Z'),
    });
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
    vi.mocked(loadRouteTrackingEventWindow).mockResolvedValueOnce(null);
    const driverEvent = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findMany: vi.fn((input: { where?: { eventType?: string; driverId?: unknown; occurredAt?: unknown } }) => (
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
    expect(driverEvent.findMany.mock.calls[1]?.[0].where?.occurredAt).toBeUndefined();
    expect(snapshot.latestPosition?.eventId).toBe('live-before-arrival');
    expect(snapshot.recentPositions).toHaveLength(1);
    expect(snapshot.stopArrivals).toEqual([]);
  });

  test.each([
    { expectedDistance: 11.1, expectedStatus: 'CONFIRMED', lastLatitude: '43.6501' },
    { expectedDistance: 64_537.5, expectedStatus: 'UNCONFIRMED', lastLatitude: '44.2304' }
  ])('reports depot-return evidence without calling it driving or working time ($expectedStatus)', async ({
    expectedDistance,
    expectedStatus,
    lastLatitude
  }) => {
    const driverEvent = {
      findFirst: vi.fn((input: { where?: { eventType?: string } }) => {
        if (input.where?.eventType === 'ROUTE_STARTED') {
          return Promise.resolve({
            createdAt: new Date('2026-07-20T12:50:18.000Z'),
            eventType: 'ROUTE_STARTED',
            id: 'route-started',
            latitude: null,
            longitude: null,
            occurredAt: new Date('2026-07-20T12:50:17.000Z')
          });
        }
        if (input.where?.eventType === 'ROUTE_COMPLETED') {
          return Promise.resolve({
            createdAt: new Date('2026-07-20T16:34:28.000Z'),
            eventType: 'ROUTE_COMPLETED',
            id: 'route-completed',
            latitude: null,
            longitude: null,
            occurredAt: new Date('2026-07-20T16:34:27.000Z')
          });
        }
        return Promise.resolve(null);
      }),
      findMany: vi.fn((input: { where?: { eventType?: string } }) => (
        input.where?.eventType === 'STOP_ARRIVED'
          ? Promise.resolve([])
          : Promise.resolve([
              {
                createdAt: new Date('2026-07-20T12:50:06.000Z'),
                driverId: 'driver-1',
                id: 'first-position',
                latitude: '43.6500',
                longitude: '-79.3800',
                occurredAt: new Date('2026-07-20T12:50:05.000Z'),
                routePlanId: 'route-1'
              },
              {
                createdAt: new Date('2026-07-20T16:34:22.000Z'),
                driverId: 'driver-1',
                id: 'last-position',
                latitude: lastLatitude,
                longitude: '-79.3800',
                occurredAt: new Date('2026-07-20T16:34:20.000Z'),
                routePlanId: 'route-1'
              }
            ])
      ))
    };
    const service = new PrismaRouteTrackingService({
      driverEvent,
      routePlan: {
        findUnique: vi.fn(() => Promise.resolve({
          constraints: { routeEndMode: 'RETURN_TO_DEPOT' },
          depotLatitude: '43.6500',
          depotLongitude: '-79.3800'
        }))
      },
      routePlanStop: { findMany: vi.fn(() => Promise.resolve([])) },
      routeTrackingGeometry: { findUnique: vi.fn(() => Promise.resolve(null)) }
    } as never);

    const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

    expect(snapshot.executionEvidence).toMatchObject({
      completion: { eventId: 'route-completed', latitude: null, longitude: null },
      firstPosition: { eventId: 'first-position' },
      lastPosition: { eventId: 'last-position' },
      returnToDepot: {
        distanceToDepotMeters: expectedDistance,
        evidenceEventId: 'last-position',
        source: 'LOCATION_UPDATED',
        status: expectedStatus,
        thresholdMeters: 150
      },
      routeEndMode: 'RETURN_TO_DEPOT',
      schemaVersion: 'route_execution_evidence.v1',
      start: { eventId: 'route-started', latitude: null, longitude: null },
      timeSemantics: 'EVENT_TIMESTAMPS_ONLY'
    });
    expect(snapshot.executionEvidence).not.toHaveProperty('actualDrivingTime');
    expect(snapshot.executionEvidence).not.toHaveProperty('workingTime');
  });

  test.each([
    { startAt: '2026-07-20T15:00:00.000Z', completedAt: '2026-07-20T14:00:00.000Z', hasStart: true },
    { startAt: '2026-07-19T15:00:00.000Z', completedAt: '2026-07-19T16:00:00.000Z', hasStart: false },
    { startAt: '2026-07-20T15:00:00.000Z', completedAt: '2026-07-22T00:00:00.000Z', hasStart: true },
    { startAt: '2026-07-22T00:01:00.000Z', completedAt: '2026-07-21T23:59:00.000Z', hasStart: false }
  ])('does not reuse an earlier execution or out-of-window endpoint ($completedAt)', async ({ startAt, completedAt, hasStart }) => {
    const driverEvent = {
      findFirst: vi.fn((input: { where?: { eventType?: string } }) => {
        const eventType = input.where?.eventType;
        if (eventType !== 'ROUTE_STARTED' && eventType !== 'ROUTE_COMPLETED') return Promise.resolve(null);
        const occurredAt = new Date(eventType === 'ROUTE_STARTED' ? startAt : completedAt);
        return Promise.resolve({
          createdAt: occurredAt,
          eventType,
          id: eventType,
          latitude: '43.6500',
          longitude: '-79.3800',
          occurredAt
        });
      }),
      findMany: vi.fn(() => Promise.resolve([]))
    };
    const service = new PrismaRouteTrackingService({
      driverEvent,
      routePlan: { findUnique: vi.fn(() => Promise.resolve({
        constraints: { routeEndMode: 'RETURN_TO_DEPOT' },
        depotLatitude: '43.6500',
        depotLongitude: '-79.3800'
      })) },
      routePlanStop: { findMany: vi.fn(() => Promise.resolve([])) },
      routeTrackingGeometry: { findUnique: vi.fn(() => Promise.resolve(null)) }
    } as never);

    const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

    expect(snapshot.executionEvidence.start?.occurredAt ?? null).toBe(hasStart ? startAt : null);
    expect(snapshot.executionEvidence.completion).toBeNull();
    expect(snapshot.executionEvidence.returnToDepot.status).toBe('UNAVAILABLE');
    expect(snapshot.executionEvidence.returnToDepot.observedAt).toBeNull();
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
      findMany: vi.fn((input: { where?: { eventType?: string; occurredAt?: unknown; OR?: unknown[] } }) => (
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
    expect(driverEvent.findMany.mock.calls[1]?.[0].where?.occurredAt).toEqual({
      gte: new Date('2026-07-20T00:00:00.000Z'),
      lt: new Date('2026-07-22T00:00:00.000Z'),
    });
    expect(snapshot.stopArrivals?.[0]).toMatchObject({
      eventId: 'arrival-1',
      latitude: 37.51,
      longitude: 126.93,
      positionAgeMs: 2_000,
      positionSource: 'nearest_location',
      stopSequence: 1
    });
  });

  test('returns the last verified road-match cache without starting provider work in the request path', async () => {
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
      roadMatchedSchemaVersion: 'route_tracking_road_match.v3',
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
      findUnique: vi.fn(() => Promise.resolve(staleGeometry))
    };
    const service = new PrismaRouteTrackingService({ driverEvent, routePlanStop, routeTrackingGeometry } as never);

    const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

    expect(snapshot.roadMatchedPath?.watermark).toBe('route_tracking_road_match.v1:korea:1:2:2026-07-20T04:01:00.000Z:old');

    staleGeometry.roadMatchedLastInputOccurredAt = new Date('2026-07-23T04:01:00.000Z');
    const outsideWindowCache = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });
    expect(outsideWindowCache.roadMatchedPath).toBeNull();
  });

  test('keeps the base snapshot independent of unavailable road-match output', async () => {
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
      }))
    };
    const service = new PrismaRouteTrackingService({ driverEvent, routePlanStop, routeTrackingGeometry } as never);

    const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

    expect(snapshot.recordedPath?.geometryPointCount).toBe(2);
    expect(snapshot.roadMatchedPath).toBeNull();
    expect(snapshot.latestPosition?.eventId).toBe('position-2');
  });

  describe('stop completions', () => {
    const completionEvent = (
      id: string,
      eventType: 'STOP_DELIVERED' | 'STOP_FAILED',
      occurredAt: string,
      overrides: { driverId?: string | null; receivedAt?: string } = {}
    ) => ({
      createdAt: new Date(overrides.receivedAt ?? new Date(Date.parse(occurredAt) + 1_000).toISOString()),
      driverId: overrides.driverId === undefined ? 'driver-1' : overrides.driverId,
      eventType,
      id,
      occurredAt: new Date(occurredAt)
    });
    const stopRow = (
      deliveryStopId: string,
      sequence: number,
      status: string,
      driverEvents: ReturnType<typeof completionEvent>[]
    ) => ({ deliveryStop: { driverEvents, status }, deliveryStopId, sequence });
    const buildService = (routeStops: unknown[], arrivals: unknown[] = []) => {
      const driverEvent = {
        findFirst: vi.fn(() => Promise.resolve(null)),
        findMany: vi.fn((input: { where?: { eventType?: string } }) => Promise.resolve(
          input.where?.eventType === 'STOP_ARRIVED' ? arrivals : []
        ))
      };
      const routePlanStop = { findMany: vi.fn(() => Promise.resolve(routeStops)) };
      const routeTrackingGeometry = { findUnique: vi.fn(() => Promise.resolve(null)) };
      return {
        routePlanStop,
        service: new PrismaRouteTrackingService({ driverEvent, routePlanStop, routeTrackingGeometry } as never)
      };
    };

    test('returns the completion time of every delivered or failed stop when no arrival was recorded', async () => {
      const { service } = buildService([
        stopRow('stop-2', 2, 'DELIVERED', [completionEvent('delivered-2', 'STOP_DELIVERED', '2026-07-20T04:20:00.000Z')]),
        stopRow('stop-1', 1, 'DELIVERED', [completionEvent('delivered-1', 'STOP_DELIVERED', '2026-07-20T04:05:00.000Z')]),
        stopRow('stop-3', 3, 'FAILED', [completionEvent('failed-3', 'STOP_FAILED', '2026-07-20T04:35:00.000Z', {
          receivedAt: '2026-07-20T04:41:00.000Z'
        })]),
        stopRow('stop-4', 4, 'PENDING', [])
      ]);

      const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

      expect(snapshot.stopArrivals).toEqual([]);
      expect(snapshot.stopCompletions).toEqual([
        {
          deliveryStopId: 'stop-1',
          driverId: 'driver-1',
          eventId: 'delivered-1',
          eventType: 'STOP_DELIVERED',
          occurredAt: '2026-07-20T04:05:00.000Z',
          receivedAt: '2026-07-20T04:05:01.000Z',
          routePlanId: 'route-1',
          schemaVersion: 'route_tracking_completion.v1',
          stopSequence: 1
        },
        {
          deliveryStopId: 'stop-2',
          driverId: 'driver-1',
          eventId: 'delivered-2',
          eventType: 'STOP_DELIVERED',
          occurredAt: '2026-07-20T04:20:00.000Z',
          receivedAt: '2026-07-20T04:20:01.000Z',
          routePlanId: 'route-1',
          schemaVersion: 'route_tracking_completion.v1',
          stopSequence: 2
        },
        {
          deliveryStopId: 'stop-3',
          driverId: 'driver-1',
          eventId: 'failed-3',
          eventType: 'STOP_FAILED',
          occurredAt: '2026-07-20T04:35:00.000Z',
          receivedAt: '2026-07-20T04:41:00.000Z',
          routePlanId: 'route-1',
          schemaVersion: 'route_tracking_completion.v1',
          stopSequence: 3
        }
      ]);
    });

    test('keeps the arrival and the completion of one stop side by side', async () => {
      const { service } = buildService(
        [stopRow('stop-1', 1, 'DELIVERED', [completionEvent('delivered-1', 'STOP_DELIVERED', '2026-07-20T04:10:00.000Z')])],
        [{
          createdAt: new Date('2026-07-20T04:05:01.000Z'),
          deliveryStopId: 'stop-1',
          driverId: 'driver-1',
          eventType: 'STOP_ARRIVED',
          id: 'arrival-1',
          latitude: '37.5',
          longitude: '126.9',
          occurredAt: new Date('2026-07-20T04:05:00.000Z'),
          routePlanId: 'route-1'
        }]
      );

      const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

      expect(snapshot.stopArrivals?.map((arrival) => arrival.eventId)).toEqual(['arrival-1']);
      expect(snapshot.stopCompletions?.map((completion) => completion.eventId)).toEqual(['delivered-1']);
    });

    test('uses the latest event that matches the current stop status and ignores everything else', async () => {
      const { service } = buildService([
        // A later button result replaces an earlier assisted one, whatever the row order.
        stopRow('stop-a', 1, 'DELIVERED', [
          completionEvent('assisted', 'STOP_DELIVERED', '2026-07-20T04:00:00.000Z'),
          completionEvent('button', 'STOP_DELIVERED', '2026-07-20T04:03:00.000Z')
        ]),
        // A failed attempt that is not the current status does not hide the delivery.
        stopRow('stop-b', 2, 'DELIVERED', [
          completionEvent('later-failed', 'STOP_FAILED', '2026-07-20T04:30:00.000Z'),
          completionEvent('delivered-b', 'STOP_DELIVERED', '2026-07-20T04:10:00.000Z')
        ]),
        // Status and event disagree, so there is no completion time to show.
        stopRow('stop-c', 3, 'FAILED', [completionEvent('delivered-c', 'STOP_DELIVERED', '2026-07-20T04:15:00.000Z')]),
        // The office moved the stop back, so the old event no longer describes it.
        stopRow('stop-d', 4, 'PENDING', [completionEvent('delivered-d', 'STOP_DELIVERED', '2026-07-20T04:20:00.000Z')]),
        // An event without a driver is not driver evidence.
        stopRow('stop-e', 5, 'DELIVERED', [completionEvent('no-driver', 'STOP_DELIVERED', '2026-07-20T04:25:00.000Z', { driverId: null })])
      ]);

      const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

      expect(snapshot.stopCompletions?.map((completion) => [completion.deliveryStopId, completion.eventId])).toEqual([
        ['stop-a', 'button'],
        ['stop-b', 'delivered-b']
      ]);
    });

    test('reads only this route plan\'s driver completion events through the stop rows', async () => {
      const { routePlanStop, service } = buildService([]);

      const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

      expect(snapshot.stopCompletions).toEqual([]);
      const query = (routePlanStop.findMany.mock.calls as unknown as Array<[{
        select: { deliveryStop: { select: { driverEvents: { orderBy: unknown; where: unknown } } } };
        where: unknown;
      }]>)[0]![0];
      expect(query.where).toEqual({ routePlanId: 'route-1' });
      expect(query.select.deliveryStop.select.driverEvents.where).toEqual({
        driverId: { not: null },
        eventType: { in: ['STOP_DELIVERED', 'STOP_FAILED'] },
        routePlanId: 'route-1'
      });
      expect(query.select.deliveryStop.select.driverEvents.orderBy).toEqual([
        { occurredAt: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' }
      ]);
    });

    test('keeps stopCompletions empty for stop rows that carry no events', async () => {
      const { service } = buildService([
        { deliveryStop: { status: 'DELIVERED' }, deliveryStopId: 'stop-1', sequence: 1 }
      ]);

      const snapshot = await service.getRouteTrackingSnapshot({ routePlanId: 'route-1' });

      expect(snapshot.stopCompletions).toEqual([]);
      expect(snapshot.progress.completedStopIds).toEqual(['stop-1']);
    });
  });

});
