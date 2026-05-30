import type { BootstrapPayload, CanonicalOrderDto, MapProviderStatus, RoutePlanDetailDto, RouteStopDto, StoreSettingsDto } from './types';
import type { RouteOpsPoint } from './maps/geojson';

export type OrderFilters = {
  deliveryArea?: string;
  deliveryDate?: string;
  deliveryStatus?: string;
  health?: string;
  search?: string;
  status?: OrderPlanningStatusFilter;
};

export type OrderPlanningStatusFilter = '' | 'planned' | 'unplanned';

export type OrderFilterState = Required<Omit<OrderFilters, 'status'>> & { status: OrderPlanningStatusFilter };

export function createDefaultOrderFilters(): OrderFilterState {
  return { deliveryArea: '', deliveryDate: '', deliveryStatus: '', health: '', search: '', status: '' };
}

export function buildOrderQuery(filters: OrderFilters): string {
  const params = new URLSearchParams();
  setParam(params, 'deliveryDate', filters.deliveryDate);
  setParam(params, 'deliveryArea', filters.deliveryArea);
  setParam(params, 'deliveryStatus', filters.deliveryStatus);
  setParam(params, 'health', filters.health);
  setParam(params, 'status', filters.status);
  setParam(params, 'search', filters.search);
  return params.toString();
}

export function buildOrderFetchQuery(filters: OrderFilters): string {
  const { deliveryDate: _deliveryDate, ...serverFilters } = filters;
  return buildOrderQuery(serverFilters);
}

export function applyClientOrderFilters(orders: CanonicalOrderDto[], filters: OrderFilters): CanonicalOrderDto[] {
  const deliveryDate = filters.deliveryDate?.trim();
  if (deliveryDate === undefined || deliveryDate === '' || deliveryDate === 'all') return orders;
  return orders.filter((order) => order.deliveryDate === deliveryDate);
}

export function summarizeSelection(orders: CanonicalOrderDto[], selectedOrderIds: ReadonlySet<string>): {
  blockers: string[];
  readySelected: CanonicalOrderDto[];
} {
  const selected = orders.filter((order) => selectedOrderIds.has(order.orderId));
  const blockers = selected.flatMap((order) => order.blockerReasons.map((reason) => `${order.orderName}: ${reason}`));
  return {
    blockers,
    readySelected: selected.filter((order) => order.blockerReasons.length === 0 && order.planningStatus === 'UNPLANNED')
  };
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

export function geometryLabel(detail: RoutePlanDetailDto | null, routerStatus: MapProviderStatus): string {
  if (detail === null) return 'No route selected';
  if (detail.routeGeometry !== null) return 'Road geometry';
  if (routerStatus === 'not_configured') return 'Sequence preview';
  if (detail.stops.every((stop) => stop.coordinates.latitude === null || stop.coordinates.longitude === null)) return 'No coordinates';
  return 'Sequence preview';
}

export function hideSetupActions(bootstrap: BootstrapPayload): boolean {
  return bootstrap.mode === 'plugin';
}

export function storeSettingsToDepotPoint(settings: StoreSettingsDto | null): RouteOpsPoint | null {
  if (settings === null) return null;
  if (!isValidLatitude(settings.defaultDepotLatitude) || !isValidLongitude(settings.defaultDepotLongitude)) return null;
  const address = settings.defaultDepotAddress?.trim();
  return {
    addressLabel: address === undefined || address === '' ? 'Store address' : address,
    id: 'settings-store-depot',
    kind: 'depot',
    label: 'Store',
    latitude: settings.defaultDepotLatitude,
    longitude: settings.defaultDepotLongitude
  };
}

function setParam(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value === undefined || value.trim() === '' || value === 'all') return;
  params.set(key, value.trim());
}

function isValidLatitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}
