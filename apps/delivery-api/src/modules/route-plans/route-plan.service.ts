import { avoidsTolls } from './route-toll-policy.js';
import { RouteOptimizationJobActiveError } from './route-optimization-job.types.js';
import type { RouteOptimizationJobDto } from './route-optimization-job.types.js';
import {
  computeRouteShapeSignature,
  withRouteGeometryResult
} from './route-plan-geometry-cache.js';
import type { RouteGeometryCacheSource, RouteGeometryCacheWrite } from './route-plan-geometry-cache.js';
import { isRouteReadyStatus } from './route-plan-lifecycle.js';
import type {
  AdminRouteStopOverrideInput,
  AdminRouteStopOverrideRepositoryResult,
  AdminRouteStopOverrideResult,
  AdminRouteStopTransitionInput,
  AdminRouteStopTransitionResult,
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
import {
  RoutePlanConflictError,
  RoutePlanGeometryRefreshFailedError,
  RoutePlanRefreshNotAllowedError
} from './route-plan.types.js';

export type RouteGeometryProvider = {
  buildRoute(input: RoutePlanDetail): Promise<RoutePlanRouteResult>;
};

export type RouteOptimizationJobGuard = {
  findLatestJob(input: { appId?: string | undefined; routePlanId: string; shopDomain: string }): Promise<RouteOptimizationJobDto | null>;
  reconcileStaleActiveJobs?(input: { appId?: string | undefined; routePlanId: string; shopDomain: string }): Promise<RouteOptimizationJobDto[]>;
};

export type RouteTrackingProgressPublisher = {
  publishProgress(event: {
    deliveryStopId: string | null;
    driverId: string | null;
    eventId: string;
    eventType: 'STOP_DELIVERED';
    occurredAt: string;
    receivedAt: string;
    routePlanId: string;
    schemaVersion: 'route_tracking.v1';
  }): void;
};

export type RoutePlanRepository = {
  transitionAdminRouteStop?(input: AdminRouteStopTransitionInput): Promise<AdminRouteStopTransitionResult | null>;
  updateAdminRouteStopOverride?(input: AdminRouteStopOverrideInput): Promise<AdminRouteStopOverrideRepositoryResult | null>;
  assignRoutePlanDriver(input: UpdateRoutePlanDriverInput): Promise<RoutePlanDetail | null>;
  createRoutePlanDraft(input: {
    createdBy: string;
    deliveryProof?: NonNullable<CreateRoutePlanInput['payload']['deliveryProof']>;
    tollPolicy?: NonNullable<CreateRoutePlanInput['payload']['tollPolicy']>;
    prepareGeometry?: (candidate: RoutePlanDetail) => Promise<RoutePlanRouteResult>;
    depot: CreateRoutePlanInput['payload']['depot'];
    name: string;
    orders: CreateRoutePlanInput['payload']['orders'];
    planDate: string;
    routeScope?: CreateRoutePlanInput['payload']['routeScope'];
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<RoutePlanSummary>;
  createRoutePlanDraftFromOrderIds?(input: {
    createdBy: string;
    deliveryProof?: NonNullable<CreateRoutePlanInput['payload']['deliveryProof']>;
    tollPolicy?: NonNullable<CreateRoutePlanInput['payload']['tollPolicy']>;
    prepareGeometry?: (candidate: RoutePlanDetail) => Promise<RoutePlanRouteResult>;
    depot: CreateRoutePlanInput['payload']['depot'];
    name: string;
    orderIds: string[];
    planDate: string;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<RoutePlanSummary>;
  findRoutePlanDetail(input: {
    routePlanId: string;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<RoutePlanDetail | null>;
  routePlanExists?(input: {
    routePlanId: string;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<boolean>;
  upsertRouteGeometryCache?(input: RouteGeometryCacheWrite): Promise<void>;
  commitOrderDataRouteGeometryCache?(input: RouteGeometryCacheWrite & {
    appId?: string | undefined;
    expectedRoutePlanUpdatedAt: string;
    shopDomain: string;
  }): Promise<boolean>;
  commitAdminRouteStopGeometryCache?(input: RouteGeometryCacheWrite & {
    appId?: string | undefined;
    expectedRoutePlanUpdatedAt: string;
    expectedStopUpdatedAts: Array<{ deliveryStopId: string; updatedAt: string }>;
    shopDomain: string;
  }): Promise<boolean>;
  deleteRoutePlan(input: {
    routePlanId: string;
    appId?: string | undefined;
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
    private readonly routeOptimizationJobGuard?: RouteOptimizationJobGuard,
    private readonly routeTrackingProgressPublisher?: RouteTrackingProgressPublisher
  ) {}

  async createRoutePlan(input: CreateRoutePlanInput): Promise<RoutePlanSummary> {
    const summary = await this.repository.createRoutePlanDraft({
      appId: input.appId,
      createdBy: input.createdBy,
      ...(input.payload.deliveryProof === undefined ? {} : { deliveryProof: input.payload.deliveryProof }),
      ...(input.payload.tollPolicy === undefined ? {} : { tollPolicy: input.payload.tollPolicy }),
      ...(avoidsTolls(input.payload.tollPolicy) ? { prepareGeometry: (candidate: RoutePlanDetail) => this.buildTollGeometry(candidate) } : {}),
      depot: input.payload.depot,
      name: input.payload.name,
      orders: input.payload.orders,
      planDate: input.payload.planDate,
      routeScope: input.payload.routeScope,
      shopDomain: input.shopDomain
    });
    if (avoidsTolls(input.payload.tollPolicy)) return summary;
    await this.refreshRouteGeometryById({
      appId: input.appId,
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
      appId: input.appId,
      createdBy: input.createdBy,
      ...(input.payload.deliveryProof === undefined ? {} : { deliveryProof: input.payload.deliveryProof }),
      ...(input.payload.tollPolicy === undefined ? {} : { tollPolicy: input.payload.tollPolicy }),
      ...(avoidsTolls(input.payload.tollPolicy) ? { prepareGeometry: (candidate: RoutePlanDetail) => this.buildTollGeometry(candidate) } : {}),
      depot: input.payload.depot,
      name: input.payload.name,
      orderIds: input.payload.orderIds,
      planDate: input.payload.planDate,
      shopDomain: input.shopDomain
    });
    if (avoidsTolls(input.payload.tollPolicy)) return summary;
    await this.refreshRouteGeometryById({
      appId: input.appId,
      routePlanId: summary.id,
      shopDomain: input.shopDomain,
      source: 'CREATE_ROUTE'
    });
    return summary;
  }

  assignRoutePlanDriver(input: UpdateRoutePlanDriverInput): Promise<RoutePlanDetail | null> {
    return this.repository.assignRoutePlanDriver(input);
  }

  async transitionAdminRouteStop(input: AdminRouteStopTransitionInput): Promise<AdminRouteStopTransitionResult | null> {
    if (this.repository.transitionAdminRouteStop === undefined) {
      throw new Error('Admin route stop transitions are not supported by this repository');
    }
    const result = await this.repository.transitionAdminRouteStop(input);
    if (result === null || result.duplicate) return result;

    if (result.trackingEvent !== null && result.trackingEvent !== undefined) {
      this.routeTrackingProgressPublisher?.publishProgress({
        ...result.trackingEvent,
        schemaVersion: 'route_tracking.v1'
      });
    }

    return result;
  }

  async updateAdminRouteStopOverride(input: AdminRouteStopOverrideInput): Promise<AdminRouteStopOverrideResult | null> {
    if (this.repository.updateAdminRouteStopOverride === undefined) {
      throw new Error('Admin route stop overrides are not supported by this repository');
    }
    const result = await this.repository.updateAdminRouteStopOverride({
      ...input,
      // The repository decides under its route lock whether the current policy needs this callback.
      prepareGeometry: (candidate) => this.buildTollGeometry(candidate)
    });
    if (result === null) return null;
    const { refreshGuard, ...response } = result;
    if (result.geometry.status === 'preserved' || refreshGuard === null) return response;
    return {
      ...response,
      routePlan: await this.refreshAdminStopOverrideGeometry(input, result.routePlan, refreshGuard)
    };
  }

  getRoutePlanDetail(input: {
    routePlanId: string;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<RoutePlanDetail | null> {
    return this.repository.findRoutePlanDetail(input);
  }

  async refreshRouteGeometryForRoutePlan(input: {
    routePlanId: string;
    appId?: string | undefined;
    shopDomain: string;
    source?: RouteGeometryCacheSource;
  }): Promise<RoutePlanDetail | null> {
    const source = input.source ?? 'EXPLICIT_REFRESH';
    if (source === 'ORDER_DATA_REFRESH') {
      await this.assertNoActiveUserOptimizationJob(input);
    }
    return this.refreshRouteGeometryById({
      appId: input.appId,
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain,
      source
    });
  }

  routePlanExists(input: { appId?: string | undefined; routePlanId: string; shopDomain: string }): Promise<boolean> {
    if (this.repository.routePlanExists !== undefined) {
      return this.repository.routePlanExists(input);
    }
    return this.repository.findRoutePlanDetail(input).then((detail) => detail !== null);
  }

  deleteRoutePlan(input: { appId?: string | undefined; routePlanId: string; shopDomain: string }): Promise<{
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
    const prepareGeometry = this.deferredTollGeometry(before, input.payload);
    const preparedRouteGeometry = prepareGeometry === undefined ? await this.prepareTollGeometry(before, input.payload) : undefined;
    const saved = await this.repository.saveRoutePlan({ ...input, ...(preparedRouteGeometry === undefined ? {} : { preparedRouteGeometry }), ...(prepareGeometry === undefined ? {} : { prepareGeometry }) });
    if (saved === null) return null;
    if (preparedRouteGeometry !== undefined || prepareGeometry !== undefined) return saved;
    const routeShapeChanged =
      shouldCheckShape &&
      (before === null || computeRouteShapeSignature(before) !== computeRouteShapeSignature(saved.detail));
    const detail = routeShapeChanged ? await this.refreshRouteGeometry(saved.detail, 'SHAPE_MUTATION') : saved.detail;
    const departureTimeChanged = saved.operations.some(
      (operation) => operation.name === 'departure_time' && operation.status === 'applied'
    );
    const detailWithTiming =
      departureTimeChanged && !routeShapeChanged ? await this.refreshRouteGeometry(detail, 'EXPLICIT_REFRESH') : detail;
    return {
      detail: detailWithTiming,
      operations: saved.operations
    };
  }

  async updateRoutePlanOptions(input: UpdateRoutePlanOptionsInput): Promise<RoutePlanDetail | null> {
    await this.assertNoActiveUserOptimizationJob(input);
    const before = await this.repository.findRoutePlanDetail(input);
    const preparedRouteGeometry = await this.prepareTollGeometry(before, input.payload);
    const updated = await this.repository.updateRoutePlanOptions({ ...input, ...(preparedRouteGeometry === undefined ? {} : { preparedRouteGeometry }) });
    if (preparedRouteGeometry !== undefined) return updated;
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
    const prepareGeometry = this.deferredTollGeometry(before, input.payload);
    const preparedRouteGeometry = prepareGeometry === undefined ? await this.prepareTollGeometry(before, input.payload, input.mutationContext?.source === 'route_optimization_job') : undefined;
    const updated = await this.repository.updateRoutePlanStops({ ...input, ...(preparedRouteGeometry === undefined ? {} : { preparedRouteGeometry }), ...(prepareGeometry === undefined ? {} : { prepareGeometry }) });
    if (preparedRouteGeometry !== undefined || prepareGeometry !== undefined) return updated;
    if (updated === null) return null;
    return this.refreshRouteGeometryIfShapeChanged({
      before,
      after: updated,
      source: input.mutationContext?.source === 'route_optimization_job' ? 'OPTIMIZATION_APPLY' : 'SHAPE_MUTATION'
    });
  }

  private deferredTollGeometry(
    before: RoutePlanDetail | null,
    payload: Pick<SaveRoutePlanInput['payload'], 'tollPolicy' | 'stops'>,
  ): SaveRoutePlanInput['prepareGeometry'] {
    if (before === null || (!avoidsTolls(payload.tollPolicy ?? before.routePlan.tollPolicy) && !avoidsTolls(before.routePlan.tollPolicy))) return undefined;
    const hasNewStop = payload.stops?.some((entry) => !before.stops.some((stop) => stop.shopifyOrderGid === entry.shopifyOrderGid
      && (entry.deliveryStopId == null || stop.deliveryStopId === entry.deliveryStopId))) ?? false;
    // New order coordinates and canonical stop IDs are resolved inside the repository transaction.
    return hasNewStop ? (candidate) => this.buildTollGeometry(candidate) : undefined;
  }

  private async prepareTollGeometry(
    before: RoutePlanDetail | null,
    payload: Pick<SaveRoutePlanInput['payload'], 'routeEndMode' | 'tollPolicy' | 'stops'>,
    force = false,
  ): Promise<SaveRoutePlanInput['preparedRouteGeometry']> {
    if (before === null) return undefined;
    const tollPolicy = payload.tollPolicy ?? before.routePlan.tollPolicy;
    if (!avoidsTolls(tollPolicy) && !avoidsTolls(before.routePlan.tollPolicy)) return undefined;
    const stops = payload.stops === undefined ? before.stops : payload.stops.map((entry) => {
      const stop = before.stops.find((candidate) => candidate.shopifyOrderGid === entry.shopifyOrderGid
        && (entry.deliveryStopId == null || candidate.deliveryStopId === entry.deliveryStopId));
      if (stop === undefined) throw new RoutePlanGeometryRefreshFailedError('Toll-avoiding route requires resolved stop coordinates before it can change. Existing route was preserved.');
      return { ...stop, sequence: entry.sequence };
    });
    const candidate: RoutePlanDetail = { ...before, stops, routePlan: { ...before.routePlan,
      ...(tollPolicy === undefined ? {} : { tollPolicy }),
      routeEndMode: payload.routeEndMode ?? before.routePlan.routeEndMode } };
    if (!force && computeRouteShapeSignature(candidate) === computeRouteShapeSignature(before)) return undefined;
    return { expectedShapeSignature: computeRouteShapeSignature(before), result: await this.buildTollGeometry(candidate) };
  }

  private async buildTollGeometry(candidate: RoutePlanDetail): Promise<RoutePlanRouteResult> {
    if (this.routeGeometryProvider === undefined) {
      throw new RoutePlanGeometryRefreshFailedError('Toll-avoiding route provider is unavailable. Existing route was preserved.');
    }
    if (!hasValidCoordinates(candidate.routePlan.depot.latitude, candidate.routePlan.depot.longitude)
      || candidate.stops.some((stop) => stop.locationDiagnostic?.routeable === false
        || !hasValidCoordinates(stop.coordinates.latitude, stop.coordinates.longitude))) {
      throw new RoutePlanGeometryRefreshFailedError('Toll-avoiding route requires valid depot and stop coordinates. Existing route was preserved.');
    }
    let result: RoutePlanRouteResult;
    try { result = await this.routeGeometryProvider.buildRoute(candidate); }
    catch { throw new RoutePlanGeometryRefreshFailedError('Toll policy could not be applied. Existing route was preserved.'); }
    if (!isCompleteOrderDataRouteResult(candidate, result)) {
      throw new RoutePlanGeometryRefreshFailedError('Toll policy did not produce a complete route. Existing route was preserved.');
    }
    return result;
  }

  private async assertNoActiveUserOptimizationJob(
    input: {
      appId?: string | undefined;
      mutationContext?: SaveRoutePlanInput['mutationContext'];
      routePlanId: string;
      shopDomain: string;
    }
  ): Promise<void> {
    if (input.mutationContext?.source === 'route_optimization_job') return;
    if (this.routeOptimizationJobGuard === undefined) return;
    await this.routeOptimizationJobGuard.reconcileStaleActiveJobs?.({
      appId: input.appId,
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain
    });
    const latestJob = await this.routeOptimizationJobGuard.findLatestJob({
      appId: input.appId,
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain
    });
    if (latestJob !== null && (latestJob.status === 'QUEUED' || latestJob.status === 'RUNNING')) {
      throw new RouteOptimizationJobActiveError();
    }
  }

  private async refreshRouteGeometryById(input: {
    routePlanId: string;
    appId?: string | undefined;
    shopDomain: string;
    source: RouteGeometryCacheSource;
  }): Promise<RoutePlanDetail | null> {
    const detail = await this.repository.findRoutePlanDetail({
      appId: input.appId,
      routePlanId: input.routePlanId,
      shopDomain: input.shopDomain
    });
    if (detail === null) return null;
    if (input.source === 'ORDER_DATA_REFRESH') {
      const status = detail.routePlan.status;
      if (!isRouteReadyStatus(status)) {
        throw new RoutePlanRefreshNotAllowedError(status);
      }
    }
    return this.refreshRouteGeometry(detail, input.source, input);
  }

  private async refreshRouteGeometryIfShapeChanged(input: {
    before: RoutePlanDetail | null;
    after: RoutePlanDetail;
    source: RouteGeometryCacheSource;
  }): Promise<RoutePlanDetail> {
    if (
      input.source !== 'OPTIMIZATION_APPLY'
      && input.before !== null
      && computeRouteShapeSignature(input.before) === computeRouteShapeSignature(input.after)
    ) {
      return input.after;
    }
    return await this.refreshRouteGeometry(input.after, input.source);
  }

  private async refreshRouteGeometry(
    detail: RoutePlanDetail,
    source: RouteGeometryCacheSource,
    scope?: { appId?: string | undefined; shopDomain: string }
  ): Promise<RoutePlanDetail> {
    if (source === 'ORDER_DATA_REFRESH') {
      return this.refreshOrderDataGeometry(detail, scope);
    }
    if (this.routeGeometryProvider === undefined) {
      if (avoidsTolls(detail.routePlan.tollPolicy)) throw new RoutePlanGeometryRefreshFailedError('Toll-avoiding route provider is unavailable. Existing geometry was preserved.');
      return detail;
    }

    const generatedAt = new Date();
    if (
      !hasValidCoordinates(detail.routePlan.depot.latitude, detail.routePlan.depot.longitude) ||
      detail.stops.some((stop) => (
        stop.locationDiagnostic?.routeable === false ||
        !hasValidCoordinates(stop.coordinates.latitude, stop.coordinates.longitude)
      ))
    ) {
      return withRouteGeometryResult(detail, emptyRouteResult(), { generatedAt, source });
    }
    const routeResult = await this.buildRouteSafely(detail);
    if (avoidsTolls(detail.routePlan.tollPolicy) && (routeResult === null || !isCompleteOrderDataRouteResult(detail, routeResult))) {
      throw new RoutePlanGeometryRefreshFailedError('Toll-avoiding route calculation failed. Existing geometry was preserved.');
    }
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

  private async refreshAdminStopOverrideGeometry(
    input: AdminRouteStopOverrideInput,
    detail: RoutePlanDetail,
    guard: AdminRouteStopOverrideRepositoryResult['refreshGuard']
  ): Promise<RoutePlanDetail> {
    if (guard === null || this.routeGeometryProvider === undefined) {
      return withRouteGeometryResult(detail, emptyRouteResult(), { source: 'SHAPE_MUTATION' });
    }
    if (
      !hasValidCoordinates(detail.routePlan.depot.latitude, detail.routePlan.depot.longitude) ||
      detail.stops.some((stop) => (
        stop.locationDiagnostic?.routeable === false ||
        !hasValidCoordinates(stop.coordinates.latitude, stop.coordinates.longitude)
      ))
    ) {
      return withRouteGeometryResult(detail, emptyRouteResult(), { source: 'SHAPE_MUTATION' });
    }

    let routeResult: RoutePlanRouteResult;
    try {
      routeResult = await this.routeGeometryProvider.buildRoute(detail);
    } catch {
      return withRouteGeometryResult(detail, emptyRouteResult(), { source: 'SHAPE_MUTATION' });
    }
    if (!isCompleteOrderDataRouteResult(detail, routeResult)) {
      return withRouteGeometryResult(detail, emptyRouteResult(), { source: 'SHAPE_MUTATION' });
    }
    if (this.repository.commitAdminRouteStopGeometryCache === undefined) {
      return withRouteGeometryResult(detail, emptyRouteResult(), { source: 'SHAPE_MUTATION' });
    }

    const generatedAt = new Date();
    const committed = await this.repository.commitAdminRouteStopGeometryCache({
      appId: input.appId,
      expectedRoutePlanUpdatedAt: guard.expectedRoutePlanUpdatedAt,
      expectedStopUpdatedAts: guard.expectedStopUpdatedAts,
      generatedAt,
      geometry: routeResult.routeGeometry,
      metrics: routeResult.routeMetrics,
      provider: 'osrm',
      providerVersion: null,
      routePlanId: detail.routePlan.id,
      shapeSignature: guard.shapeSignature,
      shopDomain: input.shopDomain,
      source: 'SHAPE_MUTATION',
      stopPoints: routeResult.routeStopPoints
    });
    if (!committed) {
      return await this.repository.findRoutePlanDetail({
        appId: input.appId,
        routePlanId: input.routePlanId,
        shopDomain: input.shopDomain
      }) ?? detail;
    }
    return withRouteGeometryResult(detail, routeResult, { generatedAt, source: 'SHAPE_MUTATION' });
  }

  private async refreshOrderDataGeometry(
    detail: RoutePlanDetail,
    scope?: { appId?: string | undefined; shopDomain: string }
  ): Promise<RoutePlanDetail> {
    if (detail.stops.length === 0) return detail;
    if (this.routeGeometryProvider === undefined) {
      throw new RoutePlanGeometryRefreshFailedError('Route geometry provider is unavailable. Existing geometry was preserved.');
    }
    if (!hasValidCoordinates(detail.routePlan.depot.latitude, detail.routePlan.depot.longitude)) {
      throw new RoutePlanGeometryRefreshFailedError('Route depot coordinates are missing. Existing geometry was preserved.');
    }
    if (detail.stops.some((stop) => (
      stop.locationDiagnostic?.routeable === false ||
      !hasValidCoordinates(stop.coordinates.latitude, stop.coordinates.longitude)
    ))) {
      throw new RoutePlanGeometryRefreshFailedError('One or more route stops have no valid coordinates. Existing geometry was preserved.');
    }

    let routeResult: RoutePlanRouteResult;
    try {
      routeResult = await this.routeGeometryProvider.buildRoute(detail);
    } catch {
      throw new RoutePlanGeometryRefreshFailedError('Route geometry provider failed. Existing geometry was preserved.');
    }
    if (!isCompleteOrderDataRouteResult(detail, routeResult)) {
      throw new RoutePlanGeometryRefreshFailedError('Route geometry provider returned an incomplete route. Existing geometry was preserved.');
    }

    const generatedAt = new Date();
    const source = 'ORDER_DATA_REFRESH';
    if (scope === undefined || this.repository.commitOrderDataRouteGeometryCache === undefined) {
      throw new RoutePlanGeometryRefreshFailedError('Safe route geometry commit is unavailable. Existing geometry was preserved.');
    }
    const committed = await this.repository.commitOrderDataRouteGeometryCache({
      appId: scope.appId,
      expectedRoutePlanUpdatedAt: detail.routePlan.updatedAt,
      generatedAt,
      geometry: routeResult.routeGeometry,
      metrics: routeResult.routeMetrics,
      provider: 'osrm',
      providerVersion: null,
      routePlanId: detail.routePlan.id,
      shapeSignature: computeRouteShapeSignature(detail),
      shopDomain: scope.shopDomain,
      source,
      stopPoints: routeResult.routeStopPoints
    });
    if (!committed) {
      throw new RoutePlanConflictError('Route changed while order data was refreshing. Reload and retry; existing geometry was preserved.');
    }
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

function hasValidCoordinates(latitude: number | null, longitude: number | null): boolean {
  return (
    typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === 'number' &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

function isCompleteOrderDataRouteResult(detail: RoutePlanDetail, result: RoutePlanRouteResult): boolean {
  if (result.routeGeometry === null || result.routeMetrics === null) return false;
  if (
    !isNonNegativeFiniteNumber(result.routeMetrics.distanceMeters) ||
    !isNonNegativeFiniteNumber(result.routeMetrics.durationSeconds) ||
    result.routeGeometry.coordinates.length < 2 ||
    result.routeGeometry.coordinates.some(([longitude, latitude]) => !hasValidCoordinates(latitude, longitude))
  ) return false;
  if (result.routeStopPoints.length !== detail.stops.length) return false;
  const expectedStopIds = new Set(detail.stops.map((stop) => stop.deliveryStopId));
  const actualStopIds = new Set(result.routeStopPoints.map((point) => point.deliveryStopId));
  return (
    actualStopIds.size === expectedStopIds.size &&
    result.routeStopPoints.every((point) => (
      expectedStopIds.has(point.deliveryStopId) &&
      isNonNegativeFiniteNumber(point.distanceFromPreviousMeters) &&
      isNonNegativeFiniteNumber(point.durationFromPreviousSeconds)
    ))
  );
}

function isNonNegativeFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function emptyRouteResult(): RoutePlanRouteResult {
  return { routeGeometry: null, routeMetrics: null, routeStopPoints: [] };
}

function hasRouteMutationPayload(input: SaveRoutePlanInput): boolean {
  return (
    input.payload.departureTime !== undefined ||
    input.payload.driverId !== undefined ||
    input.payload.routeEndMode !== undefined ||
    input.payload.tollPolicy !== undefined ||
    input.payload.deliveryProof !== undefined ||
    input.payload.scheduledStartAt !== undefined ||
    input.payload.stops !== undefined
  );
}

function hasRouteShapePayload(input: SaveRoutePlanInput): boolean {
  return input.payload.routeEndMode !== undefined || input.payload.tollPolicy !== undefined || input.payload.stops !== undefined;
}
