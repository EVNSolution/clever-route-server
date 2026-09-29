import {
  filterDistantRoadMatchedAnchors,
  type UvisVehicleTrailDocumentV1,
} from './uvis-vehicle-trail-materializer.js';

const MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND = 55;

type DailyRouteSample = {
  latitude: number;
  longitude: number;
  observedAt: string;
  staleAfter: string;
};

type PreparedSample = DailyRouteSample & {
  observedAtMs: number;
};

type TrustedAnchor = {
  coordinateIndex: number;
  line: Array<[number, number]>;
  lineIndex: number;
  segmentIndex: number;
};

export type UvisVehicleDailyRoute = {
  anchors: Array<{
    coordinateIndex: number;
    observedAt: string;
  }>;
  bridges: Array<{
    fromObservedAt: string;
    reason: 'GPS_GAP' | 'NO_MATCH';
    toObservedAt: string;
  }>;
  coordinates: Array<[number, number]>;
  sourceSampleCount: number;
  type: 'LineString';
};

export function buildUvisVehicleDailyRoute(
  samples: DailyRouteSample[],
  trailDocument: UvisVehicleTrailDocumentV1 | null,
): UvisVehicleDailyRoute | null {
  const prepared = prepareSamples(samples);
  if (prepared.length < 2 || distinctCoordinateCount(prepared) < 2) return null;

  const trustedAnchors = readTrustedAnchors(trailDocument);
  const coordinates: Array<[number, number]> = [];
  const anchors: UvisVehicleDailyRoute['anchors'] = [];
  const bridges: UvisVehicleDailyRoute['bridges'] = [];

  const first = prepared[0]!;
  const firstTrusted = trustedAnchors.get(first.observedAt);
  const firstCoordinate = readAnchorCoordinate(firstTrusted) ?? rawCoordinate(first);
  anchors.push({ observedAt: first.observedAt, coordinateIndex: appendCoordinate(coordinates, firstCoordinate) });

  for (let index = 1; index < prepared.length; index += 1) {
    const previous = prepared[index - 1]!;
    const current = prepared[index]!;
    const previousTrusted = trustedAnchors.get(previous.observedAt);
    const currentTrusted = trustedAnchors.get(current.observedAt);
    const followsMatchedRoad = previousTrusted !== undefined
      && currentTrusted !== undefined
      && previousTrusted.segmentIndex === currentTrusted.segmentIndex
      && previousTrusted.lineIndex === currentTrusted.lineIndex
      && previousTrusted.coordinateIndex <= currentTrusted.coordinateIndex;

    let coordinateIndex: number;
    if (followsMatchedRoad) {
      const rangeStart = coordinates.length;
      let validRange = true;
      for (
        let roadIndex = previousTrusted.coordinateIndex + 1;
        roadIndex <= currentTrusted.coordinateIndex;
        roadIndex += 1
      ) {
        const roadCoordinate = previousTrusted.line[roadIndex];
        if (roadCoordinate === undefined || !isValidCoordinate(roadCoordinate)) {
          validRange = false;
          break;
        }
        appendCoordinate(coordinates, roadCoordinate);
      }
      const snapped = readAnchorCoordinate(currentTrusted);
      if (validRange && snapped !== null) coordinateIndex = appendCoordinate(coordinates, snapped);
      else {
        coordinates.splice(rangeStart);
        coordinateIndex = appendCoordinate(coordinates, rawCoordinate(current));
        bridges.push(toBridge(previous, current));
      }
    } else {
      const endpoint = readAnchorCoordinate(currentTrusted) ?? rawCoordinate(current);
      coordinateIndex = appendCoordinate(coordinates, endpoint);
      bridges.push(toBridge(previous, current));
    }
    anchors.push({ observedAt: current.observedAt, coordinateIndex });
  }

  if (coordinates.length < 2) {
    return trailDocument === null ? null : buildUvisVehicleDailyRoute(prepared, null);
  }

  return {
    type: 'LineString',
    coordinates,
    anchors,
    bridges,
    sourceSampleCount: prepared.length,
  };
}

function prepareSamples(samples: DailyRouteSample[]): PreparedSample[] {
  const chronological = samples.flatMap((sample, sourceIndex) => {
    const observedAtMs = Date.parse(sample.observedAt);
    if (!Number.isFinite(observedAtMs) || !isValidCoordinate(rawCoordinate(sample))) return [];
    return [{ ...sample, observedAtMs, sourceIndex }];
  }).sort((left, right) => left.observedAtMs - right.observedAtMs || left.sourceIndex - right.sourceIndex)
    .filter((sample, index, ordered) => (
      index === 0 || Math.floor(sample.observedAtMs / 1000) > Math.floor(ordered[index - 1]!.observedAtMs / 1000)
    ));
  if (chronological.length < 3) return chronological;

  const prepared: typeof chronological = [chronological[0]!];
  for (let index = 1; index < chronological.length - 1; index += 1) {
    const previous = prepared.at(-1)!;
    const current = chronological[index]!;
    const next = chronological[index + 1]!;
    if (!isIsolatedGpsJump(previous, current, next)) prepared.push(current);
  }
  prepared.push(chronological.at(-1)!);
  return prepared;
}

function isIsolatedGpsJump(previous: PreparedSample, current: PreparedSample, next: PreparedSample): boolean {
  return impliedSpeedMetersPerSecond(previous, current) > MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND
    && impliedSpeedMetersPerSecond(current, next) > MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND
    && impliedSpeedMetersPerSecond(previous, next) <= MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND;
}

function impliedSpeedMetersPerSecond(previous: PreparedSample, current: PreparedSample): number {
  const elapsedSeconds = (current.observedAtMs - previous.observedAtMs) / 1000;
  return elapsedSeconds > 0 ? distanceMeters(previous, current) / elapsedSeconds : Number.POSITIVE_INFINITY;
}

function distanceMeters(left: DailyRouteSample, right: DailyRouteSample): number {
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = degreesToRadians(right.latitude - left.latitude);
  const longitudeDelta = degreesToRadians(right.longitude - left.longitude);
  const leftLatitude = degreesToRadians(left.latitude);
  const rightLatitude = degreesToRadians(right.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function readTrustedAnchors(trailDocument: UvisVehicleTrailDocumentV1 | null): Map<string, TrustedAnchor> {
  const trusted = new Map<string, TrustedAnchor>();
  for (const [segmentIndex, segment] of (trailDocument?.segments ?? []).entries()) {
    const geometry = filterDistantRoadMatchedAnchors(segment.roadMatchedGeometry, segment.samples);
    if (geometry === null) continue;
    for (const anchor of geometry.anchors ?? []) {
      const line = geometry.coordinates[anchor.lineIndex];
      const coordinate = line?.[anchor.coordinateIndex];
      if (line === undefined || coordinate === undefined || !isValidCoordinate(coordinate)) continue;
      if (!trusted.has(anchor.observedAt)) {
        trusted.set(anchor.observedAt, { ...anchor, line, segmentIndex });
      }
    }
  }
  return trusted;
}

function readAnchorCoordinate(anchor: TrustedAnchor | undefined): [number, number] | null {
  if (anchor === undefined) return null;
  const coordinate = anchor.line[anchor.coordinateIndex];
  return coordinate !== undefined && isValidCoordinate(coordinate) ? coordinate : null;
}

function rawCoordinate(sample: DailyRouteSample): [number, number] {
  return [sample.longitude, sample.latitude];
}

function isValidCoordinate(coordinate: [number, number]): boolean {
  return Number.isFinite(coordinate[0])
    && Number.isFinite(coordinate[1])
    && coordinate[0] >= -180
    && coordinate[0] <= 180
    && coordinate[1] >= -90
    && coordinate[1] <= 90;
}

function appendCoordinate(coordinates: Array<[number, number]>, coordinate: [number, number]): number {
  const previous = coordinates.at(-1);
  if (previous?.[0] === coordinate[0] && previous[1] === coordinate[1]) return coordinates.length - 1;
  coordinates.push([coordinate[0], coordinate[1]]);
  return coordinates.length - 1;
}

function distinctCoordinateCount(samples: DailyRouteSample[]): number {
  return new Set(samples.map((sample) => `${sample.longitude},${sample.latitude}`)).size;
}

function toBridge(
  previous: PreparedSample,
  current: PreparedSample,
): UvisVehicleDailyRoute['bridges'][number] {
  const staleAfterMs = Date.parse(previous.staleAfter);
  return {
    fromObservedAt: previous.observedAt,
    toObservedAt: current.observedAt,
    reason: Number.isFinite(staleAfterMs) && staleAfterMs < current.observedAtMs ? 'GPS_GAP' : 'NO_MATCH',
  };
}
