import type { PrismaClient } from '@prisma/client';

import {
  ROUTE_TRACKING_SCHEMA_VERSION,
  ROUTE_TRACKING_V1_POLICY
} from './route-tracking.policy.js';
import type {
  RouteTrackingPositionEventV1,
  RouteTrackingProgressEventType,
  RouteTrackingProgressEventV1,
  RouteTrackingProgressSnapshotV1,
  RouteTrackingService,
  RouteTrackingSnapshotV1,
  RouteTrackingStatus
} from './route-tracking.types.js';

type RouteTrackingPrismaClient = Pick<PrismaClient, 'driverEvent' | 'routePlanStop'>;

const ROUTE_TRACKING_PROGRESS_EVENT_TYPES: RouteTrackingProgressEventType[] = [
  'ROUTE_STARTED',
  'ROUTE_PAUSED',
  'ROUTE_COMPLETED',
  'STOP_ARRIVED',
  'STOP_DELIVERED',
  'STOP_FAILED'
];

type DriverLocationEventRow = {
  createdAt: Date;
  driverId: string | null;
  id: string;
  latitude: unknown;
  longitude: unknown;
  occurredAt: Date;
  routePlanId: string | null;
};

type DriverProgressEventRow = {
  createdAt: Date;
  deliveryStopId: string | null;
  driverId: string | null;
  eventType: string;
  id: string;
  occurredAt: Date;
  routePlanId: string | null;
};

export class PrismaRouteTrackingService implements RouteTrackingService {
  constructor(private readonly prisma: RouteTrackingPrismaClient) {}

  async getRouteTrackingSnapshot(input: {
    now?: Date;
    routePlanId: string;
  }): Promise<RouteTrackingSnapshotV1> {
    const serverTime = input.now ?? new Date();
    const [rows, latestProgressRow, routeStops] = await Promise.all([
      this.prisma.driverEvent.findMany({
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        createdAt: true,
        driverId: true,
        id: true,
        latitude: true,
        longitude: true,
        occurredAt: true,
        routePlanId: true
      },
      take: ROUTE_TRACKING_V1_POLICY.recentPositionsLimit,
      where: {
        eventType: 'LOCATION_UPDATED',
        latitude: { not: null },
        longitude: { not: null },
        routePlanId: input.routePlanId
      }
      }),
      this.prisma.driverEvent.findFirst({
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          createdAt: true,
          deliveryStopId: true,
          driverId: true,
          eventType: true,
          id: true,
          occurredAt: true,
          routePlanId: true
        },
        where: {
          eventType: { in: ROUTE_TRACKING_PROGRESS_EVENT_TYPES },
          routePlanId: input.routePlanId
        }
      }),
      this.prisma.routePlanStop.findMany({
        select: {
          deliveryStop: { select: { status: true } },
          deliveryStopId: true
        },
        where: { routePlanId: input.routePlanId }
      })
    ]);
    const recentPositions = rows
      .map((row) => toPositionEvent(row))
      .filter((position): position is RouteTrackingPositionEventV1 => position !== null)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const latestPosition = recentPositions.at(-1) ?? null;
    const progress = buildProgressSnapshot(latestProgressRow, routeStops);

    return {
      latestPosition,
      policy: ROUTE_TRACKING_V1_POLICY,
      progress,
      recentPositions,
      routePlanId: input.routePlanId,
      schemaVersion: ROUTE_TRACKING_SCHEMA_VERSION,
      serverTime: serverTime.toISOString(),
      status: getTrackingStatus(latestPosition, serverTime)
    };
  }
}

export function createRouteTrackingProgressEvent(input: {
  deliveryStopId: string | null;
  driverId: string | null;
  eventId: string;
  eventType: string;
  occurredAt: Date;
  receivedAt?: Date;
  routePlanId: string | null;
}): RouteTrackingProgressEventV1 | null {
  if (
    input.driverId === null ||
    input.routePlanId === null ||
    !isRouteTrackingProgressEventType(input.eventType)
  ) {
    return null;
  }

  return {
    deliveryStopId: input.deliveryStopId,
    driverId: input.driverId,
    eventId: input.eventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt.toISOString(),
    receivedAt: (input.receivedAt ?? new Date()).toISOString(),
    routePlanId: input.routePlanId,
    schemaVersion: ROUTE_TRACKING_SCHEMA_VERSION
  };
}

export function createRouteTrackingPositionEvent(input: {
  driverId: string | null;
  eventId: string;
  latitude: string | null;
  longitude: string | null;
  occurredAt: Date;
  receivedAt?: Date;
  routePlanId: string | null;
}): RouteTrackingPositionEventV1 | null {
  if (
    input.driverId === null ||
    input.routePlanId === null ||
    input.latitude === null ||
    input.longitude === null
  ) {
    return null;
  }

  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    driverId: input.driverId,
    eventId: input.eventId,
    latitude,
    longitude,
    occurredAt: input.occurredAt.toISOString(),
    receivedAt: (input.receivedAt ?? new Date()).toISOString(),
    routePlanId: input.routePlanId,
    schemaVersion: ROUTE_TRACKING_SCHEMA_VERSION
  };
}

function toPositionEvent(row: DriverLocationEventRow): RouteTrackingPositionEventV1 | null {
  return createRouteTrackingPositionEvent({
    driverId: row.driverId,
    eventId: row.id,
    latitude: stringifyCoordinate(row.latitude),
    longitude: stringifyCoordinate(row.longitude),
    occurredAt: row.occurredAt,
    receivedAt: row.createdAt,
    routePlanId: row.routePlanId
  });
}

function toProgressEvent(row: DriverProgressEventRow | null): RouteTrackingProgressEventV1 | null {
  if (row === null) return null;
  return createRouteTrackingProgressEvent({
    deliveryStopId: row.deliveryStopId,
    driverId: row.driverId,
    eventId: row.id,
    eventType: row.eventType,
    occurredAt: row.occurredAt,
    receivedAt: row.createdAt,
    routePlanId: row.routePlanId
  });
}

function buildProgressSnapshot(
  latestProgressRow: DriverProgressEventRow | null,
  routeStops: Array<{ deliveryStop: { status: string }; deliveryStopId: string }>
): RouteTrackingProgressSnapshotV1 {
  const latestEvent = toProgressEvent(latestProgressRow);
  return {
    completedStopIds: routeStops
      .filter((routeStop) => routeStop.deliveryStop.status === 'DELIVERED')
      .map((routeStop) => routeStop.deliveryStopId),
    currentStage: getDriverStage(latestEvent),
    currentStopId: latestEvent?.eventType === 'STOP_ARRIVED' ? latestEvent.deliveryStopId : null,
    failedStopIds: routeStops
      .filter((routeStop) => routeStop.deliveryStop.status === 'FAILED')
      .map((routeStop) => routeStop.deliveryStopId),
    latestEvent
  };
}

function getDriverStage(event: RouteTrackingProgressEventV1 | null): RouteTrackingProgressSnapshotV1['currentStage'] {
  if (event === null) return 'READY';
  if (event.eventType === 'ROUTE_COMPLETED') return 'COMPLETED';
  if (event.eventType === 'ROUTE_PAUSED') return 'PAUSED';
  if (event.eventType === 'STOP_ARRIVED') return 'AT_STOP';
  return 'DRIVING';
}

function isRouteTrackingProgressEventType(value: string): value is RouteTrackingProgressEventType {
  return ROUTE_TRACKING_PROGRESS_EVENT_TYPES.includes(value as RouteTrackingProgressEventType);
}

function stringifyCoordinate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  if (hasToNumber(value)) return String(value.toNumber());
  return null;
}

function hasToNumber(value: unknown): value is { toNumber(): number } {
  return typeof value === 'object' && value !== null && 'toNumber' in value && typeof value.toNumber === 'function';
}

function getTrackingStatus(
  latestPosition: RouteTrackingPositionEventV1 | null,
  serverTime: Date
): RouteTrackingStatus {
  if (latestPosition === null) return 'NO_POSITION';
  const ageMs = serverTime.getTime() - new Date(latestPosition.occurredAt).getTime();
  if (ageMs <= ROUTE_TRACKING_V1_POLICY.liveThresholdMs) return 'LIVE';
  if (ageMs <= ROUTE_TRACKING_V1_POLICY.delayedThresholdMs) return 'DELAYED';
  return 'STALE';
}
