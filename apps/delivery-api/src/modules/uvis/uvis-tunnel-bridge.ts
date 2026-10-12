import { distanceMeters, hasImplausibleGpsJump } from './uvis-vehicle-trail-evidence.js';
import { REVIEWED_TUNNEL_CORRIDORS } from './uvis-tunnel-corridor.js';

export type TunnelSample = {
  ignitionOn?: boolean | null;
  latitude: number;
  longitude: number;
  observedAt: string;
  observedAtMs: number;
  speedKph?: number | null;
  staleAfter: string;
};

type Projection = {
  coordinate: [number, number];
  distanceMeters: number;
  positionMeters: number;
  segmentIndex: number;
};

export type TunnelRoadAnchor = {
  coordinate: [number, number];
  coordinateIndex: number;
  lineIndex: number;
  segmentIndex: number;
};

type Corridor = (typeof REVIEWED_TUNNEL_CORRIDORS)[number];

export type InferredTunnelBridge = {
  confirmedByObservedAt: string;
  corridorId: string;
  coordinates: Array<[number, number]>;
  fromObservedAt: string;
  source: 'CURATED_OSM_TUNNEL_CORRIDOR' | 'OSRM_TUNNEL_ROUTE';
  toObservedAt: string;
  type: 'LineString';
};

const corridors = REVIEWED_TUNNEL_CORRIDORS.map((corridor) => {
  const cumulativeMeters = corridor.coordinates.map((coordinate, index) => (
    index === 0 ? 0 : distanceMeters(toPoint(corridor.coordinates[index - 1]!), toPoint(coordinate))
  ));
  for (let index = 1; index < cumulativeMeters.length; index += 1) {
    cumulativeMeters[index] = cumulativeMeters[index]! + cumulativeMeters[index - 1]!;
  }
  return { corridor, cumulativeMeters };
});

/** Waypoints for a driving route from the tunnel entry to the first fix after the exit, with travel bearings. */
export function tunnelRouteWaypoints(signature: TunnelSignature): [
  { bearingDegrees: number; coordinate: [number, number] },
  { bearingDegrees: number; coordinate: [number, number] },
] {
  const { before, entry, exit, witness } = signature;
  return [
    { bearingDegrees: bearingDegrees(before, entry), coordinate: [entry.longitude, entry.latitude] },
    { bearingDegrees: bearingDegrees(exit, witness), coordinate: [witness.longitude, witness.latitude] },
  ];
}

/**
 * Accepts the routed path only when it passes the exit fix and is a plausible drive for the frozen interval.
 * The path is cut at the exit fix. This covers every tunnel the routing engine knows, without curation.
 */
export function inferRoutedTunnelBridge(
  signature: TunnelSignature,
  route: { coordinates: Array<[number, number]> },
): InferredTunnelBridge | null {
  const { before, elapsedMs, entry, exit, witness } = signature;
  const first = route.coordinates[0];
  if (first === undefined || distanceMeters(entry, toPoint(first)) > 60
    || distanceMeters(before, entry) < 50 || distanceMeters(exit, witness) < 50) return null;
  let roadMeters = 0;
  let exitIndex = -1;
  let exitRoadMeters = 0;
  let nearestExitMeters = Infinity;
  for (let index = 0; index < route.coordinates.length; index += 1) {
    if (index > 0) roadMeters += distanceMeters(toPoint(route.coordinates[index - 1]!), toPoint(route.coordinates[index]!));
    const toExit = distanceMeters(exit, toPoint(route.coordinates[index]!));
    if (toExit < nearestExitMeters) {
      nearestExitMeters = toExit;
      exitIndex = index;
      exitRoadMeters = roadMeters;
    }
  }
  const directMeters = distanceMeters(entry, exit);
  if (
    exitIndex < 1 || nearestExitMeters > 60
    || directMeters < 500
    || exitRoadMeters < directMeters * 0.95
    || exitRoadMeters > directMeters * 1.35 + 300
    || exitRoadMeters / (elapsedMs / 1000) > 35
  ) return null;
  return {
    confirmedByObservedAt: witness.observedAt,
    coordinates: deduplicate([
      [entry.longitude, entry.latitude],
      ...route.coordinates.slice(0, exitIndex + 1),
      [exit.longitude, exit.latitude],
    ]),
    corridorId: 'osrm-route',
    fromObservedAt: entry.observedAt,
    source: 'OSRM_TUNNEL_ROUTE',
    toObservedAt: exit.observedAt,
    type: 'LineString',
  };
}

// A later observed, road-anchored position resolves the exit choice before inference.
export type TunnelSignature = {
  before: TunnelSample;
  elapsedMs: number;
  entry: TunnelSample;
  exit: TunnelSample;
  witness: TunnelSample;
};

/**
 * Recognizes the telematics pattern of a vehicle driving through a tunnel: the last fix repeats with a
 * no-fix speed (>= 200 km/h) for 3 to 15 minutes, then the next fresh fix jumps ahead and keeps moving.
 */
export function findTunnelSignature(samples: readonly TunnelSample[], jumpIndex: number): TunnelSignature | null {
  const exit = samples[jumpIndex];
  const frozen = samples[jumpIndex - 1];
  if (exit === undefined || frozen === undefined || exit.ignitionOn !== true
    || !hasImplausibleGpsJump(frozen, exit)) return null;

  let firstFrozenIndex = jumpIndex - 1;
  while (firstFrozenIndex > 0) {
    const earlier = samples[firstFrozenIndex - 1]!;
    const later = samples[firstFrozenIndex]!;
    if (!freshCadence(earlier, later) || distanceMeters(earlier, frozen) > 10) break;
    firstFrozenIndex -= 1;
  }
  const firstFrozen = samples[firstFrozenIndex]!;
  const before = samples[firstFrozenIndex - 1];
  const frozenRun = samples.slice(firstFrozenIndex, jumpIndex);
  const elapsedMs = exit.observedAtMs - firstFrozen.observedAtMs;
  const witness = downstreamWitness(samples, jumpIndex);
  if (before === undefined || frozenRun.length < 3 || elapsedMs < 180_000 || elapsedMs > 900_000
    || witness === null
    || frozenRun.some((sample) => sample.ignitionOn !== true)
    || frozenRun.slice(1).filter((sample) => (sample.speedKph ?? 0) >= 200).length < 2
    || !freshCadence(before, firstFrozen) || !freshCadence(frozen, exit)
    || hasImplausibleGpsJump(before, firstFrozen)) return null;
  return { before, elapsedMs, entry: firstFrozen, exit, witness };
}

export function inferReviewedTunnelBridge(
  samples: readonly TunnelSample[],
  jumpIndex: number,
  anchorFor: (sample: TunnelSample) => TunnelRoadAnchor | null,
): InferredTunnelBridge | null {
  const signature = findTunnelSignature(samples, jumpIndex);
  if (signature === null) return null;
  const { before, elapsedMs, entry: firstFrozen, exit, witness } = signature;

  const beforeAnchor = anchorFor(before);
  const entryAnchor = anchorFor(firstFrozen);
  const exitAnchor = anchorFor(exit);
  const witnessAnchor = anchorFor(witness);
  if (beforeAnchor === null || entryAnchor === null || exitAnchor === null || witnessAnchor === null
    || !progressesOnMatchedLine(beforeAnchor, entryAnchor)
    || !progressesOnMatchedLine(exitAnchor, witnessAnchor)
    || distanceMeters(toPoint(beforeAnchor.coordinate), toPoint(entryAnchor.coordinate)) < 50
    || distanceMeters(toPoint(exitAnchor.coordinate), toPoint(witnessAnchor.coordinate)) < 50) return null;

  const candidates = corridors.flatMap(({ corridor, cumulativeMeters }) => {
    const inferred = inferOnCorridor({
      anchors: [beforeAnchor, entryAnchor, exitAnchor, witnessAnchor],
      corridor,
      cumulativeMeters,
      elapsedMs,
      samples: [before, firstFrozen, exit, witness],
    });
    return inferred === null ? [] : [inferred];
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

function inferOnCorridor(input: {
  anchors: [TunnelRoadAnchor, TunnelRoadAnchor, TunnelRoadAnchor, TunnelRoadAnchor];
  corridor: Corridor;
  cumulativeMeters: number[];
  elapsedMs: number;
  samples: [TunnelSample, TunnelSample, TunnelSample, TunnelSample];
}): InferredTunnelBridge | null {
  const { anchors, corridor, cumulativeMeters, elapsedMs, samples } = input;
  const [before, entry, exit, witness] = samples;
  if (samples.some((sample, index) =>
    distanceMeters(sample, toPoint(anchors[index]!.coordinate)) > corridor.maxRawAnchorMeters
  )) return null;

  const entryProjection = project([entry.longitude, entry.latitude], corridor, cumulativeMeters);
  const entryAnchorProjection = project(anchors[1].coordinate, corridor, cumulativeMeters);
  const exitProjection = project([exit.longitude, exit.latitude], corridor, cumulativeMeters);
  const exitAnchorProjection = project(anchors[2].coordinate, corridor, cumulativeMeters);
  if (entryProjection.distanceMeters > 50 || entryAnchorProjection.distanceMeters > 35
    || exitProjection.distanceMeters > corridor.maxExitRawCorridorMeters
    || exitAnchorProjection.distanceMeters > 35) return null;

  const westPortal = cumulativeMeters[corridor.westPortalIndex]!;
  const eastPortal = cumulativeMeters[corridor.eastPortalIndex]!;
  const reviewedEnd = cumulativeMeters[corridor.reviewedEndIndex]!;
  const minimumExit = corridor.decisionIndex === null ? eastPortal : Math.max(
    eastPortal,
    cumulativeMeters[corridor.decisionIndex]! + corridor.decisionMarginMeters,
  );
  const roadMeters = exitProjection.positionMeters - entryProjection.positionMeters;
  const directMeters = distanceMeters(entry, exit);
  if (entryProjection.positionMeters < westPortal - corridor.entryApproachMeters
    || entryProjection.positionMeters > westPortal + 120
    || entryAnchorProjection.positionMeters < westPortal - corridor.entryApproachMeters
    || entryAnchorProjection.positionMeters > westPortal + 120
    || exitProjection.positionMeters < minimumExit
    || exitProjection.positionMeters > reviewedEnd
    || exitAnchorProjection.positionMeters < minimumExit
    || exitAnchorProjection.positionMeters > reviewedEnd
    || roadMeters < 3_000 || roadMeters > directMeters * 1.35
    || roadMeters / (elapsedMs / 1000) > 35
    || distanceMeters(before, entry) < 50
    || distanceMeters(exit, witness) < 50) return null;

  const coordinates: Array<[number, number]> = [
    [entry.longitude, entry.latitude],
    entryProjection.coordinate,
  ];
  for (let index = entryProjection.segmentIndex + 1; index <= exitProjection.segmentIndex; index += 1) {
    coordinates.push(corridor.coordinates[index]!);
  }
  coordinates.push(exitProjection.coordinate, [exit.longitude, exit.latitude]);
  return {
    confirmedByObservedAt: witness.observedAt,
    corridorId: corridor.id,
    coordinates: deduplicate(coordinates),
    fromObservedAt: entry.observedAt,
    source: 'CURATED_OSM_TUNNEL_CORRIDOR',
    toObservedAt: exit.observedAt,
    type: 'LineString',
  };
}

function downstreamWitness(samples: readonly TunnelSample[], jumpIndex: number): TunnelSample | null {
  const exit = samples[jumpIndex]!;
  let previous = exit;
  for (let index = jumpIndex + 1; index <= Math.min(jumpIndex + 3, samples.length - 1); index += 1) {
    const current = samples[index]!;
    if (!freshCadence(previous, current) || current.ignitionOn !== true) return null;
    if (distanceMeters(exit, current) <= 10) {
      if ((current.speedKph ?? 0) < 200) return null;
      previous = current;
      continue;
    }
    return (current.speedKph === null || current.speedKph === undefined || current.speedKph < 200)
      && distanceMeters(exit, current) >= 50 && !hasImplausibleGpsJump(exit, current)
      ? current : null;
  }
  return null;
}

function progressesOnMatchedLine(before: TunnelRoadAnchor, after: TunnelRoadAnchor): boolean {
  return before.segmentIndex === after.segmentIndex
    && before.lineIndex === after.lineIndex
    && after.coordinateIndex > before.coordinateIndex;
}

// The collector defines freshness: staleAfter is recordedAt + 2 polls, so one missed poll is still fresh.
// A fixed cap tighter than that broke the Seobu underground pass on 2026-10-12 after a single missed poll.
function freshCadence(before: TunnelSample, after: TunnelSample): boolean {
  const elapsedMs = after.observedAtMs - before.observedAtMs;
  const staleAfterMs = Date.parse(before.staleAfter);
  return elapsedMs >= 30_000 && Number.isFinite(staleAfterMs) && staleAfterMs >= after.observedAtMs;
}

function project(point: [number, number], corridor: Corridor, cumulativeMeters: number[]): Projection {
  const metersPerLongitude = 111_195 * Math.cos(37.6 * Math.PI / 180);
  const metersPerLatitude = 111_195;
  const x = point[0] * metersPerLongitude;
  const y = point[1] * metersPerLatitude;
  let nearest: Projection | null = null;
  for (let index = 0; index < corridor.coordinates.length - 1; index += 1) {
    const start = corridor.coordinates[index]!;
    const end = corridor.coordinates[index + 1]!;
    const startX = start[0] * metersPerLongitude;
    const startY = start[1] * metersPerLatitude;
    const dx = (end[0] - start[0]) * metersPerLongitude;
    const dy = (end[1] - start[1]) * metersPerLatitude;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) continue;
    const fraction = Math.max(0, Math.min(1, ((x - startX) * dx + (y - startY) * dy) / lengthSquared));
    const distance = Math.hypot(x - startX - dx * fraction, y - startY - dy * fraction);
    if (nearest === null || distance < nearest.distanceMeters) {
      nearest = {
        coordinate: [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction],
        distanceMeters: distance,
        positionMeters: cumulativeMeters[index]! + (cumulativeMeters[index + 1]! - cumulativeMeters[index]!) * fraction,
        segmentIndex: index,
      };
    }
  }
  return nearest!;
}

function bearingDegrees(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }): number {
  const radians = Math.PI / 180;
  const y = Math.sin((to.longitude - from.longitude) * radians) * Math.cos(to.latitude * radians);
  const x = Math.cos(from.latitude * radians) * Math.sin(to.latitude * radians)
    - Math.sin(from.latitude * radians) * Math.cos(to.latitude * radians) * Math.cos((to.longitude - from.longitude) * radians);
  return (Math.atan2(y, x) / radians + 360) % 360;
}

function toPoint(coordinate: [number, number]): { latitude: number; longitude: number } {
  return { latitude: coordinate[1], longitude: coordinate[0] };
}

function deduplicate(coordinates: Array<[number, number]>): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (const coordinate of coordinates) {
    if (result.length === 0 || distanceMeters(toPoint(coordinate), toPoint(result[result.length - 1]!)) > 1) {
      result.push(coordinate);
    }
  }
  return result;
}
