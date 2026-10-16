import { describe, expect, test } from 'vitest';

import {
  findCenterArrivalMs,
  findLastStopReached,
  trimTrailToServiceWindow,
} from '../src/modules/dsv/dsv-service-window.js';
import type { RouteTrackingRoadMatchedGeometryV1 } from '../src/modules/route-tracking/route-tracking.types.js';
import type { UvisVehicleDailyRoute } from '../src/modules/uvis/uvis-vehicle-daily-route.js';
import type { UvisVehicleTrailMarker } from '../src/modules/uvis/uvis-vehicle-trail-materializer.js';

type TestSession = {
  segments: Array<{
    roadMatchedGeometry?: RouteTrackingRoadMatchedGeometryV1 | null;
    samples: Array<{ observedAt: string }>;
    trailMarker?: UvisVehicleTrailMarker | null;
  }>;
};

const center = { latitude: 37.3329463, longitude: 126.9381069 };
// 0.001 degrees of latitude is about 111 m. 0.03 is about 3.3 km.
const near = { latitude: center.latitude + 0.001, longitude: center.longitude };
const far = { latitude: center.latitude + 0.03, longitude: center.longitude };
const at = (time: string) => new Date(`2026-10-13T${time}:00+09:00`);
const point = (time: string, place: { latitude: number; longitude: number }) => ({ ...place, observedAt: at(time) });

describe('findCenterArrivalMs', () => {
  test('a pass-by is not an arrival', () => {
    expect(findCenterArrivalMs([point('06:20', near), point('06:25', far)], center)).toBeNull();
  });

  test('a stay shorter than 10 minutes is not an arrival', () => {
    expect(findCenterArrivalMs([point('09:00', near), point('09:05', near), point('09:09', far)], center)).toBeNull();
  });

  test('a stay of 10 minutes or more arrives at its first point, after a pass-by', () => {
    const samples = [
      point('06:00', near), point('06:03', far),
      point('09:00', near), point('09:10', near), point('09:30', far),
    ];
    expect(findCenterArrivalMs(samples, center)).toBe(at('09:00').getTime());
  });

  test('the stay lasts until the first point outside, so sparse points count the whole wait', () => {
    expect(findCenterArrivalMs([point('09:00', near), point('09:12', far)], center)).toBe(at('09:00').getTime());
  });

  test('a stay still going at the latest point counts when it is long enough', () => {
    expect(findCenterArrivalMs([point('09:00', near), point('09:20', near)], center)).toBe(at('09:00').getTime());
    expect(findCenterArrivalMs([point('09:00', near), point('09:05', near)], center)).toBeNull();
  });

  test('no departure location gives no arrival', () => {
    expect(findCenterArrivalMs([point('09:00', near), point('09:20', near)], null)).toBeNull();
  });
});

describe('findLastStopReached', () => {
  const event = (eventType: string, time: string) => ({ eventType, occurredAt: at(time) });

  test('the arrival event wins over a later delivery', () => {
    const result = findLastStopReached([
      { events: [event('STOP_ARRIVED', '10:00'), event('STOP_DELIVERED', '10:20')] },
      { events: [event('STOP_ARRIVED', '11:00'), event('STOP_DELIVERED', '12:00')] },
    ]);
    expect(result).toEqual({ endedAtMs: at('11:00').getTime(), source: 'STOP_ARRIVED' });
  });

  test('a result event stands in when there is no arrival event', () => {
    const result = findLastStopReached([
      { events: [event('STOP_ARRIVED', '10:00')] },
      { events: [event('STOP_FAILED', '11:30')] },
    ]);
    expect(result).toEqual({ endedAtMs: at('11:30').getTime(), source: 'STOP_RESULT' });
  });

  test('any stop not reached leaves the end open', () => {
    expect(findLastStopReached([
      { events: [event('STOP_ARRIVED', '10:00')] },
      { events: [event('ROUTE_STARTED', '09:00')] },
    ])).toBeNull();
    expect(findLastStopReached([])).toBeNull();
  });
});

describe('trimTrailToServiceWindow', () => {
  const times = ['00:00', '06:20', '06:40', '07:10', '09:00', '12:00'].map((time) => at(time).toISOString());
  const line = times.map((_, index) => [127 + index / 1000, 37.5] as [number, number]);
  const startMs = Date.parse(times[1]!);
  const endMs = Date.parse(times[4]!);

  function fixture(): { dailyRoute: UvisVehicleDailyRoute; sessions: TestSession[] } {
    return {
      dailyRoute: {
        anchors: times.map((observedAt, coordinateIndex) => ({ coordinateIndex, observedAt })),
        bridges: [
          { fromObservedAt: times[2]!, reason: 'GPS_GAP' as const, toObservedAt: times[3]! },
          { fromObservedAt: times[4]!, reason: 'GPS_GAP' as const, toObservedAt: times[5]! },
        ],
        coordinates: line,
        sourceSampleCount: 6,
        type: 'LineString' as const,
      },
      sessions: [{
        segments: [{
          roadMatchedGeometry: {
            anchors: times.map((observedAt, coordinateIndex) => ({ coordinateIndex, lineIndex: 0, observedAt })),
            coordinates: [line],
            type: 'MultiLineString' as const,
          },
          samples: times.map((observedAt) => ({ observedAt })),
          trailMarker: { kind: 'START' as const, latitude: 37.5, longitude: 127, observedAt: times[0]! },
        }],
      }, {
        segments: [{ samples: [{ observedAt: times[5]! }] }],
      }],
    };
  }

  test('keeps only samples, geometry anchors, daily anchors and bridges inside the window', () => {
    const { dailyRoute, sessions } = fixture();
    const trimmed = trimTrailToServiceWindow(sessions, dailyRoute, { endMs, startMs });
    const segment = trimmed.sessions[0]!.segments[0]!;
    expect(segment.samples.map((sample) => sample.observedAt)).toEqual(times.slice(1, 5));
    expect(segment.trailMarker).toBeNull();
    expect(segment.roadMatchedGeometry?.anchors?.map((anchor) => [anchor.lineIndex, anchor.coordinateIndex]))
      .toEqual([[0, 0], [0, 1], [0, 2], [0, 3]]);
    expect(segment.roadMatchedGeometry?.coordinates).toEqual([line.slice(1, 5)]);
    expect(trimmed.dailyRoute?.anchors.map((anchor) => anchor.coordinateIndex)).toEqual([0, 1, 2, 3]);
    expect(trimmed.dailyRoute?.coordinates).toEqual(line.slice(1, 5));
    expect(trimmed.dailyRoute?.bridges).toEqual([
      { fromObservedAt: times[2], reason: 'GPS_GAP', toObservedAt: times[3] },
    ]);
  });

  test('removes segments and sessions left without samples', () => {
    const { dailyRoute, sessions } = fixture();
    const trimmed = trimTrailToServiceWindow(sessions, dailyRoute, { endMs, startMs });
    expect(trimmed.sessions).toHaveLength(1);
    const empty = trimTrailToServiceWindow(sessions, dailyRoute, { endMs: startMs - 1, startMs: startMs - 60_000 });
    expect(empty.sessions).toEqual([]);
    expect(empty.dailyRoute).toBeNull();
  });

  test('an open end keeps everything after the start, bridges included', () => {
    const { dailyRoute, sessions } = fixture();
    const trimmed = trimTrailToServiceWindow(sessions, dailyRoute, { endMs: null, startMs });
    expect(trimmed.sessions).toHaveLength(2);
    expect(trimmed.sessions[0]!.segments[0]!.samples).toHaveLength(5);
    expect(trimmed.dailyRoute?.bridges).toHaveLength(2);
  });

  test('the cut daily route keeps what the web adapter requires', () => {
    const { dailyRoute, sessions } = fixture();
    const trimmed = trimTrailToServiceWindow(sessions, dailyRoute, { endMs, startMs }).dailyRoute;
    expect(trimmed?.sourceSampleCount).toBe(trimmed?.anchors.length);
    expect(trimmed?.sourceSampleCount).toBe(4);
  });

  test('a daily route whose kept anchors all sit on one coordinate is dropped', () => {
    const { dailyRoute, sessions } = fixture();
    dailyRoute.anchors = dailyRoute.anchors.map((anchor) => ({ ...anchor, coordinateIndex: 2 }));
    const trimmed = trimTrailToServiceWindow(sessions, dailyRoute, { endMs, startMs });
    expect(trimmed.dailyRoute).toBeNull();
  });

  test('an inferred tunnel is dropped when the anchor it points at is outside the window', () => {
    const { dailyRoute, sessions } = fixture();
    const tunnel = (fromObservedAt: string, confirmedByObservedAt: string) => ({
      confirmedByObservedAt,
      coordinates: [[127, 37.5], [127.001, 37.5]] as Array<[number, number]>,
      corridorId: 'test',
      fromObservedAt,
      source: 'OSRM_TUNNEL_ROUTE' as const,
      toObservedAt: times[3]!,
      type: 'LineString' as const,
    });
    dailyRoute.bridges = [
      { fromObservedAt: times[2]!, inferredTunnel: tunnel(times[2]!, times[4]!), reason: 'IMPLAUSIBLE_JUMP', toObservedAt: times[3]! },
    ];
    // confirmedBy (times[4]) is inside: the tunnel stays.
    const kept = trimTrailToServiceWindow(sessions, dailyRoute, { endMs, startMs }).dailyRoute;
    expect(kept?.bridges[0]?.inferredTunnel).toBeDefined();
    // The window ends before confirmedBy: the bridge stays, the tunnel goes.
    const cut = trimTrailToServiceWindow(sessions, dailyRoute, { endMs: Date.parse(times[3]!), startMs }).dailyRoute;
    expect(cut?.bridges).toHaveLength(1);
    expect(cut?.bridges[0]).not.toHaveProperty('inferredTunnel');
  });

  test('a geometry line with fewer than two anchors inside is dropped and lineIndex is renumbered', () => {
    const { sessions } = fixture();
    const geometry = {
      anchors: [
        { coordinateIndex: 0, lineIndex: 0, observedAt: times[0]! },
        { coordinateIndex: 1, lineIndex: 0, observedAt: times[1]! },
        { coordinateIndex: 0, lineIndex: 1, observedAt: times[2]! },
        { coordinateIndex: 1, lineIndex: 1, observedAt: times[3]! },
      ],
      coordinates: [line.slice(0, 2), line.slice(2, 4)],
      type: 'MultiLineString' as const,
    };
    sessions[0]!.segments[0]!.roadMatchedGeometry = geometry;
    const trimmed = trimTrailToServiceWindow(sessions, null, { endMs, startMs });
    const result = trimmed.sessions[0]!.segments[0]!.roadMatchedGeometry;
    expect(result?.coordinates).toEqual([line.slice(2, 4)]);
    expect(result?.anchors?.map((anchor) => [anchor.lineIndex, anchor.coordinateIndex])).toEqual([[0, 0], [0, 1]]);
    expect(trimmed.dailyRoute).toBeNull();
  });
});
