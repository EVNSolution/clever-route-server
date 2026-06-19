import { RouteOptimizationJobActiveError } from './route-optimization-job.types.js';
import type { RouteOptimizationJobDto } from './route-optimization-job.types.js';
import {
  computeRouteShapeSignature,
  withRouteGeometryResult
} from './route-plan-geometry-cache.js';
import type { RouteGeometryCacheSource, RouteGeometryCacheWrite } from './route-plan-geometry-cache.js';
import type {
  CreateRoutePlanInput,
  CreateRoutePlanFromOrderIdsInput,
  ListRoutePlansInput,
  PublishRoutePlanInput,
  RoutePlanDetail,
  RoutePlanRouteResult,
  RoutePlanService,
  RoutePlanSummary,
  SaveRoutePlanInput,
  SaveRoutePlanResult,
  UpdateRoutePlanDriverInput,
  UpdateRoutePlanOptionsInput,
  UpdateRoutePlanStopsInput
} from './route-plan.types.js';

export type RouteGeometryProvider = {
  buildRoute(input: RoutePlanDetail): Promise<RoutePlanRouteResult>;
};

export type RouteOptimizationJobGuard = {
  findLatestJob(input: { routePlanId: string; shopDomain: string }): Promise<RouteOptimizationJobDto | null>;
  reconcileStaleActiveJobs?(input: { routePlanId: string; shopDomain: string }): Promise<RouteOptimizationJobDto[]>;
};

export type RoutePlanRepository = {
  assignRoutePlanDriver(input: UpdateRoutePlanDriverInput): Promise<RoutePlanDetail | null>;
  createRoutePlanDraft(input: {
    createdBy: string;
    depot: CreateRoutePlanInput['payload']['depot'];
    name: string;
    orders: CreateRoutePlanInput['payload']['orders'];
    planDate: string;
    routeScope?: CreateRoutePlanInput['payload']['routeScope'];
    shopDomain: string;
  }): Promise<RoutePlanSummary>;
  createRoutePlanDraftFromOrderIds?(input: {
    createdBy: string;
    depot: CreateRoutePlanInput['payload']['depot'];
    name: string;
    orderIds: string[];
    planDate: string;
    shopDomain: string;
  }): Promise<RoutePlanSummary>;
  findRoutePlanDetail(input: {
    routePlanId: string;
    shopDomain: string;
  }): Promise<RoutePlanDetail | null>;
  routePlanExists?(input: {
    routePlanId: string;
    shopDomain: string;
  }): Promise<boolean>;
  upsertRouteGeometryCache?(input: RouteGeometryCacheWrite): Promise<void>;
  deleteRoutePlan(input: {
    routePlanId: string;
    shopDomain: string;
  }): Promise<{ routePlanId: string; deleted: boolean }>;
  listRoutePlans(input: ListRoutePlansInput): Promise<RoutePlanSummary[]>;
  publishRoutePlan(input: PublishRoutePlanInput): Promise<RoutePlanDetail | null>;
  saveRoutePlan(input: SaveRoutePlanInput): Promise<SaveRoutePlanResult | null>;
  updateRoutePlanOptions(input: UpdateRoutePlanOptionsInput): Promise<RoutePlanDetail | null>;
  updateRoutePlanStops(input: UpdateRoutePlanStopsInput): Promise<RoutePlanDetail | null>;
};

export class RoutePlanAdminService implements RoutePlanService {
  constructor(
    private readonly repository: RoutePlanRepository,
    private readonly routeGeometryProvider?: RouteGeometryProvider,
    private readonly routeOptimizationJobGuard?: RouteOptimizationJobGuard
  ) {}

  async createRoutePlan(input: CreateRoutePlanInput): Promise<RoutePlanSummary> {
    const summary = await this.repository.createRoutePlanDraft({
      createdBy: input.createdBy,
      depot: input.payload.depot,
      name: input.payload.name,
      orders: input.payload.orders,
      planDate: input.payload.planDate,
      routeScope: input.payload.routeScope,
      shopDomain: input.shopDomain
    });
    await this.refreshRouteGeometryById({
      routePlanId: summary.id,
      shopDomain: input.shopDomain,
      source: 'CREATE_ROUTE'
    });
    return summary;
  }

  async createRoutePlanFromOrderIds(input: CreateRoutePlanFromOrderIdsInput): Promise<RoutePlanSummary> {
    if (this.repository.createRoutePlanDraftFromOrderIds === undefined) {
      throw new Error('Route creation from selected order ids is not supported by this repository');
    }
    const summary = await this.repository.createRoutePlanDraftFromOrderIds({
      createdBy: input.createdBy,
      depot: input.payload.depot,
      name: input.payload.name,
      orderIds: input.payload.orderIds,
      planDate: input.payload.planDate,
      shopDomain: input.shopDomain
    });
    await this.refreshRouteGeometryById({
      routePlanId: summary.id,
      shopDomain: input.shopDomain,
      source: 'CREATE_ROUTE'
    });
    return summary;
  }

  assignRoutePlanDriver(input: UpdateRoutePlanDriverInput): Promise<RoutePlanDetail | null> {
    return this.repository.assignRoutePlanDriver(input);
  }

  getRoutePlanDetail(input: {
    routePlanId: string;
    shopDomain: string;
  }): Promise<RoutePlanDetail | null> {
    return this.repository.findRoutePlanDetail(input);
  }

  async refreshRouteGeometryForRoutePlan(input: {
    routePlanId: string;
    shopDomain: string;
    source?: RouteGeometryCacheSource;
  }): Promise<RoutePlanDetail | null> {
    return this.refreshRouteGeometryById({
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain,
      source: input.source ?? 'EXPLICIT_REFRESH'
    });
  }

  routePlanExists(input: { routePlanId: string; shopDomain: string }): Promise<boolean> {
    if (this.repository.routePlanExists !== undefined) {
      return this.repository.routePlanExists(input);
    }
    return this.repository.findRoutePlanDetail(input).then((detail) => detail !== null);
  }

  deleteRoutePlan(input: { routePlanId: string; shopDomain: string }): Promise<{
    routePlanId: string;
    deleted: boolean;
  }> {
    return this.repository.deleteRoutePlan(input);
  }

  listRoutePlans(input: ListRoutePlansInput): Promise<RoutePlanSummary[]> {
    return this.repository.listRoutePlans(input);
  }

  publishRoutePlan(input: PublishRoutePlanInput): Promise<RoutePlanDetail | null> {
    return this.repository.publishRoutePlan(input);
  }

  async saveRoutePlan(input: SaveRoutePlanInput): Promise<SaveRoutePlanResult | null> {
    if (hasRouteMutationPayload(input)) {
      await this.assertNoActiveUserOptimizationJob(input);
    }
    const shouldCheckShape = hasRouteShapePayload(input);
    const before = shouldCheckShape ? await this.repository.findRoutePlanDetail(input) : null;
    const saved = await this.repository.saveRoutePlan(input);
    if (saved === null) return null;
    const detail = shouldCheckShape
      ? await this.refreshRouteGeometryIfShapeChanged({
          before,
          after: saved.detail,
          source: 'SHAPE_MUTATION'
        })
      : saved.detail;
    return {
      detail,
      operations: saved.operations
    };
  }

  async updateRoutePlanOptions(input: UpdateRoutePlanOptionsInput): Promise<RoutePlanDetail | null> {
    await this.assertNoActiveUserOptimizationJob(input);
    const before = await this.repository.findRoutePlanDetail(input);
    const updated = await this.repository.updateRoutePlanOptions(input);
    if (updated === null) return null;
    return this.refreshRouteGeometryIfShapeChanged({
      before,
      after: updated,
      source: 'SHAPE_MUTATION'
    });
  }

  async updateRoutePlanStops(input: UpdateRoutePlanStopsInput): Promise<RoutePlanDetail | null> {
    await this.assertNoActiveUserOptimizationJob(input);
    const before = await this.repository.findRoutePlanDetail(input);
    const updated = await this.repository.updateRoutePlanStops(input);
    if (updated === null) return null;
    return this.refreshRouteGeometryIfShapeChanged({
      before,
      after: updated,
      source: input.mutationContext?.source === 'route_optimization_job' ? 'OPTIMIZATION_APPLY' : 'SHAPE_MUTATION'
    });
  }

  private async assertNoActiveUserOptimizationJob(
    input: SaveRoutePlanInput | UpdateRoutePlanOptionsInput | UpdateRoutePlanStopsInput
  ): Promise<void> {
    if ('mutationContext' in input && input.mutationContext?.source === 'route_optimization_job') return;
    if (this.routeOptimizationJobGuard === undefined) return;
    await this.routeOptimizationJobGuard.reconcileStaleActiveJobs?.({
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain
    });
    const latestJob = await this.routeOptimizationJobGuard.findLatestJob({
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain
    });
    if (latestJob !== null && (latestJob.status === 'QUEUED' || latestJob.status === 'RUNNING')) {
      throw new RouteOptimizationJobActiveError();
    }
  }

  private async refreshRouteGeometryById(input: {
    routePlanId: string;
    shopDomain: string;
    source: RouteGeometryCacheSource;
  }): Promise<RoutePlanDetail | null> {
    const detail = await this.repository.findRoutePlanDetail({
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain
    });
    if (detail === null) return null;
    return this.refreshRouteGeometry(detail, input.source);
  }

  private async refreshRouteGeometryIfShapeChanged(input: {
    before: RoutePlanDetail | null;
    after: RoutePlanDetail;
    source: RouteGeometryCacheSource;
  }): Promise<RoutePlanDetail> {
    if (input.before !== null && computeRouteShapeSignature(input.before) === computeRouteShapeSignature(input.after)) {
      return input.after;
    }
    return await this.refreshRouteGeometry(input.after, input.source);
  }

  private async refreshRouteGeometry(detail: RoutePlanDetail, source: RouteGeometryCacheSource): Promise<RoutePlanDetail> {
    if (this.routeGeometryProvider === undefined) {
      return detail;
    }

    const generatedAt = new Date();
    const routeResult = await this.buildRouteSafely(detail);
    if (routeResult === null) {
      return withRouteGeometryResult(detail, emptyRouteResult(), { generatedAt, source });
    }

    const shapeSignature = computeRouteShapeSignature(detail);
    await this.repository.upsertRouteGeometryCache?.({
      generatedAt,
      geometry: routeResult.routeGeometry,
      metrics: routeResult.routeMetrics,
      provider: 'osrm',
      providerVersion: null,
      routePlanId: detail.routePlan.id,
      shapeSignature,
      source,
      stopPoints: routeResult.routeStopPoints
    });
    return withRouteGeometryResult(detail, routeResult, { generatedAt, source });
  }

  private async buildRouteSafely(detail: RoutePlanDetail): Promise<RoutePlanRouteResult | null> {
    try {
      return await this.routeGeometryProvider?.buildRoute(detail) ?? emptyRouteResult();
    } catch {
      return null;
    }
  }
}

function emptyRouteResult(): RoutePlanRouteResult {
  return { routeGeometry: null, routeMetrics: null, routeStopPoints: [] };
}

function hasRouteMutationPayload(input: SaveRoutePlanInput): boolean {
  return input.payload.driverId !== undefined || input.payload.routeEndMode !== undefined || input.payload.stops !== undefined;
}

function hasRouteShapePayload(input: SaveRoutePlanInput): boolean {
  return input.payload.routeEndMode !== undefined || input.payload.stops !== undefined;
}
