import type { Prisma, PrismaClient } from '@prisma/client';
import { classifyCoordinateInPolygons, coordinatesFromGeoJsonPolygon } from './route-grouping.geometry.js';
import type { DriverPushProvider } from './driver-push.provider.js';
import type {
  RouteOptimizationOutcome,
  RouteOptimizationService,
  RouteOptimizationStopSequence
} from '../route-plans/route-engine-route-optimizer.client.js';
import { computeRouteShapeSignature, routeGeometryCacheCreateData } from '../route-plans/route-plan-geometry-cache.js';
import type { RouteGeometryProvider } from '../route-plans/route-plan.service.js';
import type { RoutePlanDetail, RoutePlanRouteResult } from '../route-plans/route-plan.types.js';
import {
  RouteGroupingRiskConfirmationRequiredError,
  RouteGroupingUnresolvedAssignmentsError,
  RouteGroupingValidationError,
  type CreateRouteGroupingInput,
  type GenerateChildRoutesInput,
  type ResolveRouteGroupingAssignmentsInput,
  type RollbackRouteGroupingInput,
  type RouteGroupingAssignmentDto,
  type RouteGroupingChildDisplayStatus,
  type RouteGroupingChildDto,
  type RouteGroupingDetailDto,
  type RouteGroupingDisplayStatus,
  type RouteGroupingNotificationStatus,
  type RouteGroupingPolygonDto,
  type RouteGroupingService,
  type RouteGroupingSummaryDto,
  type RouteGroupingWarningDto,
  type SaveRouteGroupingPolygonsInput
} from './route-grouping.types.js';
import { hashPushToken } from './driver-push-token.service.js';

const OPTIMIZER_VERSION = 'route-grouping-projection-v1';
const ROUTE_GROUPING_GEOMETRY_REFRESH_CONCURRENCY = 2;
export const DEFAULT_MAX_CHILD_ROUTE_STOP_DISTANCE_FROM_DEPOT_METERS = 500_000;

type RouteGroupingPrismaClient = Pick<
  PrismaClient,
  | '$transaction'
  | 'customerRouteNotificationFact'
  | 'driverPushToken'
  | 'driverRouteNotificationAttempt'
  | 'orderDeliveryFact'
  | 'routeGrouping'
  | 'routeGroupingChildVersion'
  | 'routeGroupingOrder'
  | 'routeGroupingPolygon'
  | 'routeGroupingVersion'
  | 'routePlanGeometryCache'
  | 'routePlan'
  | 'routePlanStop'
  | 'shop'
>;

type Tx = Parameters<Parameters<RouteGroupingPrismaClient['$transaction']>[0]>[0];

type LoadedGrouping = Prisma.RouteGroupingGetPayload<{ include: ReturnType<typeof groupingInclude> }>;
type LoadedChild = LoadedGrouping['childVersions'][number];
type LoadedAssignment = LoadedGrouping['orders'][number];

type ChildSnapshot = {
  driverId: string | null;
  groupingId: string;
  groupingVersion: number;
  name: string;
  planDate: string;
  routeScope: { deliverySession: string | null; routeScopeKey: string | null; serviceType: string | null };
  stops: Array<{ deliveryStopId: string; orderId: string; sequence: number; sourceOrderId: string }>;
};

type RouteGroupingRouteGeometryRefresher = {
  refreshRouteGeometryForRoutePlan(input: {
    routePlanId: string;
    shopDomain: string;
    source: 'SNAPSHOT';
  }): Promise<unknown>;
};

type ChildRouteProjectionResult = {
  childRoutePlanIds: string[];
  groupingId: string;
};

type DepotCoordinates = {
  address: string | null;
  latitude: number;
  longitude: number;
};

type OptimizedChildRouteCandidate = {
  assignments: LoadedAssignment[];
  depot: DepotCoordinates;
  driverId: string;
  name: string;
  routeResult: RoutePlanRouteResult;
  shapeSignature: string;
};

type RouteGroupingServiceOptions = {
  maxChildRouteStopDistanceFromDepotMeters?: number;
};

export class PrismaRouteGroupingService implements RouteGroupingService {
  constructor(
    private readonly prisma: RouteGroupingPrismaClient,
    private readonly pushProvider: DriverPushProvider,
    private readonly routeGeometryRefresher?: RouteGroupingRouteGeometryRefresher,
    private readonly routeOptimizationService?: RouteOptimizationService,
    private readonly routeGeometryProvider?: RouteGeometryProvider,
    private readonly options: RouteGroupingServiceOptions = {}
  ) {}

  async createGrouping(input: CreateRouteGroupingInput): Promise<RouteGroupingDetailDto> {
    const orderIds = normalizeIds(input.orderIds);
    const planDate = parsePlanDate(input.planDate);
    if (orderIds.length === 0) throw new RouteGroupingValidationError(['select at least one order']);

    const groupingId = await this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({ select: { id: true }, where: { shopDomain: normalizeShopDomain(input.shopDomain) } });
      if (shop === null) throw new RouteGroupingValidationError(['shop not found']);
      const facts = await tx.orderDeliveryFact.findMany({
        include: {
          order: {
            include: {
              deliveryStops: { include: { routePlanStops: { select: { id: true } } }, take: 1 }
            }
          }
        },
        where: { orderId: { in: orderIds }, shopId: shop.id }
      });
      const blockers = validateCreateFacts({ facts, orderIds, planDate: input.planDate });
      if (blockers.length > 0) throw new RouteGroupingValidationError(blockers);
      const orderedFacts = orderIds.map((orderId) => facts.find((fact) => fact.orderId === orderId)).filter((fact): fact is typeof facts[number] => fact !== undefined);
      const first = orderedFacts[0];
      if (first === undefined) throw new RouteGroupingValidationError(['selected order facts not found']);
      const grouping = await tx.routeGrouping.create({
        data: {
          createdBy: input.createdBy,
          deliverySession: first.deliverySession,
          name: input.name,
          planDate,
          routeScopeKey: first.routeScopeKey,
          serviceType: first.serviceType,
          shopId: shop.id,
          status: 'DRAFT'
        },
        select: { id: true }
      });
      await tx.routeGroupingVersion.create({
        data: { actor: input.createdBy, groupingId: grouping.id, shopId: shop.id, status: 'DRAFT', version: 1 }
      });
      await tx.routeGroupingOrder.createMany({
        data: orderedFacts.map((fact, index) => ({
          deliveryStopId: fact.order.deliveryStops[0]?.id ?? '',
          groupingId: grouping.id,
          orderId: fact.orderId,
          shopId: shop.id,
          sourceSequence: index + 1
        }))
      });
      return grouping.id;
    });
    const detail = await this.getGrouping({ groupingId, shopDomain: input.shopDomain });
    if (detail === null) throw new RouteGroupingValidationError(['created grouping not found']);
    return detail;
  }

  async getGrouping(input: { groupingId: string; shopDomain: string }): Promise<RouteGroupingDetailDto | null> {
    const loaded = await this.loadGrouping(input);
    if (loaded === null) return null;
    return toGroupingDetailDto(loaded);
  }

  async listGroupings(input: { deliveryDate?: string; shopDomain: string }): Promise<RouteGroupingSummaryDto[]> {
    const shop = await this.prisma.shop.findUnique({ select: { id: true }, where: { shopDomain: normalizeShopDomain(input.shopDomain) } });
    if (shop === null) return [];
    const groups = await this.prisma.routeGrouping.findMany({
      include: groupingInclude(),
      orderBy: { createdAt: 'desc' },
      where: { shopId: shop.id, ...(input.deliveryDate === undefined ? {} : { planDate: parsePlanDate(input.deliveryDate) }) }
    });
    return groups.map((group) => toGroupingSummaryDto(group));
  }

  async savePolygons(input: SaveRouteGroupingPolygonsInput): Promise<RouteGroupingDetailDto | null> {
    const groupingId = await this.prisma.$transaction(async (tx) => {
      const group = await findGroupingForUpdate(tx, input.shopDomain, input.groupingId);
      if (group === null) return null;
      await tx.routeGroupingPolygon.deleteMany({ where: { groupingId: group.id } });
      await tx.routeGroupingPolygon.createMany({
        data: input.polygons.map((polygon, index) => ({
          closed: polygon.closed,
          color: polygon.color ?? null,
          drawOrder: index + 1,
          driverId: polygon.driverId ?? null,
          geometryJson: polygon.geometry as Prisma.InputJsonValue,
          groupingId: group.id,
          label: polygon.label,
          shopId: group.shopId
        }))
      });
      await recomputeAssignments(tx, group.id);
      await tx.routeGrouping.update({ data: { status: 'CHANGED' }, where: { id: group.id } });
      return group.id;
    });
    if (groupingId === null) return null;
    return this.getGrouping({ groupingId, shopDomain: input.shopDomain });
  }

  async resolveAssignments(input: ResolveRouteGroupingAssignmentsInput): Promise<RouteGroupingDetailDto | null> {
    const groupingId = await this.prisma.$transaction(async (tx) => {
      const group = await findGroupingForUpdate(tx, input.shopDomain, input.groupingId);
      if (group === null) return null;
      for (const assignment of input.assignments) {
        const driver = await tx.driver.findFirst({ select: { id: true }, where: { id: assignment.assignedDriverId, shopId: group.shopId } });
        if (driver === null) throw new RouteGroupingValidationError(['driver must belong to the current shop']);
        await tx.routeGroupingOrder.updateMany({
          data: { assignedDriverId: assignment.assignedDriverId, assignedPolygonId: null, assignmentStatus: 'ASSIGNED' },
          where: { groupingId: group.id, orderId: assignment.orderId }
        });
      }
      await tx.routeGrouping.update({ data: { status: 'CHANGED' }, where: { id: group.id } });
      return group.id;
    });
    if (groupingId === null) return null;
    return this.getGrouping({ groupingId, shopDomain: input.shopDomain });
  }

  async generateChildRoutes(input: GenerateChildRoutesInput): Promise<RouteGroupingDetailDto | null> {
    const initial = await this.loadGrouping({ groupingId: input.groupingId, shopDomain: input.shopDomain });
    if (initial === null) return null;
    validateReadyForChildGeneration(initial, input.confirmRisk);
    const candidates = await this.prepareOptimizedChildRouteCandidates(initial, input.shopDomain);
    const expectedSnapshot = childGenerationSnapshotSignature(initial);

    const projection = await this.prisma.$transaction(async (tx): Promise<ChildRouteProjectionResult | null> => {
      const group = await findGroupingForUpdate(tx, input.shopDomain, input.groupingId);
      if (group === null) return null;
      const loaded = await tx.routeGrouping.findUnique({ include: groupingInclude(), where: { id: group.id } });
      if (loaded === null) return null;
      validateReadyForChildGeneration(loaded, input.confirmRisk);
      if (childGenerationSnapshotSignature(loaded) !== expectedSnapshot) {
        throw new RouteGroupingValidationError(['route grouping changed; reload and retry child generation']);
      }
      const hasCurrent = loaded.childVersions.some((child) => child.status === 'CURRENT');
      if (hasCurrent) await archiveCurrentChildren(tx, loaded, input.actor);
      const nextVersion = hasCurrent ? loaded.currentVersion + 1 : loaded.currentVersion;
      const version = await createCurrentGroupingVersion(tx, loaded, { actor: input.actor, hasCurrent, nextVersion });
      const childRoutePlanIds: string[] = [];
      for (const candidate of candidates) {
        const routePlan = await createChildRoutePlan(tx, loaded, candidate, nextVersion, input.actor);
        childRoutePlanIds.push(routePlan.id);
        await createChildRouteGeometryCache(tx, routePlan.id, candidate);
        await tx.routeGroupingChildVersion.create({
          data: {
            driverId: candidate.driverId,
            groupingId: loaded.id,
            groupingVersionId: version.id,
            notificationStatus: 'SKIPPED',
            routePlanId: routePlan.id,
            shopId: loaded.shopId,
            snapshot: createChildSnapshot(loaded, candidate.assignments, candidate.driverId, routePlan.name, nextVersion),
            status: 'CURRENT',
            version: nextVersion
          }
        });
      }
      await tx.routeGrouping.update({ data: { currentVersion: nextVersion, status: 'READY' }, where: { id: loaded.id } });
      return { childRoutePlanIds, groupingId: loaded.id };
    });
    if (projection === null) return null;
    return this.getGrouping({ groupingId: projection.groupingId, shopDomain: input.shopDomain });
  }

  async rollback(input: RollbackRouteGroupingInput): Promise<RouteGroupingDetailDto | null> {
    const projection = await this.prisma.$transaction(async (tx): Promise<ChildRouteProjectionResult | null> => {
      const group = await findGroupingForUpdate(tx, input.shopDomain, input.groupingId);
      if (group === null) return null;
      const loaded = await tx.routeGrouping.findUnique({ include: groupingInclude(), where: { id: group.id } });
      if (loaded === null) return null;
      const snapshots = loaded.childVersions.filter((child) => child.version === input.version && child.status !== 'CURRENT');
      if (snapshots.length === 0) throw new RouteGroupingValidationError(['rollback version not found']);
      await archiveCurrentChildren(tx, loaded, input.actor);
      const nextVersion = loaded.currentVersion + 1;
      const version = await tx.routeGroupingVersion.create({
        data: { actor: input.actor, changeReason: `rollback:${input.version}`, groupingId: loaded.id, shopId: loaded.shopId, status: 'CURRENT', version: nextVersion }
      });
      const childRoutePlanIds: string[] = [];
      for (const child of snapshots) {
        const snapshot = readChildSnapshot(child.snapshot);
        const assignments = snapshot.stops.map((stop) => ({ deliveryStopId: stop.deliveryStopId, orderId: stop.orderId, sourceSequence: stop.sequence }));
        const routePlan = await createChildRoutePlanFromSnapshot(tx, loaded, snapshot, nextVersion, input.actor);
        childRoutePlanIds.push(routePlan.id);
        await tx.routeGroupingChildVersion.create({
          data: {
            driverId: snapshot.driverId,
            groupingId: loaded.id,
            groupingVersionId: version.id,
            notificationStatus: 'SKIPPED',
            routePlanId: routePlan.id,
            shopId: loaded.shopId,
            snapshot: { ...snapshot, groupingVersion: nextVersion, stops: assignments },
            status: 'CURRENT',
            version: nextVersion
          }
        });
      }
      await tx.routeGrouping.update({ data: { currentVersion: nextVersion, status: 'READY' }, where: { id: loaded.id } });
      return { childRoutePlanIds, groupingId: loaded.id };
    });
    if (projection === null) return null;
    await this.refreshChildRouteGeometry(projection.childRoutePlanIds, input.shopDomain);
    return this.getGrouping({ groupingId: projection.groupingId, shopDomain: input.shopDomain });
  }

  private async refreshChildRouteGeometry(routePlanIds: string[], shopDomain: string): Promise<void> {
    const routeGeometryRefresher = this.routeGeometryRefresher;
    if (routeGeometryRefresher === undefined) return;
    const uniqueRoutePlanIds = [...new Set(routePlanIds)];
    for (let index = 0; index < uniqueRoutePlanIds.length; index += ROUTE_GROUPING_GEOMETRY_REFRESH_CONCURRENCY) {
      const batch = uniqueRoutePlanIds.slice(index, index + ROUTE_GROUPING_GEOMETRY_REFRESH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((routePlanId) =>
          routeGeometryRefresher.refreshRouteGeometryForRoutePlan({
            routePlanId,
            shopDomain,
            source: 'SNAPSHOT'
          })
        )
      );
      results.forEach((result, resultIndex) => {
        if (result.status === 'rejected') {
          logRouteGeometryRefreshFailure(batch[resultIndex] ?? 'unknown-route-plan-id', result.reason);
        }
      });
    }
  }

  async recordChildRoutePublished(input: { routePlanId: string; shopDomain: string }): Promise<void> {
    const child = await this.prisma.routeGroupingChildVersion.findFirst({
      include: { grouping: { include: { shop: { select: { shopDomain: true } } } }, routePlan: { select: { driverId: true, status: true } } },
      where: { routePlanId: input.routePlanId, status: 'CURRENT' }
    });
    if (child === null || child.grouping.shop.shopDomain !== normalizeShopDomain(input.shopDomain)) return;
    await this.prisma.routeGroupingChildVersion.update({ data: { publishedAt: new Date() }, where: { id: child.id } });
    if (child.routePlan?.driverId === null || child.routePlan?.driverId === undefined) return;
    const tokens = await this.prisma.driverPushToken.findMany({ where: { driverId: child.routePlan.driverId, status: 'ACTIVE' } });
    if (tokens.length === 0) {
      await this.prisma.routeGroupingChildVersion.update({ data: { notificationStatus: 'SKIPPED' }, where: { id: child.id } });
      return;
    }
    const action = await this.hasPriorSentAttempt(child.groupingId, child.routePlan.driverId) ? 'CHANGED' : 'ASSIGNED';
    const firstToken = tokens[0];
    if (firstToken === undefined) return;
    const idempotencyKey = `${child.shopId}:${child.groupingId}:${child.version}:${child.id}:${child.routePlan.driverId}:${action}`;
    const existing = await this.prisma.driverRouteNotificationAttempt.findUnique({ where: { idempotencyKey } });
    if (existing?.status === 'SENT') return;
    const pending = await this.prisma.driverRouteNotificationAttempt.upsert({
      create: {
        action,
        childVersionId: child.id,
        driverId: child.routePlan.driverId,
        groupingId: child.groupingId,
        groupingVersion: child.version,
        idempotencyKey,
        provider: this.pushProvider.providerName,
        routePlanId: input.routePlanId,
        shopId: child.shopId,
        status: 'PENDING'
      },
      update: { attemptedAt: new Date(), provider: this.pushProvider.providerName, status: 'PENDING' },
      where: { idempotencyKey }
    });
    const result = await this.pushProvider.sendRouteNotification({
      action: action === 'ASSIGNED' ? 'assigned' : 'changed',
      childVersion: child.version,
      devicePushToken: firstToken.devicePushToken,
      routeGroupingId: child.groupingId,
      routePlanId: input.routePlanId
    });
    await this.prisma.driverRouteNotificationAttempt.update({
      data: {
        completedAt: new Date(),
        errorCode: result.errorCode ?? null,
        errorMessage: result.errorMessage ?? null,
        providerMessageId: result.providerMessageId ?? null,
        status: result.status
      },
      where: { id: pending.id }
    });
    await this.prisma.routeGroupingChildVersion.update({ data: { notificationStatus: result.status }, where: { id: child.id } });
    if (result.invalidToken === true) {
      await this.prisma.driverPushToken.updateMany({ data: { revokedAt: new Date(), status: 'INVALID' }, where: { id: firstToken.id, tokenHash: hashPushToken(firstToken.devicePushToken) } });
    }
  }

  private async hasPriorSentAttempt(groupingId: string, driverId: string): Promise<boolean> {
    const count = await this.prisma.driverRouteNotificationAttempt.count({ where: { driverId, groupingId, status: 'SENT' } });
    return count > 0;
  }

  private async loadGrouping(input: { groupingId: string; shopDomain: string }): Promise<LoadedGrouping | null> {
    const shop = await this.prisma.shop.findUnique({ select: { id: true }, where: { shopDomain: normalizeShopDomain(input.shopDomain) } });
    if (shop === null) return null;
    return this.prisma.routeGrouping.findFirst({ include: groupingInclude(), where: { id: input.groupingId, shopId: shop.id } });
  }

  private async prepareOptimizedChildRouteCandidates(
    group: LoadedGrouping,
    shopDomain: string
  ): Promise<OptimizedChildRouteCandidate[]> {
    if (this.routeOptimizationService === undefined) {
      throw new RouteGroupingValidationError(['route optimization service is not configured']);
    }
    if (this.routeGeometryProvider === undefined) {
      throw new RouteGroupingValidationError(['route geometry provider is not configured']);
    }
    const depot = readDepotFromShop(group);
    if (depot === null) {
      throw new RouteGroupingValidationError(['default depot coordinates are required before generating child routes']);
    }

    const candidates: OptimizedChildRouteCandidate[] = [];
    const byDriver = groupAssignmentsByDriver(group.orders);
    for (const [driverId, assignments] of byDriver) {
      validateChildRouteStopsNearDepot(assignments, depot, this.maxChildRouteStopDistanceFromDepotMeters());
      const name = childRouteName(group, driverId, group.currentVersion);
      const sourceDetail = buildChildRouteDetail({ assignments, depot, driverId, group, name });
      const outcome = await resolveChildRouteOptimization(this.routeOptimizationService, sourceDetail, shopDomain);
      if (!outcome.ok) {
        throw new RouteGroupingValidationError([`child route optimization failed: ${outcome.failure.message}`]);
      }
      if (outcome.result.missingCoordinateStops > 0) {
        throw new RouteGroupingValidationError(['child route optimization requires coordinates for every stop']);
      }
      const orderedAssignments = orderAssignmentsByOptimizationResult(assignments, outcome.result.stops);
      const optimizedDetail = buildChildRouteDetail({ assignments: orderedAssignments, depot, driverId, group, name });
      const routeResult = await buildChildRouteGeometry(this.routeGeometryProvider, optimizedDetail);
      if (routeResult.routeGeometry === null) {
        throw new RouteGroupingValidationError(['child route geometry could not be generated']);
      }
      candidates.push({
        assignments: orderedAssignments,
        depot,
        driverId,
        name,
        routeResult,
        shapeSignature: computeRouteShapeSignature(optimizedDetail)
      });
    }
    return candidates;
  }

  private maxChildRouteStopDistanceFromDepotMeters(): number {
    return this.options.maxChildRouteStopDistanceFromDepotMeters ?? DEFAULT_MAX_CHILD_ROUTE_STOP_DISTANCE_FROM_DEPOT_METERS;
  }
}

function logRouteGeometryRefreshFailure(routePlanId: string, reason: unknown): void {
  console.warn('[route-grouping] child route geometry refresh failed after projection commit', {
    errorMessage: reason instanceof Error ? reason.message : String(reason),
    routePlanId
  });
}

function groupingInclude() {
  return {
    childVersions: {
      include: {
        driver: true,
        notificationAttempts: true,
        routePlan: { include: { driver: true, routeStops: true } }
      },
      orderBy: [{ version: 'desc' as const }, { createdAt: 'desc' as const }]
    },
    orders: {
      include: {
        deliveryStop: { include: { order: true, routePlanStops: { select: { routePlanId: true } } } },
        assignedDriver: true,
        assignedPolygon: true,
        order: { include: { customerRouteNotifications: true } }
      },
      orderBy: { sourceSequence: 'asc' as const }
    },
    polygons: { orderBy: { drawOrder: 'asc' as const } },
    shop: true,
    versions: { orderBy: { version: 'desc' as const } }
  } satisfies Prisma.RouteGroupingInclude;
}

async function findGroupingForUpdate(tx: Tx, shopDomain: string, groupingId: string): Promise<{ id: string; shopId: string } | null> {
  const shop = await tx.shop.findUnique({ select: { id: true }, where: { shopDomain: normalizeShopDomain(shopDomain) } });
  if (shop === null) return null;
  return tx.routeGrouping.findFirst({ select: { id: true, shopId: true }, where: { id: groupingId, shopId: shop.id } });
}

function validateCreateFacts(input: { facts: Array<{ deliveryDate: Date | null; routeScopeKey: string | null; deliverySession: string | null; serviceType: string | null; orderId: string; order: { deliveryStops: Array<{ latitude: unknown; longitude: unknown; routePlanStops: Array<{ id: string }> }> } }>; orderIds: string[]; planDate: string }): string[] {
  const blockers: string[] = [];
  if (input.facts.length !== input.orderIds.length) blockers.push('selected orders must have delivery facts');
  const first = input.facts[0];
  for (const orderId of input.orderIds) {
    const fact = input.facts.find((candidate) => candidate.orderId === orderId);
    if (fact === undefined) continue;
    if (formatDateOnly(fact.deliveryDate) !== input.planDate) blockers.push('selected orders must match grouping date');
    if (first !== undefined && (fact.routeScopeKey !== first.routeScopeKey || fact.deliverySession !== first.deliverySession || fact.serviceType !== first.serviceType)) blockers.push('selected orders must share one route scope');
    if (isPickupService(fact.serviceType)) blockers.push('pickup orders cannot be grouped into driver delivery routes');
    const stop = fact.order.deliveryStops[0];
    if (stop === undefined) blockers.push('selected orders must have delivery stops');
    if (decimalNumber(stop?.latitude) === null || decimalNumber(stop?.longitude) === null) blockers.push('selected orders must have coordinates');
    if ((stop?.routePlanStops.length ?? 0) > 0) blockers.push('selected orders already have active route ownership');
  }
  return [...new Set(blockers)];
}

async function recomputeAssignments(tx: Tx, groupingId: string): Promise<void> {
  const polygons = await tx.routeGroupingPolygon.findMany({ orderBy: { drawOrder: 'asc' }, where: { groupingId, closed: true } });
  const classifiers = polygons.map((polygon) => ({ id: polygon.id, vertices: coordinatesFromGeoJsonPolygon(polygon.geometryJson) }));
  const orders = await tx.routeGroupingOrder.findMany({ include: { deliveryStop: true }, where: { groupingId } });
  for (const order of orders) {
    const latitude = decimalNumber(order.deliveryStop.latitude);
    const longitude = decimalNumber(order.deliveryStop.longitude);
    if (latitude === null || longitude === null) {
      await tx.routeGroupingOrder.update({ data: { assignedDriverId: null, assignedPolygonId: null, assignmentStatus: 'UNASSIGNED' }, where: { id: order.id } });
      continue;
    }
    const classification = classifyCoordinateInPolygons({ latitude, longitude }, classifiers);
    if (classification.status !== 'ASSIGNED') {
      await tx.routeGroupingOrder.update({ data: { assignedDriverId: null, assignedPolygonId: null, assignmentStatus: classification.status }, where: { id: order.id } });
      continue;
    }
    const polygonId = classification.polygonIds[0];
    const polygon = polygons.find((candidate) => candidate.id === polygonId);
    if (polygon?.driverId === null || polygon?.driverId === undefined) {
      await tx.routeGroupingOrder.update({ data: { assignedDriverId: null, assignedPolygonId: polygonId, assignmentStatus: 'UNASSIGNED' }, where: { id: order.id } });
      continue;
    }
    await tx.routeGroupingOrder.update({ data: { assignedDriverId: polygon.driverId, assignedPolygonId: polygon.id, assignmentStatus: 'ASSIGNED' }, where: { id: order.id } });
  }
}

async function archiveCurrentChildren(tx: Tx, group: LoadedGrouping, actor: string): Promise<void> {
  const current = group.childVersions.filter((child) => child.status === 'CURRENT');
  for (const child of current) {
    if (child.routePlanId !== null) {
      await tx.routePlanStop.deleteMany({ where: { routePlanId: child.routePlanId } });
      await tx.routePlan.updateMany({ data: { status: 'CANCELLED' }, where: { id: child.routePlanId } });
    }
    await tx.routeGroupingChildVersion.update({ data: { status: 'ARCHIVED', supersededAt: new Date() }, where: { id: child.id } });
  }
  await tx.routeGroupingVersion.updateMany({ data: { status: 'ARCHIVED' }, where: { groupingId: group.id, status: 'CURRENT' } });
  void actor;
}

async function createCurrentGroupingVersion(
  tx: Tx,
  group: LoadedGrouping,
  input: { actor: string; hasCurrent: boolean; nextVersion: number }
): Promise<{ id: string }> {
  if (!input.hasCurrent) {
    const draft = group.versions.find((version) => version.status === 'DRAFT' && version.version === input.nextVersion);
    if (draft !== undefined) {
      await tx.routeGroupingVersion.updateMany({
        data: { status: 'ARCHIVED' },
        where: { groupingId: group.id, id: { not: draft.id }, status: 'DRAFT' }
      });
      return tx.routeGroupingVersion.update({
        data: { actor: input.actor, changeReason: 'generate_child_routes', status: 'CURRENT' },
        select: { id: true },
        where: { id: draft.id }
      });
    }
  }
  await tx.routeGroupingVersion.updateMany({ data: { status: 'ARCHIVED' }, where: { groupingId: group.id, status: 'DRAFT' } });
  return tx.routeGroupingVersion.create({
    data: {
      actor: input.actor,
      changeReason: input.hasCurrent ? 'regenerate_child_routes' : 'generate_child_routes',
      groupingId: group.id,
      shopId: group.shopId,
      status: 'CURRENT',
      version: input.nextVersion
    },
    select: { id: true }
  });
}

function groupAssignmentsByDriver(assignments: LoadedAssignment[]): Map<string, LoadedAssignment[]> {
  const byDriver = new Map<string, LoadedAssignment[]>();
  for (const assignment of assignments) {
    if (assignment.assignmentStatus !== 'ASSIGNED' || assignment.assignedDriverId === null) continue;
    const current = byDriver.get(assignment.assignedDriverId) ?? [];
    current.push(assignment);
    byDriver.set(assignment.assignedDriverId, current);
  }
  for (const entries of byDriver.values()) entries.sort((left, right) => left.sourceSequence - right.sourceSequence);
  return byDriver;
}

function validateReadyForChildGeneration(group: LoadedGrouping, confirmRisk?: boolean): void {
  const unresolved = group.orders.filter((order) => order.assignmentStatus !== 'ASSIGNED' || order.assignedDriverId === null);
  if (unresolved.length > 0) throw new RouteGroupingUnresolvedAssignmentsError(unresolved.length);
  const currentChildRoutePlanIds = new Set(group.childVersions.filter((child) => child.status === 'CURRENT' && child.routePlanId !== null).map((child) => child.routePlanId));
  const externallyOwnedStops = group.orders.filter((order) => order.deliveryStop.routePlanStops.some((stop) => !currentChildRoutePlanIds.has(stop.routePlanId)));
  if (externallyOwnedStops.length > 0) {
    throw new RouteGroupingValidationError([
      `selected orders already have active route ownership: ${externallyOwnedStops.map((order) => order.order.name).slice(0, 5).join(', ')}`
    ]);
  }
  const warnings = toGroupingSummaryDto(group).warningState;
  const hasCurrent = group.childVersions.some((child) => child.status === 'CURRENT');
  if (hasCurrent && warnings.length > 0 && confirmRisk !== true) {
    throw new RouteGroupingRiskConfirmationRequiredError(warnings);
  }
}

function childGenerationSnapshotSignature(group: LoadedGrouping): string {
  return JSON.stringify({
    children: group.childVersions
      .filter((child) => child.status === 'CURRENT')
      .map((child) => ({ id: child.id, routePlanId: child.routePlanId, version: child.version }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    currentVersion: group.currentVersion,
    depot: readDepotFromShop(group),
    orders: group.orders.map((order) => ({
      assignedDriverId: order.assignedDriverId,
      assignmentStatus: order.assignmentStatus,
      deliveryStopId: order.deliveryStopId,
      latitude: decimalNumber(order.deliveryStop.latitude),
      longitude: decimalNumber(order.deliveryStop.longitude),
      orderId: order.orderId,
      sourceSequence: order.sourceSequence
    }))
  });
}

async function optimizeWithLegacyResult(
  routeOptimizationService: RouteOptimizationService,
  detail: RoutePlanDetail,
  shopDomain: string
): Promise<RouteOptimizationOutcome> {
  const startedAt = Date.now();
  const result = await routeOptimizationService.optimizeStopOrder({ detail, shopDomain });
  if (result === null) {
    return {
      failure: {
        code: 'invalid_engine_payload',
        elapsedMs: Date.now() - startedAt,
        message: 'Route optimizer did not return a stop sequence.'
      },
      ok: false
    };
  }
  return { ok: true, result };
}

async function resolveChildRouteOptimization(
  routeOptimizationService: RouteOptimizationService,
  detail: RoutePlanDetail,
  shopDomain: string
): Promise<RouteOptimizationOutcome> {
  try {
    return routeOptimizationService.optimizeStopOrderWithDiagnostics === undefined
      ? await optimizeWithLegacyResult(routeOptimizationService, detail, shopDomain)
      : await routeOptimizationService.optimizeStopOrderWithDiagnostics({ detail, shopDomain });
  } catch (error) {
    throw new RouteGroupingValidationError([`child route optimization failed: ${describeError(error)}`]);
  }
}

async function buildChildRouteGeometry(
  routeGeometryProvider: RouteGeometryProvider,
  detail: RoutePlanDetail
): Promise<RoutePlanRouteResult> {
  try {
    return await routeGeometryProvider.buildRoute(detail);
  } catch (error) {
    throw new RouteGroupingValidationError([`child route geometry failed: ${describeError(error)}`]);
  }
}

function orderAssignmentsByOptimizationResult(
  assignments: LoadedAssignment[],
  stops: RouteOptimizationStopSequence[]
): LoadedAssignment[] {
  const assignmentsByDeliveryStopId = new Map(assignments.map((assignment) => [assignment.deliveryStopId, assignment]));
  const ordered: LoadedAssignment[] = [];
  for (const stop of [...stops].sort((left, right) => left.sequence - right.sequence)) {
    const assignment = assignmentsByDeliveryStopId.get(stop.deliveryStopId);
    if (assignment === undefined) {
      throw new RouteGroupingValidationError(['child route optimizer returned an unknown stop']);
    }
    ordered.push(assignment);
  }
  if (ordered.length !== assignments.length) {
    throw new RouteGroupingValidationError(['child route optimizer omitted one or more stops']);
  }
  return ordered;
}

function validateChildRouteStopsNearDepot(assignments: LoadedAssignment[], depot: DepotCoordinates, maxDistanceMeters: number): void {
  const outsideCoverage = assignments
    .map((assignment) => {
      const latitude = decimalNumber(assignment.deliveryStop.latitude);
      const longitude = decimalNumber(assignment.deliveryStop.longitude);
      if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
      const distanceMeters = distanceBetweenCoordinatesMeters(depot, { latitude, longitude });
      if (distanceMeters <= maxDistanceMeters) return null;
      return assignment.order.name ?? assignment.order.shopifyOrderGid ?? assignment.orderId;
    })
    .filter((orderName): orderName is string => orderName !== null);
  if (outsideCoverage.length > 0) {
    throw new RouteGroupingValidationError([
      `child route contains stops outside depot coverage: ${outsideCoverage.slice(0, 5).join(', ')}`
    ]);
  }
}

function buildChildRouteDetail(input: {
  assignments: LoadedAssignment[];
  depot: DepotCoordinates;
  driverId: string;
  group: LoadedGrouping;
  name: string;
}): RoutePlanDetail {
  const now = new Date().toISOString();
  return {
    routeGeometry: null,
    routeMetrics: null,
    routePlan: {
      createdAt: now,
      deliveryAreas: [],
      deliveryDays: [],
      depot: { latitude: input.depot.latitude, longitude: input.depot.longitude },
      driver: null,
      driverId: input.driverId,
      id: `route-grouping:${input.group.id}:${input.driverId}`,
      missingCoordinates: input.assignments.filter((assignment) => decimalNumber(assignment.deliveryStop.latitude) === null || decimalNumber(assignment.deliveryStop.longitude) === null).length,
      name: input.name,
      planDate: formatDateOnly(input.group.planDate) ?? '',
      routeEndMode: 'END_AT_LAST_STOP',
      status: 'DRAFT',
      stopsCount: input.assignments.length,
      updatedAt: now
    },
    routeStopPoints: [],
    stops: input.assignments.map((assignment, index) => childAssignmentToRouteStop(assignment, index + 1))
  };
}

function childAssignmentToRouteStop(assignment: LoadedAssignment, sequence: number): RoutePlanDetail['stops'][number] {
  const stop = assignment.deliveryStop;
  return {
    address: {
      address1: stop.address1,
      address2: stop.address2,
      city: stop.city,
      countryCode: stop.countryCode,
      postalCode: stop.postalCode,
      province: stop.province
    },
    attributes: [],
    coordinates: { latitude: decimalNumber(stop.latitude), longitude: decimalNumber(stop.longitude) },
    deliveryArea: null,
    deliveryDay: null,
    deliveryStopId: assignment.deliveryStopId,
    financialStatus: null,
    fulfillmentStatus: null,
    orderId: assignment.orderId,
    orderName: assignment.order.name,
    paymentStatus: null,
    recipientName: stop.recipientName,
    sequence,
    shopifyOrderGid: assignment.order.shopifyOrderGid,
    status: stop.status
  };
}

function childRouteName(group: LoadedGrouping, driverId: string, version: number): string {
  const driverName = group.orders.find((assignment) => assignment.assignedDriverId === driverId)?.assignedDriver?.displayName ?? 'Driver';
  return `${group.name} — ${driverName} v${version}`;
}

async function createChildRoutePlan(tx: Tx, group: LoadedGrouping, candidate: OptimizedChildRouteCandidate, version: number, actor: string): Promise<{ id: string; name: string }> {
  const name = childRouteName(group, candidate.driverId, version);
  const routePlan = await tx.routePlan.create({
    data: {
      constraints: routeConstraints(group, candidate.depot),
      createdBy: actor,
      depotLatitude: decimalString(candidate.depot.latitude),
      depotLongitude: decimalString(candidate.depot.longitude),
      driverId: candidate.driverId,
      metrics: routeMetrics(candidate.assignments),
      name,
      optimizerVersion: OPTIMIZER_VERSION,
      planDate: group.planDate,
      shopId: group.shopId,
      status: 'DRAFT'
    },
    select: { id: true, name: true }
  });
  await tx.routePlanStop.createMany({ data: candidate.assignments.map((assignment, index) => ({ deliveryStopId: assignment.deliveryStopId, routePlanId: routePlan.id, sequence: index + 1 })) });
  return routePlan;
}

async function createChildRoutePlanFromSnapshot(tx: Tx, group: LoadedGrouping, snapshot: ChildSnapshot, version: number, actor: string): Promise<{ id: string; name: string }> {
  const depot = readDepotFromShop(group);
  const name = `${snapshot.name.replace(/ v\d+$/u, '')} v${version}`;
  const routePlan = await tx.routePlan.create({
    data: {
      constraints: routeConstraints(group, depot),
      createdBy: actor,
      ...(depot === null ? {} : { depotLatitude: decimalString(depot.latitude), depotLongitude: decimalString(depot.longitude) }),
      driverId: snapshot.driverId,
      metrics: { stopsCount: snapshot.stops.length },
      name,
      optimizerVersion: OPTIMIZER_VERSION,
      planDate: group.planDate,
      shopId: group.shopId,
      status: 'DRAFT'
    },
    select: { id: true, name: true }
  });
  await tx.routePlanStop.createMany({ data: snapshot.stops.map((stop, index) => ({ deliveryStopId: stop.deliveryStopId, routePlanId: routePlan.id, sequence: index + 1 })) });
  return routePlan;
}

async function createChildRouteGeometryCache(
  tx: Tx,
  routePlanId: string,
  candidate: OptimizedChildRouteCandidate
): Promise<void> {
  await tx.routePlanGeometryCache.create({
    data: routeGeometryCacheCreateData({
      generatedAt: new Date(),
      geometry: candidate.routeResult.routeGeometry,
      metrics: candidate.routeResult.routeMetrics,
      provider: 'osrm',
      providerVersion: null,
      routePlanId,
      shapeSignature: candidate.shapeSignature,
      source: 'SNAPSHOT',
      stopPoints: candidate.routeResult.routeStopPoints
    })
  });
}

function createChildSnapshot(group: LoadedGrouping, assignments: LoadedAssignment[], driverId: string, name: string, version: number): ChildSnapshot {
  return {
    driverId,
    groupingId: group.id,
    groupingVersion: version,
    name,
    planDate: formatDateOnly(group.planDate) ?? '',
    routeScope: { deliverySession: group.deliverySession, routeScopeKey: group.routeScopeKey, serviceType: group.serviceType },
    stops: assignments.map((assignment, index) => ({ deliveryStopId: assignment.deliveryStopId, orderId: assignment.orderId, sequence: index + 1, sourceOrderId: assignment.order.shopifyOrderGid }))
  };
}

function readChildSnapshot(value: Prisma.JsonValue): ChildSnapshot {
  const object = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const stops = Array.isArray(object.stops) ? object.stops : [];
  return {
    driverId: typeof object.driverId === 'string' ? object.driverId : null,
    groupingId: typeof object.groupingId === 'string' ? object.groupingId : '',
    groupingVersion: typeof object.groupingVersion === 'number' ? object.groupingVersion : 0,
    name: typeof object.name === 'string' ? object.name : 'Rolled back route',
    planDate: typeof object.planDate === 'string' ? object.planDate : '',
    routeScope: { deliverySession: null, routeScopeKey: null, serviceType: null },
    stops: stops.map((entry, index) => {
      const row = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      return {
        deliveryStopId: readOptionalSnapshotString(row.deliveryStopId),
        orderId: readOptionalSnapshotString(row.orderId),
        sequence: Number(row.sequence ?? index + 1),
        sourceOrderId: readOptionalSnapshotString(row.sourceOrderId)
      };
    }).filter((row) => row.deliveryStopId !== '' && row.orderId !== '')
  };
}


function readOptionalSnapshotString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function routeConstraints(group: LoadedGrouping, depot?: DepotCoordinates | null): Prisma.InputJsonObject {
  return {
    ...(depot === undefined || depot === null ? {} : { depot }),
    routeEndMode: 'END_AT_LAST_STOP',
    routeScope: { deliveryDate: formatDateOnly(group.planDate), deliverySession: group.deliverySession, routeScopeKey: group.routeScopeKey, serviceType: group.serviceType }
  };
}

function routeMetrics(assignments: LoadedAssignment[]): Prisma.InputJsonObject {
  return { missingCoordinates: 0, stopsCount: assignments.length };
}

function toGroupingDetailDto(group: LoadedGrouping): RouteGroupingDetailDto {
  return { ...toGroupingSummaryDto(group), assignments: group.orders.map(toAssignmentDto), polygons: group.polygons.map(toPolygonDto) };
}

function toGroupingSummaryDto(group: LoadedGrouping): RouteGroupingSummaryDto {
  const unresolvedOrders = group.orders.filter((order) => order.assignmentStatus !== 'ASSIGNED').length;
  const currentChildren = group.childVersions.filter((child) => child.status === 'CURRENT');
  return {
    children: currentChildren.map(toChildDto),
    currentVersion: group.currentVersion,
    displayStatus: deriveGroupingDisplayStatus(group, unresolvedOrders, currentChildren),
    id: group.id,
    name: group.name,
    planDate: formatDateOnly(group.planDate) ?? '',
    status: group.status,
    totalOrders: group.orders.length,
    unresolvedOrders,
    warningState: deriveWarnings(group)
  };
}

function toAssignmentDto(order: LoadedAssignment): RouteGroupingAssignmentDto {
  return {
    assignedDriverId: order.assignedDriverId,
    assignedPolygonId: order.assignedPolygonId,
    assignmentStatus: order.assignmentStatus,
    coordinates: { latitude: decimalNumber(order.deliveryStop.latitude), longitude: decimalNumber(order.deliveryStop.longitude) },
    deliveryStopId: order.deliveryStopId,
    orderId: order.orderId,
    orderName: order.order.name,
    sourceOrderId: order.order.shopifyOrderGid,
    sourceSequence: order.sourceSequence
  };
}

function toPolygonDto(polygon: LoadedGrouping['polygons'][number]): RouteGroupingPolygonDto {
  return { closed: polygon.closed, color: polygon.color, drawOrder: polygon.drawOrder, driverId: polygon.driverId, geometry: polygon.geometryJson, id: polygon.id, label: polygon.label };
}

function toChildDto(child: LoadedChild): RouteGroupingChildDto {
  return {
    childVersion: child.version,
    displayStatus: deriveChildDisplayStatus(child),
    driverId: child.driverId,
    driverName: child.driver?.displayName ?? child.routePlan?.driver?.displayName ?? null,
    notificationStatus: normalizeNotificationStatus(child.notificationStatus),
    routePlan: child.routePlan === null ? null : toMinimalRoutePlanSummary(child.routePlan),
    routePlanId: child.routePlanId,
    stopsCount: child.routePlan?.routeStops.length ?? readChildSnapshot(child.snapshot).stops.length
  };
}

function toMinimalRoutePlanSummary(routePlan: NonNullable<LoadedChild['routePlan']>) {
  return {
    createdAt: routePlan.createdAt.toISOString(),
    deliveryAreas: [],
    deliveryDays: [],
    depot: { latitude: decimalNumber(routePlan.depotLatitude), longitude: decimalNumber(routePlan.depotLongitude) },
    driver: null,
    driverId: routePlan.driverId,
    id: routePlan.id,
    missingCoordinates: 0,
    name: routePlan.name,
    planDate: formatDateOnly(routePlan.planDate) ?? '',
    routeEndMode: 'END_AT_LAST_STOP' as const,
    status: routePlan.status,
    stopsCount: routePlan.routeStops.length,
    updatedAt: routePlan.updatedAt.toISOString()
  };
}

function deriveGroupingDisplayStatus(group: LoadedGrouping, unresolvedOrders: number, currentChildren: LoadedChild[]): RouteGroupingDisplayStatus {
  if (group.status === 'CANCELLED') return 'CANCELLED';
  if (unresolvedOrders > 0) return 'NEEDS_ASSIGNMENT';
  if (currentChildren.length === 0) return 'DRAFT';
  if (currentChildren.some((child) => deriveChildDisplayStatus(child) === 'NEEDS_REPUBLISH')) return 'CHANGED';
  if (currentChildren.every((child) => deriveChildDisplayStatus(child) === 'PUBLISHED')) return 'PUBLISHED';
  return 'READY';
}

function deriveChildDisplayStatus(child: LoadedChild): RouteGroupingChildDisplayStatus {
  if (child.status !== 'CURRENT') return 'SUPERSEDED';
  if (child.routePlan?.status === 'ASSIGNED' && child.notificationStatus === 'SENT') return 'PUBLISHED';
  if (child.routePlan?.status === 'ASSIGNED' && child.notificationStatus !== 'SENT') return 'NEEDS_REPUBLISH';
  return 'DRAFT';
}

function normalizeNotificationStatus(status: string): RouteGroupingNotificationStatus {
  if (status === 'SENT' || status === 'FAILED' || status === 'PENDING') return status;
  return 'NOT_REQUIRED';
}

function deriveWarnings(group: LoadedGrouping): RouteGroupingWarningDto[] {
  const customerOrderIds = group.orders
    .filter((order) => order.order.customerRouteNotifications.some((fact) => fact.status === 'QUEUED' || fact.status === 'SENT'))
    .map((order) => order.orderId);
  const currentChildren = group.childVersions.filter((child) => child.status === 'CURRENT');
  const warnings: RouteGroupingWarningDto[] = [];
  const assignedRoutePlanIds = currentChildren.filter((child) => child.routePlan?.driverId !== null).map((child) => child.routePlanId).filter((id): id is string => id !== null);
  if (assignedRoutePlanIds.length > 0) warnings.push({ code: 'DRIVER_ASSIGNED', message: 'One or more child routes already have assigned drivers.', routePlanIds: assignedRoutePlanIds });
  const notifiedRoutePlanIds = currentChildren.flatMap((child) => child.notificationAttempts.filter((attempt) => attempt.status === 'SENT').map((attempt) => attempt.routePlanId));
  if (notifiedRoutePlanIds.length > 0) warnings.push({ code: 'DRIVER_NOTIFICATION_SENT', message: 'A driver route notification has already been sent.', routePlanIds: [...new Set(notifiedRoutePlanIds)] });
  if (customerOrderIds.length > 0) warnings.push({ code: 'CUSTOMER_NOTIFICATION_SENT_OR_QUEUED', message: 'A persisted customer notification or reminder exists for affected orders.', orderIds: [...new Set(customerOrderIds)] });
  return warnings;
}

function normalizeIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))];
}

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase();
}

function parsePlanDate(value: string): Date {
  const normalized = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : '';
  if (normalized === '') throw new RouteGroupingValidationError(['plan date must be YYYY-MM-DD']);
  return new Date(`${normalized}T00:00:00.000Z`);
}

function formatDateOnly(value: Date | null): string | null {
  if (value === null) return null;
  return value.toISOString().slice(0, 10);
}

function decimalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decimalString(value: number): string {
  return value.toFixed(7);
}

function distanceBetweenCoordinatesMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number }
): number {
  const earthRadiusMeters = 6_371_000;
  const leftLat = toRadians(left.latitude);
  const rightLat = toRadians(right.latitude);
  const deltaLat = toRadians(right.latitude - left.latitude);
  const deltaLng = toRadians(right.longitude - left.longitude);
  const haversine = Math.sin(deltaLat / 2) ** 2 + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function toRadians(value: number): number {
  return value * Math.PI / 180;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  return 'unknown error';
}

function readDepotFromShop(group: LoadedGrouping): DepotCoordinates | null {
  const latitude = decimalNumber(group.shop.defaultDepotLatitude);
  const longitude = decimalNumber(group.shop.defaultDepotLongitude);
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  return {
    address: typeof group.shop.defaultDepotAddress === 'string' ? group.shop.defaultDepotAddress : null,
    latitude,
    longitude
  };
}

function isValidLatitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

function isPickupService(value: string | null): boolean {
  return value?.toLowerCase().includes('pickup') ?? false;
}
