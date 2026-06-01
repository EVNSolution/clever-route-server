import type {
  ApiEnvelope,
  BootstrapPayload,
  BulkGeocodeOrdersResponse,
  DriversResponse,
  GeocodeOrderResponse,
  GeocodeSettingsResponse,
  OrderMetadataDiagnosticsResponse,
  OrderMutationResponse,
  OrdersResponse,
  RouteDeleteResponse,
  RoutePlanDetailDto,
  RoutesResponse,
  SettingsResponse,
  StoreSettingsDto,
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
}): Promise<OrderMutationResponse> {
  return apiMutation<OrderMutationResponse>(
    `/admin/ui/app/api/orders/${encodeURIComponent(input.orderId)}/metadata`,
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
}): Promise<{ routePlan: { id: string } }> {
  return apiMutation<{ routePlan: { id: string } }>(
    "/admin/ui/app/api/routes",
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

export async function optimizeRoute(
  routePlanId: string,
  csrfToken: string,
): Promise<RoutePlanDetailDto> {
  return apiMutation<RoutePlanDetailDto>(
    `/admin/ui/app/api/routes/${encodeURIComponent(routePlanId)}/optimize`,
    "POST",
    csrfToken,
    {},
  );
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

export async function getSettings(): Promise<SettingsResponse> {
  return apiGet<SettingsResponse>("/admin/ui/app/api/settings");
}

export async function saveSettings(input: {
  csrfToken: string;
  defaultDepotAddress: string | null;
  defaultDepotLatitude: number | null;
  defaultDepotLongitude: number | null;
  locale: string;
  routeScopeConfig?: StoreSettingsDto["routeScopeConfig"];
}): Promise<SettingsResponse> {
  return apiMutation<SettingsResponse>(
    "/admin/ui/app/api/settings",
    "PATCH",
    input.csrfToken,
    input,
  );
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
