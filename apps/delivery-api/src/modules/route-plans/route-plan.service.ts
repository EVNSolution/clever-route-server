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
    private readonly routeGeometryProvider?: RouteGeometryProvider
  ) {}

  createRoutePlan(input: CreateRoutePlanInput): Promise<RoutePlanSummary> {
    return this.repository.createRoutePlanDraft({
      createdBy: input.createdBy,
      depot: input.payload.depot,
      name: input.payload.name,
      orders: input.payload.orders,
      planDate: input.payload.planDate,
      routeScope: input.payload.routeScope,
      shopDomain: input.shopDomain
    });
  }

  createRoutePlanFromOrderIds(input: CreateRoutePlanFromOrderIdsInput): Promise<RoutePlanSummary> {
    if (this.repository.createRoutePlanDraftFromOrderIds === undefined) {
      throw new Error('Route creation from selected order ids is not supported by this repository');
    }
    return this.repository.createRoutePlanDraftFromOrderIds({
      createdBy: input.createdBy,
      depot: input.payload.depot,
      name: input.payload.name,
      orderIds: input.payload.orderIds,
      planDate: input.payload.planDate,
      shopDomain: input.shopDomain
    });
  }

  async assignRoutePlanDriver(input: UpdateRoutePlanDriverInput): Promise<RoutePlanDetail | null> {
    return this.withRouteGeometry(await this.repository.assignRoutePlanDriver(input));
  }

  async getRoutePlanDetail(input: {
    routePlanId: string;
    shopDomain: string;
  }): Promise<RoutePlanDetail | null> {
    return this.withRouteGeometry(await this.repository.findRoutePlanDetail(input));
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

  async publishRoutePlan(input: PublishRoutePlanInput): Promise<RoutePlanDetail | null> {
    return this.withRouteGeometry(await this.repository.publishRoutePlan(input));
  }

  async saveRoutePlan(input: SaveRoutePlanInput): Promise<SaveRoutePlanResult | null> {
    const saved = await this.repository.saveRoutePlan(input);
    if (saved === null) return null;
    const enriched = await this.withRouteGeometry(saved.detail);
    return {
      detail: enriched ?? saved.detail,
      operations: saved.operations
    };
  }

  async updateRoutePlanOptions(input: UpdateRoutePlanOptionsInput): Promise<RoutePlanDetail | null> {
    return this.withRouteGeometry(await this.repository.updateRoutePlanOptions(input));
  }

  async updateRoutePlanStops(input: UpdateRoutePlanStopsInput): Promise<RoutePlanDetail | null> {
    return this.withRouteGeometry(await this.repository.updateRoutePlanStops(input));
  }

  private async withRouteGeometry(detail: RoutePlanDetail | null): Promise<RoutePlanDetail | null> {
    if (detail === null || this.routeGeometryProvider === undefined) {
      return detail;
    }

    try {
      const routeResult = await this.routeGeometryProvider.buildRoute(detail);
      return {
        ...detail,
        routeGeometry: routeResult.routeGeometry,
        routeMetrics: routeResult.routeMetrics,
        routeStopPoints: routeResult.routeStopPoints
      };
    } catch {
      return {
        ...detail,
        routeGeometry: null,
        routeMetrics: null,
        routeStopPoints: []
      };
    }
  }
}
