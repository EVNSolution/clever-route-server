import { Prisma } from '@prisma/client';

import { ROUTE_TRACKING_V1_POLICY } from './route-tracking.policy.js';

export const ROUTE_TRACKING_GEOMETRY_RETENTION_DAYS = 90;
const ROUTE_TRACKING_GEOMETRY_SCHEMA_VERSION = 'route_tracking_geometry.v1';
const EARTH_RADIUS_METERS = 6_371_000;

export type RouteTrackingGeometrySampleV1 = {
  accuracyMeters?: number | null;
  driverId: string | null;
  eventId: string;
  gapBefore?: boolean;
  occurredAt: string;
  receivedAt: string;
  sourceIndex?: number;
};

export type RouteTrackingGeometryDocumentV1 = {
  coordinates: Array<[number, number]>;
  samples: RouteTrackingGeometrySampleV1[];
  sourcePointCount: number;
};

export type RouteTrackingGeometryPositionInput = {
  accuracyMeters?: number | null;
  driverId: string | null;
  eventId: string;
  latitude: number;
  longitude: number;
  occurredAt: string;
  receivedAt: string;
  routePlanId: string;
};

export type RouteTrackingGeometryRecord = {
  firstOccurredAt: Date;
  geometry: unknown;
  geometryPointCount: number;
  lastDriverId: string | null;
  lastEventId: string;
  lastLatitude: unknown;
  lastLongitude: unknown;
  lastOccurredAt: Date;
  lastReceivedAt: Date;
  roadMatchedCoverage?: string | null;
  roadMatchedGeometry?: unknown;
  roadMatchedLastInputOccurredAt?: Date | null;
  roadMatchedLastPosition?: unknown;
  roadMatchedPointCount?: number | null;
  roadMatchedSchemaVersion?: string | null;
  roadMatchedSourcePointCount?: number | null;
  roadMatchedUncertainGeometry?: unknown;
  roadMatchedWatermark?: string | null;
  routePlanId: string;
  sampleMetadata: unknown;
  sourcePointCount: number;
};

type RouteTrackingGeometryPrismaClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'driverEvent' | 'routeTrackingGeometry'
>;

export async function persistRouteTrackingGeometryPosition(
  prisma: RouteTrackingGeometryPrismaClient,
  position: RouteTrackingGeometryPositionInput
): Promise<RouteTrackingGeometryDocumentV1> {
  await prisma.$queryRaw(
    Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${position.routePlanId}, 0))`
  );

  const current = await prisma.routeTrackingGeometry.findUnique({
    where: { routePlanId: position.routePlanId }
  });
  const retentionCutoff = new Date(
    Date.parse(position.receivedAt) - ROUTE_TRACKING_GEOMETRY_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  if (Date.parse(position.occurredAt) < retentionCutoff.getTime()) {
    return readRouteTrackingGeometryDocument(current);
  }
  const currentLastOccurredAt = current?.lastOccurredAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const nextOccurredAt = Date.parse(position.occurredAt);
  const mustRebuild = current !== null && (
    !hasCurrentQualityMetadata(current.sampleMetadata)
    || Number.isFinite(nextOccurredAt) && nextOccurredAt < currentLastOccurredAt
  );
  const document = mustRebuild
    ? buildRouteTrackingGeometryDocument(await loadRouteTrackingPositions(prisma, position.routePlanId, retentionCutoff))
    : appendRouteTrackingGeometryPosition(
        pruneRouteTrackingGeometryDocument(readRouteTrackingGeometryDocument(current), retentionCutoff),
        position
      );
  const write = createRouteTrackingGeometryWrite(position.routePlanId, document);

  await prisma.routeTrackingGeometry.upsert({
    create: write,
    update: write,
    where: { routePlanId: position.routePlanId }
  });
  return document;
}

export async function rebuildRouteTrackingGeometryForRoute(
  prisma: RouteTrackingGeometryPrismaClient,
  routePlanId: string,
  now = new Date()
): Promise<RouteTrackingGeometryDocumentV1> {
  await prisma.$queryRaw(
    Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${routePlanId}, 0))`
  );
  const retentionCutoff = new Date(
    now.getTime() - ROUTE_TRACKING_GEOMETRY_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  const document = buildRouteTrackingGeometryDocument(
    await loadRouteTrackingPositions(prisma, routePlanId, retentionCutoff)
  );
  if (document.coordinates.length === 0) return document;
  const write = createRouteTrackingGeometryWrite(routePlanId, document);
  await prisma.routeTrackingGeometry.upsert({ create: write, update: write, where: { routePlanId } });
  return document;
}

export function buildRouteTrackingGeometryDocument(
  positions: RouteTrackingGeometryPositionInput[]
): RouteTrackingGeometryDocumentV1 {
  const ordered = uniqueValidPositions(positions).sort(comparePositions);
  const document: RouteTrackingGeometryDocumentV1 = { coordinates: [], samples: [], sourcePointCount: 0 };
  for (const position of ordered) appendRouteTrackingGeometryPositionMutable(document, position);
  return simplifyRouteTrackingGeometryDocument(document);
}

export function appendRouteTrackingGeometryPosition(
  document: RouteTrackingGeometryDocumentV1,
  position: RouteTrackingGeometryPositionInput
): RouteTrackingGeometryDocumentV1 {
  if (!isValidPosition(position)) return document;
  if (document.samples.some((sample) => sample.eventId === position.eventId)) return document;
  const next: RouteTrackingGeometryDocumentV1 = {
    coordinates: [...document.coordinates],
    samples: [...document.samples],
    sourcePointCount: document.sourcePointCount
  };
  appendRouteTrackingGeometryPositionMutable(next, position);
  return next;
}

function appendRouteTrackingGeometryPositionMutable(
  document: RouteTrackingGeometryDocumentV1,
  position: RouteTrackingGeometryPositionInput
): void {
  const coordinates = document.coordinates;
  const samples = document.samples;
  const coordinate: [number, number] = [position.longitude, position.latitude];
  const sample = toSample(position, document.sourcePointCount, false);
  const previousSample = samples.at(-1);
  const hasTrackingGap = previousSample !== undefined
    && Date.parse(sample.occurredAt) - Date.parse(previousSample.occurredAt) > ROUTE_TRACKING_V1_POLICY.delayedThresholdMs;
  sample.gapBefore = hasTrackingGap;
  const anchorElapsedMs = samples.length < 2
    ? Number.POSITIVE_INFINITY
    : Date.parse(sample.occurredAt) - Date.parse(samples.at(-2)!.occurredAt);
  const headingChangeDegrees = coordinates.length < 2
    ? 180
    : getHeadingChangeDegrees(coordinates.at(-2)!, coordinates.at(-1)!, coordinate);
  const canReplaceTail = !hasTrackingGap
    && previousSample?.gapBefore !== true
    && coordinates.length >= 2
    && anchorElapsedMs <= 60_000
    && headingChangeDegrees <= 20
    && distancePointToSegmentMeters(
      coordinates.at(-1)!,
      coordinates.at(-2)!,
      coordinate
    ) <= ROUTE_TRACKING_V1_POLICY.geometrySimplificationToleranceMeters;

  if (canReplaceTail) {
    coordinates[coordinates.length - 1] = coordinate;
    samples[samples.length - 1] = sample;
  } else {
    coordinates.push(coordinate);
    samples.push(sample);
  }
  document.sourcePointCount += 1;
}

function simplifyRouteTrackingGeometryDocument(
  document: RouteTrackingGeometryDocumentV1
): RouteTrackingGeometryDocumentV1 {
  if (document.coordinates.length <= 2) return document;
  const retained = new Set<number>();
  let segmentStart = 0;
  for (let index = 1; index < document.samples.length; index += 1) {
    const sample = document.samples[index]!;
    const segmentElapsedMs = Date.parse(sample.occurredAt)
      - Date.parse(document.samples[segmentStart]!.occurredAt);
    if (sample.gapBefore === true) {
      retainSimplifiedSegment(document.coordinates, segmentStart, index - 1, retained);
      segmentStart = index;
    } else if (segmentElapsedMs >= 60_000) {
      retainSimplifiedSegment(document.coordinates, segmentStart, index, retained);
      segmentStart = index;
    }
  }
  retainSimplifiedSegment(document.coordinates, segmentStart, document.coordinates.length - 1, retained);
  const indexes = [...retained].sort((left, right) => left - right);
  return {
    coordinates: indexes.map((index) => document.coordinates[index]!),
    samples: indexes.map((index) => document.samples[index]!),
    sourcePointCount: document.sourcePointCount
  };
}

function retainSimplifiedSegment(
  coordinates: Array<[number, number]>,
  start: number,
  end: number,
  retained: Set<number>
): void {
  if (end < start) return;
  retained.add(start);
  retained.add(end);
  if (end - start <= 1) return;
  let furthestIndex = -1;
  let furthestDistance = 0;
  for (let index = start + 1; index < end; index += 1) {
    const distance = distancePointToSegmentMeters(coordinates[index]!, coordinates[start]!, coordinates[end]!);
    if (distance > furthestDistance) {
      furthestDistance = distance;
      furthestIndex = index;
    }
  }
  if (furthestIndex === -1 || furthestDistance <= ROUTE_TRACKING_V1_POLICY.geometrySimplificationToleranceMeters) return;
  retainSimplifiedSegment(coordinates, start, furthestIndex, retained);
  retainSimplifiedSegment(coordinates, furthestIndex, end, retained);
}

export function pruneRouteTrackingGeometryDocument(
  document: RouteTrackingGeometryDocumentV1,
  cutoff: Date
): RouteTrackingGeometryDocumentV1 {
  const retainedIndexes = document.samples.flatMap((sample, index) =>
    Date.parse(sample.occurredAt) >= cutoff.getTime() ? [index] : []
  );
  if (retainedIndexes.length === document.samples.length) return document;
  const firstRetainedSourceIndex = retainedIndexes.length === 0
    ? document.sourcePointCount
    : document.samples[retainedIndexes[0]!]!.sourceIndex ?? retainedIndexes[0]!;
  return {
    coordinates: retainedIndexes.flatMap((index) => {
      const coordinate = document.coordinates[index];
      return coordinate === undefined ? [] : [coordinate];
    }),
    samples: retainedIndexes.map((index, retainedIndex) => ({
      ...document.samples[index]!,
      ...(retainedIndex === 0 ? { gapBefore: false } : {}),
      sourceIndex: Math.max(0, (document.samples[index]!.sourceIndex ?? index) - firstRetainedSourceIndex)
    })),
    sourcePointCount: Math.max(0, document.sourcePointCount - firstRetainedSourceIndex)
  };
}

export function readRouteTrackingGeometryDocument(
  record: RouteTrackingGeometryRecord | null | undefined
): RouteTrackingGeometryDocumentV1 {
  if (record === null || record === undefined) {
    return { coordinates: [], samples: [], sourcePointCount: 0 };
  }

  const samples = readSamples(record.sampleMetadata);
  const coordinates = readGeometryCoordinates(record.geometry);
  if (coordinates.length === 0 && samples.length === 1) {
    const latitude = finiteCoordinate(record.lastLatitude);
    const longitude = finiteCoordinate(record.lastLongitude);
    if (latitude !== null && longitude !== null) coordinates.push([longitude, latitude]);
  }
  const usableLength = Math.min(coordinates.length, samples.length);

  return {
    coordinates: coordinates.slice(0, usableLength),
    samples: samples.slice(0, usableLength),
    sourcePointCount: Math.max(record.sourcePointCount, usableLength)
  };
}

export function toRouteTrackingRecordedPath(record: RouteTrackingGeometryRecord | null | undefined) {
  if (record === null || record === undefined) return null;
  const document = readRouteTrackingGeometryDocument(record);
  return {
    firstOccurredAt: record.firstOccurredAt.toISOString(),
    geometry: document.coordinates.length >= 2
      ? { coordinates: document.coordinates, type: 'LineString' as const }
      : null,
    geometryPointCount: document.coordinates.length,
    lastOccurredAt: record.lastOccurredAt.toISOString(),
    lastReceivedAt: record.lastReceivedAt.toISOString(),
    samples: document.samples,
    schemaVersion: ROUTE_TRACKING_GEOMETRY_SCHEMA_VERSION as 'route_tracking_geometry.v1',
    sourcePointCount: document.sourcePointCount
  };
}

export function toRouteTrackingPositionEvents(record: RouteTrackingGeometryRecord | null | undefined) {
  if (record === null || record === undefined) return [];
  const document = readRouteTrackingGeometryDocument(record);
  return document.samples.flatMap((sample, index) => {
    const coordinate = document.coordinates[index];
    const driverId = sample.driverId ?? record.lastDriverId;
    if (coordinate === undefined || driverId === null) return [];
    return [{
      ...(sample.accuracyMeters === undefined ? {} : { accuracyMeters: sample.accuracyMeters }),
      driverId,
      eventId: sample.eventId,
      ...(sample.gapBefore === undefined ? {} : { gapBefore: sample.gapBefore }),
      latitude: coordinate[1],
      longitude: coordinate[0],
      occurredAt: sample.occurredAt,
      receivedAt: sample.receivedAt,
      routePlanId: record.routePlanId,
      schemaVersion: 'route_tracking.v1' as const,
      ...(sample.sourceIndex === undefined ? {} : { sourceIndex: sample.sourceIndex })
    }];
  });
}

export function createRouteTrackingGeometryWrite(routePlanId: string, document: RouteTrackingGeometryDocumentV1) {
  const first = document.samples[0];
  const last = document.samples.at(-1);
  const lastCoordinate = document.coordinates.at(-1);
  if (first === undefined || last === undefined || lastCoordinate === undefined) {
    throw new Error('Route tracking geometry requires at least one valid position');
  }
  const lastOccurredAt = new Date(last.occurredAt);
  const expiresAt = new Date(lastOccurredAt);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + ROUTE_TRACKING_GEOMETRY_RETENTION_DAYS);

  return {
    expiresAt,
    firstOccurredAt: new Date(first.occurredAt),
    geometry: document.coordinates.length >= 2
      ? toJson({ coordinates: document.coordinates, type: 'LineString' })
      : Prisma.JsonNull,
    geometryPointCount: document.coordinates.length,
    lastDriverId: last.driverId,
    lastEventId: last.eventId,
    lastLatitude: lastCoordinate[1],
    lastLongitude: lastCoordinate[0],
    lastOccurredAt,
    lastReceivedAt: new Date(last.receivedAt),
    routePlanId,
    sampleMetadata: toJson(document.samples),
    sourcePointCount: document.sourcePointCount
  };
}

async function loadRouteTrackingPositions(
  prisma: RouteTrackingGeometryPrismaClient,
  routePlanId: string,
  retentionCutoff: Date
): Promise<RouteTrackingGeometryPositionInput[]> {
  const rows = await prisma.driverEvent.findMany({
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      createdAt: true,
      driverId: true,
      id: true,
      latitude: true,
      longitude: true,
      occurredAt: true,
      payload: true,
      routePlanId: true
    },
    where: {
      eventType: 'LOCATION_UPDATED',
      latitude: { not: null },
      longitude: { not: null },
      occurredAt: { gte: retentionCutoff },
      routePlanId
    }
  });

  return rows.flatMap((row) => {
    const latitude = finiteCoordinate(row.latitude);
    const longitude = finiteCoordinate(row.longitude);
    if (latitude === null || longitude === null || row.routePlanId === null) return [];
    return [{
      driverId: row.driverId,
      eventId: row.id,
      accuracyMeters: readAccuracyMeters(row.payload),
      latitude,
      longitude,
      occurredAt: row.occurredAt.toISOString(),
      receivedAt: row.createdAt.toISOString(),
      routePlanId: row.routePlanId
    }];
  });
}

function uniqueValidPositions(positions: RouteTrackingGeometryPositionInput[]) {
  const byEventId = new Map<string, RouteTrackingGeometryPositionInput>();
  for (const position of positions) {
    if (isValidPosition(position)) byEventId.set(position.eventId, position);
  }
  return [...byEventId.values()];
}

function comparePositions(left: RouteTrackingGeometryPositionInput, right: RouteTrackingGeometryPositionInput): number {
  return Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
    || Date.parse(left.receivedAt) - Date.parse(right.receivedAt)
    || left.eventId.localeCompare(right.eventId);
}

function isValidPosition(position: RouteTrackingGeometryPositionInput): boolean {
  return Number.isFinite(position.latitude)
    && position.latitude >= -90
    && position.latitude <= 90
    && Number.isFinite(position.longitude)
    && position.longitude >= -180
    && position.longitude <= 180
    && Number.isFinite(Date.parse(position.occurredAt))
    && Number.isFinite(Date.parse(position.receivedAt));
}

function toSample(
  position: RouteTrackingGeometryPositionInput,
  sourceIndex: number,
  gapBefore: boolean
): RouteTrackingGeometrySampleV1 {
  return {
    accuracyMeters: normalizeAccuracyMeters(position.accuracyMeters),
    driverId: position.driverId,
    eventId: position.eventId,
    gapBefore,
    occurredAt: new Date(position.occurredAt).toISOString(),
    receivedAt: new Date(position.receivedAt).toISOString(),
    sourceIndex
  };
}

function readGeometryCoordinates(value: unknown): Array<[number, number]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (record.type !== 'LineString' || !Array.isArray(record.coordinates)) return [];
  return record.coordinates.flatMap((coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return [];
    const longitude = finiteCoordinate(coordinate[0]);
    const latitude = finiteCoordinate(coordinate[1]);
    return latitude === null || longitude === null ? [] : [[longitude, latitude] as [number, number]];
  });
}

function readSamples(value: unknown): RouteTrackingGeometrySampleV1[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((sample) => {
    if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) return [];
    const record = sample as Record<string, unknown>;
    const eventId = textOrNull(record.eventId);
    const occurredAt = dateStringOrNull(record.occurredAt);
    const receivedAt = dateStringOrNull(record.receivedAt);
    if (eventId === null || occurredAt === null || receivedAt === null) return [];
    const accuracyMeters = normalizeAccuracyMeters(record.accuracyMeters);
    const sourceIndex = nonNegativeIntegerOrNull(record.sourceIndex);
    return [{
      ...(Object.hasOwn(record, 'accuracyMeters') ? { accuracyMeters } : {}),
      driverId: textOrNull(record.driverId),
      eventId,
      ...(typeof record.gapBefore === 'boolean' ? { gapBefore: record.gapBefore } : {}),
      occurredAt,
      receivedAt,
      ...(sourceIndex === null ? {} : { sourceIndex })
    }];
  });
}

function readAccuracyMeters(payload: unknown): number | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const nested = record.location !== null && typeof record.location === 'object' && !Array.isArray(record.location)
    ? (record.location as Record<string, unknown>).accuracyMeters
    : undefined;
  return normalizeAccuracyMeters(record.accuracyMeters ?? record.accuracy ?? nested);
}

function normalizeAccuracyMeters(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

function hasCurrentQualityMetadata(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((sample) => sample !== null && typeof sample === 'object' && !Array.isArray(sample)
    && typeof (sample as Record<string, unknown>).gapBefore === 'boolean'
    && Number.isInteger((sample as Record<string, unknown>).sourceIndex));
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function getHeadingChangeDegrees(
  start: [number, number],
  middle: [number, number],
  end: [number, number]
): number {
  const first = bearingDegrees(start, middle);
  const second = bearingDegrees(middle, end);
  const difference = Math.abs(first - second) % 360;
  return difference > 180 ? 360 - difference : difference;
}

function bearingDegrees(from: [number, number], to: [number, number]): number {
  const latitude = toRadians((from[1] + to[1]) / 2);
  const x = (to[0] - from[0]) * Math.cos(latitude);
  const y = to[1] - from[1];
  return Math.atan2(x, y) * 180 / Math.PI;
}

function distancePointToSegmentMeters(
  point: [number, number],
  segmentStart: [number, number],
  segmentEnd: [number, number]
): number {
  const referenceLatitude = toRadians((point[1] + segmentStart[1] + segmentEnd[1]) / 3);
  const project = ([longitude, latitude]: [number, number]): [number, number] => [
    EARTH_RADIUS_METERS * toRadians(longitude) * Math.cos(referenceLatitude),
    EARTH_RADIUS_METERS * toRadians(latitude)
  ];
  const projectedPoint = project(point);
  const projectedStart = project(segmentStart);
  const projectedEnd = project(segmentEnd);
  const deltaX = projectedEnd[0] - projectedStart[0];
  const deltaY = projectedEnd[1] - projectedStart[1];
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) return Math.hypot(projectedPoint[0] - projectedStart[0], projectedPoint[1] - projectedStart[1]);
  const ratio = Math.max(0, Math.min(1, (
    (projectedPoint[0] - projectedStart[0]) * deltaX
    + (projectedPoint[1] - projectedStart[1]) * deltaY
  ) / lengthSquared));
  const closestX = projectedStart[0] + ratio * deltaX;
  const closestY = projectedStart[1] + ratio * deltaY;
  return Math.hypot(projectedPoint[0] - closestX, projectedPoint[1] - closestY);
}

function finiteCoordinate(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textOrNull(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function dateStringOrNull(value: unknown): string | null {
  const timestamp = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
