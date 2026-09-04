import { describe, expect, it } from 'vitest';

import {
  isRollingEtaRouteRecoverable,
  replayRollingEta,
  sha256CanonicalJson,
  type RollingEtaReplayEvent,
  type RollingEtaReplayStop
} from '../src/modules/driver/rolling-eta-backfill.js';

describe('rolling ETA backfill replay', () => {
  it('replays the authoritative leg and service-time model through delivery progress', () => {
    const replay = replayRollingEta({
      currentRouteVersionId: 'version-current',
      events: [
        event('route-start', 'ROUTE_STARTED', '2026-08-27T09:00:00.000Z'),
        event('stop-1-arrived', 'STOP_ARRIVED', '2026-08-27T09:20:00.000Z', 'delivery-1'),
        event('stop-1-delivered', 'STOP_DELIVERED', '2026-08-27T09:28:00.000Z', 'delivery-1')
      ],
      stops: [
        stop('stop-1', 'delivery-1', 1, 600),
        stop('stop-2', 'delivery-2', 2, 300),
        stop('stop-3', 'delivery-3', 3, 600)
      ]
    });

    expect(replay.unsafeReason).toBeNull();
    expect(replay.replayedEvents).toBe(3);
    expect(replay.stops.map((stopValue) => ({
      eta: stopValue.estimatedArrivalAt?.toISOString(),
      source: stopValue.etaSource,
      version: stopValue.etaInputRouteVersionId
    }))).toEqual([
      { eta: '2026-08-27T09:10:00.000Z', source: 'ROUTE_STARTED', version: 'version-current' },
      { eta: '2026-08-27T09:30:00.000Z', source: 'STOP_DELIVERED', version: 'version-current' },
      { eta: '2026-08-27T09:45:00.000Z', source: 'STOP_DELIVERED', version: 'version-current' }
    ]);
  });

  it('orders events by clamped occurred time and server receipt time', () => {
    const replay = replayRollingEta({
      currentRouteVersionId: null,
      events: [
        event('future-start', 'ROUTE_STARTED', '2026-08-27T12:00:00.000Z', null, '2026-08-27T09:00:00.000Z'),
        event('pickup', 'PICKUP_COMPLETED', '2026-08-27T09:05:00.000Z')
      ],
      stops: [stop('stop-1', 'delivery-1', 1, 600)]
    });

    expect(replay.stops[0]?.estimatedArrivalAt?.toISOString()).toBe('2026-08-27T09:15:00.000Z');
    expect(replay.stops[0]?.etaSource).toBe('PICKUP_COMPLETED');
  });

  it('ignores an older progress event received after a newer authoritative event', () => {
    const replay = replayRollingEta({
      currentRouteVersionId: null,
      events: [
        event('pickup', 'PICKUP_COMPLETED', '2026-08-27T09:05:00.000Z'),
        event('late-old-start', 'ROUTE_STARTED', '2026-08-27T09:00:00.000Z', null, '2026-08-27T09:10:00.000Z')
      ],
      stops: [stop('stop-1', 'delivery-1', 1, 600)]
    });

    expect(replay.replayedEvents).toBe(1);
    expect(replay.ignoredEvents).toBe(1);
    expect(replay.stops[0]?.estimatedArrivalAt?.toISOString()).toBe('2026-08-27T09:15:00.000Z');
    expect(replay.stops[0]?.etaSource).toBe('PICKUP_COMPLETED');
  });

  it('tracks latest progress and arrival anchors independently after driver reassignment', () => {
    const replay = replayRollingEta({
      currentRouteVersionId: null,
      events: [
        event('driver-a-start', 'ROUTE_STARTED', '2026-08-27T09:00:00.000Z', null, '2026-08-27T09:00:00.000Z', 'driver-a'),
        event('driver-a-arrived', 'STOP_ARRIVED', '2026-08-27T09:20:00.000Z', 'delivery-1', '2026-08-27T09:20:00.000Z', 'driver-a'),
        event('driver-b-start', 'ROUTE_STARTED', '2026-08-27T09:10:00.000Z', null, '2026-08-27T09:30:00.000Z', 'driver-b'),
        event('driver-b-delivered', 'STOP_DELIVERED', '2026-08-27T09:35:00.000Z', 'delivery-1', '2026-08-27T09:35:00.000Z', 'driver-b')
      ],
      stops: [
        stop('stop-1', 'delivery-1', 1, 600),
        stop('stop-2', 'delivery-2', 2, 300)
      ]
    });

    expect(replay.ignoredEvents).toBe(0);
    expect(replay.replayedEvents).toBe(4);
    expect(replay.stops[1]?.estimatedArrivalAt?.toISOString()).toBe('2026-08-27T09:40:00.000Z');
  });

  it('refuses a progress event that does not belong to the current route stops', () => {
    const replay = replayRollingEta({
      currentRouteVersionId: 'version-current',
      events: [event('arrived-unknown', 'STOP_ARRIVED', '2026-08-27T09:20:00.000Z', 'delivery-unknown')],
      stops: [stop('stop-1', 'delivery-1', 1, 600)]
    });

    expect(replay.unsafeReason).toBe('PROGRESS_EVENT_STOP_NOT_IN_CURRENT_ROUTE');
    expect(replay.replayedEvents).toBe(0);
  });

  it('classifies a route with any missing leg duration as not recoverable', () => {
    expect(isRollingEtaRouteRecoverable([
      stop('stop-1', 'delivery-1', 1, 600),
      stop('stop-2', 'delivery-2', 2, null)
    ])).toBe(false);
  });

  it('produces a stable review digest independent of object key order', () => {
    expect(sha256CanonicalJson({ scope: ['b', 'a'], count: 2 }))
      .toBe(sha256CanonicalJson({ count: 2, scope: ['b', 'a'] }));
  });
});

function stop(
  id: string,
  deliveryStopId: string,
  sequence: number,
  durationFromPreviousSeconds: number | null
): RollingEtaReplayStop {
  return {
    deliveryStopId,
    distanceFromPreviousMeters: null,
    durationFromPreviousSeconds,
    estimatedArrivalAt: null,
    etaCalculatedAt: null,
    etaFailureCode: null,
    etaFailureMessage: null,
    etaInputRouteVersionId: null,
    etaSource: null,
    etaStatus: 'PENDING',
    id,
    sequence,
    serviceMinutes: 5,
    status: 'PENDING',
    updatedAt: new Date('2026-08-27T08:00:00.000Z')
  };
}

function event(
  id: string,
  eventType: RollingEtaReplayEvent['eventType'],
  occurredAt: string,
  deliveryStopId: string | null = null,
  createdAt: string = occurredAt,
  driverId: string = 'driver-a'
): RollingEtaReplayEvent {
  return {
    createdAt: new Date(createdAt),
    deliveryStopId,
    driverId,
    eventType,
    id,
    occurredAt: new Date(occurredAt)
  };
}
