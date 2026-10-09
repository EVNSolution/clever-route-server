import type { Prisma } from '@prisma/client';
import { isPrivateDriverDemoScope, privateDriverDemoRouteWhere } from '../driver/private-driver-demo.js';
import { toRouteExecutionStatus, type RouteExecutionStatus } from './route-plan-lifecycle.js';

export const KFOOD_DELIVERY_APP_ID = 'clever-route-kfood';
export const KFOOD_DELIVERY_SHOP_DOMAIN = '7hrud1-xq.myshopify.com';
export const KFOOD_RETURN_NAVIGATION_GRACE_MS = 2 * 60 * 60_000;
const TERMINAL_STOPS = new Set(['CANCELLED', 'DELIVERED', 'FAILED', 'SKIPPED']);

export function isKfoodDeliveryScope(scope: {
  appId: string; shopDomain: string; shopId?: string; accountId?: string | null;
}, env: Partial<Record<string, string>> = process.env): boolean {
  return scope.appId === KFOOD_DELIVERY_APP_ID && scope.shopDomain === KFOOD_DELIVERY_SHOP_DOMAIN
    || isPrivateDriverDemoScope({ ...scope, shopId: scope.shopId, accountId: scope.accountId }, env);
}

export function kfoodDeliveryRouteWhere(env: Partial<Record<string, string>> = process.env): Prisma.RoutePlanWhereInput {
  const standard = { shop: { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN } };
  const privateScope = privateDriverDemoRouteWhere(env);
  return privateScope === null ? standard : { OR: [standard, privateScope] };
}

export type DeliveryWorkCompletionRecord = {
  assignmentGeneration?: bigint;
  deliveryWorkCompletedAt?: Date | null;
  deliveryWorkCompletedGeneration?: bigint | null;
  deliveryWorkCompletedVersionId?: string | null;
  driverNavigationUntil?: Date | null;
  driverEvents?: readonly { eventType: string }[];
  status: string;
};

export function hasDeliveryWorkCompleted(route: DeliveryWorkCompletionRecord): boolean {
  return route.assignmentGeneration !== undefined
    && route.assignmentGeneration > 0n
    && route.deliveryWorkCompletedGeneration === route.assignmentGeneration
    && route.deliveryWorkCompletedAt instanceof Date
    && Number.isFinite(route.deliveryWorkCompletedAt.getTime())
    && route.driverNavigationUntil instanceof Date
    && route.driverNavigationUntil.getTime() - route.deliveryWorkCompletedAt.getTime() === KFOOD_RETURN_NAVIGATION_GRACE_MS
    && typeof route.deliveryWorkCompletedVersionId === 'string'
    && route.deliveryWorkCompletedVersionId.length > 0;
}

// Admin/Shopify sees delivery work complete while legacy mobile access retains
// the raw IN_PROGRESS execution state solely for the return-navigation grace.
export function toRouteDeliveryDisplayStatus(route: DeliveryWorkCompletionRecord): RouteExecutionStatus {
  if (route.status === 'IN_PROGRESS' && hasDeliveryWorkCompleted(route)) return 'COMPLETED';
  return toRouteExecutionStatus(route.status, route.driverEvents);
}

export function hasDeliveryNavigationGraceExpired(route: DeliveryWorkCompletionRecord, now: Date): boolean {
  return (route.status === 'IN_PROGRESS' || route.status === 'COMPLETED') && hasDeliveryWorkCompleted(route)
    && route.driverNavigationUntil!.getTime() <= now.getTime();
}

type CompletionTx = Pick<Prisma.TransactionClient, 'routePlan'>;
export type DeliveryWorkCompletion = {
  assignmentGeneration: bigint;
  completedAt: Date;
  navigationUntil: Date;
  routeVersionId: string;
};

// Caller holds the route lock used by driver ingestion. This is also used by
// the finalizer to revalidate a marker; it never manufactures stop outcomes.
export async function reconcileKfoodDeliveryWorkCompletion(
  tx: CompletionTx,
  input: { routePlanId: string; shopId: string; now: Date; allowStart?: boolean }
): Promise<DeliveryWorkCompletion | null> {
  const route = await tx.routePlan.findFirst({
    where: {
      id: input.routePlanId, shopId: input.shopId, status: 'IN_PROGRESS',
      ...kfoodDeliveryRouteWhere()
    },
    select: {
      id: true, driverId: true, assignmentGeneration: true, deliveryWorkCompletedAt: true, driverNavigationUntil: true,
      deliveryWorkCompletedGeneration: true, deliveryWorkCompletedVersionId: true, status: true,
      liveChangeState: { select: {
        driverId: true, assignmentGeneration: true, baselineRouteVersionId: true, latestPublicationId: true
      } },
      liveChangePublications: {
        orderBy: [{ assignmentGeneration: 'desc' }, { sequence: 'desc' }], take: 1,
        select: { id: true, driverId: true, assignmentGeneration: true, snapshot: true }
      },
      routeGroupingChildVersions: {
        where: { status: 'CURRENT', supersededAt: null }, take: 2,
        select: { id: true, snapshot: true }
      },
      routeStops: {
        orderBy: { sequence: 'asc' },
        select: {
          sequence: true, deliveryStopId: true,
          deliveryStop: { select: { status: true, orderId: true, order: { select: { currentRouteVersionId: true } } } }
        }
      }
    }
  });
  if (route === null) return null;
  const version = route.routeGroupingChildVersions.length === 1 ? route.routeGroupingChildVersions[0] : undefined;
  const snapshot = version === undefined ? null : completionMembershipSnapshot(route, version);
  const resolved = version !== undefined && isResolvedCurrentMembership(snapshot, version.id, route.routeStops);
  const existing = hasDeliveryWorkCompleted(route) && route.deliveryWorkCompletedVersionId === version?.id;
  if (!resolved || (!existing && input.allowStart === false)) {
    if (route.deliveryWorkCompletedAt != null || route.driverNavigationUntil != null
      || route.deliveryWorkCompletedGeneration != null || route.deliveryWorkCompletedVersionId != null) {
      await tx.routePlan.updateMany({
        where: { id: route.id, shopId: input.shopId, status: 'IN_PROGRESS', assignmentGeneration: route.assignmentGeneration },
        data: { deliveryWorkCompletedAt: null, driverNavigationUntil: null,
          deliveryWorkCompletedGeneration: null, deliveryWorkCompletedVersionId: null }
      });
    }
    return null;
  }
  if (existing) return {
    assignmentGeneration: route.assignmentGeneration, completedAt: route.deliveryWorkCompletedAt!,
    navigationUntil: route.driverNavigationUntil!, routeVersionId: version.id
  };
  const navigationUntil = new Date(input.now.getTime() + KFOOD_RETURN_NAVIGATION_GRACE_MS);
  const updated = await tx.routePlan.updateMany({
    where: { id: route.id, shopId: input.shopId, status: 'IN_PROGRESS', assignmentGeneration: route.assignmentGeneration },
    data: {
      deliveryWorkCompletedAt: input.now, driverNavigationUntil: navigationUntil,
      deliveryWorkCompletedGeneration: route.assignmentGeneration, deliveryWorkCompletedVersionId: version.id
    }
  });
  return updated.count === 1 ? {
    assignmentGeneration: route.assignmentGeneration, completedAt: input.now, navigationUntil, routeVersionId: version.id
  } : null;
}

type CompletionStop = { sequence: number; deliveryStopId: string; deliveryStop: {
  status: string; orderId: string; order: { currentRouteVersionId: string | null }
} };

function completionMembershipSnapshot(route: {
  assignmentGeneration: bigint;
  driverId: string | null;
  liveChangeState?: {
    assignmentGeneration: bigint; driverId: string; baselineRouteVersionId: string; latestPublicationId: string;
  } | null;
  liveChangePublications?: Array<{ id: string; driverId: string; assignmentGeneration: bigint; snapshot: unknown }>;
}, version: { id: string; snapshot: unknown }): unknown {
  const state = route.liveChangeState;
  if (state == null || state.assignmentGeneration < route.assignmentGeneration) return version.snapshot;
  const publication = route.liveChangePublications?.find(row => row.id === state.latestPublicationId);
  if (state.baselineRouteVersionId !== version.id || state.driverId !== route.driverId
    || state.assignmentGeneration !== route.assignmentGeneration || publication === undefined
    || publication.driverId !== state.driverId || publication.assignmentGeneration !== state.assignmentGeneration) return null;
  // A future reorder keeps child execution ownership. Prove the same child members
  // before using the immutable Dispatch order for the completion/grace invariant.
  const childMembers = snapshotMembers(version.snapshot);
  const publicMembers = snapshotMembers(publication.snapshot);
  if (childMembers === null || publicMembers === null || childMembers !== publicMembers) return null;
  return publication.snapshot;
}

function snapshotMembers(snapshot: unknown): string | null {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const stops = (snapshot as Record<string, unknown>).stops;
  if (!Array.isArray(stops)) return null;
  const members: string[] = [];
  for (const stop of stops) {
    if (stop === null || typeof stop !== 'object' || Array.isArray(stop)) return null;
    const row = stop as Record<string, unknown>;
    if (typeof row.deliveryStopId !== 'string' || typeof row.orderId !== 'string') return null;
    members.push(`${row.deliveryStopId}:${row.orderId}`);
  }
  return new Set(members).size === members.length ? JSON.stringify(members.sort()) : null;
}

function isResolvedCurrentMembership(snapshot: unknown, versionId: string, stops: CompletionStop[]): boolean {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot) || stops.length === 0) return false;
  const record = snapshot as Record<string, unknown>;
  if (record.membershipSchemaVersion !== undefined && record.membershipSchemaVersion !== 1) return false;
  if (!Array.isArray(record.stops) || record.stops.length !== stops.length) return false;
  const members = record.stops;
  const stopIds = new Set<string>();
  const orderIds = new Set<string>();
  return stops.every((stop, index) => {
    const member = members[index] as unknown;
    if (member === null || typeof member !== 'object' || Array.isArray(member)) return false;
    const row = member as Record<string, unknown>;
    if (stopIds.has(stop.deliveryStopId) || orderIds.has(stop.deliveryStop.orderId)) return false;
    stopIds.add(stop.deliveryStopId);
    orderIds.add(stop.deliveryStop.orderId);
    return stop.sequence === index + 1 && row.sequence === stop.sequence
      && row.deliveryStopId === stop.deliveryStopId && row.orderId === stop.deliveryStop.orderId
      && stop.deliveryStop.order.currentRouteVersionId === versionId
      && TERMINAL_STOPS.has(stop.deliveryStop.status);
  });
}
