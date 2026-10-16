import { distanceMeters } from '../uvis/uvis-vehicle-trail-evidence.js';
import type { RouteTrackingRoadMatchedGeometryV1 } from '../route-tracking/route-tracking.types.js';
import type { UvisVehicleDailyRoute } from '../uvis/uvis-vehicle-daily-route.js';
import type { UvisVehicleTrailMarker } from '../uvis/uvis-vehicle-trail-materializer.js';

// The center is the settings departure location. Over 30 days of raw GPS the nearest approach on a working day was
// at most 67 m and on any other day 2,703 m, so 300 m keeps a margin over GPS error and stays far from both.
export const SERVICE_WINDOW_CENTER_RADIUS_M = 300;
// Every working day had one stay of 13 minutes or more at the center. A pass-by takes about a minute.
export const SERVICE_WINDOW_CENTER_MIN_STAY_MS = 10 * 60_000;

export type DsvV1ServiceWindow = {
  endedAt: string | null;
  endSource: 'STOP_ARRIVED' | 'STOP_RESULT' | null;
  startedAt: string;
  startSource: 'CENTER_STAY';
};

export type ServiceWindowStop = {
  events: ReadonlyArray<{ eventType: string; occurredAt: Date }>;
};

type Point = { latitude: number; longitude: number; observedAt: Date };

/**
 * First point of the first stay inside the radius that lasted at least the minimum time.
 * A stay lasts from its first point to the first point outside the radius, or to its last inside point when the
 * samples end inside the radius.
 */
export function findCenterArrivalMs(
  samples: readonly Point[],
  center: { latitude: number; longitude: number } | null,
  radiusMeters = SERVICE_WINDOW_CENTER_RADIUS_M,
  minStayMs = SERVICE_WINDOW_CENTER_MIN_STAY_MS,
): number | null {
  if (center === null) return null;
  const points = samples
    .map((sample) => ({
      inside: distanceMeters(center, sample) <= radiusMeters,
      time: sample.observedAt.getTime(),
    }))
    .filter((point) => Number.isFinite(point.time))
    .sort((left, right) => left.time - right.time);
  let stayStart: number | null = null;
  let lastInside: number | null = null;
  for (const point of points) {
    if (point.inside) {
      stayStart ??= point.time;
      lastInside = point.time;
      continue;
    }
    if (stayStart !== null && point.time - stayStart >= minStayMs) return stayStart;
    stayStart = null;
    lastInside = null;
  }
  if (stayStart !== null && lastInside !== null && lastInside - stayStart >= minStayMs) return stayStart;
  return null;
}

/**
 * Arrival at the last stop. A stop is reached by its earliest STOP_ARRIVED, else its earliest STOP_DELIVERED or
 * STOP_FAILED. Any unreached stop (and no stops at all) leaves the end open.
 */
export function findLastStopReached(
  stops: readonly ServiceWindowStop[],
): { endedAtMs: number; source: 'STOP_ARRIVED' | 'STOP_RESULT' } | null {
  let last: { endedAtMs: number; source: 'STOP_ARRIVED' | 'STOP_RESULT' } | null = null;
  for (const stop of stops) {
    const earliest = (types: readonly string[]): number | null => {
      let found: number | null = null;
      for (const event of stop.events) {
        if (!types.includes(event.eventType)) continue;
        const time = event.occurredAt.getTime();
        if (Number.isFinite(time) && (found === null || time < found)) found = time;
      }
      return found;
    };
    const arrived = earliest(['STOP_ARRIVED']);
    const reached = arrived ?? earliest(['STOP_DELIVERED', 'STOP_FAILED']);
    if (reached === null) return null;
    if (last === null || reached > last.endedAtMs) {
      last = { endedAtMs: reached, source: arrived === null ? 'STOP_RESULT' : 'STOP_ARRIVED' };
    }
  }
  return last;
}

type Segment = {
  roadMatchedGeometry?: RouteTrackingRoadMatchedGeometryV1 | null;
  samples: Array<{ observedAt: string }>;
  trailMarker?: UvisVehicleTrailMarker | null;
};
type Session = { segments: Segment[] };

/** The trail history with only the points from startMs to endMs (open end when null). Raw samples stay stored. */
export function trimTrailToServiceWindow<TSession extends Session>(
  sessions: readonly TSession[],
  dailyRoute: UvisVehicleDailyRoute | null | undefined,
  window: { endMs: number | null; startMs: number },
): { dailyRoute: UvisVehicleDailyRoute | null | undefined; sessions: TSession[] } {
  const inside = (observedAt: string): boolean => {
    const time = Date.parse(observedAt);
    return Number.isFinite(time) && time >= window.startMs && (window.endMs === null || time <= window.endMs);
  };
  const trimmedSessions = sessions.flatMap((session) => {
    const segments = session.segments.flatMap((segment) => {
      const samples = segment.samples.filter((sample) => inside(sample.observedAt));
      if (samples.length === 0) return [];
      const trimmed: Segment = { ...segment, samples };
      if (segment.roadMatchedGeometry != null) trimmed.roadMatchedGeometry = trimGeometry(segment.roadMatchedGeometry, inside);
      if (segment.trailMarker != null && !inside(segment.trailMarker.observedAt)) trimmed.trailMarker = null;
      return [trimmed];
    });
    return segments.length === 0 ? [] : [{ ...session, segments }];
  });
  return {
    dailyRoute: dailyRoute == null ? dailyRoute : trimDailyRoute(dailyRoute, inside),
    sessions: trimmedSessions,
  };
}

function trimGeometry(
  geometry: RouteTrackingRoadMatchedGeometryV1,
  inside: (observedAt: string) => boolean,
): RouteTrackingRoadMatchedGeometryV1 | null {
  if (geometry.anchors === undefined) return geometry;
  const kept = geometry.anchors.filter((anchor) => inside(anchor.observedAt));
  const coordinates: RouteTrackingRoadMatchedGeometryV1['coordinates'] = [];
  const anchors: NonNullable<RouteTrackingRoadMatchedGeometryV1['anchors']> = [];
  geometry.coordinates.forEach((line, lineIndex) => {
    const own = kept.filter((anchor) => anchor.lineIndex === lineIndex);
    if (own.length < 2) return;
    const from = Math.min(...own.map((anchor) => anchor.coordinateIndex));
    const to = Math.max(...own.map((anchor) => anchor.coordinateIndex));
    const sliced = line.slice(from, to + 1);
    if (sliced.length < 2) return;
    for (const anchor of own) {
      anchors.push({ ...anchor, coordinateIndex: anchor.coordinateIndex - from, lineIndex: coordinates.length });
    }
    coordinates.push(sliced);
  });
  return coordinates.length === 0 ? null : { ...geometry, anchors, coordinates };
}

function trimDailyRoute(
  route: UvisVehicleDailyRoute,
  inside: (observedAt: string) => boolean,
): UvisVehicleDailyRoute | null {
  const kept = route.anchors.filter((anchor) => inside(anchor.observedAt));
  if (kept.length < 2) return null;
  const from = Math.min(...kept.map((anchor) => anchor.coordinateIndex));
  const to = Math.max(...kept.map((anchor) => anchor.coordinateIndex));
  return {
    ...route,
    anchors: kept.map((anchor) => ({ ...anchor, coordinateIndex: anchor.coordinateIndex - from })),
    bridges: route.bridges.filter((bridge) => inside(bridge.fromObservedAt) && inside(bridge.toObservedAt)),
    coordinates: route.coordinates.slice(from, to + 1),
  };
}
