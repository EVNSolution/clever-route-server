import type {
  ApiEnvelope,
  BootstrapPayload,
  BulkGeocodeOrdersResponse,
  DriversResponse,
  GeocodeOrderResponse,
  GeocodeSettingsResponse,
  NotificationMutationResponse,
  NotificationsResponse,
  DeliveryCustomerAdminMemoResponse,
  OrderCustomerNoteContextResponse,
  OrderMetadataDiagnosticsResponse,
  OrderMutationResponse,
  OrdersResponse,
  RouteDeleteResponse,
  RouteOptimizationJobResponse,
  RouteGroupingDetailDto,
  RoutePlanDetailDto,
  RouteSaveResponse,
  RoutesResponse,
  SettingsResponse,
  StoreSettingsDto,
  WooSyncResponse,
  WooSyncStatusResponse,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function getBootstrap(): Promise<BootstrapPayload> {
  return apiGet<BootstrapPayload>("/admin/ui/app/api/bootstrap");
}

export async function getOrders(query: string): Promise<OrdersResponse> {
  return apiGet<OrdersResponse>(
    query === ""
      ? "/admin/ui/app/api/orders"
      : `/admin/ui/app/api/orders?${query}`,
  );
}

export async function getNotifications(
  query = "",
): Promise<NotificationsResponse> {
  return apiGet<NotificationsResponse>(
    query === ""
      ? "/admin/ui/app/api/notifications"
      : `/admin/ui/app/api/notifications?${query}`,
  );
}

export async function markNotificationRead(input: {
  csrfToken: string;
  notificationId: string;
}): Promise<NotificationMutationResponse> {
  return apiMutation<NotificationMutationResponse>(
    `/admin/ui/app/api/notifications/${encodeURIComponent(input.notificationId)}/read`,
    "PATCH",
    input.csrfToken,
    {},
  );
}


export type NotificationChangeStreamSubscription = {
  close(): void;
};

type NotificationChangeEventSource = Pick<
  EventSource,
  'addEventListener' | 'close' | 'removeEventListener'
> & {
  onerror: ((this: EventSource, event: Event) => unknown) | null;
};

type NotificationChangeEventSourceConstructor = new (
  url: string,
) => NotificationChangeEventSource;

export function openNotificationChangeStream(input: {
  onNotificationsChanged: () => void;
}): NotificationChangeStreamSubscription | null {
  const EventSourceConstructor = globalThis.EventSource as
    | NotificationChangeEventSourceConstructor
    | undefined;
  if (EventSourceConstructor === undefined) return null;

  const eventSource = new EventSourceConstructor(
    withWorkspaceQuery('/admin/ui/app/api/notifications/stream'),
  );
  const onNotificationsChanged = (): void => input.onNotificationsChanged();
  eventSource.addEventListener('notifications_changed', onNotificationsChanged);
  eventSource.onerror = () => undefined;

  return {
    close() {
      eventSource.removeEventListener(
        'notifications_changed',
        onNotificationsChanged,
      );
      eventSource.close();
    },
  };
}

export async function getOrderCustomerNoteContext(input: {
  csrfToken: string;
  orderId: string;
}): Promise<OrderCustomerNoteContextResponse> {
  return apiMutation<OrderCustomerNoteContextResponse>(
    `/admin/ui/app/api/orders/${encodeURIComponent(input.orderId)}/customer-note-context`,
    "POST",
    input.csrfToken,
    {},
  );
}

export async function patchDeliveryCustomerAdminMemo(input: {
  adminMemo: string | null;
  csrfToken: string;
  profileId: string;
}): Promise<DeliveryCustomerAdminMemoResponse> {
  return apiMutation<DeliveryCustomerAdminMemoResponse>(
    `/admin/ui/app/api/delivery-customers/${encodeURIComponent(input.profileId)}/admin-memo`,
    "PATCH",
    input.csrfToken,
    { adminMemo: input.adminMemo },
  );
}

export async function getOrderMetadataDiagnostics(
  orderId: string,
): Promise<OrderMetadataDiagnosticsResponse> {
  return apiGet<OrderMetadataDiagnosticsResponse>(
    `/admin/ui/app/api/orders/${encodeURIComponent(orderId)}/metadata-diagnostics`,
  );
}

export async function patchOrderMetadata(input: {
  csrfToken: string;
  orderId: string;
  patch: Record<string, string | null>;
  scope?: "history" | "planning";
}): Promise<OrderMutationResponse> {
  return apiMutation<OrderMutationResponse>(
    appendRouteOpsScope(
      `/admin/ui/app/api/orders/${encodeURIComponent(input.orderId)}/metadata`,
      input.scope,
    ),
    "PATCH",
    input.csrfToken,
    input.patch,
  );
}

export async function patchOrderCoordinates(input: {
  csrfToken: string;
  latitude: number;
  longitude: number;
  orderId: string;
  source: "manual" | "map_click";
}): Promise<OrderMutationResponse> {
  return apiMutation<OrderMutationResponse>(
    `/admin/ui/app/api/orders/${encodeURIComponent(input.orderId)}/coordinates`,
    "PATCH",
    input.csrfToken,
    {
      latitude: input.latitude,
      longitude: input.longitude,
      source: input.source,
    },
  );
}

export async function geocodeOrder(input: {
  address?: Record<string, string | null>;
  csrfToken: string;
  orderId: string;
  save: boolean;
}): Promise<GeocodeOrderResponse> {
  return apiMutation<GeocodeOrderResponse>(
    `/admin/ui/app/api/orders/${encodeURIComponent(input.orderId)}/geocode`,
    "POST",
    input.csrfToken,
    {
      ...(input.address === undefined ? {} : { address: input.address }),
      save: input.save,
    },
  );
}

export async function bulkGeocodeOrders(input: {
  csrfToken: string;
  query: string;
}): Promise<BulkGeocodeOrdersResponse> {
  return apiMutation<BulkGeocodeOrdersResponse>(
    input.query === ""
      ? "/admin/ui/app/api/orders/geocode"
      : `/admin/ui/app/api/orders/geocode?${input.query}`,
    "POST",
    input.csrfToken,
    {},
  );
}

export async function getBulkGeocodeJob(
  jobId: string,
): Promise<BulkGeocodeOrdersResponse> {
  return apiGet<BulkGeocodeOrdersResponse>(
    `/admin/ui/app/api/orders/geocode/${encodeURIComponent(jobId)}`,
  );
}

export async function requestWooOrderSync(input: {
  csrfToken: string;
  pageSize?: number;
}): Promise<WooSyncResponse> {
  return apiMutation<WooSyncResponse>(
    "/admin/ui/app/api/orders/sync",
    "POST",
    input.csrfToken,
    {
      ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
    },
  );
}

export async function getWooOrderSyncRun(
  syncRunId: string,
): Promise<WooSyncStatusResponse> {
  return apiGet<WooSyncStatusResponse>(
    `/admin/ui/app/api/orders/sync/${encodeURIComponent(syncRunId)}`,
  );
}

export async function getLatestWooOrderSync(): Promise<WooSyncStatusResponse> {
  return apiGet<WooSyncStatusResponse>("/admin/ui/app/api/orders/sync/latest");
}

export async function geocodeSettings(input: {
  csrfToken: string;
  defaultDepotAddress: string;
  locale: string;
}): Promise<GeocodeSettingsResponse> {
  return apiMutation<GeocodeSettingsResponse>(
    "/admin/ui/app/api/settings/geocode",
    "POST",
    input.csrfToken,
    {
      defaultDepotAddress: input.defaultDepotAddress,
      locale: input.locale,
    },
  );
}

export async function getRoutes(query = ""): Promise<RoutesResponse> {
  return apiGet<RoutesResponse>(
    query === ""
      ? "/admin/ui/app/api/routes"
      : `/admin/ui/app/api/routes?${query}`,
  );
}


export async function createRouteGrouping(input: {
  csrfToken: string;
  groupingName: string;
  orderIds: string[];
  planDate: string;
}): Promise<{ routeGroup: RouteGroupingDetailDto }> {
  return apiMutation<{ routeGroup: RouteGroupingDetailDto }>(
    "/admin/ui/app/api/route-groups",
    "POST",
    input.csrfToken,
    input,
  );
}

export async function getRouteGrouping(
  routeGroupId: string,
): Promise<{ routeGroup: RouteGroupingDetailDto }> {
  return apiGet<{ routeGroup: RouteGroupingDetailDto }>(
    `/admin/ui/app/api/route-groups/${encodeURIComponent(routeGroupId)}`,
  );
}

export async function deleteRouteGrouping(routeGroupId: string, csrfToken: string): Promise<{ deleted: boolean; deletedChildRoutePlanCount: number; groupingId: string }> {
  return apiMutation<{ deleted: boolean; deletedChildRoutePlanCount: number; groupingId: string }>(
    `/admin/ui/app/api/route-groups/${encodeURIComponent(routeGroupId)}`,
    "DELETE",
    csrfToken,
    {},
  );
}

export async function saveRouteGroupingPolygons(input: {
  csrfToken: string;
  deletePolygonIds?: string[];
  expectedUpdatedAt: string;
  polygons: Array<{
    closed: boolean;
    color?: string | null;
    driverId?: string | null;
    geometry: unknown;
    id?: string | null;
    label: string;
  }>;
  routeGroupId: string;
}): Promise<{ routeGroup: RouteGroupingDetailDto }> {
  return apiMutation<{ routeGroup: RouteGroupingDetailDto }>(
    `/admin/ui/app/api/route-groups/${encodeURIComponent(input.routeGroupId)}/polygons`,
    "PATCH",
    input.csrfToken,
    {
      ...(input.deletePolygonIds === undefined ? {} : { deletePolygonIds: input.deletePolygonIds }),
      expectedUpdatedAt: input.expectedUpdatedAt,
      polygons: input.polygons,
    },
  );
}

export async function resolveRouteGroupingAssignments(input: {
  assignments: Array<{ assignedDriverId: string; orderId: string }>;
  csrfToken: string;
  routeGroupId: string;
}): Promise<{ routeGroup: RouteGroupingDetailDto }> {
  return apiMutation<{ routeGroup: RouteGroupingDetailDto }>(
    `/admin/ui/app/api/route-groups/${encodeURIComponent(input.routeGroupId)}/assignments`,
    "PATCH",
    input.csrfToken,
    { assignments: input.assignments },
  );
}

export async function generateRouteGroupingChildRoutes(input: {
  confirmRisk?: boolean;
  csrfToken: string;
  routeGroupId: string;
}): Promise<{ routeGroup: RouteGroupingDetailDto }> {
  return apiMutation<{ routeGroup: RouteGroupingDetailDto }>(
    `/admin/ui/app/api/route-groups/${encodeURIComponent(input.routeGroupId)}/generate-child-routes`,
    "POST",
    input.csrfToken,
    { confirmRisk: input.confirmRisk === true },
  );
}


export async function getRouteDetail(
  routePlanId: string,
): Promise<RoutePlanDetailDto> {
  return apiGet<RoutePlanDetailDto>(
    `/admin/ui/app/api/routes/${encodeURIComponent(routePlanId)}`,
  );
}

export async function createRoute(input: {
  csrfToken: string;
  depotAddress: string | null;
  depotLatitude: number | null;
  depotLongitude: number | null;
  orderIds: string[];
  planDate: string;
  routeName: string;
  scope?: "history" | "planning";
}): Promise<{ routePlan: { id: string } }> {
  return apiMutation<{ routePlan: { id: string } }>(
    appendRouteOpsScope("/admin/ui/app/api/routes", input.scope),
    "POST",
    input.csrfToken,
    input,
  );
}

export async function deleteRoute(
  routePlanId: string,
  csrfToken: string,
): Promise<RouteDeleteResponse> {
  return apiMutation<RouteDeleteResponse>(
    `/admin/ui/app/api/routes/${encodeURIComponent(routePlanId)}`,
    "DELETE",
    csrfToken,
    {},
  );
}

export async function saveRoute(input: {
  csrfToken: string;
  departureTime?: string | null;
  driverId?: string | null;
  expectedUpdatedAt?: string;
  routeEndMode?: RoutePlanDetailDto["routePlan"]["routeEndMode"];
  routePlanId: string;
  stops?: Array<{ deliveryStopId: string; sourceOrderId: string }>;
}): Promise<RouteSaveResponse> {
  return apiMutation<RouteSaveResponse>(
    `/admin/ui/app/api/routes/${encodeURIComponent(input.routePlanId)}`,
    "PATCH",
    input.csrfToken,
    {
      ...(Object.hasOwn(input, "departureTime")
        ? { departureTime: input.departureTime ?? null }
        : {}),
      ...(Object.hasOwn(input, "driverId")
        ? { driverId: input.driverId ?? null }
        : {}),
      ...(input.expectedUpdatedAt === undefined
        ? {}
        : { expectedUpdatedAt: input.expectedUpdatedAt }),
      ...(input.routeEndMode === undefined
        ? {}
        : { routeEndMode: input.routeEndMode }),
      ...(input.stops === undefined ? {} : { stops: input.stops }),
    },
  );
}

export async function publishRoute(
  routePlanId: string,
  csrfToken: string,
): Promise<RoutePlanDetailDto> {
  return apiMutation<RoutePlanDetailDto>(
    `/admin/ui/app/api/routes/${encodeURIComponent(routePlanId)}/publish`,
    "POST",
    csrfToken,
    {},
  );
}

export async function saveStopSequence(
  routePlanId: string,
  csrfToken: string,
  stops: Array<{ deliveryStopId: string; sourceOrderId: string }>,
): Promise<RoutePlanDetailDto> {
  return apiMutation<RoutePlanDetailDto>(
    `/admin/ui/app/api/routes/${encodeURIComponent(routePlanId)}/stops`,
    "PATCH",
    csrfToken,
    { stops },
  );
}

export async function saveRouteOptions(
  routePlanId: string,
  csrfToken: string,
  routeEndMode: RoutePlanDetailDto["routePlan"]["routeEndMode"],
): Promise<RoutePlanDetailDto> {
  return apiMutation<RoutePlanDetailDto>(
    `/admin/ui/app/api/routes/${encodeURIComponent(routePlanId)}/options`,
    "PATCH",
    csrfToken,
    { routeEndMode },
  );
}

export async function createRouteOptimizationJob(
  routePlanId: string,
  csrfToken: string,
): Promise<RouteOptimizationJobResponse> {
  return apiMutation<RouteOptimizationJobResponse>(
    `/admin/ui/app/api/routes/${encodeURIComponent(routePlanId)}/optimize-jobs`,
    "POST",
    csrfToken,
    {},
  );
}

export async function getLatestRouteOptimizationJob(
  routePlanId: string,
): Promise<RouteOptimizationJobResponse> {
  return apiGet<RouteOptimizationJobResponse>(
    `/admin/ui/app/api/routes/${encodeURIComponent(routePlanId)}/optimize-jobs/latest`,
  );
}

export async function getRouteOptimizationJob(
  routePlanId: string,
  jobId: string,
): Promise<RouteOptimizationJobResponse> {
  return apiGet<RouteOptimizationJobResponse>(
    `/admin/ui/app/api/routes/${encodeURIComponent(routePlanId)}/optimize-jobs/${encodeURIComponent(jobId)}`,
  );
}

export async function optimizeRoute(
  routePlanId: string,
  csrfToken: string,
): Promise<RouteOptimizationJobResponse> {
  return createRouteOptimizationJob(routePlanId, csrfToken);
}

export async function assignDriver(
  routePlanId: string,
  csrfToken: string,
  driverId: string | null,
): Promise<RoutePlanDetailDto> {
  return apiMutation<RoutePlanDetailDto>(
    `/admin/ui/app/api/routes/${encodeURIComponent(routePlanId)}/driver`,
    "PATCH",
    csrfToken,
    { driverId },
  );
}

export async function getDrivers(): Promise<DriversResponse> {
  return apiGet<DriversResponse>("/admin/ui/app/api/drivers");
}

export async function createDriver(input: {
  csrfToken: string;
  displayName: string | null;
  phone: string;
}): Promise<DriversResponse> {
  return apiMutation<DriversResponse>(
    "/admin/ui/app/api/drivers",
    "POST",
    input.csrfToken,
    input,
  );
}

export async function regenerateDriverInviteCode(input: {
  csrfToken: string;
  driverId: string;
}): Promise<DriversResponse> {
  return apiMutation<DriversResponse>(
    `/admin/ui/app/api/drivers/${encodeURIComponent(input.driverId)}/regenerate-invite-code`,
    "POST",
    input.csrfToken,
    {},
  );
}

export async function deleteDriver(input: {
  csrfToken: string;
  driverId: string;
}): Promise<DriversResponse> {
  return apiMutation<DriversResponse>(
    `/admin/ui/app/api/drivers/${encodeURIComponent(input.driverId)}`,
    "DELETE",
    input.csrfToken,
    {},
  );
}

export async function getSettings(): Promise<SettingsResponse> {
  return apiGet<SettingsResponse>("/admin/ui/app/api/settings");
}

export async function saveSettings(input: {
  csrfToken: string;
  defaultDepotAddress: string | null;
  defaultDepotLatitude: number | null;
  defaultDepotLongitude: number | null;
  locale: string;
  routeOpsUiSettings: StoreSettingsDto["routeOpsUiSettings"];
  routeScopeConfig?: StoreSettingsDto["routeScopeConfig"];
}): Promise<SettingsResponse> {
  return apiMutation<SettingsResponse>(
    "/admin/ui/app/api/settings",
    "PATCH",
    input.csrfToken,
    input,
  );
}

function appendRouteOpsScope(
  path: string,
  scope: "history" | "planning" | undefined,
): string {
  if (scope === undefined) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}scope=${encodeURIComponent(scope)}`;
}

async function apiGet<T>(url: string): Promise<T> {
  return readEnvelope<T>(
    await fetch(withWorkspaceQuery(url), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }),
  );
}

async function apiMutation<T>(
  url: string,
  method: "DELETE" | "PATCH" | "POST",
  csrfToken: string,
  body: unknown,
): Promise<T> {
  return readEnvelope<T>(
    await fetch(withWorkspaceQuery(url), {
      body: JSON.stringify(body),
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      method,
    }),
  );
}

export function withWorkspaceQuery(
  url: string,
  currentSearch = window.location.search,
): string {
  const current = new URLSearchParams(currentSearch);
  const shopDomain = current.get("shopDomain")?.trim();
  if (shopDomain === undefined || shopDomain === "") return url;

  const separatorIndex = url.indexOf("?");
  const path = separatorIndex === -1 ? url : url.slice(0, separatorIndex);
  const rawQuery = separatorIndex === -1 ? "" : url.slice(separatorIndex + 1);
  const query = new URLSearchParams(rawQuery);
  if (!query.has("shopDomain")) query.set("shopDomain", shopDomain);
  const serialized = query.toString();
  return serialized === "" ? path : `${path}?${serialized}`;
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const payload = (await response
    .json()
    .catch(() => null)) as ApiEnvelope<T> | null;
  if (
    !response.ok ||
    payload === null ||
    payload.error !== null ||
    payload.data === null
  ) {
    const message = payload?.error?.message ?? "CLEVER Route request failed";
    const code = payload?.error?.code ?? "REQUEST_FAILED";
    throw new ApiError(message, response.status, code);
  }
  return payload.data;
}
