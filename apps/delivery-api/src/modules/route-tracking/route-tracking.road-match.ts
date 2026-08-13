import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import {
  coordinateInCoverage,
  normalizeRouteEngineBaseUrl,
  type RouteEngineCoverage,
} from '../route-plans/route-engine-coverage.js';
import { ROUTE_TRACKING_V1_POLICY } from './route-tracking.policy.js';
import {
  readRouteTrackingGeometryDocument,
  type RouteTrackingGeometryDocumentV1,
  type RouteTrackingGeometryRecord,
} from './route-tracking.geometry.js';
import type {
  RouteTrackingRoadMatchedGeometryV1,
  RouteTrackingRoadMatchedPathV1,
} from './route-tracking.types.js';

const ROUTE_TRACKING_ROAD_MATCH_SCHEMA_VERSION = 'route_tracking_road_match.v1';
const MIN_CONFIDENT_MATCH = 0.5;
const MAX_OSRM_MATCH_POINTS = 80;
const MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND = 55;
const EARTH_RADIUS_METERS = 6_371_000;

type FetchLike = (url: string, init: { method: 'GET'; redirect: 'error'; signal?: AbortSignal }) => Promise<Response>;

export type RouteTrackingRoadMatchProvider = {
  match(document: RouteTrackingGeometryDocumentV1): Promise<RouteTrackingRoadMatchedPathV1 | null>;
};

export type RouteTrackingRoadMatchOutcome = {
  path: RouteTrackingRoadMatchedPathV1 | null;
  retryable: boolean;
};

export type RouteTrackingRoadMatchClassifyingProvider = RouteTrackingRoadMatchProvider & {
  matchWithStatus(document: RouteTrackingGeometryDocumentV1): Promise<RouteTrackingRoadMatchOutcome>;
};

export type OsrmRouteTrackingRoadMatchProviderOptions = {
  baseUrls: Partial<Record<RouteEngineCoverage, string>>;
  fetch?: FetchLike | undefined;
  gpsPrecisionMeters?: number | undefined;
  maxMatchPoints?: number | undefined;
  timeoutMs?: number | undefined;
};

type MatchedLine = {
  confidence: number;
  coordinates: Array<[number, number]>;
};

type MatchChunkResult = {
  lastMatchedPosition: RouteTrackingRoadMatchedPathV1['lastMatchedPosition'];
  lines: MatchedLine[];
};

type MatchChunk = {
  coordinates: Array<[number, number]>;
  samples: RouteTrackingGeometryDocumentV1['samples'];
};

export class OsrmRouteTrackingRoadMatchProvider implements RouteTrackingRoadMatchProvider {
  private readonly baseUrls: Partial<Record<RouteEngineCoverage, string>>;
  private readonly fetch: FetchLike;
  private readonly gpsPrecisionMeters: number | null;
  private readonly maxMatchPoints: number;
  private readonly timeoutMs: number;

  constructor(options: OsrmRouteTrackingRoadMatchProviderOptions) {
    this.baseUrls = Object.fromEntries(
      Object.entries(options.baseUrls)
        .map(([coverage, baseUrl]) => [coverage, normalizeRouteEngineBaseUrl('OSRM', baseUrl)])
    );
    this.fetch = options.fetch ?? fetch;
    this.gpsPrecisionMeters = normalizeGpsPrecision(options.gpsPrecisionMeters);
    this.maxMatchPoints = normalizeMaxMatchPoints(options.maxMatchPoints);
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1000, Math.floor(options.timeoutMs))
        : 10000;
  }

  async match(document: RouteTrackingGeometryDocumentV1): Promise<RouteTrackingRoadMatchedPathV1 | null> {
    return (await this.matchWithStatus(document)).path;
  }

  async matchWithStatus(document: RouteTrackingGeometryDocumentV1): Promise<RouteTrackingRoadMatchOutcome> {
    const input = normalizeInputDocument(document);
    if (input.coordinates.length < 2) return { path: null, retryable: false };
    const coverage = selectCoverageForGps(input.coordinates, Object.keys(this.baseUrls) as RouteEngineCoverage[]);
    if (coverage === null) return { path: null, retryable: false };
    const baseUrl = this.baseUrls[coverage];
    if (baseUrl === undefined) return { path: null, retryable: false };

    const matchedLines: MatchedLine[] = [];
    let lastMatchedPosition: RouteTrackingRoadMatchedPathV1['lastMatchedPosition'] = null;
    let retryable = false;
    for (const chunk of splitForOsrmMatch(input, coverage, this.maxMatchPoints)) {
      if (chunk.coordinates.length < 2) continue;
      const result = await this.matchChunk(baseUrl, chunk);
      retryable ||= result.retryable;
      matchedLines.push(...result.lines);
      lastMatchedPosition = result.lastMatchedPosition ?? lastMatchedPosition;
    }
    if (matchedLines.length === 0 || lastMatchedPosition === null) return { path: null, retryable };

    const confident = matchedLines
      .filter((line) => line.confidence >= MIN_CONFIDENT_MATCH)
      .map((line) => line.coordinates);
    const uncertain = matchedLines
      .filter((line) => line.confidence < MIN_CONFIDENT_MATCH)
      .map((line) => line.coordinates);
    const matchedPointCount = [...confident, ...uncertain].reduce((sum, line) => sum + line.length, 0);
    if (matchedPointCount < 2) return { path: null, retryable };
    const lastSample = input.samples.at(-1)!;

    return {
      path: {
        coverage,
        inputPointCount: input.sourcePointCount,
        lastInputOccurredAt: lastSample.occurredAt,
        lastMatchedPosition,
        matchedGeometry: toMultiLineString(confident),
        matchedPointCount,
        schemaVersion: ROUTE_TRACKING_ROAD_MATCH_SCHEMA_VERSION,
        uncertainGeometry: toMultiLineString(uncertain),
        watermark: buildWatermark({
          coverage,
          inputPointCount: input.sourcePointCount,
          lastInputOccurredAt: lastSample.occurredAt,
          matchedPointCount,
          lines: [...confident, ...uncertain],
        }),
      },
      retryable,
    };
  }

  private async matchChunk(baseUrl: string, chunk: MatchChunk): Promise<MatchChunkResult & { retryable: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(buildMatchUrl(baseUrl, chunk, this.gpsPrecisionMeters), {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      return { lastMatchedPosition: null, lines: [], retryable: true };
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return { lastMatchedPosition: null, lines: [], retryable: response.status === 408 || response.status === 429 || response.status >= 500 };
    let retryable = false;
    const payload = await response.json().catch(() => {
      retryable = true;
      return null;
    });
    const lines = readMatchedLines(payload);
    return {
      lastMatchedPosition: readLastMatchedPositionFromResponse(payload, chunk, lines),
      lines,
      retryable,
    };
  }
}

export function buildRouteTrackingRoadMatchedPath(
  record: RouteTrackingGeometryRecord | null | undefined,
): RouteTrackingRoadMatchedPathV1 | null {
  if (record === null || record === undefined) return null;
  const coverage = readCoverage(record.roadMatchedCoverage);
  const inputPointCount = readPositiveInteger(record.roadMatchedSourcePointCount);
  const matchedPointCount = readPositiveInteger(record.roadMatchedPointCount);
  const lastInputOccurredAt = record.roadMatchedLastInputOccurredAt;
  const watermark = readText(record.roadMatchedWatermark);
  if (
    coverage === null ||
    inputPointCount === null ||
    matchedPointCount === null ||
    lastInputOccurredAt === null ||
    lastInputOccurredAt === undefined ||
    watermark === null ||
    record.roadMatchedSchemaVersion !== ROUTE_TRACKING_ROAD_MATCH_SCHEMA_VERSION
  ) {
    return null;
  }

  return {
    coverage,
    inputPointCount,
    lastInputOccurredAt: lastInputOccurredAt.toISOString(),
    lastMatchedPosition: readLastMatchedPosition(record.roadMatchedLastPosition),
    matchedGeometry: readMultiLineString(record.roadMatchedGeometry),
    matchedPointCount,
    schemaVersion: ROUTE_TRACKING_ROAD_MATCH_SCHEMA_VERSION,
    uncertainGeometry: readMultiLineString(record.roadMatchedUncertainGeometry),
    watermark,
  };
}

export function shouldRefreshRouteTrackingRoadMatchedPath(record: RouteTrackingGeometryRecord | null | undefined): boolean {
  if (record === null || record === undefined) return false;
  const document = readRouteTrackingGeometryDocument(record);
  if (document.coordinates.length < 2) return false;
  if (record.roadMatchedSchemaVersion !== ROUTE_TRACKING_ROAD_MATCH_SCHEMA_VERSION) return true;
  if ((record.roadMatchedSourcePointCount ?? 0) < record.sourcePointCount) return true;
  if (record.roadMatchedLastInputOccurredAt === null || record.roadMatchedLastInputOccurredAt === undefined) return true;
  return false;
}

export function buildRouteTrackingRoadMatchCacheWrite(path: RouteTrackingRoadMatchedPathV1): {
  roadMatchedCoverage: RouteEngineCoverage;
  roadMatchedGeometry: Prisma.JsonObject | typeof Prisma.JsonNull;
  roadMatchedLastInputOccurredAt: Date;
  roadMatchedLastPosition: Prisma.JsonObject | typeof Prisma.JsonNull;
  roadMatchedPointCount: number;
  roadMatchedSchemaVersion: typeof ROUTE_TRACKING_ROAD_MATCH_SCHEMA_VERSION;
  roadMatchedSourcePointCount: number;
  roadMatchedUncertainGeometry: Prisma.JsonObject | typeof Prisma.JsonNull;
  roadMatchedWatermark: string;
} {
  return {
    roadMatchedCoverage: path.coverage,
    roadMatchedGeometry: toJsonOrNull(path.matchedGeometry),
    roadMatchedLastInputOccurredAt: new Date(path.lastInputOccurredAt),
    roadMatchedLastPosition: toJsonOrNull(path.lastMatchedPosition),
    roadMatchedPointCount: path.matchedPointCount,
    roadMatchedSchemaVersion: ROUTE_TRACKING_ROAD_MATCH_SCHEMA_VERSION,
    roadMatchedSourcePointCount: path.inputPointCount,
    roadMatchedUncertainGeometry: toJsonOrNull(path.uncertainGeometry),
    roadMatchedWatermark: path.watermark,
  };
}

function normalizeInputDocument(document: RouteTrackingGeometryDocumentV1): RouteTrackingGeometryDocumentV1 {
  const usableLength = Math.min(document.coordinates.length, document.samples.length);
  const coordinates: Array<[number, number]> = [];
  const samples: RouteTrackingGeometryDocumentV1['samples'] = [];
  for (let index = 0; index < usableLength; index += 1) {
    const coordinate = document.coordinates[index]!;
    const sample = document.samples[index]!;
    if (isValidCoordinate(coordinate) && Number.isFinite(Date.parse(sample.occurredAt))) {
      coordinates.push(coordinate);
      samples.push(sample);
    }
  }
  return { coordinates, samples, sourcePointCount: Math.max(document.sourcePointCount, coordinates.length) };
}

function splitForOsrmMatch(
  document: RouteTrackingGeometryDocumentV1,
  coverage: RouteEngineCoverage,
  maxMatchPoints: number,
): MatchChunk[] {
  const byGap: MatchChunk[] = [];
  let current: MatchChunk = { coordinates: [], samples: [] };
  for (let index = 0; index < document.coordinates.length; index += 1) {
    const coordinate = document.coordinates[index]!;
    const sample = document.samples[index]!;
    if (!coordinateInCoverage({ latitude: coordinate[1], longitude: coordinate[0] }, coverage)) {
      if (current.coordinates.length >= 2) byGap.push(current);
      current = { coordinates: [], samples: [] };
      continue;
    }
    const previousSample = current.samples.at(-1);
    const previousCoordinate = current.coordinates.at(-1);
    const elapsedMs = previousSample === undefined
      ? null
      : Date.parse(sample.occurredAt) - Date.parse(previousSample.occurredAt);
    const isImplausibleJump = previousCoordinate !== undefined
      && elapsedMs !== null
      && elapsedMs > 0
      && distanceBetweenCoordinatesMeters(previousCoordinate, coordinate) / (elapsedMs / 1000)
        > MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND;
    if (
      previousSample !== undefined &&
      (elapsedMs !== null && elapsedMs > ROUTE_TRACKING_V1_POLICY.delayedThresholdMs || isImplausibleJump)
    ) {
      if (current.coordinates.length >= 2) byGap.push(current);
      current = { coordinates: [], samples: [] };
    }
    current.coordinates.push(coordinate);
    current.samples.push(sample);
  }
  if (current.coordinates.length >= 2) byGap.push(current);

  return byGap.flatMap((chunk) => splitByMaxPoints(chunk, maxMatchPoints));
}

function distanceBetweenCoordinatesMeters(left: [number, number], right: [number, number]): number {
  const leftLatitude = toRadians(left[1]);
  const rightLatitude = toRadians(right[1]);
  const latitudeDelta = rightLatitude - leftLatitude;
  const longitudeDelta = toRadians(right[0] - left[0]);
  const halfChord = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(halfChord)));
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function splitByMaxPoints(chunk: MatchChunk, maxMatchPoints: number): MatchChunk[] {
  if (chunk.coordinates.length <= maxMatchPoints) return [chunk];
  const chunks: MatchChunk[] = [];
  let start = 0;
  while (start < chunk.coordinates.length - 1) {
    const end = Math.min(chunk.coordinates.length, start + maxMatchPoints);
    const coordinates = chunk.coordinates.slice(start, end);
    const samples = chunk.samples.slice(start, end);
    if (coordinates.length >= 2) chunks.push({ coordinates, samples });
    if (end === chunk.coordinates.length) break;
    start = end - 1;
  }
  return chunks;
}

function normalizeMaxMatchPoints(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_OSRM_MATCH_POINTS;
  return Math.max(2, Math.min(100, Math.floor(value)));
}

function buildMatchUrl(baseUrl: string, chunk: MatchChunk, gpsPrecisionMeters: number | null): string {
  const coordinatePath = chunk.coordinates.map(([longitude, latitude]) => `${longitude},${latitude}`).join(';');
  const timestamps = chunk.samples
    .map((sample) => Math.floor(Date.parse(sample.occurredAt) / 1000))
    .join(';');
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    gaps: 'split',
    tidy: 'true',
    timestamps,
  });
  if (gpsPrecisionMeters !== null) {
    params.set('radiuses', chunk.coordinates.map(() => String(gpsPrecisionMeters)).join(';'));
  }
  return `${baseUrl}/match/v1/driving/${coordinatePath}?${params.toString()}`;
}

function readMatchedLines(payload: unknown): MatchedLine[] {
  const object = objectOrNull(payload);
  if (object?.code !== 'Ok' || !Array.isArray(object.matchings)) return [];
  return object.matchings.flatMap((matching) => {
    const match = objectOrNull(matching);
    const confidence = typeof match?.confidence === 'number' && Number.isFinite(match.confidence)
      ? match.confidence
      : 0;
    const geometry = readLineString(match?.geometry);
    return geometry === null ? [] : [{ confidence, coordinates: geometry }];
  });
}

function readLastMatchedPositionFromResponse(
  payload: unknown,
  chunk: MatchChunk,
  lines: MatchedLine[],
): RouteTrackingRoadMatchedPathV1['lastMatchedPosition'] {
  const tracepoints = objectOrNull(payload)?.tracepoints;
  if (Array.isArray(tracepoints)) {
    for (let index = Math.min(tracepoints.length, chunk.samples.length) - 1; index >= 0; index -= 1) {
      const tracepoint = objectOrNull(tracepoints[index]);
      const location = tracepoint?.location;
      if (!Array.isArray(location) || location.length < 2) continue;
      const coordinate: [number, number] = [Number(location[0]), Number(location[1])];
      if (!isValidCoordinate(coordinate)) continue;
      return {
        latitude: coordinate[1],
        longitude: coordinate[0],
        occurredAt: chunk.samples[index]!.occurredAt,
      };
    }
  }

  const fallbackCoordinate = lines.at(-1)?.coordinates.at(-1);
  const fallbackSample = chunk.samples.at(-1);
  return fallbackCoordinate === undefined || fallbackSample === undefined
    ? null
    : {
        latitude: fallbackCoordinate[1],
        longitude: fallbackCoordinate[0],
        occurredAt: fallbackSample.occurredAt,
      };
}

function readLineString(value: unknown): Array<[number, number]> | null {
  const object = objectOrNull(value);
  if (object?.type !== 'LineString' || !Array.isArray(object.coordinates)) return null;
  const coordinates = object.coordinates.flatMap((coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return [];
    const longitude = Number(coordinate[0]);
    const latitude = Number(coordinate[1]);
    return isValidCoordinate([longitude, latitude]) ? [[longitude, latitude] as [number, number]] : [];
  });
  const withoutClosedTail = removeClosedTail(coordinates);
  return withoutClosedTail.length >= 2 ? withoutClosedTail : null;
}

function removeClosedTail(coordinates: Array<[number, number]>): Array<[number, number]> {
  if (coordinates.length < 2) return coordinates;
  const first = coordinates[0]!;
  const last = coordinates.at(-1)!;
  return first[0] === last[0] && first[1] === last[1]
    ? coordinates.slice(0, -1)
    : coordinates;
}

function toMultiLineString(lines: Array<Array<[number, number]>>): RouteTrackingRoadMatchedGeometryV1 | null {
  const usableLines = lines
    .map(removeClosedTail)
    .filter((line) => line.length >= 2);
  return usableLines.length === 0
    ? null
    : { coordinates: usableLines, type: 'MultiLineString' };
}

function selectCoverageForGps(
  coordinates: Array<[number, number]>,
  configuredCoverages: RouteEngineCoverage[],
): RouteEngineCoverage | null {
  let selectedCoverage: RouteEngineCoverage | null = null;
  let selectedPointCount = 0;
  for (const coverage of configuredCoverages) {
    const pointCount = coordinates.filter(([longitude, latitude]) => (
      coordinateInCoverage({ latitude, longitude }, coverage)
    )).length;
    if (pointCount > selectedPointCount) {
      selectedCoverage = coverage;
      selectedPointCount = pointCount;
    }
  }
  return selectedPointCount >= 2 ? selectedCoverage : null;
}

function buildWatermark(input: {
  coverage: RouteEngineCoverage;
  inputPointCount: number;
  lastInputOccurredAt: string;
  matchedPointCount: number;
  lines: Array<Array<[number, number]>>;
}): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(input.lines))
    .digest('hex')
    .slice(0, 16);
  return [
    ROUTE_TRACKING_ROAD_MATCH_SCHEMA_VERSION,
    input.coverage,
    input.inputPointCount,
    input.matchedPointCount,
    input.lastInputOccurredAt,
    hash,
  ].join(':');
}

function readMultiLineString(value: unknown): RouteTrackingRoadMatchedGeometryV1 | null {
  const object = objectOrNull(value);
  if (object?.type !== 'MultiLineString' || !Array.isArray(object.coordinates)) return null;
  const coordinates = object.coordinates.flatMap((line) => {
    if (!Array.isArray(line)) return [];
    const coordinates = line.flatMap((coordinate) => {
      if (!Array.isArray(coordinate) || coordinate.length < 2) return [];
      const longitude = Number(coordinate[0]);
      const latitude = Number(coordinate[1]);
      return isValidCoordinate([longitude, latitude]) ? [[longitude, latitude] as [number, number]] : [];
    });
    const withoutClosedTail = removeClosedTail(coordinates);
    return withoutClosedTail.length >= 2 ? [withoutClosedTail] : [];
  });
  if (coordinates.length === 0) return null;
  const anchors = readGeometryAnchors(object.anchors, coordinates);
  return {
    ...(anchors.length === 0 ? {} : { anchors }),
    coordinates,
    type: 'MultiLineString',
  };
}

function readGeometryAnchors(
  value: unknown,
  coordinates: Array<Array<[number, number]>>,
): NonNullable<RouteTrackingRoadMatchedGeometryV1['anchors']> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const object = objectOrNull(item);
    const lineIndex = Number(object?.lineIndex);
    const coordinateIndex = Number(object?.coordinateIndex);
    const observedAt = typeof object?.observedAt === 'string' && Number.isFinite(Date.parse(object.observedAt))
      ? new Date(object.observedAt).toISOString()
      : null;
    if (
      !Number.isInteger(lineIndex)
      || !Number.isInteger(coordinateIndex)
      || lineIndex < 0
      || coordinateIndex < 0
      || coordinates[lineIndex]?.[coordinateIndex] === undefined
      || observedAt === null
    ) return [];
    return [{ observedAt, lineIndex, coordinateIndex }];
  }).sort(compareRoadMatchedAnchors);
}

function compareRoadMatchedAnchors(
  left: NonNullable<RouteTrackingRoadMatchedGeometryV1['anchors']>[number],
  right: NonNullable<RouteTrackingRoadMatchedGeometryV1['anchors']>[number],
): number {
  const timeOrder = Date.parse(left.observedAt) - Date.parse(right.observedAt);
  if (timeOrder !== 0) return timeOrder;
  const lineOrder = left.lineIndex - right.lineIndex;
  return lineOrder === 0 ? left.coordinateIndex - right.coordinateIndex : lineOrder;
}

function readLastMatchedPosition(value: unknown): RouteTrackingRoadMatchedPathV1['lastMatchedPosition'] {
  const object = objectOrNull(value);
  if (object === null) return null;
  const latitude = Number(object.latitude);
  const longitude = Number(object.longitude);
  const occurredAt = typeof object.occurredAt === 'string' && Number.isFinite(Date.parse(object.occurredAt))
    ? new Date(object.occurredAt).toISOString()
    : null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || occurredAt === null) return null;
  return { latitude, longitude, occurredAt };
}

function readCoverage(value: unknown): RouteEngineCoverage | null {
  return value === 'korea' || value === 'ontario' ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function toJsonOrNull(value: unknown): Prisma.JsonObject | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : value as Prisma.JsonObject;
}

function normalizeGpsPrecision(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * 100) / 100
    : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isValidCoordinate(coordinate: [number, number]): boolean {
  const [longitude, latitude] = coordinate;
  return Number.isFinite(latitude)
    && latitude >= -90
    && latitude <= 90
    && Number.isFinite(longitude)
    && longitude >= -180
    && longitude <= 180;
}
