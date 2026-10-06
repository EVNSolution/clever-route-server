import { DsvEtaStatus, Prisma, type PrismaClient } from '@prisma/client';

import { replayRollingEta, sha256CanonicalJson, type RollingEtaReplayStop } from '../driver/rolling-eta-backfill.js';
import { computeRouteShapeSignature, computeRouteShapeSignatureFromParts, routeGeometryCacheCreateData } from '../route-plans/route-plan-geometry-cache.js';
import { PrismaRoutePlanRepository } from '../route-plans/route-plan.repository.js';
import type { RouteGeometryProvider } from '../route-plans/route-plan.service.js';
import type { RoutePlanRouteResult } from '../route-plans/route-plan.types.js';

const PROGRESS_EVENTS = ['ROUTE_STARTED', 'PICKUP_COMPLETED', 'STOP_ARRIVED', 'STOP_DELIVERED', 'STOP_FAILED'] as const;
const SNAPSHOT_SELECT = {
  assignmentGeneration: true,
  constraints: true,
  depotLatitude: true,
  depotLongitude: true,
  driverEvents: {
    orderBy: { id: 'asc' },
    select: { createdAt: true, deliveryStopId: true, driverId: true, eventType: true, id: true, occurredAt: true, routeVersionId: true }
  },
  driverId: true,
  id: true,
  isStoreReviewData: true,
  planDate: true,
  routeGeometryCaches: { orderBy: { id: 'asc' }, select: { id: true, shapeSignature: true } },
  routeGroupingChildVersions: {
    orderBy: { id: 'asc' },
    select: { id: true, status: true, supersededAt: true, updatedAt: true }
  },
  routeStops: {
    orderBy: { sequence: 'asc' },
    select: {
      deliveryStop: {
        select: {
          latitude: true,
          longitude: true,
          order: { select: { currentRouteVersionId: true, id: true, updatedAt: true } },
          serviceMinutes: true,
          status: true,
          updatedAt: true
        }
      },
      deliveryStopId: true,
      distanceFromPreviousMeters: true,
      durationFromPreviousSeconds: true,
      estimatedArrivalAt: true,
      etaCalculatedAt: true,
      etaFailureCode: true,
      etaFailureMessage: true,
      etaInputRouteVersionId: true,
      etaSource: true,
      etaStatus: true,
      id: true,
      sequence: true,
      shopId: true,
      updatedAt: true
    }
  },
  shopId: true,
  status: true,
  updatedAt: true,
  vehicleId: true
} as const satisfies Prisma.RoutePlanSelect;

type RouteSnapshot = Prisma.RoutePlanGetPayload<{ select: typeof SNAPSHOT_SELECT }>;
type Db = PrismaClient | Prisma.TransactionClient;

export type DsvEtaRepairScope = {
  plannedStarts: Record<string, string>;
  routePlanIds: string[];
  shopDomain: string;
  shopId: string;
};
export type DsvEtaRepairStopUpdate = {
  before: {
    distanceFromPreviousMeters: number | null;
    durationFromPreviousSeconds: number | null;
    estimatedArrivalAt: string | null;
    etaCalculatedAt: string | null;
    etaFailureCode: string | null;
    etaFailureMessage: string | null;
    etaInputRouteVersionId: string | null;
    etaSource: string | null;
    etaStatus: string;
  };
  deliveryStopId: string;
  distanceFromPreviousMeters: number;
  durationFromPreviousSeconds: number;
  estimatedArrivalAt: string | null;
  etaCalculatedAt: string | null;
  etaInputRouteVersionId: string | null;
  etaSource: string | null;
  etaStatus: 'READY';
  expectedUpdatedAt: string;
  id: string;
  routePlanId: string;
  sequence: number;
};
export type DsvEtaRepairPlan = {
  generatedAt: string;
  routes: Array<{
    beforeCacheIds?: string[];
    beforeFingerprint: string;
    cacheAction?: 'CREATE' | 'REUSE';
    executionFingerprint: string;
    geometry: RoutePlanRouteResult;
    plannedStartAt: string;
    plannedStartSource: 'REVIEWED_OVERRIDE';
    routePlanId: string;
    shapeSignature: string;
    status: 'READY' | 'IN_PROGRESS' | 'COMPLETED';
    stops: DsvEtaRepairStopUpdate[];
  }>;
  schema: 'dsv_eta_missing_duration_repair_v1' | 'dsv_eta_missing_duration_repair_v2';
  sourceRevision: string;
  scope: DsvEtaRepairScope;
};

export class DsvEtaRepairRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function createDsvEtaRepairPlan(
  prisma: PrismaClient,
  provider: RouteGeometryProvider,
  scope: DsvEtaRepairScope,
  sourceRevision: string,
  now = new Date()
): Promise<DsvEtaRepairPlan> {
  const shop = await prisma.shop.findUnique({ where: { id: scope.shopId }, select: { appId: true, shopDomain: true } });
  refuseUnless(shop?.appId === 'clever' && shop.shopDomain === scope.shopDomain, 'SHOP_SCOPE_MISMATCH');
  const repo = new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true });
  const routes: DsvEtaRepairPlan['routes'] = [];
  for (const routePlanId of scope.routePlanIds) {
    const before = await readRoute(prisma, scope, routePlanId);
    const currentVersionId = validateRoute(before, scope, 'dsv_eta_missing_duration_repair_v2');
    const detail = await repo.findRoutePlanDetail({ appId: 'clever', routePlanId, shopDomain: scope.shopDomain });
    refuseUnless(detail !== null, 'ROUTE_DETAIL_MISSING');
    const shapeSignature = computeRouteShapeSignature(detail);
    const hasMatchingCache = before.routeGeometryCaches.some((cache) => cache.shapeSignature === shapeSignature);
    const cached = hasMatchingCache
      && detail.routeGeometryStatus === 'fresh'
      && isCompleteGeometry(detail.routeGeometry, detail.routeMetrics)
      && detail.routeStopPoints.length === before.routeStops.length
      && before.routeStops.every((stop, index) => {
        const point = detail.routeStopPoints[index];
        return point?.deliveryStopId === stop.deliveryStopId && point.sequence === stop.sequence
          && roundedNonNegative(point.durationFromPreviousSeconds) !== null
          && roundedNonNegative(point.distanceFromPreviousMeters) !== null;
      });
    refuseUnless(!hasMatchingCache || cached, 'MATCHING_CACHE_INCOMPLETE');
    const geometry: RoutePlanRouteResult = cached
      ? { routeGeometry: detail.routeGeometry ?? null, routeMetrics: detail.routeMetrics ?? null, routeStopPoints: detail.routeStopPoints ?? [] }
      : await provider.buildRoute(detail);
    validateDsvEtaRepairGeometry(before, geometry);
    const plannedStartAt = new Date(scope.plannedStarts[routePlanId] ?? '');
    refuseUnless(Number.isFinite(plannedStartAt.getTime())
      && plannedStartAt.toISOString() === scope.plannedStarts[routePlanId]
      && Math.abs(plannedStartAt.getTime() - before.planDate.getTime()) < 24 * 60 * 60 * 1000,
    'REVIEWED_PLANNED_START_INVALID');
    const afterRead = await readRoute(prisma, scope, routePlanId);
    refuseUnless(fingerprint(before) === fingerprint(afterRead), 'CHANGED_DURING_DRY_RUN');
    routes.push({
      beforeCacheIds: before.routeGeometryCaches.map((cache) => cache.id),
      beforeFingerprint: fingerprint(before),
      cacheAction: cached ? 'REUSE' : 'CREATE',
      executionFingerprint: executionFingerprint(before),
      geometry,
      plannedStartAt: plannedStartAt.toISOString(),
      plannedStartSource: 'REVIEWED_OVERRIDE',
      routePlanId,
      shapeSignature,
      status: before.status as 'READY' | 'IN_PROGRESS' | 'COMPLETED',
      stops: buildDsvEtaRepairStopUpdates(before, geometry, currentVersionId, plannedStartAt, now)
    });
  }
  return { generatedAt: now.toISOString(), routes, schema: 'dsv_eta_missing_duration_repair_v2', sourceRevision, scope };
}

export async function applyDsvEtaRepairPlan(prisma: PrismaClient, plan: DsvEtaRepairPlan): Promise<{ appliedStops: number; routes: number }> {
  validateDsvEtaRepairPlanSchema(plan);
  return prisma.$transaction(async (tx) => {
    for (const routePlanId of plan.scope.routePlanIds) {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM route_plans WHERE id = ${routePlanId}::uuid AND "shopId" = ${plan.scope.shopId}::uuid FOR UPDATE
      `);
      refuseUnless(locked.length === 1, 'ROUTE_LOCK_MISSING');
    }
    let appliedStops = 0;
    for (const routePlanId of plan.scope.routePlanIds) {
      const item = plan.routes.find((route) => route.routePlanId === routePlanId);
      refuseUnless(item !== undefined, 'PLAN_ROUTE_MISSING');
      const before = await readRoute(tx, plan.scope, routePlanId);
      const currentVersionId = validateRoute(before, plan.scope, plan.schema);
      refuseUnless(fingerprintForSchema(before, plan.schema) === item.beforeFingerprint, 'CHANGED_SINCE_DRY_RUN');
      if (plan.schema === 'dsv_eta_missing_duration_repair_v2') {
        refuseUnless(fingerprint(before.routeGeometryCaches.map((cache) => cache.id)) === fingerprint(item.beforeCacheIds), 'CACHE_BASELINE_CHANGED');
      }
      refuseUnless(executionFingerprint(before) === item.executionFingerprint, 'EXECUTION_CHANGED_SINCE_DRY_RUN');
      validateDsvEtaRepairGeometry(before, item.geometry);
      refuseUnless(routeShapeSignature(before) === item.shapeSignature, 'SHAPE_SIGNATURE_MISMATCH');
      refuseUnless(item.plannedStartSource === 'REVIEWED_OVERRIDE'
        && item.plannedStartAt === plan.scope.plannedStarts[routePlanId], 'PLANNED_START_MISMATCH');
      const expected = buildDsvEtaRepairStopUpdates(
        before, item.geometry, currentVersionId, new Date(item.plannedStartAt), new Date(plan.generatedAt)
      );
      refuseUnless(fingerprint(expected) === fingerprint(item.stops), 'PLAN_ETA_MISMATCH');
      refuseUnless(item.stops.length === before.routeStops.length, 'PLAN_STOP_COUNT_MISMATCH');
      if (plan.schema === 'dsv_eta_missing_duration_repair_v1' || item.cacheAction === 'CREATE') {
        refuseUnless(!before.routeGeometryCaches.some((cache) => cache.shapeSignature === item.shapeSignature), 'CACHE_ALREADY_PRESENT');
        await tx.routePlanGeometryCache.create({
          data: routeGeometryCacheCreateData({
            generatedAt: new Date(plan.generatedAt),
            geometry: item.geometry.routeGeometry,
            metrics: item.geometry.routeMetrics,
            provider: 'osrm',
            routePlanId,
            shapeSignature: item.shapeSignature,
            source: 'EXPLICIT_REFRESH',
            stopPoints: item.geometry.routeStopPoints
          })
        });
      } else {
        refuseUnless(item.cacheAction === 'REUSE'
          && before.routeGeometryCaches.some((cache) => cache.shapeSignature === item.shapeSignature), 'CACHE_REUSE_MISMATCH');
      }
      for (const stop of item.stops) {
        const current = before.routeStops.find((candidate) => candidate.id === stop.id);
        refuseUnless(current?.deliveryStopId === stop.deliveryStopId && current.sequence === stop.sequence, 'PLAN_STOP_MISMATCH');
        const updated = await tx.routePlanStop.updateMany({
          data: {
            distanceFromPreviousMeters: stop.distanceFromPreviousMeters,
            durationFromPreviousSeconds: stop.durationFromPreviousSeconds,
            estimatedArrivalAt: stop.estimatedArrivalAt === null ? null : new Date(stop.estimatedArrivalAt),
            etaCalculatedAt: stop.etaCalculatedAt === null ? null : new Date(stop.etaCalculatedAt),
            etaFailureCode: null,
            etaFailureMessage: null,
            etaInputRouteVersionId: stop.etaInputRouteVersionId,
            etaSource: stop.etaSource,
            etaStatus: DsvEtaStatus.READY
          },
          where: {
            deliveryStopId: stop.deliveryStopId,
            id: stop.id,
            routePlanId,
            sequence: stop.sequence,
            shopId: plan.scope.shopId,
            updatedAt: new Date(stop.expectedUpdatedAt)
          }
        });
        refuseUnless(updated.count === 1, 'STOP_CHANGED_DURING_APPLY');
        appliedStops += 1;
      }
      const after = await readRoute(tx, plan.scope, routePlanId);
      await assertAppliedRoute(tx, item, after, plan.schema);
    }
    return { appliedStops, routes: plan.routes.length };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000,
    timeout: plan.schema === 'dsv_eta_missing_duration_repair_v2' ? 300_000 : 120_000 });
}

export async function auditDsvEtaRepairPlan(prisma: PrismaClient, plan: DsvEtaRepairPlan): Promise<{ auditedStops: number; routes: number }> {
  validateDsvEtaRepairPlanSchema(plan);
  let auditedStops = 0;
  for (const item of plan.routes) {
    const route = await readRoute(prisma, plan.scope, item.routePlanId);
    await assertAppliedRoute(prisma, item, route, plan.schema);
    auditedStops += item.stops.length;
  }
  return { auditedStops, routes: plan.routes.length };
}

async function assertAppliedRoute(
  db: Db,
  item: DsvEtaRepairPlan['routes'][number],
  after: RouteSnapshot,
  schema: DsvEtaRepairPlan['schema']
): Promise<void> {
  refuseUnless(item.executionFingerprint === executionFingerprint(after), 'EXECUTION_INVARIANT_CHANGED');
  refuseUnless(routeShapeSignature(after) === item.shapeSignature, 'SHAPE_SIGNATURE_CHANGED');
  const cache = validateDsvEtaAppliedCacheSet(item, after.routeGeometryCaches, schema);
  const writtenCache = await db.routePlanGeometryCache.findUnique({
    where: { id: cache.id }, select: { geometry: true, metrics: true, shapeSignature: true, stopPoints: true }
  });
  refuseUnless(writtenCache?.shapeSignature === item.shapeSignature
    && fingerprint(writtenCache.geometry) === fingerprint(item.geometry.routeGeometry)
    && fingerprint(writtenCache.metrics) === fingerprint(item.geometry.routeMetrics)
    && fingerprint(writtenCache.stopPoints) === fingerprint(item.geometry.routeStopPoints), 'POSTCHECK_CACHE_MISMATCH');
  for (const stop of item.stops) {
    const actual = after.routeStops.find((candidate) => candidate.id === stop.id);
    refuseUnless(actual !== undefined && actual.durationFromPreviousSeconds === stop.durationFromPreviousSeconds
      && actual.distanceFromPreviousMeters === stop.distanceFromPreviousMeters
      && actual.etaStatus === stop.etaStatus
      && actual.estimatedArrivalAt?.toISOString() === stop.estimatedArrivalAt
      && actual.etaCalculatedAt?.toISOString() === stop.etaCalculatedAt
      && actual.etaInputRouteVersionId === stop.etaInputRouteVersionId
      && actual.etaSource === stop.etaSource
      && actual.etaFailureCode === null
      && actual.etaFailureMessage === null, 'POSTCHECK_MISMATCH');
  }
}

export function validateDsvEtaAppliedCacheSet(
  item: DsvEtaRepairPlan['routes'][number],
  afterCaches: RouteSnapshot['routeGeometryCaches'],
  schema: DsvEtaRepairPlan['schema']
): RouteSnapshot['routeGeometryCaches'][number] {
  const matching = afterCaches.filter((cache) => cache.shapeSignature === item.shapeSignature);
  const cache = matching[0];
  refuseUnless(matching.length === 1 && cache !== undefined, 'POSTCHECK_CACHE_MISSING');
  if (schema === 'dsv_eta_missing_duration_repair_v1') {
    refuseUnless(afterCaches.length === 1, 'POSTCHECK_CACHE_SET_CHANGED');
  } else {
    const beforeIds = item.beforeCacheIds ?? [];
    const afterIds = afterCaches.map((candidate) => candidate.id);
    refuseUnless(item.cacheAction === 'REUSE'
      ? fingerprint(afterIds) === fingerprint(beforeIds) && beforeIds.includes(cache.id)
      : fingerprint(afterIds.filter((id) => id !== cache.id)) === fingerprint(beforeIds)
        && !beforeIds.includes(cache.id), 'POSTCHECK_CACHE_SET_CHANGED');
  }
  return cache;
}

export function buildDsvEtaRepairStopUpdates(
  route: RouteSnapshot,
  geometry: RoutePlanRouteResult,
  currentVersionId: string,
  plannedStartAt: Date,
  now: Date
): DsvEtaRepairStopUpdate[] {
  const points = new Map(geometry.routeStopPoints.map((point) => [point.deliveryStopId, point]));
  let cursorMs = plannedStartAt.getTime();
  const seeded: RollingEtaReplayStop[] = route.routeStops.map((stop) => {
    const duration = roundedNonNegative(points.get(stop.deliveryStopId)?.durationFromPreviousSeconds);
    refuseUnless(duration !== null, 'LEG_DURATION_MISSING');
    cursorMs += duration * 1000;
    const estimatedArrivalAt = new Date(cursorMs);
    const serviceMinutes = stop.deliveryStop.serviceMinutes;
    cursorMs += (serviceMinutes === null || serviceMinutes < 0 ? 5 : serviceMinutes) * 60_000;
    return {
      deliveryStopId: stop.deliveryStopId,
      distanceFromPreviousMeters: roundedNonNegative(points.get(stop.deliveryStopId)?.distanceFromPreviousMeters),
      durationFromPreviousSeconds: duration,
      estimatedArrivalAt,
      etaCalculatedAt: now,
      etaFailureCode: null,
      etaFailureMessage: null,
      etaInputRouteVersionId: currentVersionId,
      etaSource: 'PLANNED_DEPARTURE',
      etaStatus: 'READY',
      id: stop.id,
      sequence: stop.sequence,
      serviceMinutes,
      status: stop.deliveryStop.status,
      updatedAt: stop.updatedAt
    };
  });
  const events = route.driverEvents
    .filter((event) => (PROGRESS_EVENTS as readonly string[]).includes(event.eventType) && event.routeVersionId === currentVersionId)
    .map((event) => ({
      createdAt: event.createdAt,
      deliveryStopId: event.deliveryStopId,
      driverId: event.driverId,
      eventType: event.eventType as typeof PROGRESS_EVENTS[number],
      id: event.id,
      occurredAt: event.occurredAt
    }));
  refuseUnless(events.every((event) => event.driverId === route.driverId)
    && (events.length > 0 || (route.status === 'READY' && route.driverEvents.length === 0)), 'CURRENT_EVENTS_UNUSABLE');
  const replay = events.length === 0
    ? { stops: seeded, unsafeReason: null }
    : replayRollingEta({ currentRouteVersionId: currentVersionId, events, stops: seeded });
  refuseUnless(replay.unsafeReason === null, 'EVENT_REPLAY_UNSAFE');
  return route.routeStops.map((stop, index) => {
    const point = points.get(stop.deliveryStopId)!;
    const predicted = replay.stops[index]?.estimatedArrivalAt ?? null;
    refuseUnless(predicted !== null && replay.stops[index]?.etaStatus === 'READY', 'REPLAYED_ETA_UNAVAILABLE');
    return {
      before: {
        distanceFromPreviousMeters: stop.distanceFromPreviousMeters,
        durationFromPreviousSeconds: stop.durationFromPreviousSeconds,
        estimatedArrivalAt: stop.estimatedArrivalAt?.toISOString() ?? null,
        etaCalculatedAt: stop.etaCalculatedAt?.toISOString() ?? null,
        etaFailureCode: stop.etaFailureCode,
        etaFailureMessage: stop.etaFailureMessage,
        etaInputRouteVersionId: stop.etaInputRouteVersionId,
        etaSource: stop.etaSource,
        etaStatus: stop.etaStatus
      },
      deliveryStopId: stop.deliveryStopId,
      distanceFromPreviousMeters: roundedNonNegative(point.distanceFromPreviousMeters)!,
      durationFromPreviousSeconds: roundedNonNegative(point.durationFromPreviousSeconds)!,
      estimatedArrivalAt: predicted.toISOString(),
      etaCalculatedAt: now.toISOString(),
      etaInputRouteVersionId: currentVersionId,
      etaSource: replay.stops[index]?.etaSource === 'PLANNED_DEPARTURE'
        ? 'DSV_ETA_REPAIR_PLANNED'
        : 'DSV_ETA_REPAIR_EVENT_REPLAY',
      etaStatus: 'READY',
      expectedUpdatedAt: stop.updatedAt.toISOString(),
      id: stop.id,
      routePlanId: route.id,
      sequence: stop.sequence
    };
  });
}

async function readRoute(db: Db, scope: DsvEtaRepairScope, routePlanId: string): Promise<RouteSnapshot> {
  const route = await db.routePlan.findFirst({ select: SNAPSHOT_SELECT, where: { id: routePlanId, shopId: scope.shopId } });
  refuseUnless(route !== null, 'ROUTE_SCOPE_MISMATCH');
  return route;
}

export function validateDsvEtaRepairPlanSchema(plan: DsvEtaRepairPlan): void {
  refuseUnless(plan.schema === 'dsv_eta_missing_duration_repair_v1'
    || plan.schema === 'dsv_eta_missing_duration_repair_v2', 'PLAN_SCHEMA_MISMATCH');
  refuseUnless(plan.routes.length === plan.scope.routePlanIds.length && plan.routes.length > 0
    && new Set(plan.routes.map((route) => route.routePlanId)).size === plan.routes.length
    && plan.routes.every((route) => plan.scope.routePlanIds.includes(route.routePlanId)), 'PLAN_SCOPE_MISMATCH');
  for (const route of plan.routes) {
    if (plan.schema === 'dsv_eta_missing_duration_repair_v1') {
      refuseUnless(route.cacheAction === undefined && route.beforeCacheIds === undefined
        && (route.status === 'IN_PROGRESS' || route.status === 'COMPLETED')
        && route.stops.every((stop) => stop.before.etaStatus === 'PENDING' || stop.before.etaStatus === 'FAILED'), 'PLAN_V1_SEMANTICS_CHANGED');
    } else {
      refuseUnless((route.cacheAction === 'CREATE' || route.cacheAction === 'REUSE')
        && Array.isArray(route.beforeCacheIds)
        && new Set(route.beforeCacheIds).size === route.beforeCacheIds.length
        && route.beforeCacheIds.every((id) => typeof id === 'string'), 'PLAN_CACHE_BASELINE_MISSING');
    }
  }
}

function fingerprintForSchema(route: RouteSnapshot, schema: DsvEtaRepairPlan['schema']): string {
  if (schema === 'dsv_eta_missing_duration_repair_v2') return fingerprint(route);
  return fingerprint({ ...route, routeGeometryCaches: route.routeGeometryCaches.map((cache) => ({ id: cache.id })) });
}

function validateRoute(route: RouteSnapshot, scope: DsvEtaRepairScope, schema: DsvEtaRepairPlan['schema']): string {
  refuseUnless(route.shopId === scope.shopId && !route.isStoreReviewData && route.driverId !== null, 'ROUTE_SCOPE_MISMATCH');
  refuseUnless(schema === 'dsv_eta_missing_duration_repair_v2'
    ? route.status === 'READY' || route.status === 'IN_PROGRESS' || route.status === 'COMPLETED'
    : route.status === 'IN_PROGRESS' || route.status === 'COMPLETED', 'ROUTE_STATUS_CHANGED');
  if (schema === 'dsv_eta_missing_duration_repair_v1') {
    refuseUnless(route.routeGeometryCaches.length === 0, 'GEOMETRY_ALREADY_PRESENT');
  }
  refuseUnless(route.routeStops.length > 0, 'EMPTY_ROUTE');
  const current = route.routeGroupingChildVersions.filter((version) => version.status === 'CURRENT' && version.supersededAt === null);
  refuseUnless(current.length === 1, 'CURRENT_VERSION_AMBIGUOUS');
  const versionId = current[0]!.id;
  refuseUnless(route.routeStops.every((stop) => stop.shopId === scope.shopId
    && stop.deliveryStop.order.currentRouteVersionId === versionId
    && stop.durationFromPreviousSeconds === null
    && stop.distanceFromPreviousMeters === null
    && stop.estimatedArrivalAt === null
    && (stop.etaStatus === 'PENDING' || stop.etaStatus === 'FAILED'
      || (schema === 'dsv_eta_missing_duration_repair_v2' && stop.etaStatus === 'NOT_REQUIRED'))
    && (stop.etaFailureCode === null || stop.etaFailureCode === 'ETA_INPUT_DURATION_UNAVAILABLE')
    && (stop.deliveryStop.status === 'PENDING' || stop.deliveryStop.status === 'DELIVERED')), 'STOP_STATE_UNEXPECTED');
  refuseUnless(route.status !== 'COMPLETED' || route.routeStops.every((stop) => stop.deliveryStop.status === 'DELIVERED'), 'COMPLETED_ROUTE_HAS_PENDING_STOP');
  refuseUnless(route.status !== 'READY' || route.routeStops.every((stop) => stop.deliveryStop.status === 'PENDING'), 'READY_ROUTE_HAS_COMPLETED_STOP');
  return versionId;
}

export function validateDsvEtaRepairGeometry(route: RouteSnapshot, geometry: RoutePlanRouteResult): void {
  refuseUnless(isCompleteGeometry(geometry.routeGeometry, geometry.routeMetrics)
    && geometry.routeStopPoints.length === route.routeStops.length, 'GEOMETRY_INCOMPLETE');
  route.routeStops.forEach((stop, index) => {
    const point = geometry.routeStopPoints[index];
    refuseUnless(point?.deliveryStopId === stop.deliveryStopId && point.sequence === stop.sequence
      && roundedNonNegative(point.durationFromPreviousSeconds) !== null
      && roundedNonNegative(point.distanceFromPreviousMeters) !== null, 'GEOMETRY_STOP_MISMATCH');
  });
}

function isCompleteGeometry(
  routeGeometry: RoutePlanRouteResult['routeGeometry'],
  routeMetrics: RoutePlanRouteResult['routeMetrics']
): boolean {
  return routeGeometry !== null && routeMetrics !== null
    && roundedNonNegative(routeMetrics.distanceMeters) !== null
    && roundedNonNegative(routeMetrics.durationSeconds) !== null
    && routeGeometry.coordinates.length >= 2
    && routeGeometry.coordinates.every(([longitude, latitude]) =>
      typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      && typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
      && !(longitude === 0 && latitude === 0));
}

function roundedNonNegative(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function fingerprint(value: unknown): string {
  return sha256CanonicalJson(JSON.parse(JSON.stringify(value, (_, item: unknown) => typeof item === 'bigint' ? String(item) : item)));
}

function executionFingerprint(route: RouteSnapshot): string {
  return fingerprint({
    assignmentGeneration: route.assignmentGeneration,
    constraints: route.constraints,
    depotLatitude: route.depotLatitude,
    depotLongitude: route.depotLongitude,
    driverEvents: route.driverEvents,
    driverId: route.driverId,
    planDate: route.planDate,
    routeGroupingChildVersions: route.routeGroupingChildVersions,
    routeStops: route.routeStops.map((stop) => ({
      deliveryStop: stop.deliveryStop,
      deliveryStopId: stop.deliveryStopId,
      id: stop.id,
      sequence: stop.sequence,
      shopId: stop.shopId
    })),
    status: route.status,
    updatedAt: route.updatedAt,
    vehicleId: route.vehicleId
  });
}

function routeShapeSignature(route: RouteSnapshot): string {
  const constraints = route.constraints !== null && typeof route.constraints === 'object' && !Array.isArray(route.constraints)
    ? route.constraints as Record<string, unknown> : {};
  return computeRouteShapeSignatureFromParts({
    depot: { latitude: route.depotLatitude === null ? null : Number(route.depotLatitude), longitude: route.depotLongitude === null ? null : Number(route.depotLongitude) },
    routeEndMode: constraints.routeEndMode === 'RETURN_TO_DEPOT' ? 'RETURN_TO_DEPOT' : 'END_AT_LAST_STOP',
    stops: route.routeStops.map((stop) => ({
      coordinates: {
        latitude: stop.deliveryStop.latitude === null ? null : Number(stop.deliveryStop.latitude),
        longitude: stop.deliveryStop.longitude === null ? null : Number(stop.deliveryStop.longitude)
      },
      deliveryStopId: stop.deliveryStopId,
      orderId: stop.deliveryStop.order.id,
      sequence: stop.sequence
    }))
  });
}

function refuseUnless(condition: unknown, code: string): asserts condition {
  if (!condition) throw new DsvEtaRepairRefusal(code);
}
