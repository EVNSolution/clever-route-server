import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

import type {
  RoutePlanDetail,
  RoutePlanRouteGeometry,
  RoutePlanRouteMetrics,
  RoutePlanRouteStopPoint
} from './route-plan.types.js';

export type RouteGeometryCacheSource =
  | 'CREATE_ROUTE'
  | 'SHAPE_MUTATION'
  | 'SNAPSHOT'
  | 'OPTIMIZATION_APPLY'
  | 'EXPLICIT_REFRESH'
  | 'PERIODIC_SYNC';

export type RouteGeometryCacheRead = {
  generatedAt: Date | string;
  geometry: unknown;
  metrics: unknown;
  provider: string;
  providerVersion: string | null;
  shapeSignature: string;
  source: string;
  stopPoints: unknown;
};

export type RouteGeometryCacheWrite = {
  generatedAt?: Date;
  geometry: RoutePlanRouteGeometry | null;
  metrics: RoutePlanRouteMetrics | null;
  provider: string;
  providerVersion?: string | null;
  routePlanId: string;
  shapeSignature: string;
  source: RouteGeometryCacheSource;
  stopPoints: RoutePlanRouteStopPoint[];
};

export function routeGeometryCacheCreateData(input: RouteGeometryCacheWrite): Prisma.RoutePlanGeometryCacheUncheckedCreateInput {
  return {
    generatedAt: input.generatedAt ?? new Date(),
    geometry: input.geometry === null ? Prisma.JsonNull : toJson(input.geometry),
    metrics: input.metrics === null ? Prisma.JsonNull : toJson(input.metrics),
    overview: 'simplified',
    provider: input.provider,
    providerVersion: input.providerVersion ?? null,
    routePlanId: input.routePlanId,
    shapeSignature: input.shapeSignature,
    source: input.source,
    stopPoints: toJson(input.stopPoints)
  };
}

export function routeGeometryCacheUpsertArgs(input: RouteGeometryCacheWrite): Prisma.RoutePlanGeometryCacheUpsertArgs {
  const data = routeGeometryCacheCreateData(input);
  return {
    create: data,
    update: data,
    where: {
      routePlanId_shapeSignature: {
        routePlanId: input.routePlanId,
        shapeSignature: input.shapeSignature
      }
    }
  };
}

export function computeRouteShapeSignature(detail: RoutePlanDetail): string {
  const routePlan = detail.routePlan;
  return stableHash({
    depot: normalizeCoordinatePair(routePlan.depot.latitude, routePlan.depot.longitude),
    routeEndMode: routePlan.routeEndMode,
    stops: [...detail.stops]
      .sort((left, right) => left.sequence - right.sequence)
      .map((stop) => ({
        deliveryStopId: stop.deliveryStopId,
        orderId: stop.orderId,
        sequence: stop.sequence,
        coordinates: normalizeCoordinatePair(stop.coordinates.latitude, stop.coordinates.longitude)
      }))
  });
}

export function applyCachedRouteGeometry(detail: RoutePlanDetail, cache: RouteGeometryCacheRead | null | undefined): RoutePlanDetail {
  const expectedSignature = computeRouteShapeSignature(detail);
  if (cache === null || cache === undefined) {
    return {
      ...detail,
      routeGeometry: null,
      routeGeometryGeneratedAt: null,
      routeGeometrySource: null,
      routeGeometryStatus: 'missing',
      routeMetrics: null,
      routeShapeSignature: expectedSignature,
      routeStopPoints: []
    };
  }

  if (cache.shapeSignature !== expectedSignature) {
    return {
      ...detail,
      routeGeometry: null,
      routeGeometryGeneratedAt: normalizeDateString(cache.generatedAt),
      routeGeometrySource: cache.source,
      routeGeometryStatus: 'stale',
      routeMetrics: null,
      routeShapeSignature: expectedSignature,
      routeStopPoints: []
    };
  }

  const geometry = readRouteGeometry(cache.geometry);
  const metrics = readRouteMetrics(cache.metrics);
  const stopPoints = readRouteStopPoints(cache.stopPoints);
  return {
    ...detail,
    routeGeometry: geometry,
    routeGeometryGeneratedAt: normalizeDateString(cache.generatedAt),
    routeGeometrySource: cache.source,
    routeGeometryStatus: geometry === null ? 'unavailable' : 'fresh',
    routeMetrics: metrics,
    routeShapeSignature: expectedSignature,
    routeStopPoints: stopPoints
  };
}

export function withRouteGeometryResult(
  detail: RoutePlanDetail,
  result: {
    routeGeometry: RoutePlanRouteGeometry | null;
    routeMetrics: RoutePlanRouteMetrics | null;
    routeStopPoints: RoutePlanRouteStopPoint[];
  },
  input: { generatedAt?: Date; source: RouteGeometryCacheSource }
): RoutePlanDetail {
  return {
    ...detail,
    routeGeometry: result.routeGeometry,
    routeGeometryGeneratedAt: (input.generatedAt ?? new Date()).toISOString(),
    routeGeometrySource: input.source,
    routeGeometryStatus: result.routeGeometry === null ? 'unavailable' : 'fresh',
    routeMetrics: result.routeMetrics,
    routeShapeSignature: computeRouteShapeSignature(detail),
    routeStopPoints: result.routeStopPoints
  };
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function normalizeCoordinatePair(latitude: number | null, longitude: number | null): { latitude: number | null; longitude: number | null } {
  return {
    latitude: normalizeCoordinate(latitude),
    longitude: normalizeCoordinate(longitude)
  };
}

function normalizeCoordinate(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(7));
}

function normalizeDateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function readRouteGeometry(value: unknown): RoutePlanRouteGeometry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== 'LineString' || !Array.isArray(record.coordinates)) return null;
  const coordinates = record.coordinates
    .map((entry) => readCoordinateTuple(entry))
    .filter((entry): entry is [number, number] => entry !== null);
  return coordinates.length < 2 ? null : { type: 'LineString', coordinates };
}

function readCoordinateTuple(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = Number(value[0]);
  const latitude = Number(value[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return [longitude, latitude];
}

function readRouteMetrics(value: unknown): RoutePlanRouteMetrics | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    distanceMeters: readNullableNumber(record.distanceMeters),
    durationSeconds: readNullableNumber(record.durationSeconds)
  };
}

function readRouteStopPoints(value: unknown): RoutePlanRouteStopPoint[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readRouteStopPoint(entry)).filter((entry): entry is RoutePlanRouteStopPoint => entry !== null);
}

function readRouteStopPoint(value: unknown): RoutePlanRouteStopPoint | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const deliveryStopId = readString(record.deliveryStopId);
  const sequence = readNumber(record.sequence);
  const shopifyOrderGid = readString(record.shopifyOrderGid);
  if (deliveryStopId === null || sequence === null || shopifyOrderGid === null) return null;
  return {
    deliveryStopId,
    inputCoordinates: readCoordinateTuple(record.inputCoordinates),
    name: readString(record.name),
    sequence,
    shopifyOrderGid,
    snapDistanceMeters: readNullableNumber(record.snapDistanceMeters),
    snappedCoordinates: readCoordinateTuple(record.snappedCoordinates)
  };
}

function readNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function readNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) ? numberValue : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
