import { distanceMeters, hasImplausibleGpsJump } from './uvis-vehicle-trail-evidence.js';
import { HONGJIMUN_JEONGNEUNG_EASTBOUND } from './uvis-tunnel-corridor.js';

type TunnelSample = {
  ignitionOn?: boolean | null;
  latitude: number;
  longitude: number;
  observedAt: string;
  observedAtMs: number;
  speedKph?: number | null;
};

type Projection = {
  coordinate: [number, number];
  distanceMeters: number;
  positionMeters: number;
  segmentIndex: number;
};

export type InferredTunnelBridge = {
  corridorId: string;
  coordinates: Array<[number, number]>;
  fromObservedAt: string;
  source: 'CURATED_OSM_TUNNEL_CORRIDOR';
  toObservedAt: string;
  type: 'LineString';
};

const corridor = HONGJIMUN_JEONGNEUNG_EASTBOUND;
const cumulativeMeters = corridor.coordinates.map((coordinate, index) => (
  index === 0 ? 0 : distanceMeters(
    toPoint(corridor.coordinates[index - 1]!),
    toPoint(coordinate),
  )
));
for (let index = 1; index < cumulativeMeters.length; index += 1) {
  cumulativeMeters[index] = cumulativeMeters[index]! + cumulativeMeters[index - 1]!;
}

// The curated corridor is one-way and has no highway branch between these portals.
// Do not extend this inference to other tunnels without a separately reviewed corridor.
export function inferUnbranchedTunnelBridge(
  samples: readonly TunnelSample[],
  jumpIndex: number,
  anchorFor: (sample: TunnelSample) => [number, number] | null,
): InferredTunnelBridge | null {
  const exit = samples[jumpIndex];
  const frozen = samples[jumpIndex - 1];
  const after = samples[jumpIndex + 1];
  if (exit === undefined || frozen === undefined || after === undefined
    || !hasImplausibleGpsJump(frozen, exit)) return null;

  let firstFrozenIndex = jumpIndex - 1;
  while (firstFrozenIndex > 0) {
    const earlier = samples[firstFrozenIndex - 1]!;
    const later = samples[firstFrozenIndex]!;
    const intervalMs = later.observedAtMs - earlier.observedAtMs;
    if (intervalMs < 30_000 || intervalMs > 90_000
      || distanceMeters(earlier, frozen) > 10) break;
    firstFrozenIndex -= 1;
  }
  const firstFrozen = samples[firstFrozenIndex]!;
  const before = samples[firstFrozenIndex - 1];
  const frozenRun = samples.slice(firstFrozenIndex, jumpIndex);
  const elapsedMs = exit.observedAtMs - firstFrozen.observedAtMs;
  if (before === undefined || frozenRun.length < 4 || elapsedMs < 180_000 || elapsedMs > 600_000
    || frozenRun.some((sample) => sample.ignitionOn !== true)
    || frozenRun.slice(1).filter((sample) => (sample.speedKph ?? 0) >= 200).length < 2
    || !nearbyTime(before, firstFrozen) || !nearbyTime(frozen, exit) || !nearbyTime(exit, after)
    || hasImplausibleGpsJump(before, firstFrozen) || hasImplausibleGpsJump(exit, after)) return null;

  const selected = [before, firstFrozen, exit, after];
  const projections: Projection[] = [];
  const anchorProjections: Projection[] = [];
  for (const sample of selected) {
    const anchor = anchorFor(sample);
    if (anchor === null || distanceMeters(sample, toPoint(anchor)) > 50) return null;
    const projection = project([sample.longitude, sample.latitude]);
    const anchorProjection = project(anchor);
    if (projection.distanceMeters > 50 || anchorProjection.distanceMeters > 35) return null;
    projections.push(projection);
    anchorProjections.push(anchorProjection);
  }
  const [beforeProjection, entryProjection, exitProjection, afterProjection] = projections as [
    Projection, Projection, Projection, Projection,
  ];
  const [beforeAnchor, entryAnchor, exitAnchor, afterAnchor] = anchorProjections as [
    Projection, Projection, Projection, Projection,
  ];
  const westPortal = cumulativeMeters[corridor.westPortalIndex]!;
  const eastPortal = cumulativeMeters[corridor.eastPortalIndex]!;
  const reviewedEnd = cumulativeMeters[corridor.reviewedEndIndex]!;
  const roadMeters = exitProjection.positionMeters - entryProjection.positionMeters;
  const directMeters = distanceMeters(firstFrozen, exit);
  if (beforeProjection.positionMeters + 50 >= entryProjection.positionMeters
    || beforeAnchor.positionMeters + 50 >= entryAnchor.positionMeters
    || entryProjection.positionMeters < westPortal - 120
    || entryProjection.positionMeters > westPortal + 120
    || entryAnchor.positionMeters < westPortal - 120
    || entryAnchor.positionMeters > westPortal + 120
    || exitProjection.positionMeters < eastPortal
    || exitProjection.positionMeters > reviewedEnd
    || exitAnchor.positionMeters < eastPortal
    || exitAnchor.positionMeters > reviewedEnd
    || afterProjection.positionMeters < exitProjection.positionMeters + 50
    || afterAnchor.positionMeters < exitAnchor.positionMeters + 50
    || roadMeters < 3_000 || roadMeters > directMeters * 1.35
    || roadMeters / (elapsedMs / 1000) > 35) return null;

  const coordinates: Array<[number, number]> = [
    [firstFrozen.longitude, firstFrozen.latitude],
    entryProjection.coordinate,
  ];
  for (let index = entryProjection.segmentIndex + 1; index <= exitProjection.segmentIndex; index += 1) {
    coordinates.push(corridor.coordinates[index]!);
  }
  coordinates.push(exitProjection.coordinate, [exit.longitude, exit.latitude]);
  return {
    corridorId: corridor.id,
    coordinates: deduplicate(coordinates),
    fromObservedAt: firstFrozen.observedAt,
    source: 'CURATED_OSM_TUNNEL_CORRIDOR',
    toObservedAt: exit.observedAt,
    type: 'LineString',
  };
}

function nearbyTime(before: TunnelSample, after: TunnelSample): boolean {
  const elapsedMs = after.observedAtMs - before.observedAtMs;
  return elapsedMs >= 30_000 && elapsedMs <= 120_000;
}

function project(point: [number, number]): Projection {
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
