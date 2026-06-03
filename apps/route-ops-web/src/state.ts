import type {
  BootstrapPayload,
  CanonicalOrderDto,
  MapProviderStatus,
  RoutePlanDetailDto,
  RouteStopDto,
  StoreSettingsDto
} from './types';
import type { RouteOpsPoint } from './maps/geojson';
import { getStateCopy } from './i18n';

export type OrderFilters = {
  deliveryArea?: string;
  deliveryDate?: string;
  deliverySession?: string;
  deliveryStatus?: string;
  health?: string;
  search?: string;
  scope?: OrderScopeFilter;
  serviceType?: string;
  status?: OrderPlanningStatusFilter;
  tab?: OrderTabFilter;
};

export type OrderScopeFilter = 'planning' | 'history';
export type OrderTabFilter = 'all' | 'unplanned' | 'planned' | 'needs_review';
export type OrderPlanningStatusFilter = '' | 'planned' | 'unplanned';

export type OrderFilterState = Required<Omit<OrderFilters, 'status'>> & {
  status: OrderPlanningStatusFilter;
};

export type OrderWorksetContext = {
  routeScopeKey?: string | null;
  routeDate?: string | null;
  scope?: OrderScopeFilter;
  today?: string;
};

export type OrderWorksetUnavailableReason =
  | 'already_planned'
  | 'completed_or_cancelled'
  | 'different_delivery_date'
  | 'different_route_scope'
  | 'missing_address'
  | 'missing_coordinates'
  | 'missing_delivery_date'
  | 'missing_route_scope'
  | 'needs_review';

export type OrderWorksetReason = {
  code: OrderWorksetUnavailableReason;
  label: string;
};

export type OrderWorksetSummary = {
  reasonLabels: string[];
  reasonsByCode: Record<OrderWorksetUnavailableReason, number>;
  selectableCount: number;
  selectableOrderIds: string[];
  selectedCount: number;
  unavailableCount: number;
};

export const ORDER_WORKSET_REASON_LABELS: Record<
  OrderWorksetUnavailableReason,
  string
> = {
  already_planned: 'Already planned',
  completed_or_cancelled: 'Completed/cancelled',
  different_delivery_date: 'Different delivery date',
  different_route_scope: 'Different delivery session',
  missing_address: 'Missing address',
  missing_coordinates: 'Missing coordinates',
  missing_delivery_date: 'Missing delivery date',
  missing_route_scope: 'Missing route scope',
  needs_review: 'Needs review'
};

export function createDefaultOrderFilters(): OrderFilterState {
  return {
    deliveryArea: '',
    deliveryDate: '',
    deliverySession: '',
    deliveryStatus: '',
    health: '',
    scope: 'planning',
    search: '',
    serviceType: '',
    status: '',
    tab: 'unplanned'
  };
}

export function buildOrderQuery(filters: OrderFilters): string {
  const params = new URLSearchParams();
  setParam(params, 'deliveryDate', filters.deliveryDate);
  setParam(params, 'deliveryArea', filters.deliveryArea);
  setParam(params, 'deliveryStatus', filters.deliveryStatus);
  setParam(params, 'health', filters.health);
  setRequiredParam(params, 'scope', filters.scope);
  setRequiredParam(params, 'tab', filters.tab);
  if (filters.tab === undefined) setParam(params, 'status', filters.status);
  setParam(params, 'serviceType', filters.serviceType);
  setParam(params, 'deliverySession', filters.deliverySession);
  setParam(params, 'search', filters.search);
  return params.toString();
}

export function buildOrderFetchQuery(filters: OrderFilters): string {
  const { deliveryDate: _deliveryDate, ...serverFilters } = filters;
  return buildOrderQuery(serverFilters);
}

export function applyClientOrderFilters(
  orders: CanonicalOrderDto[],
  filters: OrderFilters
): CanonicalOrderDto[] {
  const deliveryDate = filters.deliveryDate?.trim();
  if (deliveryDate === undefined || deliveryDate === '' || deliveryDate === 'all')
    return orders;
  return orders.filter((order) => order.deliveryDate === deliveryDate);
}

export function matchesPlanningScope(
  order: CanonicalOrderDto,
  today: string
): boolean {
  if (isCompletedOrCancelledOrder(order)) return false;
  if (order.deliveryDate !== null) return order.deliveryDate >= today;
  return isNeedsReviewOrder(order);
}

export function matchesOrderTab(
  order: CanonicalOrderDto,
  tab: OrderTabFilter,
  today: string
): boolean {
  if (!matchesPlanningScope(order, today)) return false;
  if (tab === 'all')
    return (
      matchesOrderTab(order, 'unplanned', today) ||
      matchesOrderTab(order, 'planned', today) ||
      matchesOrderTab(order, 'needs_review', today)
    );
  if (tab === 'planned') return isPlannedOrder(order);
  if (tab === 'needs_review') return isNeedsReviewOrder(order);
  return !isPlannedOrder(order) && isRoutePlanEligibleForWorkset(order);
}

export function getOrderWorksetUnavailableReasons(
  order: CanonicalOrderDto,
  context: OrderWorksetContext = {}
): OrderWorksetReason[] {
  const reasons = new Set<OrderWorksetUnavailableReason>();
  if (isCompletedOrCancelledOrder(order)) reasons.add('completed_or_cancelled');
  if (isPlannedOrder(order)) reasons.add('already_planned');
  if (order.deliveryDate === null) reasons.add('missing_delivery_date');
  if (!hasRouteScope(order)) reasons.add('missing_route_scope');
  if (!hasResolvedCoordinates(order))
    reasons.add(
      hasGeocodableAddress(order) ? 'missing_coordinates' : 'missing_address'
    );
  if (isNeedsReviewOrder(order)) reasons.add('needs_review');
  if (
    context.routeDate !== undefined &&
    context.routeDate !== null &&
    order.deliveryDate !== null &&
    order.deliveryDate !== context.routeDate
  ) {
    reasons.add('different_delivery_date');
  }
  const routeScopeKey = getRouteScopeKey(order);
  if (
    context.routeScopeKey !== undefined &&
    context.routeScopeKey !== null &&
    routeScopeKey !== null &&
    routeScopeKey !== context.routeScopeKey
  ) {
    reasons.add('different_route_scope');
  }
  if (
    order.routeEligible === true &&
    reasons.has('needs_review') &&
    order.blockerReasons.length === 0 &&
    order.metadataResolved !== false
  ) {
    reasons.delete('needs_review');
  }
  return [...reasons].map((code) => ({
    code,
    label: ORDER_WORKSET_REASON_LABELS[code]
  }));
}

export function formatOrderWorksetUnavailableReasons(
  reasons: OrderWorksetReason[],
  locale: string | null | undefined = 'en-CA'
): OrderWorksetReason[] {
  const labels = getStateCopy(locale).worksetReasons;
  return reasons.map((reason) => ({ ...reason, label: labels[reason.code] }));
}

export function isOrderWorksetEligible(
  order: CanonicalOrderDto,
  context: OrderWorksetContext = {}
): boolean {
  return (
    getOrderWorksetUnavailableReasons(order, context).length === 0 &&
    isRoutePlanEligibleForWorkset(order)
  );
}

export function summarizeOrderWorkset(
  orders: CanonicalOrderDto[],
  selectedOrderIds: ReadonlySet<string>,
  context: OrderWorksetContext = {},
  locale: string | null | undefined = 'en-CA'
): OrderWorksetSummary {
  const labels = getStateCopy(locale).worksetReasons;
  const reasonsByCode = Object.fromEntries(
    Object.keys(ORDER_WORKSET_REASON_LABELS).map((code) => [code, 0])
  ) as Record<OrderWorksetUnavailableReason, number>;
  const selectableOrderIds: string[] = [];
  for (const order of orders) {
    const reasons = getOrderWorksetUnavailableReasons(order, context);
    if (reasons.length === 0 && isRoutePlanEligibleForWorkset(order)) {
      selectableOrderIds.push(order.orderId);
      continue;
    }
    for (const reason of reasons) reasonsByCode[reason.code] += 1;
  }
  const reasonLabels = (
    Object.entries(reasonsByCode) as Array<
      [OrderWorksetUnavailableReason, number]
    >
  )
    .filter(([, count]) => count > 0)
    .map(([code, count]) => `${labels[code]} ${count}`);
  return {
    reasonLabels,
    reasonsByCode,
    selectableCount: selectableOrderIds.length,
    selectableOrderIds,
    selectedCount: selectableOrderIds.filter((orderId) =>
      selectedOrderIds.has(orderId)
    ).length,
    unavailableCount: orders.length - selectableOrderIds.length
  };
}

export function summarizeSelection(
  orders: CanonicalOrderDto[],
  selectedOrderIds: ReadonlySet<string>
): {
  blockers: string[];
  readySelected: CanonicalOrderDto[];
} {
  const selected = orders.filter((order) => selectedOrderIds.has(order.orderId));
  const blockers = selected.flatMap((order) =>
    order.blockerReasons.map((reason) => `${order.orderName}: ${reason}`)
  );
  return {
    blockers,
    readySelected: selected.filter(
      (order) =>
        order.blockerReasons.length === 0 &&
        order.planningStatus === 'UNPLANNED'
    )
  };
}

function isRoutePlanEligibleForWorkset(order: CanonicalOrderDto): boolean {
  if (isPlannedOrder(order)) return false;
  return (
    order.routeEligible === true ||
    (order.routeEligible !== false &&
      order.blockerReasons.length === 0 &&
      order.planningStatus === 'UNPLANNED' &&
      hasRouteScope(order) &&
      order.deliveryDate !== null &&
      hasResolvedCoordinates(order))
  );
}

function isPlannedOrder(order: CanonicalOrderDto): boolean {
  return order.routePlanId !== null || order.planningStatus !== 'UNPLANNED';
}

function isNeedsReviewOrder(order: CanonicalOrderDto): boolean {
  return (
    order.health === 'needs_review' ||
    order.metadataResolved === false ||
    order.routeEligible === false ||
    order.blockerReasons.length > 0 ||
    order.deliveryDate === null ||
    !hasRouteScope(order) ||
    !hasResolvedCoordinates(order)
  );
}

function isCompletedOrCancelledOrder(order: CanonicalOrderDto): boolean {
  return (
    order.deliveryStatus === 'completed' ||
    order.status === 'cancelled' ||
    order.status === 'CANCELLED'
  );
}

function hasRouteScope(order: CanonicalOrderDto): boolean {
  return isPresent(order.serviceType) && isPresent(order.deliverySession);
}

function getRouteScopeKey(order: CanonicalOrderDto): string | null {
  if (!hasRouteScope(order) || order.deliveryDate === null) return null;
  return [
    order.deliveryDate,
    order.serviceType,
    order.deliverySession,
    order.timeWindowStart ?? '',
    order.timeWindowEnd ?? ''
  ].join('|');
}

function hasResolvedCoordinates(order: CanonicalOrderDto): boolean {
  return (
    typeof order.coordinates.latitude === 'number' &&
    Number.isFinite(order.coordinates.latitude) &&
    typeof order.coordinates.longitude === 'number' &&
    Number.isFinite(order.coordinates.longitude)
  );
}

function hasGeocodableAddress(order: CanonicalOrderDto): boolean {
  return [
    order.shippingAddress.address1,
    order.shippingAddress.city,
    order.shippingAddress.province,
    order.shippingAddress.postalCode
  ].some(isPresent);
}

function isPresent(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim().length > 0;
}

export function routeStopOrderKey(stop: RouteStopDto): string {
  return stop.deliveryStopId || stop.sourceOrderId || stop.orderId;
}

export function hasStopSequenceChanged(savedStops: RouteStopDto[] | null | undefined, draftStops: RouteStopDto[]): boolean {
  if (savedStops === null || savedStops === undefined) return false;
  if (savedStops.length !== draftStops.length) return true;
  return savedStops.some((stop, index) => {
    const draftStop = draftStops[index];
    return draftStop === undefined || routeStopOrderKey(stop) !== routeStopOrderKey(draftStop);
  });
}

export function moveStop(stops: RouteStopDto[], deliveryStopId: string, direction: -1 | 1): RouteStopDto[] {
  const index = stops.findIndex((stop) => stop.deliveryStopId === deliveryStopId);
  if (index < 0) return stops;
  const target = index + direction;
  if (target < 0 || target >= stops.length) return stops;
  const next = [...stops];
  const [removed] = next.splice(index, 1);
  if (removed === undefined) return stops;
  next.splice(target, 0, removed);
  return resequenceStops(next);
}


export function moveStopBefore(stops: RouteStopDto[], draggedStopId: string, targetStopId: string): RouteStopDto[] {
  if (draggedStopId === targetStopId) return stops;
  const draggedIndex = stops.findIndex((stop) => stop.deliveryStopId === draggedStopId);
  const targetIndex = stops.findIndex((stop) => stop.deliveryStopId === targetStopId);
  if (draggedIndex < 0 || targetIndex < 0) return stops;
  const next = [...stops];
  const [dragged] = next.splice(draggedIndex, 1);
  if (dragged === undefined) return stops;
  const adjustedTargetIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(adjustedTargetIndex, 0, dragged);
  return resequenceStops(next);
}

export function resequenceStops(stops: RouteStopDto[]): RouteStopDto[] {
  return stops.map((stop, index) => ({ ...stop, sequence: index + 1 }));
}

export function deriveRouteStats(detail: RoutePlanDetailDto | null): {
  attempted: number;
  completed: number;
  missingCoordinates: number;
  stops: number;
} {
  if (detail === null) return { attempted: 0, completed: 0, missingCoordinates: 0, stops: 0 };
  return detail.stops.reduce(
    (stats, stop) => ({
      attempted: stats.attempted + (stop.status.toUpperCase() === 'ATTEMPTED' ? 1 : 0),
      completed: stats.completed + (stop.status.toUpperCase() === 'COMPLETED' ? 1 : 0),
      missingCoordinates: stats.missingCoordinates + (stop.coordinates.latitude === null || stop.coordinates.longitude === null ? 1 : 0),
      stops: stats.stops + 1
    }),
    { attempted: 0, completed: 0, missingCoordinates: 0, stops: 0 }
  );
}

export function mapReadiness(input: {
  coordinatesCount: number;
  mapStatus: MapProviderStatus;
}): 'interactive_map' | 'no_coordinates' | 'provider_not_configured' {
  void input.coordinatesCount;
  if (input.mapStatus === 'not_configured') return 'provider_not_configured';
  return 'interactive_map';
}

export function geometryLabel(detail: RoutePlanDetailDto | null, routerStatus: MapProviderStatus, locale: string | null | undefined = 'en-CA'): string {
  const t = getStateCopy(locale).geometry;
  if (detail === null) return t.noRouteSelected;
  if (detail.routeGeometry !== null) return t.roadGeometry;
  if (countRoutableRoutePoints(detail) < 2) return t.noCoordinates;
  if (routerStatus === 'not_configured') return t.routerNotConfigured;
  return t.roadGeometryUnavailable;
}

function countRoutableRoutePoints(detail: RoutePlanDetailDto): number {
  const depot = detail.routePlan.depot;
  const points = [
    depot === null ? null : { latitude: depot.latitude, longitude: depot.longitude },
    ...detail.stops.map((stop) => stop.coordinates)
  ];
  return points.filter((point): point is { latitude: number; longitude: number } =>
    point !== null &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude)
  ).length;
}

export function hideSetupActions(bootstrap: BootstrapPayload): boolean {
  return bootstrap.mode === 'plugin';
}

export function storeSettingsToDepotPoint(settings: StoreSettingsDto | null, locale: string | null | undefined = settings?.locale): RouteOpsPoint | null {
  if (settings === null) return null;
  if (!isValidLatitude(settings.defaultDepotLatitude) || !isValidLongitude(settings.defaultDepotLongitude)) return null;
  const address = settings.defaultDepotAddress?.trim();
  return {
    addressLabel: address === undefined || address === '' ? getStateCopy(locale).storeAddress : address,
    id: 'settings-store-depot',
    kind: 'depot',
    label: getStateCopy(locale).store,
    latitude: settings.defaultDepotLatitude,
    longitude: settings.defaultDepotLongitude
  };
}

function setParam(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value === undefined || value.trim() === '' || value === 'all') return;
  params.set(key, value.trim());
}

function setRequiredParam(
  params: URLSearchParams,
  key: string,
  value: string | undefined
): void {
  if (value === undefined || value.trim() === '') return;
  params.set(key, value.trim());
}

function isValidLatitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}
