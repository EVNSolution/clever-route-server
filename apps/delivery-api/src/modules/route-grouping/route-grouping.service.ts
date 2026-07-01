import type { Prisma, PrismaClient } from '@prisma/client';
import { classifyCoordinateInPolygons, coordinatesFromGeoJsonPolygon } from './route-grouping.geometry.js';
import type { DriverPushProvider } from './driver-push.provider.js';
import type {
  RouteOptimizationOutcome,
  RouteOptimizationService,
  RouteOptimizationStopSequence
} from '../route-plans/route-optimization.types.js';
import { applyCachedRouteGeometry, computeRouteShapeSignature, routeGeometryCacheCreateData } from '../route-plans/route-plan-geometry-cache.js';
import type { RouteGeometryCacheRead } from '../route-plans/route-plan-geometry-cache.js';
import type { RouteGeometryProvider } from '../route-plans/route-plan.service.js';
import type { RoutePlanDetail, RoutePlanRouteMetrics, RoutePlanRouteResult } from '../route-plans/route-plan.types.js';
import { aggregateOrderItems, toOrderItemDto } from '../order-items/order-items.js';
import {
  RouteGroupingBranchLockConflictError,
  RouteGroupingConflictError,
  RouteGroupingRiskConfirmationRequiredError,
  RouteGroupingUnresolvedAssignmentsError,
  RouteGroupingValidationError,
  type CreateRouteGroupingBranchInput,
  type CreateRouteGroupingInput,
  type DeleteRouteGroupingResult,
  type GenerateChildRoutesInput,
  type ResolveRouteGroupingAssignmentsInput,
  type RollbackRouteGroupingInput,
  type RouteGroupingAssignmentDto,
  type RouteGroupingBranchDto,
  type RouteGroupingChildDisplayStatus,
  type RouteGroupingChildDto,
  type RouteGroupingDetailDto,
  type RouteGroupingDraftRouteInput,
  type RouteGroupingDisplayStatus,
  type RouteGroupingOptimizationPreviewInput,
  type RouteGroupingOptimizationPreviewResult,
  type RouteGroupingNotificationStatus,
  type RouteGroupingPolygonDto,
  type RouteGroupingService,
  type RouteGroupingSummaryDto,
  type RouteGroupingWarningDto,
  type SaveRouteGroupingDraftInput,
  type SaveRouteGroupingPolygonsInput,
  type UpdateRouteGroupingBranchInput,
  type UpdateRouteGroupingBranchOrdersInput,
  type UpdateRouteGroupingOrdersInput
} from './route-grouping.types.js';
import { hashPushToken } from './driver-push-token.service.js';
import { createRouteGroupingInventory, syncRouteGroupingInventoryOrders } from '../inventory/inventory.service.js';
import { appScopedShopWhere, normalizeShopifyAppId } from '../shopify/shopify-app-scope.js';

const OPTIMIZER_VERSION = 'route-grouping-projection-v1';
const DEFAULT_ROUTE_GROUPING_ROUTE_END_MODE = 'RETURN_TO_DEPOT' as const;
const ROUTE_GROUPING_GEOMETRY_REFRESH_CONCURRENCY = 2;
const ROUTE_GROUPING_DRAFT_SAVE_ACTOR = 'route-detail-draft-save';
const ROUTE_GROUPING_INVENTORY_ACTOR = 'route-grouping-membership';
export const DEFAULT_MAX_CHILD_ROUTE_STOP_DISTANCE_FROM_DEPOT_METERS = 500_000;

const ROUTE_GROUPING_POLYGON_COLORS = [
  '#2563eb',
  '#16a34a',
  '#ea580c',
  '#9333ea',
  '#dc2626',
  '#0891b2',
  '#ca8a04',
  '#be185d'
] as const;

function routeGroupingPolygonColor(index: number): string {
  return ROUTE_GROUPING_POLYGON_COLORS[index % ROUTE_GROUPING_POLYGON_COLORS.length] ?? ROUTE_GROUPING_POLYGON_COLORS[0];
}

type RouteGroupingPrismaClient = Pick<
  PrismaClient,
  | '$transaction'
  | 'customerRouteNotificationFact'
  | 'driverEvent'
  | 'driverProofMedia'
  | 'driverPushToken'
  | 'driverRouteFeedback'
  | 'driverRouteNotificationAttempt'
  | 'inventory'
  | 'inventoryEvent'
  | 'inventoryOrder'
  | 'order'
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
type LoadedBranch = LoadedGrouping['branches'][number];
type GroupingForUpdate = { dateRangeEnd: Date | null; dateRangeStart: Date | null; id: string; name: string; planDate: Date; shopId: string; updatedAt: Date };
type RouteGeometryCacheSummaryRecord = {
  generatedAt: Date;
  geometry: unknown;
  metrics: unknown;
  provider: string;
  providerVersion: string | null;
  shapeSignature: string;
  source: string;
  stopPoints: unknown;
};

type OptimizedDraftRoute = {
  assignments: LoadedAssignment[];
  routeResult: RoutePlanRouteResult;
  shapeSignature: string;
};

type ChildSnapshot = {
  color?: string | null;
  driverId: string | null;
  groupingId: string;
  groupingVersion: number;
  name: string;
  planDate: string;
  routeIdx?: number;
  sortOrder?: number;
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
  color?: string | null;
  depot: DepotCoordinates;
  driverId: string | null;
  name: string;
  routeIdx?: number;
  routeResult: RoutePlanRouteResult;
  shapeSignature: string;
};

type ReOptimizedCurrentRouteCandidate = OptimizedChildRouteCandidate & {
  childId: string | null;
  routePlanId: string | null;
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

  async createBranch(input: CreateRouteGroupingBranchInput): Promise<RouteGroupingDetailDto | null> {
    const orderIds = normalizeIds(input.orderIds ?? []);
    const groupingId = await this.prisma.$transaction(async (tx) => {
      const group = await findGroupingForUpdate(tx, input);
      if (group === null) return null;
      const driverId = await readBranchDriverId(tx, group.shopId, input.driverId);
      const sortOrder = input.sortOrder ?? (await nextBranchSortOrder(tx, group.id));
      const branch = await tx.routeGroupingBranch.create({
        data: {
          color: normalizeOptionalText(input.color),
          createdBy: input.actor,
          driverId,
          groupingId: group.id,
          label: normalizeOptionalText(input.label),
          shopId: group.shopId,
          sortOrder
        },
        select: { id: true }
      });
      if (orderIds.length > 0) await claimBranchOrders(tx, group, branch.id, orderIds);
      await tx.routeGrouping.update({ data: { status: 'DRAFT' }, where: { id: group.id } });
      return group.id;
    }).catch((error: unknown) => {
      if (isUniqueConstraintError(error)) throw new RouteGroupingBranchLockConflictError(orderIds);
      throw error;
    });
    if (groupingId === null) return null;
    return this.getGrouping({ appId: input.appId, groupingId, shopDomain: input.shopDomain });
  }

  async createGrouping(input: CreateRouteGroupingInput): Promise<RouteGroupingDetailDto> {
    const orderIds = normalizeIds(input.orderIds);
    const dateRange = readGroupingDateRange(input);
    if (orderIds.length === 0) throw new RouteGroupingValidationError(['select at least one order']);

    const groupingId = await this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }) });
      if (shop === null) throw new RouteGroupingValidationError(['shop not found']);
      if (hasValidDepotCoordinates(input.depot)) {
        await tx.shop.update({
          data: {
            defaultDepotAddress: input.depot.address,
            defaultDepotLatitude: decimalString(input.depot.latitude),
            defaultDepotLongitude: decimalString(input.depot.longitude)
          },
          where: { id: shop.id }
        });
      }
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
      const blockers = validateCreateFacts({ dateRange, facts, orderIds });
      if (blockers.length > 0) throw new RouteGroupingValidationError(blockers);
      const orderedFacts = orderIds.map((orderId) => facts.find((fact) => fact.orderId === orderId)).filter((fact): fact is typeof facts[number] => fact !== undefined);
      const grouping = await tx.routeGrouping.create({
        data: {
          createdBy: input.createdBy,
          dateRangeEnd: dateRange.end,
          dateRangeStart: dateRange.start,
          deliverySession: sharedFactValue(orderedFacts, 'deliverySession'),
          name: input.name,
          planDate: dateRange.planDate,
          routeScopeKey: sharedFactValue(orderedFacts, 'routeScopeKey'),
          serviceType: sharedFactValue(orderedFacts, 'serviceType'),
          shopId: shop.id,
          status: 'DRAFT'
        },
        select: { id: true }
      });
      const version = await tx.routeGroupingVersion.create({
        data: { actor: input.createdBy, groupingId: grouping.id, shopId: shop.id, status: 'CURRENT', version: 1 },
        select: { id: true }
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
      const loaded = await tx.routeGrouping.findUnique({ include: groupingInclude(), where: { id: grouping.id } });
      if (loaded === null) throw new RouteGroupingValidationError(['created grouping not found']);
      const routeIdx = await nextGlobalRouteIdx(tx, shop.id);
      await createDraftChildRoutePlan(tx, loaded, {
        assignments: loaded.orders,
        color: null,
        groupingVersionId: version.id,
        name: `#${routeIdx}`,
        optimized: null,
        routeIdx,
        sortOrder: routeIdx
      });
      await createRouteGroupingInventory(tx, {
        actor: input.createdBy,
        groupingId: grouping.id,
        name: input.name,
        orderIds,
        shopId: shop.id
      });
      return grouping.id;
    });
    const detail = await this.getGrouping({ appId: input.appId, groupingId, shopDomain: input.shopDomain });
    if (detail === null) throw new RouteGroupingValidationError(['created grouping not found']);
    return detail;
  }

  async getGrouping(input: { appId?: string | undefined; groupingId: string; shopDomain: string }): Promise<RouteGroupingDetailDto | null> {
    const loaded = await this.loadGrouping(input);
    if (loaded === null) return null;
    return toGroupingDetailDto(loaded);
  }

  async deleteGrouping(input: { appId?: string | undefined; groupingId: string; shopDomain: string }): Promise<DeleteRouteGroupingResult> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    return this.prisma.$transaction(async (tx) => {
      const group = await tx.routeGrouping.findFirst({
        include: { childVersions: { select: { routePlanId: true } } },
        where: { id: input.groupingId, shop: { appId: normalizeShopifyAppId(input.appId), shopDomain } }
      });
      if (group === null) return { deleted: false, deletedChildRoutePlanCount: 0, groupingId: input.groupingId };

      const childRoutePlanIds = [...new Set(group.childVersions.map((child) => child.routePlanId).filter((id): id is string => id !== null))];
      if (childRoutePlanIds.length > 0) {
        await tx.routePlanStop.deleteMany({ where: { routePlanId: { in: childRoutePlanIds } } });
        await tx.routePlan.deleteMany({ where: { id: { in: childRoutePlanIds }, shopId: group.shopId } });
      }
      await tx.routeGrouping.delete({ where: { id: group.id } });
      return { deleted: true, deletedChildRoutePlanCount: childRoutePlanIds.length, groupingId: input.groupingId };
    });
  }

  async listGroupings(input: { appId?: string | undefined; dateRangeEnd?: string; dateRangeStart?: string; deliveryDate?: string; shopDomain: string }): Promise<RouteGroupingSummaryDto[]> {
    const shop = await this.prisma.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }) });
    if (shop === null) return [];
    const rangeFilter = routeGroupingRangeFilter(input);
    const groups = await this.prisma.routeGrouping.findMany({
      include: groupingInclude(),
      orderBy: { createdAt: 'desc' },
      where: { shopId: shop.id, ...rangeFilter }
    });
    return groups.map((group) => toGroupingSummaryDto(group));
  }


  async updateBranch(input: UpdateRouteGroupingBranchInput): Promise<RouteGroupingDetailDto | null> {
    const groupingId = await this.prisma.$transaction(async (tx) => {
      const group = await findGroupingForUpdate(tx, input);
      if (group === null) return null;
      const branch = await tx.routeGroupingBranch.findFirst({
        select: { id: true },
        where: { groupingId: group.id, id: input.branchId, shopId: group.shopId }
      });
      if (branch === null) throw new RouteGroupingValidationError(['branch not found']);
      const data: Prisma.RouteGroupingBranchUpdateInput = {};
      if (input.label !== undefined) data.label = normalizeOptionalText(input.label);
      if (input.color !== undefined) data.color = normalizeOptionalText(input.color);
      if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
      if (input.driverId !== undefined) data.driver = await branchDriverRelation(tx, group.shopId, input.driverId);
      if (Object.keys(data).length === 0) return group.id;
      await tx.routeGroupingBranch.update({ data, where: { id: branch.id } });
      await tx.routeGrouping.update({ data: { status: 'DRAFT' }, where: { id: group.id } });
      return group.id;
    });
    if (groupingId === null) return null;
    return this.getGrouping({ appId: input.appId, groupingId, shopDomain: input.shopDomain });
  }

  async updateBranchOrders(input: UpdateRouteGroupingBranchOrdersInput): Promise<RouteGroupingDetailDto | null> {
    const addOrderIds = normalizeIds(input.addOrderIds ?? []);
    const removeOrderIds = normalizeIds(input.removeOrderIds ?? []);
    if (addOrderIds.length === 0 && removeOrderIds.length === 0) {
      return this.getGrouping({ appId: input.appId, groupingId: input.groupingId, shopDomain: input.shopDomain });
    }

    const groupingId = await this.prisma.$transaction(async (tx) => {
      const group = await findGroupingForUpdate(tx, input);
      if (group === null) return null;
      const branch = await tx.routeGroupingBranch.findFirst({
        select: { id: true },
        where: { groupingId: group.id, id: input.branchId, shopId: group.shopId }
      });
      if (branch === null) throw new RouteGroupingValidationError(['branch not found']);
      if (removeOrderIds.length > 0) await deleteBranchOrderLocks(tx, group, branch.id, removeOrderIds);
      if (addOrderIds.length > 0) await claimBranchOrders(tx, group, branch.id, addOrderIds);
      await tx.routeGrouping.update({ data: { status: 'DRAFT' }, where: { id: group.id } });
      return group.id;
    }).catch((error: unknown) => {
      if (isUniqueConstraintError(error)) throw new RouteGroupingBranchLockConflictError(addOrderIds);
      throw error;
    });
    if (groupingId === null) return null;
    return this.getGrouping({ appId: input.appId, groupingId, shopDomain: input.shopDomain });
  }

  async updateGroupingOrders(input: UpdateRouteGroupingOrdersInput): Promise<RouteGroupingDetailDto | null> {
    const addOrderIds = normalizeIds(input.addOrderIds ?? []);
    const removeOrderIds = normalizeIds(input.removeOrderIds ?? []);
    if (addOrderIds.length === 0 && removeOrderIds.length === 0) {
      return this.getGrouping({ appId: input.appId, groupingId: input.groupingId, shopDomain: input.shopDomain });
    }

    const groupingId = await this.prisma.$transaction(async (tx) => {
      const group = await findGroupingForUpdate(tx, input);
      if (group === null) return null;
      if (input.expectedUpdatedAt !== undefined) {
        const guarded = await tx.routeGrouping.updateMany({
          data: { status: 'DRAFT' },
          where: { id: group.id, shopId: group.shopId, updatedAt: parseExpectedUpdatedAt(input.expectedUpdatedAt) }
        });
        if (guarded.count !== 1) throw new RouteGroupingConflictError();
      } else {
        await tx.routeGrouping.update({ data: { status: 'DRAFT' }, where: { id: group.id } });
      }

      if (removeOrderIds.length > 0) {
        await deleteBranchOrderLocks(tx, group, undefined, removeOrderIds);
        await tx.routeGroupingOrder.deleteMany({ where: { groupingId: group.id, orderId: { in: removeOrderIds } } });
      }

      const existingOrderIds = new Set(
        (await tx.routeGroupingOrder.findMany({ select: { orderId: true }, where: { groupingId: group.id } }))
          .map((row) => row.orderId)
      );
      const newOrderIds = addOrderIds.filter((orderId) => !existingOrderIds.has(orderId));
      if (newOrderIds.length > 0) {
        const facts = await tx.orderDeliveryFact.findMany({
          include: {
            order: {
              include: {
                deliveryStops: { include: { routePlanStops: { select: { id: true } } }, take: 1 }
              }
            }
          },
          where: { orderId: { in: newOrderIds }, shopId: group.shopId }
        });
        const blockers = validateCreateFacts({ dateRange: loadedGroupDateRange(group), facts, orderIds: newOrderIds });
        if (blockers.length > 0) throw new RouteGroupingValidationError(blockers);
        const orderedFacts = newOrderIds.map((orderId) => facts.find((fact) => fact.orderId === orderId)).filter((fact): fact is typeof facts[number] => fact !== undefined);
        const maxSequence = await tx.routeGroupingOrder.aggregate({ _max: { sourceSequence: true }, where: { groupingId: group.id } });
        const startSequence = maxSequence._max.sourceSequence ?? 0;
        await tx.routeGroupingOrder.createMany({
          data: orderedFacts.map((fact, index) => ({
            deliveryStopId: fact.order.deliveryStops[0]?.id ?? '',
            groupingId: group.id,
            orderId: fact.orderId,
            shopId: group.shopId,
            sourceSequence: startSequence + index + 1
          }))
        });
      }

      await syncRouteGroupingInventoryOrders(tx, {
        actor: ROUTE_GROUPING_INVENTORY_ACTOR,
        addOrderIds: newOrderIds,
        groupingId: group.id,
        name: group.name,
        removeOrderIds,
        shopId: group.shopId
      });
      await recomputeAssignments(tx, group.id);
      return group.id;
    });
    if (groupingId === null) return null;
    return this.getGrouping({ appId: input.appId, groupingId, shopDomain: input.shopDomain });
  }

  async previewOptimization(input: RouteGroupingOptimizationPreviewInput): Promise<RouteGroupingOptimizationPreviewResult | null> {
    const group = await this.loadGrouping({ appId: input.appId, groupingId: input.groupingId, shopDomain: input.shopDomain });
    if (group === null) return null;
    if (this.routeOptimizationService === undefined) throw new RouteGroupingValidationError(['route optimization service is not configured']);
    if (this.routeGeometryProvider === undefined) throw new RouteGroupingValidationError(['route geometry provider is not configured']);
    const depot = readDepotFromShop(group);
    if (depot === null) throw new RouteGroupingValidationError(['default depot coordinates are required before previewing routes']);

    const routes = normalizeDraftRoutes(input.routes);
    const assignmentByOrderId = new Map(group.orders.map((assignment) => [assignment.orderId, assignment]));
    const previewRoutes: RouteGroupingOptimizationPreviewResult['preview']['routes'] = [];

    for (const route of routes) {
      const assignments = route.orderIds.map((orderId) => assignmentByOrderId.get(orderId));
      if (assignments.some((assignment) => assignment === undefined)) throw new RouteGroupingValidationError(['route preview orders must belong to the current route grouping']);
      const typedAssignments = assignments as LoadedAssignment[];
      const label = route.label ?? `#${route.routeIdx ?? route.sortOrder ?? previewRoutes.length + 1}`;
      if (typedAssignments.length === 0) {
        previewRoutes.push({ ...route, label, metrics: null, optimized: null, orderIds: [], routeGeometry: null, routeStopPoints: [] });
        continue;
      }
      validateChildRouteStopsNearDepot(typedAssignments, depot, this.maxChildRouteStopDistanceFromDepotMeters());
      const sourceDetail = buildChildRouteDetail({ assignments: typedAssignments, depot, driverId: null, group, name: label });
      const outcome = await resolveChildRouteOptimization(this.routeOptimizationService, sourceDetail, input.shopDomain);
      if (!outcome.ok) throw new RouteGroupingValidationError([`route preview optimization failed: ${outcome.failure.message}`]);
      if (outcome.result.missingCoordinateStops > 0) throw new RouteGroupingValidationError(['route preview optimization requires coordinates for every stop']);
      const orderedAssignments = orderAssignmentsByOptimizationResult(typedAssignments, outcome.result.stops);
      const optimizedDetail = buildChildRouteDetail({ assignments: orderedAssignments, depot, driverId: null, group, name: label });
      const routeResult = await buildChildRouteGeometry(this.routeGeometryProvider, optimizedDetail);
      previewRoutes.push({
        ...route,
        label,
        metrics: routeResult.routeMetrics,
        orderIds: orderedAssignments.map((assignment) => assignment.orderId),
        routeGeometry: routeResult.routeGeometry,
        routeStopPoints: routeResult.routeStopPoints
      });
    }

    return { preview: { routes: previewRoutes } };
  }

  async saveDraft(input: SaveRouteGroupingDraftInput): Promise<RouteGroupingDetailDto | null> {
    const routes = normalizeDraftRoutes(input.routes);
    const submittedOrderIds = routes.flatMap((route) => route.orderIds);
    if (routes.length === 0) throw new RouteGroupingValidationError(['route draft must include at least one route']);
    if (new Set(submittedOrderIds).size !== submittedOrderIds.length) throw new RouteGroupingValidationError(['route draft order ids must be unique']);
    assertChildOnlyDraftRouteEnvelope(routes);

    const groupingId = await this.prisma.$transaction(async (tx) => {
      const group = await findGroupingForUpdate(tx, input);
      if (group === null) return null;
      await lockRouteGroupingDraftSave(tx, group.id);
      const loaded = await tx.routeGrouping.findUnique({ include: groupingInclude(), where: { id: group.id } });
      if (loaded === null) return null;

      const existingOrders = await tx.routeGroupingOrder.findMany({
        select: { deliveryStopId: true, id: true, orderId: true },
        where: { groupingId: group.id, shopId: group.shopId }
      });
      const existingOrderIds = new Set(existingOrders.map((order) => order.orderId));
      if (existingOrders.length !== submittedOrderIds.length || submittedOrderIds.some((orderId) => !existingOrderIds.has(orderId))) {
        throw new RouteGroupingValidationError(['route draft must include every current route group order exactly once']);
      }

      const currentChildren = loaded.childVersions.filter((child) => child.status === 'CURRENT');
      const currentRoutePlanIds = currentChildren.map((child) => child.routePlanId).filter((routePlanId): routePlanId is string => routePlanId !== null);
      const submittedRoutePlanIds = routes.map((route) => route.routePlanId).filter((routePlanId): routePlanId is string => routePlanId !== null);
      if (new Set(submittedRoutePlanIds).size !== submittedRoutePlanIds.length) throw new RouteGroupingValidationError(['route draft route plan ids must be unique']);
      const submittedRoutePlanIdSet = new Set(submittedRoutePlanIds);
      if (currentRoutePlanIds.some((routePlanId) => !submittedRoutePlanIdSet.has(routePlanId))) {
        throw new RouteGroupingValidationError(['route draft must include every current child route']);
      }

      const submittedRouteIdxes = routes.map((route) => route.routeIdx).filter((routeIdx): routeIdx is number => routeIdx !== undefined);
      if (new Set(submittedRouteIdxes).size !== submittedRouteIdxes.length) throw new RouteGroupingValidationError(['route draft routeIdx values must be unique']);

      const draftOptimizations = await this.prepareDraftRouteOptimizations(input, loaded, routes);

      let sourceSequence = 1;
      for (const route of routes) {
        for (const orderId of route.orderIds) {
          await tx.routeGroupingOrder.updateMany({
            data: { sourceSequence },
            where: { groupingId: group.id, orderId, shopId: group.shopId }
          });
          sourceSequence += 1;
        }
      }

      const assignmentByOrderId = new Map(loaded.orders.map((assignment) => [assignment.orderId, assignment]));
      const currentGroupingVersion = loaded.versions.find((version) => version.status === 'CURRENT')
        ?? await createCurrentGroupingVersion(tx, loaded, { actor: ROUTE_GROUPING_DRAFT_SAVE_ACTOR, hasCurrent: false, nextVersion: loaded.currentVersion });

      for (const route of routes) {
        const targetChild = findDraftChild(loaded, route);
        const draftOptimization = draftOptimizations.get(route);
        const assignments = draftOptimization?.assignments
          ?? route.orderIds.map((orderId) => assignmentByOrderId.get(orderId)).filter((assignment): assignment is LoadedAssignment => assignment !== undefined);
        if (targetChild !== null) {
          const preservedRouteIdx = { routeIdx: readChildSnapshot(targetChild.snapshot).routeIdx };
          const savedRouteIdx = preservedRouteIdx.routeIdx;
          if (route.routeIdx !== undefined && savedRouteIdx !== undefined && route.routeIdx !== savedRouteIdx) {
            throw new RouteGroupingValidationError(['route draft routeIdx changed; reload and retry']);
          }
          const routeIdx = savedRouteIdx ?? await nextGlobalRouteIdx(tx, group.shopId);
          const previousSnapshot = readChildSnapshot(targetChild.snapshot);
          if (targetChild.routePlanId !== null) {
            await rewriteRoutePlanStops(tx, targetChild.routePlanId, assignments);
            await tx.routePlan.update({
              data: {
                ...(route.label === null ? {} : { name: route.label }),
                metrics: routeMetrics(assignments)
              },
              where: { id: targetChild.routePlanId }
            });
            if (draftOptimization !== undefined) {
              await tx.routePlanGeometryCache.deleteMany({ where: { routePlanId: targetChild.routePlanId } });
              await createDraftRouteGeometryCache(tx, targetChild.routePlanId, draftOptimization);
            }
          }
          await tx.routeGroupingChildVersion.update({
            data: {
              snapshot: createChildSnapshot(
                loaded,
                assignments,
                targetChild.driverId,
                route.label ?? childRouteSlotName(targetChild),
                loaded.currentVersion,
                route.color ?? previousSnapshot.color ?? null,
                route.sortOrder ?? previousSnapshot.sortOrder ?? routeIdx,
                routeIdx
              )
            },
            where: { id: targetChild.id }
          });
          if (route.optimized !== undefined && targetChild.routePlanId !== null) {
            logIgnoredExistingRouteOptimizedPayload(group.id, targetChild.routePlanId, route.routeKey ?? null);
          }
          continue;
        }

        if (route.routePlanId !== null) throw new RouteGroupingValidationError(['route draft route plans must belong to the current route grouping']);
        const routeIdx = await nextGlobalRouteIdx(tx, group.shopId);
        await createDraftChildRoutePlan(tx, loaded, {
          assignments,
          color: route.color,
          groupingVersionId: currentGroupingVersion.id,
          name: route.label ?? `#${routeIdx}`,
          optimized: route.optimized ?? toDraftOptimizedSnapshot(draftOptimization),
          routeIdx,
          sortOrder: route.sortOrder ?? routeIdx
        });
      }

      await recomputeAssignments(tx, group.id);
      await tx.routeGrouping.update({ data: { status: 'DRAFT' }, where: { id: group.id } });
      return group.id;
    });
    if (groupingId === null) return null;
    return this.getGrouping({ appId: input.appId, groupingId, shopDomain: input.shopDomain });
  }

  private async prepareDraftRouteOptimizations(
    input: SaveRouteGroupingDraftInput,
    group: LoadedGrouping,
    routes: RouteGroupingDraftRouteInput[]
  ): Promise<Map<RouteGroupingDraftRouteInput, OptimizedDraftRoute>> {
    const assignmentByOrderId = new Map(group.orders.map((assignment) => [assignment.orderId, assignment]));
    const routesToOptimize = routes.flatMap((route) => {
      const assignments = route.orderIds.map((orderId) => assignmentByOrderId.get(orderId));
      if (assignments.some((assignment) => assignment === undefined)) {
        throw new RouteGroupingValidationError(['route draft orders must belong to the current route grouping']);
      }
      const typedAssignments = assignments as LoadedAssignment[];
      return shouldOptimizeDraftRoute(group, route, typedAssignments)
        ? [{ assignments: typedAssignments, route }]
        : [];
    });
    if (routesToOptimize.length === 0) return new Map();
    if (this.routeOptimizationService === undefined) throw new RouteGroupingValidationError(['route optimization service is not configured']);
    if (this.routeGeometryProvider === undefined) throw new RouteGroupingValidationError(['route geometry provider is not configured']);
    const depot = readDepotFromShop(group);
    if (depot === null) throw new RouteGroupingValidationError(['default depot coordinates are required before saving route draft']);

    const optimizedRoutes = new Map<RouteGroupingDraftRouteInput, OptimizedDraftRoute>();
    for (const { assignments, route } of routesToOptimize) {
      const name = route.label ?? `#${route.routeIdx ?? route.sortOrder ?? optimizedRoutes.size + 1}`;
      validateChildRouteStopsNearDepot(assignments, depot, this.maxChildRouteStopDistanceFromDepotMeters());
      const sourceDetail = buildChildRouteDetail({ assignments, depot, driverId: null, group, name });
      const outcome = await resolveChildRouteOptimization(this.routeOptimizationService, sourceDetail, input.shopDomain);
      if (!outcome.ok) throw new RouteGroupingValidationError([`route draft optimization failed: ${outcome.failure.message}`]);
      if (outcome.result.missingCoordinateStops > 0) throw new RouteGroupingValidationError(['route draft optimization requires coordinates for every stop']);
      const orderedAssignments = orderAssignmentsByOptimizationResult(assignments, outcome.result.stops);
      const optimizedDetail = buildChildRouteDetail({ assignments: orderedAssignments, depot, driverId: null, group, name });
      const routeResult = await buildChildRouteGeometry(this.routeGeometryProvider, optimizedDetail);
      if (routeResult.routeGeometry === null) throw new RouteGroupingValidationError(['route draft geometry could not be generated']);
      optimizedRoutes.set(route, {
        assignments: orderedAssignments,
        routeResult,
        shapeSignature: computeRouteShapeSignature(optimizedDetail)
      });
    }
    return optimizedRoutes;
  }

  async savePolygons(input: SaveRouteGroupingPolygonsInput): Promise<RouteGroupingDetailDto | null> {
    assertUniquePolygonDrivers(input.polygons);
    const groupingId = await this.prisma.$transaction(async (tx) => {
      const group = await findGroupingForUpdate(tx, input);
      if (group === null) return null;
      const expectedUpdatedAt = parseExpectedUpdatedAt(input.expectedUpdatedAt);
      const guarded = await tx.routeGrouping.updateMany({
        data: { status: 'DRAFT' },
        where: { id: group.id, shopId: group.shopId, updatedAt: expectedUpdatedAt }
      });
      if (guarded.count !== 1) throw new RouteGroupingConflictError();

      const existingPolygons = await tx.routeGroupingPolygon.findMany({ orderBy: { drawOrder: 'asc' }, where: { groupingId: group.id } });
      const existingIds = new Set(existingPolygons.map((polygon) => polygon.id));
      const deleteIds = normalizeIds(input.deletePolygonIds ?? []);
      const deleteIdSet = new Set(deleteIds);
      const incomingIds = input.polygons.map((polygon) => polygon.id?.trim()).filter((id): id is string => id !== undefined && id !== null && id !== '');
      const incomingIdSet = new Set(incomingIds);

      if (incomingIdSet.size !== incomingIds.length) throw new RouteGroupingValidationError(['polygon ids must be unique']);
      for (const polygonId of deleteIds) {
        if (!existingIds.has(polygonId)) throw new RouteGroupingValidationError(['delete polygon ids must belong to the current route grouping']);
        if (incomingIdSet.has(polygonId)) throw new RouteGroupingValidationError(['deleted polygon ids cannot also be saved']);
      }
      for (const polygonId of incomingIds) {
        if (!existingIds.has(polygonId)) throw new RouteGroupingValidationError(['polygon ids must belong to the current route grouping']);
      }
      if (existingIds.size > 0) {
        const omittedIds = [...existingIds].filter((polygonId) => !incomingIdSet.has(polygonId) && !deleteIdSet.has(polygonId));
        if (omittedIds.length > 0) throw new RouteGroupingValidationError(['existing polygons cannot be omitted without explicit deletion']);
      }

      if (deleteIds.length > 0) await tx.routeGroupingPolygon.deleteMany({ where: { id: { in: deleteIds }, groupingId: group.id } });

      for (let index = 0; index < input.polygons.length; index += 1) {
        const polygon = input.polygons[index];
        if (polygon === undefined) continue;
        const polygonId = polygon.id?.trim();
        const data = {
          closed: polygon.closed,
          color: polygon.color ?? routeGroupingPolygonColor(index),
          drawOrder: index + 1,
          driverId: polygon.driverId ?? null,
          geometryJson: polygon.geometry as Prisma.InputJsonValue,
          label: polygon.label
        };
        if (polygonId !== undefined && polygonId !== '') {
          await tx.routeGroupingPolygon.update({ data, where: { id: polygonId } });
          continue;
        }
        await tx.routeGroupingPolygon.create({
          data: {
            ...data,
            groupingId: group.id,
            shopId: group.shopId
          }
        });
      }

      await recomputeAssignments(tx, group.id);
      return group.id;
    });
    if (groupingId === null) return null;
    return this.getGrouping({ appId: input.appId, groupingId, shopDomain: input.shopDomain });
  }

  async resolveAssignments(input: ResolveRouteGroupingAssignmentsInput): Promise<RouteGroupingDetailDto | null> {
    const groupingId = await this.prisma.$transaction(async (tx) => {
      const group = await findGroupingForUpdate(tx, input);
      if (group === null) return null;
      for (const assignment of input.assignments) {
        const driver = await tx.driver.findFirst({ select: { id: true }, where: { id: assignment.assignedDriverId, shopId: group.shopId } });
        if (driver === null) throw new RouteGroupingValidationError(['driver must belong to the current shop']);
        await tx.routeGroupingOrder.updateMany({
          data: { assignedDriverId: assignment.assignedDriverId, assignedPolygonId: null, assignmentStatus: 'ASSIGNED' },
          where: { groupingId: group.id, orderId: assignment.orderId }
        });
      }
      await tx.routeGrouping.update({ data: { status: 'DRAFT' }, where: { id: group.id } });
      return group.id;
    });
    if (groupingId === null) return null;
    return this.getGrouping({ appId: input.appId, groupingId, shopDomain: input.shopDomain });
  }

  async generateChildRoutes(input: GenerateChildRoutesInput): Promise<RouteGroupingDetailDto | null> {
    const initial = await this.loadGrouping({ appId: input.appId, groupingId: input.groupingId, shopDomain: input.shopDomain });
    if (initial === null) return null;
    validateReadyForChildGeneration(initial, input.confirmRisk);
    const candidates = await this.prepareOptimizedChildRouteCandidates(initial, input.shopDomain);
    if (candidates.length < 2) {
      return this.getGrouping({ appId: input.appId, groupingId: input.groupingId, shopDomain: input.shopDomain });
    }
    const expectedSnapshot = childGenerationSnapshotSignature(initial);

    const projection = await this.prisma.$transaction(async (tx): Promise<ChildRouteProjectionResult | null> => {
      const group = await findGroupingForUpdate(tx, input);
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
        const routeIdx = await nextGlobalRouteIdx(tx, loaded.shopId);
        const numberedCandidate = { ...candidate, name: `#${routeIdx}`, routeIdx };
        const routePlan = await createChildRoutePlan(tx, loaded, numberedCandidate, input.actor);
        childRoutePlanIds.push(routePlan.id);
        await createChildRouteGeometryCache(tx, routePlan.id, numberedCandidate);
        await tx.routeGroupingChildVersion.create({
          data: {
            driverId: numberedCandidate.driverId,
            groupingId: loaded.id,
            groupingVersionId: version.id,
            notificationStatus: 'SKIPPED',
            routePlanId: routePlan.id,
            shopId: loaded.shopId,
            snapshot: createChildSnapshot(loaded, numberedCandidate.assignments, numberedCandidate.driverId, routePlan.name, nextVersion, numberedCandidate.color, routeIdx, routeIdx),
            status: 'CURRENT',
            version: nextVersion
          }
        });
      }
      await tx.routeGrouping.update({ data: { currentVersion: nextVersion, status: 'DRAFT' }, where: { id: loaded.id } });
      return { childRoutePlanIds, groupingId: loaded.id };
    });
    if (projection === null) return null;
    return this.getGrouping({ appId: input.appId, groupingId: projection.groupingId, shopDomain: input.shopDomain });
  }

  async reOptimizeRoutes(input: GenerateChildRoutesInput): Promise<RouteGroupingDetailDto | null> {
    const initial = await this.loadGrouping({ appId: input.appId, groupingId: input.groupingId, shopDomain: input.shopDomain });
    if (initial === null) return null;

    const currentChildren = initial.childVersions.filter((child) => child.status === 'CURRENT' && child.routePlanId !== null);
    if (currentChildren.length === 0) {
      return this.getGrouping({ appId: input.appId, groupingId: input.groupingId, shopDomain: input.shopDomain });
    }
    if (this.routeOptimizationService === undefined) {
      throw new RouteGroupingValidationError(['route optimization service is not configured']);
    }
    if (this.routeGeometryProvider === undefined) {
      throw new RouteGroupingValidationError(['route geometry provider is not configured']);
    }
    const depot = readDepotFromShop(initial);
    if (depot === null) {
      throw new RouteGroupingValidationError(['default depot coordinates are required before re-optimizing routes']);
    }

    const expectedSnapshot = childGenerationSnapshotSignature(initial);
    const routeAssignmentGroups = currentChildren.map((child) => ({ assignments: currentChildAssignments(initial, child), color: readChildSnapshot(child.snapshot).color ?? null, driverId: child.driverId, name: childRouteSlotName(child) }));
    const candidates: ReOptimizedCurrentRouteCandidate[] = [];
    const routeSlotCount = Math.max(routeAssignmentGroups.length, currentChildren.length);
    for (let index = 0; index < routeSlotCount; index += 1) {
      const assignmentGroup = routeAssignmentGroups[index];
      const child = currentChildren[index];
      const fallbackName = child?.routePlan?.name ?? (child ? readChildSnapshot(child.snapshot).name : `#${index + 1}`);
      const effectiveGroup = assignmentGroup ?? { assignments: [], color: child ? readChildSnapshot(child.snapshot).color ?? null : null, driverId: child?.driverId ?? null, name: fallbackName };
      const assignments = effectiveGroup.assignments;
      const name = effectiveGroup.name || fallbackName;
      const driverId = effectiveGroup.driverId;
      const routePlanId = child?.routePlanId ?? null;
      const childId = child?.id ?? null;
      const sourceDetail = buildChildRouteDetail({ assignments, depot, driverId, group: initial, name });
      if (assignments.length === 0) {
        candidates.push({
          assignments,
          childId,
          depot,
          color: effectiveGroup.color ?? null,
          driverId,
          name,
          routePlanId,
          routeResult: { routeGeometry: null, routeMetrics: null, routeStopPoints: [] },
          shapeSignature: computeRouteShapeSignature(sourceDetail)
        });
        continue;
      }
      validateChildRouteStopsNearDepot(assignments, depot, this.maxChildRouteStopDistanceFromDepotMeters());
      const outcome = await resolveChildRouteOptimization(this.routeOptimizationService, sourceDetail, input.shopDomain);
      if (!outcome.ok) {
        throw new RouteGroupingValidationError([`route re-optimization failed: ${outcome.failure.message}`]);
      }
      if (outcome.result.missingCoordinateStops > 0) {
        throw new RouteGroupingValidationError(['route re-optimization requires coordinates for every stop']);
      }
      const orderedAssignments = orderAssignmentsByOptimizationResult(assignments, outcome.result.stops);
      const optimizedDetail = buildChildRouteDetail({ assignments: orderedAssignments, depot, driverId, group: initial, name });
      const routeResult = await buildChildRouteGeometry(this.routeGeometryProvider, optimizedDetail);
      if (routeResult.routeGeometry === null) {
        throw new RouteGroupingValidationError(['route geometry could not be generated']);
      }
      candidates.push({
        assignments: orderedAssignments,
        childId,
        depot,
        color: effectiveGroup.color ?? null,
        driverId,
        name,
        routePlanId,
        routeResult,
        shapeSignature: computeRouteShapeSignature(optimizedDetail)
      });
    }

    const groupingId = await this.prisma.$transaction(async (tx): Promise<string | null> => {
      const group = await findGroupingForUpdate(tx, input);
      if (group === null) return null;
      const loaded = await tx.routeGrouping.findUnique({ include: groupingInclude(), where: { id: group.id } });
      if (loaded === null) return null;
      if (childGenerationSnapshotSignature(loaded) !== expectedSnapshot) {
        throw new RouteGroupingValidationError(['route grouping changed; reload and retry re-optimization']);
      }
      const currentVersion = loaded.versions.find((version) => version.status === 'CURRENT')
        ?? await createCurrentGroupingVersion(tx, loaded, { actor: input.actor, hasCurrent: false, nextVersion: loaded.currentVersion });
      for (const candidate of candidates) {
        if (candidate.routePlanId !== null && candidate.childId !== null) {
          const existingChildSnapshot = readChildSnapshot(loaded.childVersions.find((child) => child.id === candidate.childId)?.snapshot ?? {});
          const existingChildColor = existingChildSnapshot.color ?? null;
          const existingRouteIdx = existingChildSnapshot.routeIdx ?? await nextGlobalRouteIdx(tx, loaded.shopId);
          await rewriteRoutePlanStops(tx, candidate.routePlanId, candidate.assignments);
          await tx.routePlan.update({
            data: {
              constraints: routeConstraints(loaded, candidate.depot),
              driverId: candidate.driverId,
              metrics: routeMetrics(candidate.assignments),
              name: candidate.name,
              optimizerVersion: OPTIMIZER_VERSION
            },
            where: { id: candidate.routePlanId }
          });
          await tx.routePlanGeometryCache.deleteMany({ where: { routePlanId: candidate.routePlanId } });
          await createChildRouteGeometryCache(tx, candidate.routePlanId, candidate);
          await tx.routeGroupingChildVersion.update({
            data: {
              driverId: candidate.driverId,
              snapshot: createChildSnapshot(loaded, candidate.assignments, candidate.driverId, candidate.name, loaded.currentVersion, candidate.color ?? existingChildColor, existingChildSnapshot.sortOrder ?? existingRouteIdx, existingRouteIdx)
            },
            where: { id: candidate.childId }
          });
          continue;
        }

        const routeIdx = await nextGlobalRouteIdx(tx, loaded.shopId);
        const numberedCandidate = { ...candidate, name: `#${routeIdx}`, routeIdx };
        const routePlan = await createChildRoutePlan(tx, loaded, numberedCandidate, input.actor);
        await createChildRouteGeometryCache(tx, routePlan.id, numberedCandidate);
        await tx.routeGroupingChildVersion.create({
          data: {
            driverId: numberedCandidate.driverId,
            groupingId: loaded.id,
            groupingVersionId: currentVersion.id,
            notificationStatus: 'SKIPPED',
            routePlanId: routePlan.id,
            shopId: loaded.shopId,
            snapshot: createChildSnapshot(loaded, numberedCandidate.assignments, numberedCandidate.driverId, routePlan.name, loaded.currentVersion, numberedCandidate.color, routeIdx, routeIdx),
            status: 'CURRENT',
            version: loaded.currentVersion
          }
        });
      }
      await tx.routeGrouping.update({ data: { status: 'DRAFT' }, where: { id: loaded.id } });
      return loaded.id;
    });
    if (groupingId === null) return null;
    return this.getGrouping({ appId: input.appId, groupingId, shopDomain: input.shopDomain });
  }

  async deleteBranch(input: { appId?: string | undefined; branchId: string; groupingId: string; shopDomain: string }): Promise<RouteGroupingDetailDto | null> {
    const groupingId = await this.prisma.$transaction(async (tx) => {
      const group = await findGroupingForUpdate(tx, input);
      if (group === null) return null;
      const branch = await tx.routeGroupingBranch.findFirst({
        select: { id: true },
        where: { groupingId: group.id, id: input.branchId, shopId: group.shopId }
      });
      if (branch === null) return group.id;
      await tx.routeGroupingBranch.delete({ where: { id: branch.id } });
      await tx.routeGrouping.update({ data: { status: 'DRAFT' }, where: { id: group.id } });
      return group.id;
    });
    if (groupingId === null) return null;
    return this.getGrouping({ appId: input.appId, groupingId, shopDomain: input.shopDomain });
  }

  async rollback(input: RollbackRouteGroupingInput): Promise<RouteGroupingDetailDto | null> {
    const projection = await this.prisma.$transaction(async (tx): Promise<ChildRouteProjectionResult | null> => {
      const group = await findGroupingForUpdate(tx, input);
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
        const routePlan = await createChildRoutePlanFromSnapshot(tx, loaded, snapshot, input.actor);
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
      await tx.routeGrouping.update({ data: { currentVersion: nextVersion, status: 'DRAFT' }, where: { id: loaded.id } });
      return { childRoutePlanIds, groupingId: loaded.id };
    });
    if (projection === null) return null;
    await this.refreshChildRouteGeometry(projection.childRoutePlanIds, input.shopDomain);
    return this.getGrouping({ appId: input.appId, groupingId: projection.groupingId, shopDomain: input.shopDomain });
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
    const publishedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.routeGroupingChildVersion.update({ data: { publishedAt }, where: { id: child.id } }),
      this.prisma.routeGrouping.updateMany({ data: { status: 'PUBLISHED' }, where: { id: child.groupingId, status: { not: 'CANCELLED' } } })
    ]);
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

  private async loadGrouping(input: { appId?: string | undefined; groupingId: string; shopDomain: string }): Promise<LoadedGrouping | null> {
    const shop = await this.prisma.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }) });
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
    const routeAssignmentGroups = [...groupAssignmentsByDriver(group.orders)]
      .map(([driverId, assignments], index) => ({ assignments, color: null, driverId, name: `#${index + 1}` }))
      .filter((route) => route.assignments.length > 0);
    if (routeAssignmentGroups.length < 2) return [];
    for (const { assignments, color, driverId, name } of routeAssignmentGroups) {
      if (assignments.length === 0) continue;
      validateChildRouteStopsNearDepot(assignments, depot, this.maxChildRouteStopDistanceFromDepotMeters());
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
        color,
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


function normalizeDraftRoutes(routes: RouteGroupingDraftRouteInput[]): RouteGroupingDraftRouteInput[] {
  return routes.map((route, index) => {
    const branchId = route.branchId === null ? null : route.branchId?.trim() ?? null;
    const routePlanId = normalizeOptionalText(route.routePlanId);
    const tempId = normalizeOptionalText(route.tempId);
    const routeIdx = typeof route.routeIdx === 'number' && Number.isInteger(route.routeIdx) ? route.routeIdx : undefined;
    return {
      branchId,
      color: normalizeOptionalText(route.color),
      label: normalizeOptionalText(route.label),
      ...(route.optimized === undefined ? {} : { optimized: route.optimized ?? null }),
      orderIds: normalizeIds(route.orderIds),
      ...(routeIdx === undefined ? {} : { routeIdx }),
      routeKey: normalizeOptionalText(route.routeKey) ?? (routePlanId !== null ? `routePlan:${routePlanId}` : tempId !== null ? `temp:${tempId}` : routeIdx !== undefined ? `routeIdx:${routeIdx}` : `draft:${index + 1}`),
      routePlanId,
      sortOrder: typeof route.sortOrder === 'number' && Number.isInteger(route.sortOrder) ? route.sortOrder : routeIdx ?? index + 1,
      tempId
    };
  });
}

function assertChildOnlyDraftRouteEnvelope(routes: RouteGroupingDraftRouteInput[]): void {
  const routeKeys = routes.map((route) => route.routeKey ?? '');
  if (new Set(routeKeys).size !== routeKeys.length) throw new RouteGroupingValidationError(['route draft route keys must be unique']);
  if (routes.some((route) => route.branchId !== null)) throw new RouteGroupingValidationError(['route draft must include child routes only']);
  if (routes.some((route) => route.routeKey === 'root')) throw new RouteGroupingValidationError(['route draft must not include a root route row']);
}

function findDraftChild(group: LoadedGrouping, route: RouteGroupingDraftRouteInput): LoadedChild | null {
  const routePlanId = normalizeOptionalText(route.routePlanId);
  if (routePlanId === null) return null;
  return group.childVersions
    .filter((child) => child.status === 'CURRENT')
    .find((child) => child.routePlanId === routePlanId) ?? null;
}

function routeAssignmentsChanged(child: LoadedChild, assignments: LoadedAssignment[]): boolean {
  const savedStopIds = (child.routePlan?.routeStops ?? [])
    .sort((left, right) => left.sequence - right.sequence)
    .map((stop) => stop.deliveryStopId);
  return !sameStringSequence(savedStopIds, assignments.map((assignment) => assignment.deliveryStopId));
}

function shouldOptimizeDraftRoute(group: LoadedGrouping, route: RouteGroupingDraftRouteInput, assignments: LoadedAssignment[]): boolean {
  if (assignments.length === 0) return false;
  const targetChild = findDraftChild(group, route);
  if (targetChild === null) {
    if (route.routePlanId !== null) throw new RouteGroupingValidationError(['route draft route plans must belong to the current route grouping']);
    return !hasDraftOptimizedSnapshot(route.optimized);
  }
  if (routeAssignmentsChanged(targetChild, assignments)) return true;
  if (targetChild.routePlan === null) return true;
  const depot = readDepotFromShop(group);
  if (depot === null) return true;
  const detail = buildChildRouteDetail({ assignments, depot, driverId: targetChild.driverId, group, name: targetChild.routePlan.name });
  return readExactChildRouteMetricsFromRoutePlan(targetChild.routePlan, detail) === null;
}

function hasDraftOptimizedSnapshot(optimized: RouteGroupingDraftRouteInput['optimized'] | null | undefined): boolean {
  return optimized !== undefined
    && optimized !== null
    && optimized.routeGeometry !== undefined
    && optimized.routeGeometry !== null
    && optimized.metrics !== undefined
    && optimized.metrics !== null;
}

function toDraftOptimizedSnapshot(route: OptimizedDraftRoute | undefined): RouteGroupingDraftRouteInput['optimized'] | null {
  if (route === undefined) return null;
  return {
    metrics: route.routeResult.routeMetrics,
    orderIds: route.assignments.map((assignment) => assignment.orderId),
    routeGeometry: route.routeResult.routeGeometry,
    routeStopPoints: route.routeResult.routeStopPoints
  };
}

function logIgnoredExistingRouteOptimizedPayload(groupingId: string, routePlanId: string, routeKey: string | null): void {
  console.warn('[route-grouping] ignored optimized payload for existing route during draft save', {
    groupingId,
    routeKey,
    routePlanId
  });
}

function sameStringSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function logRouteGeometryRefreshFailure(routePlanId: string, reason: unknown): void {
  console.warn('[route-grouping] child route geometry refresh failed after projection commit', {
    errorName: reason instanceof Error ? reason.name : typeof reason,
    routePlanId
  });
}

function groupingInclude() {
  return {
    branches: {
      include: {
        driver: true,
        orderLocks: {
          include: { routeGroupingOrder: { select: { sourceSequence: true } } },
          orderBy: { createdAt: 'asc' as const }
        }
      },
      orderBy: { createdAt: 'asc' as const }
    },
    childVersions: {
      include: {
        driver: true,
        notificationAttempts: true,
        routePlan: {
          include: {
            driver: true,
            routeGeometryCaches: {
              orderBy: { generatedAt: 'desc' as const },
              select: routeGeometryCacheSummarySelect()
            },
            routeStops: true
          }
        }
      },
      orderBy: [{ version: 'desc' as const }, { createdAt: 'desc' as const }]
    },
    orders: {
      include: {
        deliveryStop: { include: { order: true, routePlanStops: { select: { routePlanId: true } } } },
        assignedDriver: true,
        assignedPolygon: true,
        order: { include: { customerRouteNotifications: true, orderItems: { orderBy: { lineIndex: 'asc' as const } } } }
      },
      orderBy: { sourceSequence: 'asc' as const }
    },
    polygons: { orderBy: { drawOrder: 'asc' as const } },
    shop: true,
    versions: { orderBy: { version: 'desc' as const } }
  } satisfies Prisma.RouteGroupingInclude;
}

function routeGeometryCacheSummarySelect() {
  return {
    generatedAt: true,
    geometry: true,
    metrics: true,
    provider: true,
    providerVersion: true,
    shapeSignature: true,
    source: true,
    stopPoints: true
  } as const;
}

async function findGroupingForUpdate(
  tx: Tx,
  input: { appId?: string | undefined; groupingId: string; shopDomain: string }
): Promise<GroupingForUpdate | null> {
  const shop = await tx.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }) });
  if (shop === null) return null;
  return tx.routeGrouping.findFirst({
    select: { dateRangeEnd: true, dateRangeStart: true, id: true, name: true, planDate: true, shopId: true, updatedAt: true },
    where: { id: input.groupingId, shopId: shop.id }
  });
}

async function lockRouteGroupingDraftSave(tx: Tx, groupingId: string): Promise<void> {
  await tx.$queryRaw<{ locked: number }[]>`WITH lock AS (SELECT pg_advisory_xact_lock(hashtext(${`route-grouping-draft-save:${groupingId}`}))) SELECT 1 AS locked FROM lock`;
}

async function readBranchDriverId(tx: Tx, shopId: string, driverId: string | null | undefined): Promise<string | null> {
  if (driverId === undefined || driverId === null || driverId.trim() === '') return null;
  const driver = await tx.driver.findFirst({ select: { id: true }, where: { id: driverId.trim(), shopId } });
  if (driver === null) throw new RouteGroupingValidationError(['driver must belong to the current shop']);
  return driver.id;
}

async function branchDriverRelation(tx: Tx, shopId: string, driverId: string | null | undefined): Promise<NonNullable<Prisma.RouteGroupingBranchUpdateInput['driver']>> {
  const id = await readBranchDriverId(tx, shopId, driverId);
  return id === null ? { disconnect: true } : { connect: { id } };
}

async function nextBranchSortOrder(tx: Tx, groupingId: string): Promise<number> {
  const max = await tx.routeGroupingBranch.aggregate({ _max: { sortOrder: true }, where: { groupingId } });
  return (max._max.sortOrder ?? 0) + 1;
}

async function nextGlobalRouteIdx(tx: Tx, shopId: string): Promise<number> {
  await tx.$queryRaw<{ locked: number }[]>`WITH lock AS (SELECT pg_advisory_xact_lock(hashtext(${`route-grouping-route-idx:${shopId}`}))) SELECT 1 AS locked FROM lock`;
  const rows = await tx.routeGroupingChildVersion.findMany({
    select: { snapshot: true },
    where: { shopId }
  });
  const maxRouteIdx = rows.reduce((max, row) => {
    const snapshot = readChildSnapshot(row.snapshot);
    return Math.max(max, snapshot.routeIdx ?? 0);
  }, 0);
  return Math.max(maxRouteIdx, rows.length) + 1;
}

async function claimBranchOrders(
  tx: Tx,
  group: GroupingForUpdate,
  branchId: string,
  orderIds: string[]
): Promise<void> {
  const rows = await tx.routeGroupingOrder.findMany({
    select: { deliveryStopId: true, id: true, orderId: true },
    where: { groupingId: group.id, orderId: { in: orderIds } }
  });
  if (rows.length !== orderIds.length) throw new RouteGroupingValidationError(['branch orders must belong to the current route grouping']);

  const activeLocks = await tx.routeGroupingBranchOrderLock.findMany({
    select: { branchId: true, orderId: true },
    where: { orderId: { in: orderIds }, shopId: group.shopId }
  });
  const conflictOrderIds = activeLocks.filter((lock) => lock.branchId !== branchId).map((lock) => lock.orderId);
  if (conflictOrderIds.length > 0) throw new RouteGroupingBranchLockConflictError([...new Set(conflictOrderIds)]);

  const byOrderId = new Map(rows.map((row) => [row.orderId, row]));
  const alreadyClaimedByBranch = new Set(activeLocks.filter((lock) => lock.branchId === branchId).map((lock) => lock.orderId));
  const orderIdsToClaim = orderIds.filter((orderId) => !alreadyClaimedByBranch.has(orderId));
  if (orderIdsToClaim.length === 0) return;
  await tx.routeGroupingBranchOrderLock.createMany({
    data: orderIdsToClaim.map((orderId) => {
      const row = byOrderId.get(orderId);
      if (row === undefined) throw new RouteGroupingValidationError(['branch orders must belong to the current route grouping']);
      return {
        branchId,
        deliveryStopId: row.deliveryStopId,
        groupingId: group.id,
        orderId,
        routeGroupingOrderId: row.id,
        shopId: group.shopId
      };
    })
  });
}

async function deleteBranchOrderLocks(
  tx: Tx,
  group: GroupingForUpdate,
  branchId: string | undefined,
  orderIds: string[] | undefined
): Promise<void> {
  await tx.routeGroupingBranchOrderLock.deleteMany({
    where: {
      groupingId: group.id,
      shopId: group.shopId,
      ...(branchId === undefined ? {} : { branchId }),
      ...(orderIds === undefined ? {} : { orderId: { in: orderIds } })
    }
  });
}

type GroupingDateRange = { end: Date; endText: string; planDate: Date; start: Date; startText: string };

type DeliveryFactForGrouping = {
  deliveryDate: Date | null;
  deliverySession: string | null;
  order: { deliveryStops: Array<{ latitude: unknown; longitude: unknown; routePlanStops: Array<{ id: string }> }> };
  orderId: string;
  routeScopeKey: string | null;
  serviceType: string | null;
};

function readGroupingDateRange(input: { dateRangeEnd?: string; dateRangeStart?: string; planDate?: string }): GroupingDateRange {
  const hasRange = input.dateRangeStart !== undefined || input.dateRangeEnd !== undefined;
  if (hasRange) {
    if (input.dateRangeStart === undefined || input.dateRangeEnd === undefined) {
      throw new RouteGroupingValidationError(['date range requires start and end']);
    }
    const start = parsePlanDate(input.dateRangeStart);
    const end = parsePlanDate(input.dateRangeEnd);
    if (start.getTime() > end.getTime()) throw new RouteGroupingValidationError(['date range start must be before end']);
    return { end, endText: formatDateOnly(end) ?? '', planDate: start, start, startText: formatDateOnly(start) ?? '' };
  }
  const planDate = parsePlanDate(input.planDate ?? '');
  const planDateText = formatDateOnly(planDate) ?? '';
  return { end: planDate, endText: planDateText, planDate, start: planDate, startText: planDateText };
}

function loadedGroupDateRange(group: { dateRangeEnd: Date | null; dateRangeStart: Date | null; planDate: Date }): GroupingDateRange {
  const start = group.dateRangeStart ?? group.planDate;
  const end = group.dateRangeEnd ?? group.planDate;
  return { end, endText: formatDateOnly(end) ?? '', planDate: group.planDate, start, startText: formatDateOnly(start) ?? '' };
}

function routeGroupingRangeFilter(input: { dateRangeEnd?: string; dateRangeStart?: string; deliveryDate?: string }): Prisma.RouteGroupingWhereInput {
  if (input.deliveryDate !== undefined) {
    const deliveryDate = parsePlanDate(input.deliveryDate);
    return {
      OR: [
        { dateRangeStart: { lte: deliveryDate }, dateRangeEnd: { gte: deliveryDate } },
        { dateRangeEnd: null, dateRangeStart: null, planDate: deliveryDate }
      ]
    };
  }
  if (input.dateRangeStart !== undefined || input.dateRangeEnd !== undefined) {
    if (input.dateRangeStart === undefined || input.dateRangeEnd === undefined) {
      throw new RouteGroupingValidationError(['date range requires start and end']);
    }
    const start = parsePlanDate(input.dateRangeStart);
    const end = parsePlanDate(input.dateRangeEnd);
    if (start.getTime() > end.getTime()) throw new RouteGroupingValidationError(['date range start must be before end']);
    return {
      OR: [
        { dateRangeStart: { lte: end }, dateRangeEnd: { gte: start } },
        { dateRangeEnd: null, dateRangeStart: null, planDate: { gte: start, lte: end } }
      ]
    };
  }
  return {};
}

function sharedFactValue(facts: DeliveryFactForGrouping[], key: 'deliverySession' | 'routeScopeKey' | 'serviceType'): string | null {
  const first = facts[0]?.[key] ?? null;
  return facts.every((fact) => fact[key] === first) ? first : null;
}

function validateCreateFacts(input: { dateRange: GroupingDateRange; facts: DeliveryFactForGrouping[]; orderIds: string[] }): string[] {
  const blockers: string[] = [];
  if (input.facts.length !== input.orderIds.length) blockers.push('selected orders must have delivery facts');
  for (const orderId of input.orderIds) {
    const fact = input.facts.find((candidate) => candidate.orderId === orderId);
    if (fact === undefined) continue;
    const deliveryDate = formatDateOnly(fact.deliveryDate);
    if (deliveryDate !== null && (deliveryDate < input.dateRange.startText || deliveryDate > input.dateRange.endText)) {
      blockers.push('selected orders must fall within grouping date range');
    }
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

function groupAssignmentsByDriver(assignments: LoadedAssignment[]): Map<string | null, LoadedAssignment[]> {
  const byDriver = new Map<string | null, LoadedAssignment[]>();
  for (const assignment of assignments) {
    const driverId = assignment.assignmentStatus === 'ASSIGNED' ? assignment.assignedDriverId : null;
    if (assignment.assignmentStatus !== 'ASSIGNED' && assignment.assignmentStatus !== 'UNASSIGNED') continue;
    const current = byDriver.get(driverId) ?? [];
    current.push(assignment);
    byDriver.set(driverId, current);
  }
  for (const entries of byDriver.values()) entries.sort((left, right) => left.sourceSequence - right.sourceSequence);
  return byDriver;
}

function validateReadyForChildGeneration(group: LoadedGrouping, confirmRisk?: boolean): void {
  assertUniquePolygonDrivers(group.polygons);
  const unresolved = group.orders.filter((order) => order.assignmentStatus !== 'ASSIGNED' && order.assignmentStatus !== 'UNASSIGNED');
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

function childRouteSlotName(child: LoadedChild): string {
  return child.routePlan?.name ?? readChildSnapshot(child.snapshot).name;
}

function currentChildAssignments(group: LoadedGrouping, child: LoadedChild): LoadedAssignment[] {
  const assignmentsByStopId = new Map(group.orders.map((assignment) => [assignment.deliveryStopId, assignment]));
  const snapshotStops = readChildSnapshot(child.snapshot).stops
    .sort((left, right) => left.sequence - right.sequence)
    .map((stop) => stop.deliveryStopId);
  const routePlanStops = (child.routePlan?.routeStops ?? [])
    .sort((left, right) => left.sequence - right.sequence)
    .map((stop) => stop.deliveryStopId);
  const stopIds = snapshotStops.length > 0 ? snapshotStops : routePlanStops;

  return stopIds
    .map((deliveryStopId) => assignmentsByStopId.get(deliveryStopId) ?? null)
    .filter((assignment): assignment is LoadedAssignment => assignment !== null);
}

async function rewriteRoutePlanStops(tx: Tx, routePlanId: string, assignments: LoadedAssignment[]): Promise<void> {
  await tx.routePlanStop.deleteMany({ where: { routePlanId } });
  if (assignments.length === 0) return;
  await tx.routePlanStop.createMany({
    data: assignments.map((assignment, index) => ({
      deliveryStopId: assignment.deliveryStopId,
      routePlanId,
      sequence: index + 1
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
  driverId: string | null;
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
      id: `route-grouping:${input.group.id}:${input.driverId ?? 'unassigned'}`,
      itemSummary: routeItemSummary(input.assignments),
      missingCoordinates: input.assignments.filter((assignment) => decimalNumber(assignment.deliveryStop.latitude) === null || decimalNumber(assignment.deliveryStop.longitude) === null).length,
      name: input.name,
      planDate: formatDateOnly(input.group.planDate) ?? '',
      routeEndMode: DEFAULT_ROUTE_GROUPING_ROUTE_END_MODE,
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
  const items = assignmentOrderItems(assignment);
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
    itemCount: assignmentItemCount(assignment),
    items,
    orderId: assignment.orderId,
    orderName: assignment.order.name,
    paymentStatus: null,
    recipientName: stop.recipientName,
    sequence,
    shopifyOrderGid: assignment.order.shopifyOrderGid,
    status: stop.status
  };
}

function assignmentOrderItems(assignment: LoadedAssignment) {
  return (assignment.order.orderItems ?? []).map((item) => toOrderItemDto(item));
}

function assignmentItemCount(assignment: LoadedAssignment): number {
  return assignmentOrderItems(assignment).reduce((sum, item) => sum + item.quantity, 0);
}

function routeItemSummary(assignments: LoadedAssignment[]) {
  return aggregateOrderItems(assignments.flatMap((assignment) => assignmentOrderItems(assignment)));
}

function stripGeneratedChildRouteVersion(name: string): string {
  return name.replace(/\s+v\d+$/u, '');
}

async function createDraftChildRoutePlan(
  tx: Tx,
  group: LoadedGrouping,
  input: {
    assignments: LoadedAssignment[];
    color: string | null | undefined;
    groupingVersionId: string;
    name: string;
    optimized: RouteGroupingDraftRouteInput['optimized'] | null;
    routeIdx: number | undefined;
    sortOrder: number | undefined;
  }
): Promise<{ id: string; name: string }> {
  const depot = readDepotFromShop(group);
  const name = stripGeneratedChildRouteVersion(input.name.trim() || `#${input.routeIdx ?? input.sortOrder ?? 1}`);
  const metrics = input.optimized?.metrics === undefined || input.optimized?.metrics === null
    ? routeMetrics(input.assignments)
    : toJson(input.optimized.metrics);
  const routePlan = await tx.routePlan.create({
    data: {
      constraints: routeConstraints(group, depot),
      createdBy: ROUTE_GROUPING_DRAFT_SAVE_ACTOR,
      ...(depot === null ? {} : { depotLatitude: decimalString(depot.latitude), depotLongitude: decimalString(depot.longitude) }),
      driverId: null,
      metrics,
      name,
      optimizerVersion: OPTIMIZER_VERSION,
      planDate: group.planDate,
      shopId: group.shopId,
      status: 'DRAFT'
    },
    select: { id: true, name: true }
  });
  await tx.routePlanStop.createMany({ data: input.assignments.map((assignment, index) => ({ deliveryStopId: assignment.deliveryStopId, routePlanId: routePlan.id, sequence: index + 1 })) });
  await tx.routeGroupingChildVersion.create({
    data: {
      driverId: null,
      groupingId: group.id,
      groupingVersionId: input.groupingVersionId,
      notificationStatus: 'SKIPPED',
      routePlanId: routePlan.id,
      shopId: group.shopId,
      snapshot: createChildSnapshot(group, input.assignments, null, routePlan.name, group.currentVersion, input.color ?? null, input.sortOrder, input.routeIdx),
      status: 'CURRENT',
      version: group.currentVersion
    }
  });
  if (depot !== null && input.optimized?.routeGeometry !== undefined) {
    const detail = buildChildRouteDetail({ assignments: input.assignments, depot, driverId: null, group, name: routePlan.name });
    await tx.routePlanGeometryCache.create({
      data: routeGeometryCacheCreateData({
        generatedAt: new Date(),
        geometry: input.optimized.routeGeometry ?? null,
        metrics: input.optimized.metrics ?? null,
        provider: 'osrm',
        providerVersion: null,
        routePlanId: routePlan.id,
        shapeSignature: computeRouteShapeSignature(detail),
        source: 'SNAPSHOT',
        stopPoints: input.optimized.routeStopPoints ?? []
      })
    });
  }
  return routePlan;
}

async function createChildRoutePlan(tx: Tx, group: LoadedGrouping, candidate: OptimizedChildRouteCandidate, actor: string): Promise<{ id: string; name: string }> {
  const name = candidate.name.trim() || `#${candidate.routeIdx ?? 1}`;
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
  if (candidate.assignments.length > 0) {
    await tx.routePlanStop.createMany({ data: candidate.assignments.map((assignment, index) => ({ deliveryStopId: assignment.deliveryStopId, routePlanId: routePlan.id, sequence: index + 1 })) });
  }
  return routePlan;
}

async function createChildRoutePlanFromSnapshot(tx: Tx, group: LoadedGrouping, snapshot: ChildSnapshot, actor: string): Promise<{ id: string; name: string }> {
  const depot = readDepotFromShop(group);
  const name = stripGeneratedChildRouteVersion(snapshot.name);
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

async function createDraftRouteGeometryCache(
  tx: Tx,
  routePlanId: string,
  candidate: OptimizedDraftRoute
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

function createChildSnapshot(group: LoadedGrouping, assignments: LoadedAssignment[], driverId: string | null, name: string, version: number, color?: string | null, sortOrder?: number, routeIdx?: number): ChildSnapshot {
  return {
    ...(color === undefined ? {} : { color }),
    ...(routeIdx === undefined ? {} : { routeIdx }),
    ...(sortOrder === undefined ? {} : { sortOrder }),
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
  const routeIdx = typeof object.routeIdx === 'number' && Number.isInteger(object.routeIdx) ? object.routeIdx : undefined;
  const sortOrder = typeof object.sortOrder === 'number' && Number.isInteger(object.sortOrder) ? object.sortOrder : undefined;
  return {
    color: typeof object.color === 'string' ? object.color : null,
    driverId: typeof object.driverId === 'string' ? object.driverId : null,
    groupingId: typeof object.groupingId === 'string' ? object.groupingId : '',
    groupingVersion: typeof object.groupingVersion === 'number' ? object.groupingVersion : 0,
    name: typeof object.name === 'string' ? object.name : 'Rolled back route',
    planDate: typeof object.planDate === 'string' ? object.planDate : '',
    ...(routeIdx === undefined ? {} : { routeIdx }),
    ...(sortOrder === undefined ? {} : { sortOrder }),
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
    routeEndMode: DEFAULT_ROUTE_GROUPING_ROUTE_END_MODE,
    routeScope: { deliveryDate: formatDateOnly(group.planDate), deliverySession: group.deliverySession, routeScopeKey: group.routeScopeKey, serviceType: group.serviceType }
  };
}

function routeMetrics(assignments: LoadedAssignment[]): Prisma.InputJsonObject {
  return { missingCoordinates: 0, stopsCount: assignments.length };
}

function toGroupingDetailDto(group: LoadedGrouping): RouteGroupingDetailDto {
  return {
    ...toGroupingSummaryDto(group),
    assignments: group.orders.map(toAssignmentDto),
    branches: group.branches.map(toBranchDto),
    polygons: group.polygons.map(toPolygonDto)
  };
}

function toGroupingSummaryDto(group: LoadedGrouping): RouteGroupingSummaryDto {
  const unresolvedOrders = group.orders.filter((order) => order.assignmentStatus !== 'ASSIGNED' && order.assignmentStatus !== 'UNASSIGNED').length;
  const currentChildren = group.childVersions.filter((child) => child.status === 'CURRENT');
  const dateRange = loadedGroupDateRange(group);
  return {
    children: currentChildren.map((child) => toChildDto(child, group)),
    currentVersion: group.currentVersion,
    dateRangeEnd: dateRange.endText,
    dateRangeStart: dateRange.startText,
    displayStatus: deriveGroupingDisplayStatus(group),
    id: group.id,
    name: group.name,
    planDate: formatDateOnly(group.planDate) ?? '',
    status: group.status,
    switchRoutes: toGroupingSwitchRoutes(group, currentChildren),
    totalOrders: group.orders.length,
    unresolvedOrders,
    updatedAt: group.updatedAt.toISOString(),
    warningState: deriveWarnings(group)
  };
}

function formatDeliveryStopAddress(stop: LoadedAssignment['deliveryStop']): string {
  return [stop.address1, stop.address2, stop.city, stop.province, stop.postalCode, stop.countryCode]
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part !== null && part !== '')
    .join(', ');
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
    recipientName: order.deliveryStop.recipientName,
    addressLabel: formatDeliveryStopAddress(order.deliveryStop),
    phone: order.deliveryStop.phone ?? order.order.phone ?? null,
    email: order.order.email ?? null,
    itemCount: assignmentItemCount(order),
    sourceOrderId: order.order.shopifyOrderGid,
    sourceSequence: order.sourceSequence
  };
}

function toPolygonDto(polygon: LoadedGrouping['polygons'][number]): RouteGroupingPolygonDto {
  return { closed: polygon.closed, color: polygon.color, drawOrder: polygon.drawOrder, driverId: polygon.driverId, geometry: polygon.geometryJson, id: polygon.id, label: polygon.label };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function readOptimizedBranchSnapshot(value: unknown): RouteGroupingBranchDto['optimized'] {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function toBranchDto(branch: LoadedBranch) {
  return {
    createdAt: branch.createdAt.toISOString(),
    driverId: branch.driverId,
    color: branch.color,
    driverName: branch.driver?.displayName ?? null,
    id: branch.id,
    label: branch.label,
    optimized: readOptimizedBranchSnapshot(branch.optimizedJson),
    orderIds: [...branch.orderLocks]
      .sort((first, second) => first.routeGroupingOrder.sourceSequence - second.routeGroupingOrder.sourceSequence)
      .map((lock) => lock.orderId),
    ordersCount: branch.orderLocks.length,
    sortOrder: branch.sortOrder,
    updatedAt: branch.updatedAt.toISOString()
  };
}

function toChildDto(child: LoadedChild, group: LoadedGrouping): RouteGroupingChildDto {
  const snapshot = readChildSnapshot(child.snapshot);
  const assignments = currentChildAssignments(group, child);
  const stops = assignments.map(toAssignmentDto);
  const childRouteMetrics = readChildRouteMetrics(child, group);
  return {
    childVersion: child.version,
    color: snapshot.color ?? null,
    displayStatus: deriveChildDisplayStatus(child),
    driverId: child.driverId,
    driverName: child.driver?.displayName ?? child.routePlan?.driver?.displayName ?? null,
    notificationStatus: normalizeNotificationStatus(child.notificationStatus),
    orderIds: stops.map((stop) => stop.orderId),
    routeMetrics: childRouteMetrics,
    routePlan: child.routePlan === null ? null : toMinimalRoutePlanSummary(child.routePlan, childRouteMetrics, assignments),
    routePlanId: child.routePlanId,
    routeIdx: snapshot.routeIdx ?? null,
    sortOrder: snapshot.sortOrder ?? null,
    stops,
    stopsCount: stops.length
  };
}

function readChildRouteMetrics(child: LoadedChild, group: LoadedGrouping): RoutePlanRouteMetrics | null {
  if (child.routePlan === null) return null;
  const depot = readDepotFromShop(group);
  if (depot === null) return null;

  const detail = buildChildRouteDetail({
    assignments: currentChildAssignments(group, child),
    depot,
    driverId: child.driverId,
    group,
    name: child.routePlan.name
  });

  return readChildRouteMetricsFromRoutePlan(child.routePlan, detail);
}

function readChildRouteMetricsFromRoutePlan(routePlan: NonNullable<LoadedChild['routePlan']>, detail: RoutePlanDetail): RoutePlanRouteMetrics | null {
  return readExactChildRouteMetricsFromRoutePlan(routePlan, detail);
}

function readExactChildRouteMetricsFromRoutePlan(routePlan: NonNullable<LoadedChild['routePlan']>, detail: RoutePlanDetail): RoutePlanRouteMetrics | null {
  const caches = routePlan.routeGeometryCaches as RouteGeometryCacheSummaryRecord[] | undefined;
  if (caches === undefined || caches.length === 0) return null;

  const shapeSignature = computeRouteShapeSignature(detail);
  const cache = caches.find((entry) => entry.shapeSignature === shapeSignature) ?? null;
  const applied = applyCachedRouteGeometry(detail, toRouteGeometrySummaryCacheRead(cache));
  return applied.routeGeometry !== null && applied.routeMetrics !== null ? applied.routeMetrics : null;
}

function toRouteGeometrySummaryCacheRead(record: RouteGeometryCacheSummaryRecord | null): RouteGeometryCacheRead | null {
  if (record === null) return null;
  return record;
}

function toGroupingSwitchRoutes(group: LoadedGrouping, currentChildren: LoadedChild[]) {
  const seen = new Set<string>();
  const routes: Array<{ label: string; routeGroupId?: string | null; routePlanId: string | null }> = [];
  const add = (label: string | null | undefined, routePlanId: string | null, routeGroupId: string | null = null) => {
    const safeLabel = label?.trim();
    const key = `${routeGroupId ?? ''}:${routePlanId ?? ''}:${safeLabel ?? ''}`;
    if (!safeLabel || seen.has(key)) return;
    seen.add(key);
    routes.push({ label: safeLabel, routeGroupId, routePlanId });
  };

  add(group.name, null, group.id);
  currentChildren.forEach((child) => {
    const snapshot = readChildSnapshot(child.snapshot);
    add(child.routePlan?.name ?? snapshot.name, child.routePlanId);
  });

  return routes;
}

function readDepartureTime(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).departureTime;
  if (typeof raw !== 'string') return null;
  const departureTime = raw.trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(departureTime) ? departureTime : null;
}

function toMinimalRoutePlanSummary(routePlan: NonNullable<LoadedChild['routePlan']>, routeMetrics: RoutePlanRouteMetrics | null, assignments: LoadedAssignment[]) {
  return {
    createdAt: routePlan.createdAt.toISOString(),
    deliveryAreas: [],
    deliveryDays: [],
    depot: { latitude: decimalNumber(routePlan.depotLatitude), longitude: decimalNumber(routePlan.depotLongitude) },
    departureTime: readDepartureTime(routePlan.constraints),
    driver: null,
    driverId: routePlan.driverId,
    id: routePlan.id,
    itemSummary: routeItemSummary(assignments),
    missingCoordinates: 0,
    name: routePlan.name,
    planDate: formatDateOnly(routePlan.planDate) ?? '',
    routeEndMode: DEFAULT_ROUTE_GROUPING_ROUTE_END_MODE,
    routeMetrics,
    status: routePlan.status,
    stopsCount: routePlan.routeStops.length,
    updatedAt: routePlan.updatedAt.toISOString()
  };
}

function deriveGroupingDisplayStatus(group: LoadedGrouping): RouteGroupingDisplayStatus {
  if (group.status === 'CANCELLED') return 'CANCELLED';
  if (group.status === 'PUBLISHED') return 'PUBLISHED';
  return 'DRAFT';
}

function deriveChildDisplayStatus(child: LoadedChild): RouteGroupingChildDisplayStatus {
  if (child.routePlan?.status === 'CANCELLED') return 'CANCELLED';
  if (child.routePlan?.status === 'PUBLISHED') return 'PUBLISHED';
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

function assertUniquePolygonDrivers(polygons: Array<{ driverId?: string | null }>): void {
  const seenDriverIds = new Set<string>();
  for (const polygon of polygons) {
    const driverId = polygon.driverId?.trim();
    if (driverId === undefined || driverId === '') continue;
    if (seenDriverIds.has(driverId)) {
      throw new RouteGroupingValidationError(['driver can only be assigned to one split polygon in a route grouping']);
    }
    seenDriverIds.add(driverId);
  }
}

function normalizeIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))];
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase();
}


function parseExpectedUpdatedAt(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RouteGroupingValidationError(['expectedUpdatedAt must be a valid ISO timestamp']);
  return date;
}

function parsePlanDate(value: string): Date {
  const normalized = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : '';
  if (normalized === '') throw new RouteGroupingValidationError(['plan date must be YYYY-MM-DD']);
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || formatDateOnly(date) !== normalized) {
    throw new RouteGroupingValidationError(['plan date must be valid']);
  }
  return date;
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

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}

function hasValidDepotCoordinates(depot: CreateRouteGroupingInput['depot']): depot is { address: string | null; latitude: number; longitude: number } {
  return depot !== undefined && isValidLatitude(decimalNumber(depot.latitude)) && isValidLongitude(decimalNumber(depot.longitude));
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
