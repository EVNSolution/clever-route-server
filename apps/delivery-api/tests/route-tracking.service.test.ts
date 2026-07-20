import { describe, expect, test, vi } from 'vitest';

import { ROUTE_TRACKING_V1_POLICY } from '../src/modules/route-tracking/route-tracking.policy.js';
import { PrismaRouteTrackingService } from '../src/modules/route-tracking/route-tracking.service.js';

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
      findMany: vi.fn(() => Promise.resolve([
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
      ]))
    };
    const routePlanStop = {
      findMany: vi.fn(() => Promise.resolve([
        { deliveryStop: { status: 'DELIVERED' }, deliveryStopId: 'stop-completed' },
        { deliveryStop: { status: 'FAILED' }, deliveryStopId: 'stop-failed' },
        { deliveryStop: { status: 'PENDING' }, deliveryStopId: 'stop-current' }
      ]))
    };
    const service = new PrismaRouteTrackingService({ driverEvent, routePlanStop } as never);

    const snapshot = await service.getRouteTrackingSnapshot({
      now: new Date('2026-07-20T04:02:30.000Z'),
      routePlanId: 'route-1'
    });

    expect(driverEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: ROUTE_TRACKING_V1_POLICY.recentPositionsLimit
    }));
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
});
