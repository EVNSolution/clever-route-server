import type { PrismaClient } from '@prisma/client';
import type { PrismaDriverSyncHealthService, DriverSyncHealthDto } from '../driver/driver-sync-health.service.js';
import type { OperationalAlertDto, PrismaOperationalAlertRepository } from '../notifications/operational-alert.repository.js';

export type RouteOperationalStateV1 = {
  activeAlerts: OperationalAlertDto[];
  deviceProgress: {
    completedStopCount: number;
    currentStopSequence: number | null;
    locallyFinished: boolean;
    totalStopCount: number;
  } | null;
  observedAt: string;
  physicalPosition: {
    accuracyMeters: number | null;
    distanceMeters: number | null;
    freshness: 'AGING' | 'FRESH' | 'STALE' | 'UNKNOWN';
    nearestStopSequence: number | null;
    occurredAt: string;
    proximityPolicyVersion: 1;
    proximityThresholdMeters: number;
    reliableForProximity: boolean;
    receivedAt: string;
    withinProximityThreshold: boolean | null;
  } | null;
  routePlanId: string;
  routeStatus: string;
  serverProgress: {
    deliveredStopCount: number;
    failedStopCount: number;
    lastConfirmedAt: string | null;
    resolvedStopCount: number;
    totalStopCount: number;
  };
  syncHealth: DriverSyncHealthDto | null;
};

export class PrismaRouteOperationalStateService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly syncHealth: PrismaDriverSyncHealthService,
    private readonly alerts: PrismaOperationalAlertRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async get(routePlanId: string): Promise<RouteOperationalStateV1 | null> {
    return (await this.getMany([routePlanId])).get(routePlanId) ?? null;
  }

  async getMany(routePlanIds: string[]): Promise<Map<string, RouteOperationalStateV1>> {
    const uniqueRoutePlanIds = [...new Set(routePlanIds)];
    if (uniqueRoutePlanIds.length === 0) return new Map();
    const now = this.now();
    const routes = await this.prisma.routePlan.findMany({
      include: {
        driverRouteSessionLeases: {
          include: { syncSession: { include: { heartbeats: { orderBy: { heartbeatSequence: 'desc' }, take: 1 } } } },
          orderBy: { issuedAt: 'desc' },
          take: 1,
          where: { expiresAt: { gt: now }, revokedAt: null }
        },
        trackingGeometry: { select: { lastEventId: true, lastLatitude: true, lastLongitude: true, lastOccurredAt: true, lastReceivedAt: true } },
        routeStops: { include: { deliveryStop: { select: { latitude: true, longitude: true, status: true, updatedAt: true } } } }
      },
      where: { id: { in: uniqueRoutePlanIds } }
    });
    const positionEventIds = routes.flatMap(({ trackingGeometry }) => trackingGeometry === null ? [] : [trackingGeometry.lastEventId]);
    const [positionEvents, activeAlerts, syncHealth] = await Promise.all([
      positionEventIds.length === 0
        ? Promise.resolve([])
        : this.prisma.driverEvent.findMany({ select: { id: true, payload: true }, where: { id: { in: positionEventIds } } }),
      this.alerts.listActiveForRoutePlans(uniqueRoutePlanIds),
      this.syncHealth.getActiveSyncHealthForRoutePlans(uniqueRoutePlanIds, now)
    ]);
    const positionPayloadByEventId = new Map(positionEvents.map((event) => [event.id, event.payload]));
    return new Map(routes.map((route) => [route.id, toOperationalState({
      activeAlerts: activeAlerts.get(route.id) ?? [],
      now,
      positionPayload: route.trackingGeometry === null
        ? null
        : positionPayloadByEventId.get(route.trackingGeometry.lastEventId) ?? null,
      route,
      syncHealth: syncHealth.get(route.id) ?? null
    })]));
  }
}

function toOperationalState(input: {
  activeAlerts: OperationalAlertDto[];
  now: Date;
  positionPayload: unknown;
  route: {
    constraints: unknown;
    driverRouteSessionLeases: Array<{ syncSession: { heartbeats: Array<{
      completedStopCount: number | null;
      currentStopSequence: number | null;
      locallyFinished: boolean | null;
      totalStopCount: number | null;
    }> } }>;
    id: string;
    routeStops: Array<{ sequence: number; deliveryStop: { latitude: unknown; longitude: unknown; status: string; updatedAt: Date } }>;
    status: string;
    trackingGeometry: { lastEventId: string; lastLatitude: unknown; lastLongitude: unknown; lastOccurredAt: Date; lastReceivedAt: Date } | null;
  };
  syncHealth: DriverSyncHealthDto | null;
}): RouteOperationalStateV1 {
  const { route } = input;
  const activeLease = route.driverRouteSessionLeases[0] ?? null;
  const latestHeartbeat = activeLease?.syncSession.heartbeats[0] ?? null;
  const delivered = route.routeStops.filter(({ deliveryStop }) => deliveryStop.status === 'DELIVERED');
  const failed = route.routeStops.filter(({ deliveryStop }) => deliveryStop.status === 'FAILED');
  const resolved = route.routeStops.filter(({ deliveryStop }) => ['CANCELLED', 'DELIVERED', 'FAILED', 'SKIPPED'].includes(deliveryStop.status));
  const lastConfirmedAt = resolved.reduce<Date | null>((latest, stop) => latest === null || stop.deliveryStop.updatedAt > latest ? stop.deliveryStop.updatedAt : latest, null);
  const physicalPosition = route.trackingGeometry === null
    ? null
    : derivePhysicalPosition(route.trackingGeometry, route.routeStops, input.positionPayload, route.constraints, input.now);
  return {
    activeAlerts: input.activeAlerts,
    deviceProgress: latestHeartbeat === null || latestHeartbeat.completedStopCount === null || latestHeartbeat.totalStopCount === null
      ? null
      : {
          completedStopCount: latestHeartbeat.completedStopCount,
          currentStopSequence: latestHeartbeat.currentStopSequence,
          locallyFinished: latestHeartbeat.locallyFinished ?? false,
          totalStopCount: latestHeartbeat.totalStopCount
        },
    observedAt: input.now.toISOString(),
    physicalPosition,
    routePlanId: route.id,
    routeStatus: route.status,
    serverProgress: {
      deliveredStopCount: delivered.length,
      failedStopCount: failed.length,
      lastConfirmedAt: lastConfirmedAt?.toISOString() ?? null,
      resolvedStopCount: resolved.length,
      totalStopCount: route.routeStops.length
    },
    syncHealth: input.syncHealth
  };
}

const DEFAULT_PROXIMITY_THRESHOLD_METERS = 100;
const DEFAULT_MAX_ACCURACY_METERS = 100;

function derivePhysicalPosition(
  geometry: { lastLatitude: unknown; lastLongitude: unknown; lastOccurredAt: Date; lastReceivedAt: Date },
  stops: Array<{ sequence: number; deliveryStop: { latitude: unknown; longitude: unknown; status: string } }>,
  payload: unknown,
  constraints: unknown,
  now: Date
): RouteOperationalStateV1['physicalPosition'] {
  const latitude = coordinate(geometry.lastLatitude);
  const longitude = coordinate(geometry.lastLongitude);
  const policy = readProximityPolicy(constraints);
  const accuracyMeters = readAccuracyMeters(payload);
  const nearest = stops
    .filter(({ deliveryStop }) => !['CANCELLED', 'DELIVERED', 'FAILED', 'SKIPPED'].includes(deliveryStop.status))
    .flatMap((stop) => {
      const stopLatitude = coordinate(stop.deliveryStop.latitude);
      const stopLongitude = coordinate(stop.deliveryStop.longitude);
      return stopLatitude !== null && stopLongitude !== null && latitude !== null && longitude !== null
        ? [{ distanceMeters: haversineMeters(latitude, longitude, stopLatitude, stopLongitude), sequence: stop.sequence }]
        : [];
    })
    .sort((left, right) => left.distanceMeters - right.distanceMeters)[0] ?? null;
  const freshness = positionFreshness(geometry.lastOccurredAt, now);
  const reliableForProximity = accuracyMeters !== null
    && accuracyMeters <= policy.maxAccuracyMeters
    && (freshness === 'FRESH' || freshness === 'AGING')
    && nearest !== null;
  return {
    accuracyMeters,
    distanceMeters: nearest?.distanceMeters ?? null,
    freshness,
    nearestStopSequence: nearest?.sequence ?? null,
    occurredAt: geometry.lastOccurredAt.toISOString(),
    proximityPolicyVersion: 1,
    proximityThresholdMeters: policy.proximityThresholdMeters,
    reliableForProximity,
    receivedAt: geometry.lastReceivedAt.toISOString(),
    withinProximityThreshold: reliableForProximity && nearest !== null
      ? nearest.distanceMeters <= policy.proximityThresholdMeters
      : null
  };
}

function coordinate(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readAccuracyMeters(payload: unknown): number | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const nested = record.location !== null && typeof record.location === 'object' && !Array.isArray(record.location)
    ? (record.location as Record<string, unknown>).accuracyMeters
    : undefined;
  const value = record.accuracyMeters ?? record.accuracy ?? nested;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readProximityPolicy(constraints: unknown): { maxAccuracyMeters: number; proximityThresholdMeters: number } {
  if (constraints === null || typeof constraints !== 'object' || Array.isArray(constraints)) {
    return { maxAccuracyMeters: DEFAULT_MAX_ACCURACY_METERS, proximityThresholdMeters: DEFAULT_PROXIMITY_THRESHOLD_METERS };
  }
  const operationalHealth = (constraints as Record<string, unknown>).operationalHealth;
  const record = operationalHealth !== null && typeof operationalHealth === 'object' && !Array.isArray(operationalHealth)
    ? operationalHealth as Record<string, unknown>
    : {};
  return {
    maxAccuracyMeters: positiveNumber(record.maxGpsAccuracyMeters) ?? DEFAULT_MAX_ACCURACY_METERS,
    proximityThresholdMeters: positiveNumber(record.proximityThresholdMeters) ?? DEFAULT_PROXIMITY_THRESHOLD_METERS
  };
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function haversineMeters(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(latitude2 - latitude1);
  const longitudeDelta = radians(longitude2 - longitude1);
  const left = radians(latitude1);
  const right = radians(latitude2);
  const halfChord = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left) * Math.cos(right) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(halfChord), Math.sqrt(1 - halfChord));
}

function positionFreshness(occurredAt: Date, now: Date): 'AGING' | 'FRESH' | 'STALE' | 'UNKNOWN' {
  const occurredAtMs = occurredAt.getTime();
  if (!Number.isFinite(occurredAtMs) || occurredAtMs > now.getTime()) return 'UNKNOWN';
  const ageSeconds = (now.getTime() - occurredAtMs) / 1000;
  if (ageSeconds <= 120) return 'FRESH';
  if (ageSeconds <= 300) return 'AGING';
  return 'STALE';
}
