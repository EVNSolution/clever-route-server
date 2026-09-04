import { createHash } from 'node:crypto';

import { DsvEtaStatus, Prisma, type PrismaClient } from '@prisma/client';

import { readRouteStopPoints } from '../route-plans/route-plan-geometry-cache.js';
import {
  calculateArrivalEtaUpdate,
  calculateCompletionEtaUpdate,
  calculatePickupEtaUpdate,
  calculateRouteStartEtaUpdate,
  type DriverRouteEtaStop,
  type DriverRouteEtaUpdate
} from './driver-route-eta.js';

export const ROLLING_ETA_BACKFILL_SCHEMA = 'rolling_eta_backfill_plan_v1';
export const ROLLING_ETA_BACKFILL_CHANGE_CONTROL_REF = 'EVNSolution/clever-change-control#283';
export const ROLLING_ETA_BACKFILL_APP_ID = 'clever-route-kfood';

const PROGRESS_EVENT_TYPES = ['ROUTE_STARTED', 'PICKUP_COMPLETED', 'STOP_ARRIVED', 'STOP_DELIVERED'] as const;

type ProgressEventType = typeof PROGRESS_EVENT_TYPES[number];
type RollingEtaPrisma = PrismaClient | Prisma.TransactionClient;

export type RollingEtaBackfillScope = {
  appId: typeof ROLLING_ETA_BACKFILL_APP_ID;
  shopId: string;
};

export type RollingEtaBackfillState = {
  estimatedArrivalAt: string | null;
  etaCalculatedAt: string | null;
  etaFailureCode: string | null;
  etaFailureMessage: string | null;
  etaInputRouteVersionId: string | null;
  etaSource: string | null;
  etaStatus: string;
};

export type RollingEtaBackfillItem = {
  after: RollingEtaBackfillState;
  before: RollingEtaBackfillState;
  expectedUpdatedAt: string;
  routePlanId: string;
  sequence: number;
  shopId: string;
  stopId: string;
};

export type RollingEtaBackfillUnsafeRoute = {
  reason: 'AMBIGUOUS_CURRENT_ROUTE_VERSION' | 'EMPTY_ROUTE' | 'PROGRESS_EVENT_DRIVER_UNAVAILABLE' | 'PROGRESS_EVENT_STOP_NOT_IN_CURRENT_ROUTE';
  routePlanId: string;
  shopId: string;
};

export type RollingEtaBackfillExcludedRoute = {
  reason: 'MISSING_LEG_DURATION';
  routePlanId: string;
  shopId: string;
};

export type RollingEtaBackfillPlan = {
  items: RollingEtaBackfillItem[];
  schema: typeof ROLLING_ETA_BACKFILL_SCHEMA;
  scope: RollingEtaBackfillScope;
};

export type RollingEtaBackfillInspection = {
  excludedRoutes: RollingEtaBackfillExcludedRoute[];
  ignoredNonCurrentVersionEvents: number;
  ignoredSupersededProgressEvents: number;
  inspectedRoutes: number;
  plan: RollingEtaBackfillPlan;
  planSha256: string;
  replayedEvents: number;
  replayedRoutes: number;
  unsafeRoutes: RollingEtaBackfillUnsafeRoute[];
};

export type RollingEtaReplayStop = DriverRouteEtaStop & {
  etaInputRouteVersionId: string | null;
  etaSource: string | null;
  etaStatus: string;
  id: string;
  updatedAt: Date;
};

export type RollingEtaReplayEvent = {
  createdAt: Date;
  deliveryStopId: string | null;
  driverId: string | null;
  eventType: ProgressEventType;
  id: string;
  occurredAt: Date;
};

export class RollingEtaBackfillRefusalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RollingEtaBackfillRefusalError';
  }
}

export class RollingEtaBackfillService {
  constructor(private readonly prisma: PrismaClient) {}

  async inspect(scope: RollingEtaBackfillScope): Promise<RollingEtaBackfillInspection> {
    return inspectRollingEtaBackfill(this.prisma, scope);
  }

  async apply(input: {
    changeControlRef: string;
    expectedChangeCount: number;
    reviewedPlanSha256: string;
    scope: RollingEtaBackfillScope;
  }): Promise<{
    appliedItems: number;
    mode: 'apply';
    planSha256: string;
  }> {
    if (input.changeControlRef !== ROLLING_ETA_BACKFILL_CHANGE_CONTROL_REF) {
      throw new RollingEtaBackfillRefusalError('CHANGE_CONTROL_REF_MISMATCH');
    }
    if (!Number.isSafeInteger(input.expectedChangeCount) || input.expectedChangeCount < 1) {
      throw new RollingEtaBackfillRefusalError('EXPECTED_CHANGE_COUNT_INVALID');
    }
    if (!/^[a-f0-9]{64}$/u.test(input.reviewedPlanSha256)) {
      throw new RollingEtaBackfillRefusalError('REVIEWED_PLAN_SHA256_INVALID');
    }

    return this.prisma.$transaction(async (tx) => {
      const inspection = await inspectRollingEtaBackfill(tx, input.scope);
      if (inspection.unsafeRoutes.length > 0) {
        throw new RollingEtaBackfillRefusalError('UNSAFE_ROUTES_PRESENT');
      }
      if (inspection.plan.items.length !== input.expectedChangeCount) {
        throw new RollingEtaBackfillRefusalError('EXPECTED_CHANGE_COUNT_MISMATCH');
      }
      if (inspection.planSha256 !== input.reviewedPlanSha256) {
        throw new RollingEtaBackfillRefusalError('REVIEWED_PLAN_SHA256_MISMATCH');
      }

      for (const item of inspection.plan.items) {
        const updated = await tx.routePlanStop.updateMany({
          data: {
            estimatedArrivalAt: toDate(item.after.estimatedArrivalAt),
            etaCalculatedAt: toDate(item.after.etaCalculatedAt),
            etaFailureCode: item.after.etaFailureCode,
            etaFailureMessage: item.after.etaFailureMessage,
            etaInputRouteVersionId: item.after.etaInputRouteVersionId,
            etaSource: item.after.etaSource,
            etaStatus: readEtaStatus(item.after.etaStatus)
          },
          where: {
            id: item.stopId,
            routePlanId: item.routePlanId,
            shopId: item.shopId,
            updatedAt: new Date(item.expectedUpdatedAt)
          }
        });
        if (updated.count !== 1) {
          throw new RollingEtaBackfillRefusalError('CHANGED_DURING_APPLY');
        }
      }

      return {
        appliedItems: inspection.plan.items.length,
        mode: 'apply' as const,
        planSha256: inspection.planSha256
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000
    });
  }
}

export async function inspectRollingEtaBackfill(
  prisma: RollingEtaPrisma,
  rawScope: RollingEtaBackfillScope
): Promise<RollingEtaBackfillInspection> {
  const scope = normalizeScope(rawScope);
  const routePlans = await prisma.routePlan.findMany({
    orderBy: [{ shopId: 'asc' }, { id: 'asc' }],
    select: {
      driverEvents: {
        select: {
          createdAt: true,
          deliveryStopId: true,
          driverId: true,
          eventType: true,
          id: true,
          occurredAt: true,
          routeVersionId: true
        },
        where: { eventType: { in: [...PROGRESS_EVENT_TYPES] } }
      },
      id: true,
      routeGeometryCaches: {
        orderBy: { generatedAt: 'desc' },
        select: { stopPoints: true },
        take: 1
      },
      routeGroupingChildVersions: {
        select: { id: true },
        where: { status: 'CURRENT' }
      },
      routeStops: {
        orderBy: { sequence: 'asc' },
        select: {
          deliveryStop: { select: { serviceMinutes: true, status: true } },
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
          updatedAt: true
        }
      },
      shopId: true
    },
    where: {
      driverEvents: { some: { eventType: { in: [...PROGRESS_EVENT_TYPES] } } },
      shop: {
        is: {
          appId: scope.appId,
          dsvOperationalSettings: { equals: Prisma.DbNull }
        }
      },
      shopId: scope.shopId
    }
  });

  const items: RollingEtaBackfillItem[] = [];
  const excludedRoutes: RollingEtaBackfillExcludedRoute[] = [];
  const unsafeRoutes: RollingEtaBackfillUnsafeRoute[] = [];
  let ignoredNonCurrentVersionEvents = 0;
  let ignoredSupersededProgressEvents = 0;
  let replayedEvents = 0;
  let replayedRoutes = 0;

  for (const routePlan of routePlans) {
    if (routePlan.routeGroupingChildVersions.length > 1) {
      unsafeRoutes.push({
        reason: 'AMBIGUOUS_CURRENT_ROUTE_VERSION',
        routePlanId: routePlan.id,
        shopId: routePlan.shopId
      });
      continue;
    }
    if (routePlan.routeStops.length === 0) {
      unsafeRoutes.push({ reason: 'EMPTY_ROUTE', routePlanId: routePlan.id, shopId: routePlan.shopId });
      continue;
    }

    const currentRouteVersionId = routePlan.routeGroupingChildVersions[0]?.id ?? null;
    const currentEvents = routePlan.driverEvents.filter((event) => event.routeVersionId === currentRouteVersionId);
    ignoredNonCurrentVersionEvents += routePlan.driverEvents.length - currentEvents.length;
    if (currentEvents.length === 0) continue;

    const cachePoints = readRouteStopPoints(routePlan.routeGeometryCaches[0]?.stopPoints);
    const cachePointByStopId = new Map(cachePoints.map((point) => [point.deliveryStopId, point]));
    const cacheMatchesRoute = routePlan.routeStops.every((stop) => cachePointByStopId.get(stop.deliveryStopId)?.sequence === stop.sequence);
    const replayStops: RollingEtaReplayStop[] = routePlan.routeStops.map((stop) => {
      const cachePoint = cacheMatchesRoute ? cachePointByStopId.get(stop.deliveryStopId) : undefined;
      return {
        deliveryStopId: stop.deliveryStopId,
        distanceFromPreviousMeters: normalizedInteger(stop.distanceFromPreviousMeters ?? cachePoint?.distanceFromPreviousMeters),
        durationFromPreviousSeconds: normalizedInteger(stop.durationFromPreviousSeconds ?? cachePoint?.durationFromPreviousSeconds),
        estimatedArrivalAt: stop.estimatedArrivalAt,
        etaCalculatedAt: stop.etaCalculatedAt,
        etaFailureCode: stop.etaFailureCode,
        etaFailureMessage: stop.etaFailureMessage,
        etaInputRouteVersionId: stop.etaInputRouteVersionId,
        etaSource: stop.etaSource,
        etaStatus: stop.etaStatus,
        id: stop.id,
        sequence: stop.sequence,
        serviceMinutes: stop.deliveryStop.serviceMinutes,
        status: stop.deliveryStop.status,
        updatedAt: stop.updatedAt
      };
    });
    const events: RollingEtaReplayEvent[] = currentEvents.map((event) => ({
      createdAt: event.createdAt,
      deliveryStopId: event.deliveryStopId,
      driverId: event.driverId,
      eventType: event.eventType as ProgressEventType,
      id: event.id,
      occurredAt: event.occurredAt
    }));
    if (!isRollingEtaRouteRecoverable(replayStops)) {
      excludedRoutes.push({ reason: 'MISSING_LEG_DURATION', routePlanId: routePlan.id, shopId: routePlan.shopId });
      continue;
    }
    const replay = replayRollingEta({ currentRouteVersionId, events, stops: replayStops });
    if (replay.unsafeReason !== null) {
      unsafeRoutes.push({ reason: replay.unsafeReason, routePlanId: routePlan.id, shopId: routePlan.shopId });
      continue;
    }
    replayedRoutes += 1;
    replayedEvents += replay.replayedEvents;
    ignoredSupersededProgressEvents += replay.ignoredEvents;

    for (let index = 0; index < replayStops.length; index += 1) {
      const beforeStop = replayStops[index]!;
      const afterStop = replay.stops[index]!;
      const before = stateForStop(beforeStop);
      const after = stateForStop(afterStop);
      if (canonicalJson(before) === canonicalJson(after)) continue;
      items.push({
        after,
        before,
        expectedUpdatedAt: beforeStop.updatedAt.toISOString(),
        routePlanId: routePlan.id,
        sequence: beforeStop.sequence,
        shopId: routePlan.shopId,
        stopId: beforeStop.id
      });
    }
  }

  items.sort((left, right) => left.shopId.localeCompare(right.shopId)
    || left.routePlanId.localeCompare(right.routePlanId)
    || left.sequence - right.sequence
    || left.stopId.localeCompare(right.stopId));
  const plan: RollingEtaBackfillPlan = { items, schema: ROLLING_ETA_BACKFILL_SCHEMA, scope };
  return {
    excludedRoutes,
    ignoredNonCurrentVersionEvents,
    ignoredSupersededProgressEvents,
    inspectedRoutes: routePlans.length,
    plan,
    planSha256: sha256CanonicalJson(plan),
    replayedEvents,
    replayedRoutes,
    unsafeRoutes
  };
}

export function replayRollingEta(input: {
  currentRouteVersionId: string | null;
  events: RollingEtaReplayEvent[];
  stops: RollingEtaReplayStop[];
}): {
  ignoredEvents: number;
  replayedEvents: number;
  stops: RollingEtaReplayStop[];
  unsafeReason: RollingEtaBackfillUnsafeRoute['reason'] | null;
} {
  let stops = [...input.stops].sort((left, right) => left.sequence - right.sequence);
  const stopIds = new Set(stops.map((stop) => stop.deliveryStopId));
  const seenEvents: RollingEtaReplayEvent[] = [];
  const events = [...input.events].sort(compareEventReceipts);
  const latestAppliedEventByDriverId = new Map<string, RollingEtaReplayEvent>();
  let ignoredEvents = 0;

  for (const event of events) {
    if (event.driverId === null) {
      return { ignoredEvents: 0, replayedEvents: 0, stops: input.stops, unsafeReason: 'PROGRESS_EVENT_DRIVER_UNAVAILABLE' };
    }
    if ((event.eventType === 'STOP_ARRIVED' || event.eventType === 'STOP_DELIVERED')
      && (event.deliveryStopId === null || !stopIds.has(event.deliveryStopId))) {
      return { ignoredEvents: 0, replayedEvents: 0, stops: input.stops, unsafeReason: 'PROGRESS_EVENT_STOP_NOT_IN_CURRENT_ROUTE' };
    }
    seenEvents.push(event);
    const latestAppliedEvent = latestAppliedEventByDriverId.get(event.driverId) ?? null;
    if (latestAppliedEvent !== null && compareEventAuthority(event, latestAppliedEvent) <= 0) {
      ignoredEvents += 1;
      continue;
    }
    latestAppliedEventByDriverId.set(event.driverId, event);

    const serverReceivedAt = event.createdAt;
    let update: DriverRouteEtaUpdate;
    switch (event.eventType) {
      case 'ROUTE_STARTED':
        update = calculateRouteStartEtaUpdate({
          eventOccurredAt: event.occurredAt,
          inputRouteVersionId: input.currentRouteVersionId,
          serverReceivedAt,
          stops
        });
        break;
      case 'PICKUP_COMPLETED':
        update = calculatePickupEtaUpdate({
          eventOccurredAt: event.occurredAt,
          inputRouteVersionId: input.currentRouteVersionId,
          serverReceivedAt,
          stops
        });
        break;
      case 'STOP_ARRIVED': {
        const deliveryStopId = event.deliveryStopId!;
        update = calculateArrivalEtaUpdate({
          arrivedDeliveryStopId: deliveryStopId,
          eventOccurredAt: event.occurredAt,
          inputRouteVersionId: input.currentRouteVersionId,
          serverReceivedAt,
          stops
        });
        break;
      }
      case 'STOP_DELIVERED': {
        const deliveryStopId = event.deliveryStopId!;
        update = calculateCompletionEtaUpdate({
          arrivedAt: earliestArrivalAt(seenEvents, event.driverId, deliveryStopId),
          completedDeliveryStopId: deliveryStopId,
          eventOccurredAt: event.occurredAt,
          inputRouteVersionId: input.currentRouteVersionId,
          serverReceivedAt,
          stops
        });
        break;
      }
    }
    stops = applyUpdate(stops, update);
  }

  return { ignoredEvents, replayedEvents: events.length - ignoredEvents, stops, unsafeReason: null };
}

export function isRollingEtaRouteRecoverable(stops: DriverRouteEtaStop[]): boolean {
  return stops.length > 0 && stops.every((stop) => stop.durationFromPreviousSeconds !== null);
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function applyUpdate(stops: RollingEtaReplayStop[], update: DriverRouteEtaUpdate): RollingEtaReplayStop[] {
  const updates = new Map(update.updatedStops.map((stop) => [stop.deliveryStopId, stop]));
  return stops.map((stop) => {
    const next = updates.get(stop.deliveryStopId);
    if (next === undefined) return stop;
    return {
      ...stop,
      estimatedArrivalAt: toDate(next.estimatedArrivalAt),
      etaCalculatedAt: new Date(update.etaCalculatedAt),
      etaFailureCode: update.etaFailureCode,
      etaFailureMessage: update.etaFailureMessage,
      etaInputRouteVersionId: update.inputRouteVersionId,
      etaSource: update.etaSource,
      etaStatus: update.etaStatus
    };
  });
}

function compareEventAuthority(left: RollingEtaReplayEvent, right: RollingEtaReplayEvent): number {
  return effectiveEventTime(left).getTime() - effectiveEventTime(right).getTime()
    || left.createdAt.getTime() - right.createdAt.getTime()
    || left.id.localeCompare(right.id);
}

function compareEventReceipts(left: RollingEtaReplayEvent, right: RollingEtaReplayEvent): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
}

function earliestArrivalAt(events: RollingEtaReplayEvent[], driverId: string, deliveryStopId: string): Date | null {
  const arrival = events
    .filter((event) => event.driverId === driverId
      && event.eventType === 'STOP_ARRIVED'
      && event.deliveryStopId === deliveryStopId)
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime()
      || left.createdAt.getTime() - right.createdAt.getTime()
      || left.id.localeCompare(right.id))[0];
  return arrival === undefined ? null : effectiveEventTime(arrival);
}

function effectiveEventTime(event: Pick<RollingEtaReplayEvent, 'createdAt' | 'occurredAt'>): Date {
  return event.occurredAt.getTime() > event.createdAt.getTime() ? event.createdAt : event.occurredAt;
}

function stateForStop(stop: RollingEtaReplayStop): RollingEtaBackfillState {
  return {
    estimatedArrivalAt: stop.estimatedArrivalAt?.toISOString() ?? null,
    etaCalculatedAt: stop.etaCalculatedAt?.toISOString() ?? null,
    etaFailureCode: stop.etaFailureCode ?? null,
    etaFailureMessage: stop.etaFailureMessage ?? null,
    etaInputRouteVersionId: stop.etaInputRouteVersionId,
    etaSource: stop.etaSource,
    etaStatus: stop.etaStatus
  };
}

function normalizeScope(scope: RollingEtaBackfillScope): RollingEtaBackfillScope {
  if (scope.appId !== ROLLING_ETA_BACKFILL_APP_ID) {
    throw new RollingEtaBackfillRefusalError('APP_SCOPE_NOT_KFOOD');
  }
  const shopId = scope.shopId.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(shopId)) {
    throw new RollingEtaBackfillRefusalError('SHOP_SCOPE_INVALID');
  }
  return { appId: ROLLING_ETA_BACKFILL_APP_ID, shopId };
}

function normalizedInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function readEtaStatus(value: string): DsvEtaStatus {
  if (value === DsvEtaStatus.READY || value === DsvEtaStatus.FAILED) return value;
  throw new RollingEtaBackfillRefusalError('ETA_STATUS_INVALID');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
