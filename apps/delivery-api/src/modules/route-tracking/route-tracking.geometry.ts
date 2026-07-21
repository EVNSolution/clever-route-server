import { Prisma } from '@prisma/client';

import { ROUTE_TRACKING_V1_POLICY } from './route-tracking.policy.js';

const ROUTE_TRACKING_GEOMETRY_RETENTION_DAYS = 90;
const ROUTE_TRACKING_GEOMETRY_SCHEMA_VERSION = 'route_tracking_geometry.v1';
const EARTH_RADIUS_METERS = 6_371_000;

export type RouteTrackingGeometrySampleV1 = {
  driverId: string | null;
  eventId: string;
  occurredAt: string;
  receivedAt: string;
};

export type RouteTrackingGeometryDocumentV1 = {
  coordinates: Array<[number, number]>;
  samples: RouteTrackingGeometrySampleV1[];
  sourcePointCount: number;
};

export type RouteTrackingGeometryPositionInput = RouteTrackingGeometrySampleV1 & {
  latitude: number;
  longitude: number;
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
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${position.routePlanId}, 0))`
  );

  const current = await prisma.routeTrackingGeometry.findUnique({
    where: { routePlanId: position.routePlanId }
  });
  const currentLastOccurredAt = current?.lastOccurredAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const nextOccurredAt = Date.parse(position.occurredAt);
  const mustRebuild = current !== null && Number.isFinite(nextOccurredAt) && nextOccurredAt < currentLastOccurredAt;
  const document = mustRebuild
    ? buildRouteTrackingGeometryDocument(await loadRouteTrackingPositions(prisma, position.routePlanId))
    : appendRouteTrackingGeometryPosition(readRouteTrackingGeometryDocument(current), position);
  const write = createRouteTrackingGeometryWrite(position.routePlanId, document);

  await prisma.routeTrackingGeometry.upsert({
    create: write,
    update: write,
    where: { routePlanId: position.routePlanId }
  });
  return document;
}

export function buildRouteTrackingGeometryDocument(
  positions: RouteTrackingGeometryPositionInput[]
): RouteTrackingGeometryDocumentV1 {
  const ordered = uniqueValidPositions(positions).sort(comparePositions);
  return ordered.reduce<RouteTrackingGeometryDocumentV1>(
    (document, position) => appendRouteTrackingGeometryPosition(document, position),
    { coordinates: [], samples: [], sourcePointCount: 0 }
  );
}

export function appendRouteTrackingGeometryPosition(
  document: RouteTrackingGeometryDocumentV1,
  position: RouteTrackingGeometryPositionInput
): RouteTrackingGeometryDocumentV1 {
  if (!isValidPosition(position)) return document;
  if (document.samples.some((sample) => sample.eventId === position.eventId)) return document;

  const coordinates = [...document.coordinates];
  const samples = [...document.samples];
  const coordinate: [number, number] = [position.longitude, position.latitude];
  const sample = toSample(position);
  const previousSample = samples.at(-1);
  const hasTrackingGap = previousSample !== undefined
    && Date.parse(sample.occurredAt) - Date.parse(previousSample.occurredAt) > ROUTE_TRACKING_V1_POLICY.delayedThresholdMs;
  const canReplaceTail = !hasTrackingGap
    && coordinates.length >= 2
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

  return {
    coordinates,
    samples,
    sourcePointCount: document.sourcePointCount + 1
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
      driverId,
      eventId: sample.eventId,
      latitude: coordinate[1],
      longitude: coordinate[0],
      occurredAt: sample.occurredAt,
      receivedAt: sample.receivedAt,
      routePlanId: record.routePlanId,
      schemaVersion: 'route_tracking.v1' as const
    }];
  });
}

function createRouteTrackingGeometryWrite(routePlanId: string, document: RouteTrackingGeometryDocumentV1) {
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
  routePlanId: string
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
      routePlanId: true
    },
    where: {
      eventType: 'LOCATION_UPDATED',
      latitude: { not: null },
      longitude: { not: null },
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

function toSample(position: RouteTrackingGeometryPositionInput): RouteTrackingGeometrySampleV1 {
  return {
    driverId: position.driverId,
    eventId: position.eventId,
    occurredAt: new Date(position.occurredAt).toISOString(),
    receivedAt: new Date(position.receivedAt).toISOString()
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
    return [{
      driverId: textOrNull(record.driverId),
      eventId,
      occurredAt,
      receivedAt
    }];
  });
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
