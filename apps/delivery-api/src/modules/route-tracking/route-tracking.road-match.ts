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
  RouteTrackingSourceRangeV1,
} from './route-tracking.types.js';

const ROUTE_TRACKING_ROAD_MATCH_SCHEMA_VERSION = 'route_tracking_road_match.v1';
const ROUTE_TRACKING_ROAD_MATCH_CACHE_VERSION = 'route_tracking_road_match.v5';
const PREVIOUS_ROUTE_TRACKING_ROAD_MATCH_CACHE_VERSION = 'route_tracking_road_match.v4';
const LEGACY_ROUTE_TRACKING_ROAD_MATCH_CACHE_VERSION = 'route_tracking_road_match.v3';
const MIN_CONFIDENT_MATCH = 0.5;
const MIN_SOFT_MATCH_CONFIDENCE = 0.8;
const MAX_OSRM_MATCH_POINTS = 80;
const MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND = 55;
const EARTH_RADIUS_METERS = 6_371_000;
const MAX_GAP_SUPPLEMENT_CANDIDATES = 64;
const MAX_GAP_SUPPLEMENT_ELAPSED_MS = 120_000;
const MAX_GAP_SUPPLEMENT_ANCHOR_ACCURACY_METERS = 50;
const MAX_GAP_SUPPLEMENT_SPEED_METERS_PER_SECOND = 40;
const MAX_HARD_MATCH_SPEED_METERS_PER_SECOND = 55;
const MIN_GAP_SUPPLEMENT_DISTANCE_METERS = 15;
const MAX_GAP_SUPPLEMENT_DISTANCE_METERS = 750;
const MAX_CONTEXTUAL_SUPPLEMENT_ACCURACY_METERS = 400;
const MAX_CONTEXTUAL_SUPPLEMENT_DISTANCE_METERS = 3_000;
const MAX_CONTEXTUAL_SUPPLEMENT_ELAPSED_MS = 10 * 60_000;

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
  classificationMode?: 'bounded-per-leg' | 'legacy-whole-match' | undefined;
  fetch?: FetchLike | undefined;
  gpsPrecisionMeters?: number | undefined;
  maxMatchPoints?: number | undefined;
  timeoutMs?: number | undefined;
};

type MatchedLine = {
  confidence: number;
  coordinates: Array<[number, number]>;
  interpolationLevel: 0 | 1 | 2;
  sourceRange: RouteTrackingSourceRangeV1;
};

type MatchChunkResult = {
  lastMatchedPosition: RouteTrackingRoadMatchedPathV1['lastMatchedPosition'];
  lines: MatchedLine[];
};

type MatchChunk = {
  coordinates: Array<[number, number]>;
  samples: RouteTrackingGeometryDocumentV1['samples'];
};

type GapSupplementCandidate = {
  contextual: boolean;
  coordinates: Array<[number, number]>;
  endCoordinate: [number, number];
  elapsedSeconds: number;
  range: RouteTrackingSourceRangeV1;
  samples: RouteTrackingGeometryDocumentV1['samples'];
  startCoordinate: [number, number];
  straightDistanceMeters: number;
};

type InferredLine = {
  coordinates: Array<[number, number]>;
  sourceRange: RouteTrackingSourceRangeV1;
};

type GapSupplementResult = {
  line: InferredLine | null;
  retryable: boolean;
};

export class OsrmRouteTrackingRoadMatchProvider implements RouteTrackingRoadMatchProvider {
  private readonly baseUrls: Partial<Record<RouteEngineCoverage, string>>;
  private readonly classificationMode: 'bounded-per-leg' | 'legacy-whole-match';
  private readonly fetch: FetchLike;
  private readonly gpsPrecisionMeters: number | null;
  private readonly maxMatchPoints: number;
  private readonly timeoutMs: number;

  constructor(options: OsrmRouteTrackingRoadMatchProviderOptions) {
    this.baseUrls = Object.fromEntries(
      Object.entries(options.baseUrls)
        .map(([coverage, baseUrl]) => [coverage, normalizeRouteEngineBaseUrl('OSRM', baseUrl)])
    );
    this.classificationMode = options.classificationMode ?? 'bounded-per-leg';
    this.fetch = options.fetch ?? fetch;
    this.gpsPrecisionMeters = normalizeGpsPrecision(options.gpsPrecisionMeters);
    this.maxMatchPoints = normalizeMaxMatchPoints(options.maxMatchPoints);
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1000, Math.floor(options.timeoutMs))
        : 10000;
  }

  async match(document: RouteTrackingGeometryDocumentV1): Promise<RouteTrackingRoadMatchedPathV1 | null> {
    const outcome = await this.matchWithStatus(document);
    return outcome.retryable ? null : outcome.path;
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
    const maximumInputAccuracyMeters = this.classificationMode === 'legacy-whole-match'
      ? ROUTE_TRACKING_V1_POLICY.maxMatchAccuracyMeters
      : ROUTE_TRACKING_V1_POLICY.maxInterpolationAccuracyMeters;
    for (const chunk of splitForOsrmMatch(input, coverage, this.maxMatchPoints, maximumInputAccuracyMeters)) {
      if (chunk.coordinates.length < 2) continue;
      const result = await this.matchChunk(baseUrl, chunk, maximumInputAccuracyMeters);
      retryable ||= result.retryable;
      matchedLines.push(...result.lines);
      lastMatchedPosition = result.lastMatchedPosition ?? lastMatchedPosition;
    }
    const mergedLines = mergeAdjacentMatchedLines(matchedLines);
    const confident = mergedLines.filter((line) => line.interpolationLevel === 0);
    const moderate = mergedLines.filter((line) => line.interpolationLevel === 1);
    const uncertain = mergedLines.filter((line) => line.interpolationLevel === 2);
    const matchedPointCount = mergedLines.reduce((sum, line) => sum + line.coordinates.length, 0);
    const lastSample = input.samples.at(-1)!;
    const unmatchedRanges = buildUnmatchedRanges(input, [...confident, ...moderate]);
    const supplementOutcome = await this.inferLowAccuracyGaps(
      baseUrl,
      input,
      confident,
      [...confident, ...moderate],
      uncertain,
    );
    retryable ||= supplementOutcome.retryable;
    const inferredLines: InferredLine[] = [
      ...moderate.map(({ coordinates, sourceRange }) => ({ coordinates, sourceRange })),
      ...supplementOutcome.lines,
    ];
    const inferredGeometry = toInferredMultiLineString(inferredLines);
    const inferredRanges = inferredLines.map((line) => line.sourceRange);

    return {
      path: {
        coverage,
        inputPointCount: input.sourcePointCount,
        inferredGeometry,
        inferredRanges,
        lastInputOccurredAt: lastSample.occurredAt,
        lastMatchedPosition,
        matchedGeometry: toMultiLineString(confident),
        matchedRanges: confident.map((line) => line.sourceRange),
        matchedPointCount,
        qualityVersion: this.classificationMode === 'legacy-whole-match'
          ? 'gps_quality.v3'
          : 'gps_quality.v4',
        schemaVersion: ROUTE_TRACKING_ROAD_MATCH_SCHEMA_VERSION,
        uncertainGeometry: toMultiLineString(uncertain),
        uncertainRanges: uncertain.map((line) => line.sourceRange),
        unmatchedRanges,
        watermark: buildWatermark({
          coverage,
          inputPointCount: input.sourcePointCount,
          lastInputOccurredAt: lastSample.occurredAt,
          matchedPointCount,
          lines: [
            ...mergedLines.map((line) => line.coordinates),
            ...inferredLines.map((line) => line.coordinates),
          ],
        }),
      },
      retryable,
    };
  }

  private async matchChunk(
    baseUrl: string,
    chunk: MatchChunk,
    maximumInputAccuracyMeters: number,
  ): Promise<MatchChunkResult & { retryable: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(buildMatchUrl(baseUrl, chunk, this.gpsPrecisionMeters, maximumInputAccuracyMeters), {
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
    const lines = this.classificationMode === 'legacy-whole-match'
      ? readLegacyMatchedLines(payload, chunk)
      : readMatchedLines(payload, chunk);
    return {
      lastMatchedPosition: readLastMatchedPositionFromResponse(payload, chunk, lines),
      lines,
      retryable,
    };
  }

  private async inferLowAccuracyGaps(
    baseUrl: string,
    document: RouteTrackingGeometryDocumentV1,
    confidentLines: MatchedLine[],
    approvedLines: MatchedLine[],
    rejectedLines: MatchedLine[],
  ): Promise<{ lines: InferredLine[]; retryable: boolean }> {
    const candidates = buildGapSupplementCandidates(document, confidentLines, approvedLines, rejectedLines)
      .slice(0, MAX_GAP_SUPPLEMENT_CANDIDATES);
    const inferred: InferredLine[] = [];
    let retryable = false;
    for (let offset = 0; offset < candidates.length; offset += 4) {
      const batch = await Promise.all(candidates.slice(offset, offset + 4).map((candidate) => (
        this.routeGapSupplement(baseUrl, candidate)
      )));
      retryable ||= batch.some((result) => result.retryable);
      inferred.push(...batch.flatMap((result) => result.line === null ? [] : [result.line]));
    }
    const contextualCandidates = buildContextualGapSupplementCandidates(
      document,
      confidentLines,
      [
        ...approvedLines,
        ...inferred.map((line) => ({
          confidence: 1,
          coordinates: line.coordinates,
          interpolationLevel: 1 as const,
          sourceRange: line.sourceRange,
        })),
      ],
      rejectedLines,
    ).slice(0, MAX_GAP_SUPPLEMENT_CANDIDATES);
    for (let offset = 0; offset < contextualCandidates.length; offset += 2) {
      const batch = await Promise.all(contextualCandidates.slice(offset, offset + 2).map((candidate) => (
        this.routeGapSupplement(baseUrl, candidate)
      )));
      retryable ||= batch.some((result) => result.retryable);
      inferred.push(...batch.flatMap((result) => result.line === null ? [] : [result.line]));
    }
    return { lines: inferred, retryable };
  }

  private async routeGapSupplement(
    baseUrl: string,
    candidate: GapSupplementCandidate,
  ): Promise<GapSupplementResult> {
    if (!candidate.contextual && candidate.samples.length >= 3) return this.matchGapSupplement(baseUrl, candidate);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(buildGapSupplementUrl(baseUrl, candidate), {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      return { line: null, retryable: true };
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return { line: null, retryable: isRetryableStatus(response.status) };
    let parseFailed = false;
    const payload = await response.json().catch(() => {
      parseFailed = true;
      return null;
    });
    const coordinates = selectGapSupplementRoute(payload, candidate);
    return {
      line: coordinates === null ? null : { coordinates, sourceRange: candidate.range },
      retryable: parseFailed,
    };
  }

  private async matchGapSupplement(
    baseUrl: string,
    candidate: GapSupplementCandidate,
  ): Promise<GapSupplementResult> {
    const chunk = { coordinates: candidate.coordinates, samples: candidate.samples };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(buildMatchUrl(
        baseUrl,
        chunk,
        this.gpsPrecisionMeters,
        ROUTE_TRACKING_V1_POLICY.maxInterpolationAccuracyMeters,
      ), {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      return { line: null, retryable: true };
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return { line: null, retryable: isRetryableStatus(response.status) };
    let parseFailed = false;
    const payload = await response.json().catch(() => {
      parseFailed = true;
      return null;
    });
    const coordinates = selectStrictGapSupplementMatch(payload, candidate);
    return {
      line: coordinates === null ? null : { coordinates, sourceRange: candidate.range },
      retryable: parseFailed,
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
  const cacheVersion = record.roadMatchedSchemaVersion;
  if (
    coverage === null ||
    inputPointCount === null ||
    matchedPointCount === null ||
    lastInputOccurredAt === null ||
    lastInputOccurredAt === undefined ||
    watermark === null ||
    (cacheVersion !== ROUTE_TRACKING_ROAD_MATCH_CACHE_VERSION
      && cacheVersion !== PREVIOUS_ROUTE_TRACKING_ROAD_MATCH_CACHE_VERSION
      && cacheVersion !== LEGACY_ROUTE_TRACKING_ROAD_MATCH_CACHE_VERSION)
  ) {
    return null;
  }

  return {
    coverage,
    inferredGeometry: readEmbeddedInferredGeometry(record.roadMatchedGeometry, record.roadMatchedUncertainGeometry),
    inferredRanges: readEmbeddedInferredRanges(record.roadMatchedGeometry, record.roadMatchedUncertainGeometry),
    inputPointCount,
    lastInputOccurredAt: lastInputOccurredAt.toISOString(),
    lastMatchedPosition: readLastMatchedPosition(record.roadMatchedLastPosition),
    matchedGeometry: readMultiLineString(record.roadMatchedGeometry),
    matchedRanges: readMultiLineString(record.roadMatchedGeometry)?.sourceRanges ?? [],
    matchedPointCount,
    qualityVersion: cacheVersion === LEGACY_ROUTE_TRACKING_ROAD_MATCH_CACHE_VERSION
      ? 'gps_quality.v3'
      : 'gps_quality.v4',
    schemaVersion: ROUTE_TRACKING_ROAD_MATCH_SCHEMA_VERSION,
    uncertainGeometry: readMultiLineString(record.roadMatchedUncertainGeometry),
    uncertainRanges: readMultiLineString(record.roadMatchedUncertainGeometry)?.sourceRanges ?? [],
    unmatchedRanges: readEmbeddedUnmatchedRanges(record.roadMatchedGeometry, record.roadMatchedUncertainGeometry),
    watermark,
  };
}

export function shouldRefreshRouteTrackingRoadMatchedPath(record: RouteTrackingGeometryRecord | null | undefined): boolean {
  if (record === null || record === undefined) return false;
  const document = readRouteTrackingGeometryDocument(record);
  if (document.coordinates.length < 2) return false;
  if (record.roadMatchedSchemaVersion !== ROUTE_TRACKING_ROAD_MATCH_CACHE_VERSION) return true;
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
  roadMatchedSchemaVersion: typeof ROUTE_TRACKING_ROAD_MATCH_CACHE_VERSION;
  roadMatchedSourcePointCount: number;
  roadMatchedUncertainGeometry: Prisma.JsonObject | typeof Prisma.JsonNull;
  roadMatchedWatermark: string;
} {
  return {
    roadMatchedCoverage: path.coverage,
    roadMatchedGeometry: toJsonOrNull(embedRoadMatchMetadata(
      path.matchedGeometry,
      path.unmatchedRanges,
      path.inferredGeometry,
      path.inferredRanges,
    )),
    roadMatchedLastInputOccurredAt: new Date(path.lastInputOccurredAt),
    roadMatchedLastPosition: toJsonOrNull(path.lastMatchedPosition),
    roadMatchedPointCount: path.matchedPointCount,
    roadMatchedSchemaVersion: ROUTE_TRACKING_ROAD_MATCH_CACHE_VERSION,
    roadMatchedSourcePointCount: path.inputPointCount,
    roadMatchedUncertainGeometry: toJsonOrNull(embedRoadMatchMetadata(
      path.uncertainGeometry,
      path.unmatchedRanges,
      path.inferredGeometry,
      path.inferredRanges,
    )),
    roadMatchedWatermark: path.watermark,
  };
}

function normalizeInputDocument(document: RouteTrackingGeometryDocumentV1): RouteTrackingGeometryDocumentV1 {
  const usableLength = Math.min(document.coordinates.length, document.samples.length);
  const coordinates: Array<[number, number]> = [];
  const samples: RouteTrackingGeometryDocumentV1['samples'] = [];
  let forceGapBefore = false;
  for (let index = 0; index < usableLength; index += 1) {
    const coordinate = document.coordinates[index]!;
    const sample = document.samples[index]!;
    if (isValidCoordinate(coordinate) && Number.isFinite(Date.parse(sample.occurredAt))) {
      coordinates.push(coordinate);
      samples.push({
        ...sample,
        gapBefore: sample.gapBefore === true || forceGapBefore,
        sourceIndex: sample.sourceIndex ?? index,
      });
      forceGapBefore = false;
    } else {
      forceGapBefore = true;
    }
  }
  return { coordinates, samples, sourcePointCount: Math.max(document.sourcePointCount, coordinates.length) };
}

function splitForOsrmMatch(
  document: RouteTrackingGeometryDocumentV1,
  coverage: RouteEngineCoverage,
  maxMatchPoints: number,
  maximumInputAccuracyMeters: number,
): MatchChunk[] {
  const byGap: MatchChunk[] = [];
  let current: MatchChunk = { coordinates: [], samples: [] };
  for (let index = 0; index < document.coordinates.length; index += 1) {
    const coordinate = document.coordinates[index]!;
    const sample = document.samples[index]!;
    if (!coordinateInCoverage({ latitude: coordinate[1], longitude: coordinate[0] }, coverage)
      || (typeof sample.accuracyMeters === 'number' && (
        !Number.isFinite(sample.accuracyMeters)
        || sample.accuracyMeters < 0
        || sample.accuracyMeters > maximumInputAccuracyMeters
      ))) {
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
      (
        sample.gapBefore === true
        || previousSample.driverId !== sample.driverId
        || elapsedMs === null
        || elapsedMs <= 0
        || elapsedMs > ROUTE_TRACKING_V1_POLICY.delayedThresholdMs
        || isImplausibleJump
      )
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

function buildMatchUrl(
  baseUrl: string,
  chunk: MatchChunk,
  gpsPrecisionMeters: number | null,
  maximumInputAccuracyMeters: number,
): string {
  const coordinatePath = chunk.coordinates.map(([longitude, latitude]) => `${longitude},${latitude}`).join(';');
  const timestamps = chunk.samples
    .map((sample) => Math.floor(Date.parse(sample.occurredAt) / 1000))
    .join(';');
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    gaps: 'split',
    steps: 'true',
    tidy: 'true',
    timestamps,
  });
  if (gpsPrecisionMeters !== null || chunk.samples.some((sample) => (sample.accuracyMeters ?? 0) > 0)) {
    params.set('radiuses', chunk.samples.map((sample) => (
      typeof sample.accuracyMeters === 'number' && sample.accuracyMeters > 0
        ? String(Math.min(sample.accuracyMeters, maximumInputAccuracyMeters))
        : String(Math.min(gpsPrecisionMeters ?? 25, maximumInputAccuracyMeters))
    )).join(';'));
  }
  return `${baseUrl}/match/v1/driving/${coordinatePath}?${params.toString()}`;
}

function buildGapSupplementCandidates(
  document: RouteTrackingGeometryDocumentV1,
  confidentLines: MatchedLine[],
  approvedLines: MatchedLine[],
  rejectedLines: MatchedLine[],
): GapSupplementCandidate[] {
  const ranges = confidentLines.map((line) => line.sourceRange)
    .sort((left, right) => left.startSourceIndex - right.startSourceIndex);
  const approvedRanges = approvedLines.map((line) => line.sourceRange);
  const rejectedRanges = rejectedLines.map((line) => line.sourceRange);
  return ranges.slice(0, -1).flatMap((leftRange, index) => {
    const rightRange = ranges[index + 1]!;
    if (rightRange.startSourceIndex <= leftRange.endSourceIndex) return [];
    if (approvedRanges.some((range) => (
      range.startSourceIndex < rightRange.startSourceIndex
      && range.endSourceIndex > leftRange.endSourceIndex
      && !(range.startSourceIndex === leftRange.startSourceIndex && range.endSourceIndex === leftRange.endSourceIndex)
      && !(range.startSourceIndex === rightRange.startSourceIndex && range.endSourceIndex === rightRange.endSourceIndex)
    ))) return [];
    if (rejectedRanges.some((range) => (
      range.startSourceIndex < rightRange.startSourceIndex
      && range.endSourceIndex > leftRange.endSourceIndex
    ))) return [];
    const leftIndex = document.samples.findIndex((sample) => sample.sourceIndex === leftRange.endSourceIndex);
    const rightIndex = document.samples.findIndex((sample) => sample.sourceIndex === rightRange.startSourceIndex);
    if (leftIndex < 0 || rightIndex <= leftIndex) return [];
    const leftSample = document.samples[leftIndex]!;
    const rightSample = document.samples[rightIndex]!;
    const leftSourceIndex = leftSample.sourceIndex;
    const rightSourceIndex = rightSample.sourceIndex;
    if (
      typeof leftSample.accuracyMeters !== 'number'
      || typeof rightSample.accuracyMeters !== 'number'
      || leftSample.accuracyMeters > MAX_GAP_SUPPLEMENT_ANCHOR_ACCURACY_METERS
      || rightSample.accuracyMeters > MAX_GAP_SUPPLEMENT_ANCHOR_ACCURACY_METERS
      || typeof leftSample.driverId !== 'string'
      || leftSample.driverId.trim() === ''
      || leftSourceIndex === undefined
      || rightSourceIndex === undefined
      || !isSourceIndexCovered(leftSourceIndex, ranges)
      || !isSourceIndexCovered(rightSourceIndex, ranges)
    ) return [];
    const samples = document.samples.slice(leftIndex, rightIndex + 1);
    const coordinates = document.coordinates.slice(leftIndex, rightIndex + 1);
    if (
      samples.length !== coordinates.length
      || samples.slice(1).some((sample) => sample.gapBefore !== false)
      || samples.some((sample) => (
        typeof sample.accuracyMeters !== 'number'
        || !Number.isFinite(sample.accuracyMeters)
        || sample.accuracyMeters < 0
        || sample.accuracyMeters > ROUTE_TRACKING_V1_POLICY.maxInterpolationAccuracyMeters
        || sample.driverId !== leftSample.driverId
      ))
      || samples.slice(1).some((sample, sampleIndex) => {
        const previous = samples[sampleIndex]!;
        const elapsedMs = Date.parse(sample.occurredAt) - Date.parse(previous.occurredAt);
        if (!(elapsedMs > 0 && elapsedMs <= ROUTE_TRACKING_V1_POLICY.delayedThresholdMs)) return true;
        return distanceBetweenCoordinatesMeters(coordinates[sampleIndex]!, coordinates[sampleIndex + 1]!)
          / (elapsedMs / 1000) > MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND;
      })
    ) return [];
    const elapsedSeconds = (Date.parse(rightSample.occurredAt) - Date.parse(leftSample.occurredAt)) / 1000;
    if (!(elapsedSeconds > 0 && elapsedSeconds <= MAX_GAP_SUPPLEMENT_ELAPSED_MS / 1000)) return [];
    const startCoordinate = document.coordinates[leftIndex]!;
    const endCoordinate = document.coordinates[rightIndex]!;
    const straightDistanceMeters = distanceBetweenCoordinatesMeters(startCoordinate, endCoordinate);
    if (
      straightDistanceMeters < MIN_GAP_SUPPLEMENT_DISTANCE_METERS
      || straightDistanceMeters > MAX_GAP_SUPPLEMENT_DISTANCE_METERS
      || straightDistanceMeters / elapsedSeconds > MAX_GAP_SUPPLEMENT_SPEED_METERS_PER_SECOND
    ) return [];
    return [{
      contextual: false,
      coordinates,
      elapsedSeconds,
      endCoordinate,
      range: {
        endEventId: rightSample.eventId,
        endOccurredAt: rightSample.occurredAt,
        endSourceIndex: rightSourceIndex,
        interpolationLevel: 1,
        reason: samples.slice(1, -1).some((sample) => (
          sample.accuracyMeters! > ROUTE_TRACKING_V1_POLICY.maxMatchAccuracyMeters
        )) ? 'LOW_ACCURACY' : 'NO_MATCH',
        startEventId: leftSample.eventId,
        startOccurredAt: leftSample.occurredAt,
        startSourceIndex: leftSourceIndex,
      },
      samples,
      startCoordinate,
      straightDistanceMeters,
    }];
  });
}

function buildContextualGapSupplementCandidates(
  document: RouteTrackingGeometryDocumentV1,
  confidentLines: MatchedLine[],
  approvedLines: MatchedLine[],
  rejectedLines: MatchedLine[],
): GapSupplementCandidate[] {
  const ranges = confidentLines.map((line) => line.sourceRange)
    .sort((left, right) => left.startSourceIndex - right.startSourceIndex);
  const approvedRanges = approvedLines.map((line) => line.sourceRange);
  const rejectedRanges = rejectedLines.map((line) => line.sourceRange);
  return ranges.slice(0, -1).flatMap((leftRange, index) => {
    const rightRange = ranges[index + 1]!;
    if (rightRange.startSourceIndex <= leftRange.endSourceIndex + 1) return [];
    if (approvedRanges.some((range) => (
      range.startSourceIndex <= leftRange.endSourceIndex
      && range.endSourceIndex >= rightRange.startSourceIndex
    ))) return [];
    if (rejectedRanges.some((range) => (
      range.startSourceIndex < rightRange.startSourceIndex
      && range.endSourceIndex > leftRange.endSourceIndex
    ))) return [];
    const leftIndex = document.samples.findIndex((sample) => sample.sourceIndex === leftRange.endSourceIndex);
    const rightIndex = document.samples.findIndex((sample) => sample.sourceIndex === rightRange.startSourceIndex);
    if (leftIndex < 0 || rightIndex - leftIndex < 3) return [];
    const samples = document.samples.slice(leftIndex, rightIndex + 1);
    const coordinates = document.coordinates.slice(leftIndex, rightIndex + 1);
    const leftSample = samples[0]!;
    const rightSample = samples.at(-1)!;
    const driverId = leftSample.driverId;
    if (
      coordinates.length !== samples.length
      || typeof driverId !== 'string'
      || driverId.trim() === ''
      || typeof leftSample.accuracyMeters !== 'number'
      || typeof rightSample.accuracyMeters !== 'number'
      || leftSample.accuracyMeters > MAX_GAP_SUPPLEMENT_ANCHOR_ACCURACY_METERS
      || rightSample.accuracyMeters > MAX_GAP_SUPPLEMENT_ANCHOR_ACCURACY_METERS
      || samples.slice(1).some((sample) => sample.gapBefore !== false)
      || samples.some((sample) => (
        sample.driverId !== driverId
        || typeof sample.accuracyMeters !== 'number'
        || !Number.isFinite(sample.accuracyMeters)
        || sample.accuracyMeters < 0
        || sample.accuracyMeters > MAX_CONTEXTUAL_SUPPLEMENT_ACCURACY_METERS
      ))
      || !samples.slice(1, -1).some((sample) => (
        sample.accuracyMeters! > ROUTE_TRACKING_V1_POLICY.maxInterpolationAccuracyMeters
      ))
      || samples.slice(1).some((sample, sampleIndex) => {
        const previous = samples[sampleIndex]!;
        const elapsedMs = Date.parse(sample.occurredAt) - Date.parse(previous.occurredAt);
        if (!(elapsedMs > 0 && elapsedMs <= ROUTE_TRACKING_V1_POLICY.delayedThresholdMs)) return true;
        return distanceBetweenCoordinatesMeters(coordinates[sampleIndex]!, coordinates[sampleIndex + 1]!)
          / (elapsedMs / 1000) > MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND;
      })
    ) return [];
    const elapsedSeconds = (Date.parse(rightSample.occurredAt) - Date.parse(leftSample.occurredAt)) / 1000;
    const startCoordinate = coordinates[0]!;
    const endCoordinate = coordinates.at(-1)!;
    const straightDistanceMeters = distanceBetweenCoordinatesMeters(startCoordinate, endCoordinate);
    if (
      !(elapsedSeconds > 0 && elapsedSeconds <= MAX_CONTEXTUAL_SUPPLEMENT_ELAPSED_MS / 1000)
      || straightDistanceMeters < MIN_GAP_SUPPLEMENT_DISTANCE_METERS
      || straightDistanceMeters > MAX_CONTEXTUAL_SUPPLEMENT_DISTANCE_METERS
      || straightDistanceMeters / elapsedSeconds > MAX_GAP_SUPPLEMENT_SPEED_METERS_PER_SECOND
    ) return [];
    const startSourceIndex = leftSample.sourceIndex;
    const endSourceIndex = rightSample.sourceIndex;
    if (startSourceIndex === undefined || endSourceIndex === undefined) return [];
    return [{
      contextual: true,
      coordinates,
      elapsedSeconds,
      endCoordinate,
      range: {
        endEventId: rightSample.eventId,
        endOccurredAt: rightSample.occurredAt,
        endSourceIndex,
        interpolationLevel: 1,
        reason: 'LOW_ACCURACY',
        startEventId: leftSample.eventId,
        startOccurredAt: leftSample.occurredAt,
        startSourceIndex,
      },
      samples,
      startCoordinate,
      straightDistanceMeters,
    }];
  });
}

function isSourceIndexCovered(sourceIndex: number, ranges: RouteTrackingSourceRangeV1[]): boolean {
  return ranges.some((range) => sourceIndex >= range.startSourceIndex && sourceIndex <= range.endSourceIndex);
}

function buildGapSupplementUrl(baseUrl: string, candidate: GapSupplementCandidate): string {
  const coordinatePath = [candidate.startCoordinate, candidate.endCoordinate]
    .map(([longitude, latitude]) => `${longitude},${latitude}`)
    .join(';');
  const params = new URLSearchParams({
    alternatives: 'true',
    geometries: 'geojson',
    overview: 'full',
    radiuses: '50;50',
  });
  return `${baseUrl}/route/v1/driving/${coordinatePath}?${params.toString()}`;
}

function selectGapSupplementRoute(
  payload: unknown,
  candidate: GapSupplementCandidate,
): Array<[number, number]> | null {
  const object = objectOrNull(payload);
  if (object?.code !== 'Ok' || !Array.isArray(object.routes) || !Array.isArray(object.waypoints)) return null;
  const waypointLocations = object.waypoints.slice(0, 2).map((waypoint) => readCoordinatePair(objectOrNull(waypoint)?.location));
  const startWaypoint = waypointLocations[0];
  const endWaypoint = waypointLocations[1];
  if (
    waypointLocations.length !== 2
    || startWaypoint === null
    || startWaypoint === undefined
    || endWaypoint === null
    || endWaypoint === undefined
    || distanceBetweenCoordinatesMeters(candidate.startCoordinate, startWaypoint) > 50
    || distanceBetweenCoordinatesMeters(candidate.endCoordinate, endWaypoint) > 50
  ) return null;
  const maxRoadDistance = candidate.contextual
    ? Math.min(5_000, candidate.straightDistanceMeters * 2 + 100)
    : Math.min(1_250, candidate.straightDistanceMeters * 1.8 + 50);
  const maxRouteDuration = candidate.elapsedSeconds * 1.5 + (candidate.contextual ? 30 : 15);
  const routes = object.routes.flatMap((route) => {
    const record = objectOrNull(route);
    const distance = Number(record?.distance);
    const duration = Number(record?.duration);
    const coordinates = readLineString(record?.geometry);
    if (
      coordinates === null
      || !Number.isFinite(distance)
      || !Number.isFinite(duration)
      || distance <= 0
      || duration <= 0
      || distance > maxRoadDistance
      || distance / duration > MAX_GAP_SUPPLEMENT_SPEED_METERS_PER_SECOND
      || distance / candidate.elapsedSeconds > MAX_GAP_SUPPLEMENT_SPEED_METERS_PER_SECOND
      || duration > maxRouteDuration
      || distanceBetweenCoordinatesMeters(coordinates[0]!, startWaypoint) > 50
      || distanceBetweenCoordinatesMeters(coordinates.at(-1)!, endWaypoint) > 50
    ) return [];
    return [{ coordinates, distance, duration }];
  }).sort((left, right) => left.duration - right.duration || left.distance - right.distance);
  const best = routes[0];
  if (best === undefined) return null;
  const bestGeometry = JSON.stringify(best.coordinates);
  const ambiguous = routes.slice(1).some((route) => (
    route.distance <= best.distance * 1.25
    && route.duration <= best.duration * 1.25
    && JSON.stringify(route.coordinates) !== bestGeometry
  ));
  if (ambiguous) return null;
  return candidate.contextual && !supportsContextualRoute(candidate, best.coordinates)
    ? null
    : best.coordinates;
}

function supportsContextualRoute(
  candidate: GapSupplementCandidate,
  routeCoordinates: Array<[number, number]>,
): boolean {
  const routeLength = routeCoordinates.slice(1).reduce((sum, coordinate, index) => (
    sum + distanceBetweenCoordinatesMeters(routeCoordinates[index]!, coordinate)
  ), 0);
  if (!(routeLength > 0)) return false;
  const projections = candidate.coordinates.map((coordinate) => projectCoordinateOntoLine(coordinate, routeCoordinates));
  if (projections.some((projection) => projection === null)) return false;
  const supported = projections.every((projection, index) => {
    const accuracy = candidate.samples[index]!.accuracyMeters!;
    const maximumDistance = index === 0 || index === projections.length - 1
      ? 50
      : Math.min(150, Math.max(35, accuracy + 15));
    return projection!.distanceMeters <= maximumDistance;
  });
  if (!supported) return false;
  const first = projections[0]!;
  const last = projections.at(-1)!;
  if (first.offsetMeters > 50 || routeLength - last.offsetMeters > 50) return false;
  for (let index = 1; index < projections.length; index += 1) {
    const previous = projections[index - 1]!;
    const current = projections[index]!;
    if (current.offsetMeters + 20 < previous.offsetMeters) return false;
    const elapsedSeconds = (
      Date.parse(candidate.samples[index]!.occurredAt)
      - Date.parse(candidate.samples[index - 1]!.occurredAt)
    ) / 1000;
    if (!(elapsedSeconds > 0)) return false;
    if (Math.max(0, current.offsetMeters - previous.offsetMeters) / elapsedSeconds
      > MAX_HARD_MATCH_SPEED_METERS_PER_SECOND) return false;
  }
  return true;
}

function projectCoordinateOntoLine(
  coordinate: [number, number],
  line: Array<[number, number]>,
): { distanceMeters: number; offsetMeters: number } | null {
  if (line.length < 2) return null;
  let best: { distanceMeters: number; offsetMeters: number } | null = null;
  let offsetBeforeSegment = 0;
  for (let index = 1; index < line.length; index += 1) {
    const start = line[index - 1]!;
    const end = line[index]!;
    const meanLatitudeRadians = toRadians((start[1] + end[1] + coordinate[1]) / 3);
    const scaleX = Math.cos(meanLatitudeRadians);
    const segmentX = (end[0] - start[0]) * scaleX;
    const segmentY = end[1] - start[1];
    const pointX = (coordinate[0] - start[0]) * scaleX;
    const pointY = coordinate[1] - start[1];
    const denominator = segmentX ** 2 + segmentY ** 2;
    const ratio = denominator === 0
      ? 0
      : Math.max(0, Math.min(1, (pointX * segmentX + pointY * segmentY) / denominator));
    const projected: [number, number] = [
      start[0] + (end[0] - start[0]) * ratio,
      start[1] + (end[1] - start[1]) * ratio,
    ];
    const segmentLength = distanceBetweenCoordinatesMeters(start, end);
    const projection = {
      distanceMeters: distanceBetweenCoordinatesMeters(coordinate, projected),
      offsetMeters: offsetBeforeSegment + segmentLength * ratio,
    };
    if (best === null || projection.distanceMeters < best.distanceMeters) best = projection;
    offsetBeforeSegment += segmentLength;
  }
  return best;
}

function selectStrictGapSupplementMatch(
  payload: unknown,
  candidate: GapSupplementCandidate,
): Array<[number, number]> | null {
  const object = objectOrNull(payload);
  if (object?.code !== 'Ok' || !Array.isArray(object.matchings) || !Array.isArray(object.tracepoints)) return null;
  if (object.matchings.length !== 1 || object.tracepoints.length !== candidate.samples.length) return null;
  const matching = objectOrNull(object.matchings[0]);
  const confidence = Number(matching?.confidence);
  const distance = Number(matching?.distance);
  const duration = Number(matching?.duration);
  const coordinates = readLineString(matching?.geometry);
  const maxRoadDistance = Math.min(1_250, candidate.straightDistanceMeters * 1.8 + 50);
  const maxRouteDuration = candidate.elapsedSeconds * 1.5 + 15;
  if (
    !Number.isFinite(confidence)
    || confidence < MIN_CONFIDENT_MATCH
    || !Number.isFinite(distance)
    || !Number.isFinite(duration)
    || distance <= 0
    || duration <= 0
    || distance > maxRoadDistance
    || distance / candidate.elapsedSeconds > MAX_GAP_SUPPLEMENT_SPEED_METERS_PER_SECOND
    || duration > maxRouteDuration
    || coordinates === null
  ) return null;
  const supported = object.tracepoints.every((tracepoint, index) => {
    const point = objectOrNull(tracepoint);
    const location = readCoordinatePair(point?.location);
    return point?.matchings_index === 0
      && isUnambiguousTracepoint(point)
      && location !== null
      && isSnapDisplacementPlausible(
        candidate.coordinates[index]!,
        location,
        candidate.samples[index]!.accuracyMeters,
      );
  });
  if (!supported) return null;
  const firstLocation = readCoordinatePair(objectOrNull(object.tracepoints[0])?.location);
  const lastLocation = readCoordinatePair(objectOrNull(object.tracepoints.at(-1))?.location);
  if (
    firstLocation === null
    || lastLocation === null
    || distanceBetweenCoordinatesMeters(candidate.startCoordinate, firstLocation) > 50
    || distanceBetweenCoordinatesMeters(candidate.endCoordinate, lastLocation) > 50
  ) return null;
  return coordinates;
}

function readCoordinatePair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const coordinate: [number, number] = [Number(value[0]), Number(value[1])];
  return isValidCoordinate(coordinate) ? coordinate : null;
}

function readAlternativesCount(value: Record<string, unknown> | null): number | null {
  const count = value?.alternatives_count;
  return typeof count === 'number'
    && Number.isFinite(count)
    && Number.isInteger(count)
    && count >= 0
    ? count
    : null;
}

function isUnambiguousTracepoint(value: Record<string, unknown> | null): boolean {
  return readAlternativesCount(value) === 0;
}

function readMatchedLines(payload: unknown, chunk: MatchChunk): MatchedLine[] {
  const object = objectOrNull(payload);
  const matchings = Array.isArray(object?.matchings) ? object.matchings : null;
  if (object?.code !== 'Ok' || matchings === null) return [];
  const tracepoints = Array.isArray(object.tracepoints) ? object.tracepoints : [];
  return matchings.flatMap((matching, matchingIndex) => {
    const match = objectOrNull(matching);
    const confidence = typeof match?.confidence === 'number' && Number.isFinite(match.confidence)
      ? match.confidence
      : 0;
    return readMatchedLegLines(match, tracepoints, chunk, matchingIndex, matchings.length, confidence);
  });
}

function readLegacyMatchedLines(payload: unknown, chunk: MatchChunk): MatchedLine[] {
  const object = objectOrNull(payload);
  const matchings = Array.isArray(object?.matchings) ? object.matchings : null;
  if (object?.code !== 'Ok' || matchings === null) return [];
  const tracepoints = Array.isArray(object.tracepoints) ? object.tracepoints : [];
  return matchings.flatMap((matching, matchingIndex) => {
    const match = objectOrNull(matching);
    const confidence = typeof match?.confidence === 'number' && Number.isFinite(match.confidence)
      ? match.confidence
      : 0;
    const coordinates = readLineString(match?.geometry);
    if (coordinates === null) return [];
    const matchedIndexes = tracepoints.flatMap((tracepoint, index) => (
      objectOrNull(tracepoint)?.matchings_index === matchingIndex ? [index] : []
    ));
    const indexes = matchedIndexes.length > 0
      ? matchedIndexes
      : tracepoints.length === chunk.samples.length && tracepoints.every((tracepoint) => tracepoint !== null)
        ? chunk.samples.map((_, index) => index)
        : [];
    const firstIndex = indexes[0];
    const lastIndex = indexes.at(-1);
    if (indexes.length < 2 || firstIndex === undefined || lastIndex === undefined) return [];
    const samples = chunk.samples.slice(firstIndex, lastIndex + 1);
    const interpolationLevel = confidence >= MIN_CONFIDENT_MATCH ? 0 : 2;
    return [{
      confidence,
      coordinates,
      interpolationLevel,
      sourceRange: rangeFromSamples(samples, interpolationLevel),
    }];
  });
}

function readMatchedLegLines(
  matching: Record<string, unknown> | null,
  tracepoints: unknown[],
  chunk: MatchChunk,
  matchingIndex: number,
  matchingCount: number,
  confidence: number,
): MatchedLine[] {
  const legs = Array.isArray(matching?.legs) ? matching.legs : [];
  const lines: MatchedLine[] = [];
  for (let index = 0; index < chunk.samples.length - 1; index += 1) {
    const left = objectOrNull(tracepoints[index]);
    const right = objectOrNull(tracepoints[index + 1]);
    const leftMatchingIndex = left?.matchings_index;
    const rightMatchingIndex = right?.matchings_index;
    const leftMatchingIndexValid = isValidMatchingIndex(leftMatchingIndex, matchingCount);
    const rightMatchingIndexValid = isValidMatchingIndex(rightMatchingIndex, matchingCount);
    if (!leftMatchingIndexValid || !rightMatchingIndexValid) {
      const rejectionOwner = leftMatchingIndexValid
        ? leftMatchingIndex
        : rightMatchingIndexValid
          ? rightMatchingIndex
          : 0;
      if (matchingIndex === rejectionOwner) lines.push(rejectedLegLine(chunk, index, confidence));
      continue;
    }
    if (leftMatchingIndex !== matchingIndex && rightMatchingIndex !== matchingIndex) continue;
    if (left === null || right === null) {
      lines.push(rejectedLegLine(chunk, index, confidence));
      continue;
    }
    if (leftMatchingIndex !== rightMatchingIndex) continue;
    const leftWaypointIndex = left?.waypoint_index;
    const rightWaypointIndex = right?.waypoint_index;
    const leftAlternativesCount = readAlternativesCount(left);
    const rightAlternativesCount = readAlternativesCount(right);
    if (
      leftMatchingIndex !== matchingIndex
      || typeof leftWaypointIndex !== 'number'
      || !Number.isFinite(leftWaypointIndex)
      || !Number.isInteger(leftWaypointIndex)
      || typeof rightWaypointIndex !== 'number'
      || !Number.isFinite(rightWaypointIndex)
      || rightWaypointIndex !== leftWaypointIndex + 1
      || leftAlternativesCount === null
      || rightAlternativesCount === null
    ) {
      lines.push(rejectedLegLine(chunk, index, confidence));
      continue;
    }
    const leg = objectOrNull(legs[leftWaypointIndex]);
    const coordinates = readLegCoordinates(leg);
    if (coordinates === null) {
      lines.push(rejectedLegLine(chunk, index, confidence));
      continue;
    }
    const samples = chunk.samples.slice(index, index + 2);
    const inputCoordinates = chunk.coordinates.slice(index, index + 2);
    const leftLocation = readCoordinatePair(left.location);
    const rightLocation = readCoordinatePair(right.location);
    const elapsedSeconds = (Date.parse(samples[1]!.occurredAt) - Date.parse(samples[0]!.occurredAt)) / 1000;
    const roadDistance = Number(leg?.distance);
    const roadDuration = Number(leg?.duration);
    const straightDistance = distanceBetweenCoordinatesMeters(inputCoordinates[0]!, inputCoordinates[1]!);
    const accuracies = samples.map((sample) => sample.accuracyMeters);
    const hasKnownBoundedAccuracy = accuracies.every((accuracy) => (
      typeof accuracy === 'number'
      && Number.isFinite(accuracy)
      && accuracy >= 0
      && accuracy <= ROUTE_TRACKING_V1_POLICY.maxInterpolationAccuracyMeters
    ));
    const accuracySum = hasKnownBoundedAccuracy ? (accuracies[0]! + accuracies[1]!) : 0;
    const strictSnap = leftLocation !== null
      && rightLocation !== null
      && isSnapDisplacementPlausible(inputCoordinates[0]!, leftLocation, accuracies[0], 1)
      && isSnapDisplacementPlausible(inputCoordinates[1]!, rightLocation, accuracies[1], 1);
    const hardSnap = leftLocation !== null
      && rightLocation !== null
      && isSnapDisplacementPlausible(inputCoordinates[0]!, leftLocation, accuracies[0], 3)
      && isSnapDisplacementPlausible(inputCoordinates[1]!, rightLocation, accuracies[1], 3);
    const strictDetour = roadDistance <= Math.min(1_250, straightDistance * 1.8 + 50);
    const hardDetour = roadDistance <= Math.min(1_250, straightDistance * 1.8 + 50 + 3 * accuracySum);
    const strictSpeed = roadDistance / elapsedSeconds <= MAX_GAP_SUPPLEMENT_SPEED_METERS_PER_SECOND;
    const hardSpeed = Math.max(0, roadDistance - 3 * accuracySum) / elapsedSeconds
      <= MAX_HARD_MATCH_SPEED_METERS_PER_SECOND;
    const strictDuration = roadDuration <= elapsedSeconds * 1.5 + 15;
    if (
      leftLocation === null
      || rightLocation === null
      || !hasKnownBoundedAccuracy
      || !Number.isFinite(roadDistance)
      || !Number.isFinite(roadDuration)
      || roadDistance <= 0
      || roadDuration <= 0
      || !(elapsedSeconds > 0 && elapsedSeconds <= ROUTE_TRACKING_V1_POLICY.delayedThresholdMs / 1000)
      || confidence < MIN_CONFIDENT_MATCH
      || !hardDetour
      || !hardSpeed
      || !hardSnap
    ) {
      lines.push(rejectedLegLine(chunk, index, confidence));
      continue;
    }
    const requiresSoftAcceptance = leftAlternativesCount > 0
      || rightAlternativesCount > 0
      || !strictDetour
      || !strictSpeed
      || !strictDuration
      || !strictSnap;
    if (requiresSoftAcceptance && confidence < MIN_SOFT_MATCH_CONFIDENCE) {
      lines.push(rejectedLegLine(chunk, index, confidence));
      continue;
    }
    const interpolationLevel: 0 | 1 = requiresSoftAcceptance
      || accuracies.some((accuracy) => accuracy! > ROUTE_TRACKING_V1_POLICY.maxMatchAccuracyMeters)
      ? 1
      : 0;
    lines.push({
      confidence,
      coordinates,
      interpolationLevel,
      sourceRange: rangeFromSamples(samples, interpolationLevel),
    });
  }
  return lines;
}

function isValidMatchingIndex(value: unknown, matchingCount: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0
    && value < matchingCount;
}

function rejectedLegLine(chunk: MatchChunk, index: number, confidence: number): MatchedLine {
  const samples = chunk.samples.slice(index, index + 2);
  return {
    confidence,
    coordinates: chunk.coordinates.slice(index, index + 2),
    interpolationLevel: 2,
    sourceRange: rangeFromSamples(samples, 2),
  };
}

function isSnapDisplacementPlausible(
  observed: [number, number],
  snapped: [number, number],
  accuracyMeters: number | null | undefined,
  accuracyMultiplier = 1,
): boolean {
  if (typeof accuracyMeters !== 'number' || !Number.isFinite(accuracyMeters) || accuracyMeters < 0) return false;
  const maximumDisplacement = accuracyMultiplier === 1
    ? Math.min(225, Math.max(25, accuracyMeters) + 10)
    : Math.min(600, Math.max(25, accuracyMultiplier * accuracyMeters) + 10);
  return distanceBetweenCoordinatesMeters(observed, snapped) <= maximumDisplacement;
}

function readLegCoordinates(value: unknown): Array<[number, number]> | null {
  const steps = objectOrNull(value)?.steps;
  if (!Array.isArray(steps)) return null;
  const coordinates: Array<[number, number]> = [];
  for (const step of steps) {
    const line = readLineString(objectOrNull(step)?.geometry);
    if (line === null) return null;
    if (coordinates.length > 0 && !sameCoordinate(coordinates.at(-1)!, line[0]!)) return null;
    if (coordinates.length > 0 && line.every((coordinate) => sameCoordinate(coordinates.at(-1)!, coordinate))) continue;
    coordinates.push(...(coordinates.length > 0 ? line.slice(1) : line));
  }
  return coordinates.length >= 2 ? coordinates : null;
}

function mergeAdjacentMatchedLines(lines: MatchedLine[]): MatchedLine[] {
  const ordered = [...lines].sort((left, right) => (
    left.sourceRange.startSourceIndex - right.sourceRange.startSourceIndex
    || left.sourceRange.endSourceIndex - right.sourceRange.endSourceIndex
  ));
  const merged: MatchedLine[] = [];
  for (const line of ordered) {
    const previous = merged.at(-1);
    if (
      previous !== undefined
      && previous.interpolationLevel === line.interpolationLevel
      && previous.sourceRange.endSourceIndex === line.sourceRange.startSourceIndex
      && sameCoordinate(previous.coordinates.at(-1)!, line.coordinates[0]!)
    ) {
      previous.coordinates.push(...line.coordinates.slice(1));
      previous.sourceRange = {
        ...line.sourceRange,
        startEventId: previous.sourceRange.startEventId,
        startOccurredAt: previous.sourceRange.startOccurredAt,
        startSourceIndex: previous.sourceRange.startSourceIndex,
      };
      previous.confidence = Math.min(previous.confidence, line.confidence);
      continue;
    }
    if (previous?.sourceRange.startSourceIndex === line.sourceRange.startSourceIndex
      && previous.sourceRange.endSourceIndex === line.sourceRange.endSourceIndex
      && previous.interpolationLevel === line.interpolationLevel) continue;
    merged.push({ ...line, coordinates: [...line.coordinates], sourceRange: { ...line.sourceRange } });
  }
  return merged;
}

function sameCoordinate(left: [number, number], right: [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
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
  return coordinates.length >= 2 ? coordinates : null;
}

function toMultiLineString(lines: MatchedLine[]): RouteTrackingRoadMatchedGeometryV1 | null {
  const usableLines = lines
    .filter((line) => line.coordinates.length >= 2);
  return usableLines.length === 0
    ? null
    : {
        coordinates: usableLines.map((line) => line.coordinates),
        sourceRanges: usableLines.map((line) => line.sourceRange),
        type: 'MultiLineString'
      };
}

function toInferredMultiLineString(lines: InferredLine[]): RouteTrackingRoadMatchedGeometryV1 | null {
  const usableLines = lines
    .filter((line) => line.coordinates.length >= 2);
  return usableLines.length === 0
    ? null
    : {
        coordinates: usableLines.map((line) => line.coordinates),
        sourceRanges: usableLines.map((line) => line.sourceRange),
        type: 'MultiLineString',
      };
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
    return coordinates.length >= 2 ? [coordinates] : [];
  });
  if (coordinates.length === 0) return null;
  const anchors = readGeometryAnchors(object.anchors, coordinates);
  const sourceRanges = readSourceRanges(object.sourceRanges);
  return {
    ...(anchors.length === 0 ? {} : { anchors }),
    coordinates,
    ...(sourceRanges.length === 0 ? {} : { sourceRanges }),
    type: 'MultiLineString',
  };
}

function rangeFromSamples(
  samples: RouteTrackingGeometryDocumentV1['samples'],
  interpolationLevel?: 0 | 1 | 2,
): RouteTrackingSourceRangeV1 {
  const first = samples[0]!;
  const last = samples.at(-1)!;
  return {
    endEventId: last.eventId,
    endOccurredAt: last.occurredAt,
    endSourceIndex: last.sourceIndex ?? samples.length - 1,
    ...(interpolationLevel === undefined ? {} : { interpolationLevel }),
    startEventId: first.eventId,
    startOccurredAt: first.occurredAt,
    startSourceIndex: first.sourceIndex ?? 0,
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function buildUnmatchedRanges(
  document: RouteTrackingGeometryDocumentV1,
  matchedLines: MatchedLine[],
): RouteTrackingSourceRangeV1[] {
  const covered = new Set<number>();
  for (const line of matchedLines) {
    for (let index = line.sourceRange.startSourceIndex; index <= line.sourceRange.endSourceIndex; index += 1) {
      covered.add(index);
    }
  }
  const ranges: RouteTrackingSourceRangeV1[] = [];
  let pending: RouteTrackingGeometryDocumentV1['samples'] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const reason: NonNullable<RouteTrackingSourceRangeV1['reason']> = pending.some((sample) => (
      (sample.accuracyMeters ?? 0) > ROUTE_TRACKING_V1_POLICY.maxMatchAccuracyMeters
    ))
      ? 'LOW_ACCURACY'
      : 'NO_MATCH';
    const range = rangeFromSamples(pending);
    ranges.push({
      endEventId: range.endEventId,
      endOccurredAt: range.endOccurredAt,
      endSourceIndex: range.endSourceIndex,
      interpolationLevel: 2,
      reason,
      startEventId: range.startEventId,
      startOccurredAt: range.startOccurredAt,
      startSourceIndex: range.startSourceIndex,
    });
    pending = [];
  };
  for (const sample of document.samples) {
    const sourceIndex = sample.sourceIndex ?? document.samples.indexOf(sample);
    if (covered.has(sourceIndex)) {
      flush();
    } else {
      const nextReason = (sample.accuracyMeters ?? 0) > ROUTE_TRACKING_V1_POLICY.maxMatchAccuracyMeters
        ? 'LOW_ACCURACY'
        : 'NO_MATCH';
      const pendingReason = pending.length === 0
        ? null
        : (pending[0]!.accuracyMeters ?? 0) > ROUTE_TRACKING_V1_POLICY.maxMatchAccuracyMeters
          ? 'LOW_ACCURACY'
          : 'NO_MATCH';
      if (pendingReason !== null && pendingReason !== nextReason) flush();
      pending.push({ ...sample, sourceIndex });
    }
  }
  flush();
  return ranges;
}

function readSourceRanges(value: unknown): RouteTrackingSourceRangeV1[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const object = objectOrNull(item);
    const startEventId = readText(object?.startEventId);
    const endEventId = readText(object?.endEventId);
    const startOccurredAt = readDateText(object?.startOccurredAt);
    const endOccurredAt = readDateText(object?.endOccurredAt);
    const startSourceIndex = readPositiveInteger(object?.startSourceIndex);
    const endSourceIndex = readPositiveInteger(object?.endSourceIndex);
    if (startEventId === null || endEventId === null || startOccurredAt === null || endOccurredAt === null
      || startSourceIndex === null || endSourceIndex === null || endSourceIndex < startSourceIndex) return [];
    const reason = readRangeReason(object?.reason);
    const interpolationLevel = readInterpolationLevel(object?.interpolationLevel);
    return [{
      endEventId,
      endOccurredAt,
      endSourceIndex,
      ...(interpolationLevel === null ? {} : { interpolationLevel }),
      ...(reason === null ? {} : { reason }),
      startEventId,
      startOccurredAt,
      startSourceIndex,
    }];
  });
}

function readInterpolationLevel(value: unknown): 0 | 1 | 2 | null {
  return value === 0 || value === 1 || value === 2 ? value : null;
}

function readEmbeddedUnmatchedRanges(...values: unknown[]): RouteTrackingSourceRangeV1[] {
  for (const value of values) {
    const ranges = readSourceRanges(objectOrNull(value)?.unmatchedRanges);
    if (ranges.length > 0) return ranges;
  }
  return [];
}

function readEmbeddedInferredGeometry(...values: unknown[]): RouteTrackingRoadMatchedGeometryV1 | null {
  for (const value of values) {
    const geometry = readMultiLineString(objectOrNull(value)?.inferredGeometry);
    if (geometry !== null) return geometry;
  }
  return null;
}

function readEmbeddedInferredRanges(...values: unknown[]): RouteTrackingSourceRangeV1[] {
  for (const value of values) {
    const ranges = readSourceRanges(objectOrNull(value)?.inferredRanges);
    if (ranges.length > 0) return ranges;
  }
  return [];
}

function embedRoadMatchMetadata(
  geometry: RouteTrackingRoadMatchedGeometryV1 | null,
  unmatchedRanges: RouteTrackingSourceRangeV1[] | undefined,
  inferredGeometry: RouteTrackingRoadMatchedGeometryV1 | null | undefined,
  inferredRanges: RouteTrackingSourceRangeV1[] | undefined,
): RouteTrackingRoadMatchedGeometryV1 | null {
  if (
    geometry === null
    && (unmatchedRanges === undefined || unmatchedRanges.length === 0)
    && (inferredGeometry === undefined || inferredGeometry === null)
    && (inferredRanges === undefined || inferredRanges.length === 0)
  ) return null;
  return {
    ...(geometry ?? { coordinates: [], type: 'MultiLineString' as const }),
    ...(unmatchedRanges === undefined || unmatchedRanges.length === 0 ? {} : { unmatchedRanges }),
    ...(inferredGeometry === undefined || inferredGeometry === null ? {} : { inferredGeometry }),
    ...(inferredRanges === undefined || inferredRanges.length === 0 ? {} : { inferredRanges }),
  };
}

function readDateText(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function readRangeReason(value: unknown): NonNullable<RouteTrackingSourceRangeV1['reason']> | null {
  return value === 'GPS_GAP' || value === 'IMPLAUSIBLE_JUMP' || value === 'LOW_ACCURACY'
    || value === 'NO_MATCH' || value === 'OUT_OF_COVERAGE'
    ? value
    : null;
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
