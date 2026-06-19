import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

import type { FastifyReply } from "fastify";

import type { AdminCommerceActor } from "../modules/commerce/admin-commerce-auth.js";
import type { AdminDriverRow } from "../modules/driver/admin-driver.types.js";
import { WooCommerceOnboardingError } from "../modules/commerce/woocommerce-connection-onboarding.service.js";
import {
  defaultRouteScopeConfig,
  isActiveDeliverySession,
  isActiveServiceType,
  type RouteScopeConfigDto,
} from "../modules/route-ops/route-scope-config.js";
import type { CanonicalOrderRow } from "../modules/shopify/order-sync.mapper.js";
import type {
  DeliveryBatchCandidate,
  ListCanonicalOrdersFilters,
  RouteOpsCanonicalMetadataPatch,
} from "../modules/shopify/order-sync.repository.js";
import {
  deriveOperateDeliveryStatus,
  deriveOrderHealth,
  isOperateDeliveryStatus,
  isOrderHealth,
  type OperateDeliveryStatus,
  type OrderHealth,
} from "../modules/shopify/order-operate-status.js";
import {
  RoutePlanBatchInvalidError,
  RoutePlanDriverAssignInvalidError,
  RoutePlanOrderAlreadyPlannedError,
  RoutePlanStopUpdateInvalidError,
  type CreateRoutePlanPayload,
  type RoutePlanDetail,
  type RoutePlanOrderInput,
  type RoutePlanRouteScopeInput,
  type RoutePlanService,
  type RoutePlanSummary,
  type SaveRoutePlanPayload,
} from "../modules/route-plans/route-plan.types.js";
import type {
  RouteOptimizationService,
  RouteOptimizationStopSequence,
} from "../modules/route-plans/route-engine-route-optimizer.client.js";
const ADMIN_UI_APP_ROUTE_PLANS_PATH = "/admin/ui/app/routes";

type RoutePlanningDependencies = {
  actor: AdminCommerceActor;
  now?: () => Date;
  onboardingService: {
    listConnections(input: {
      actor: AdminCommerceActor;
    }): Promise<Array<{ shopDomain: string; timezone: string | null }>>;
  };
  settingsService?: {
    getSettings(input: { shopDomain: string }): Promise<{
      routeScopeConfig: RouteScopeConfigDto;
    } | null>;
  };
};

type RouteUiServices = {
  orderSyncService: {
    listCanonicalOrders(input: {
      shopDomain: string;
    }): Promise<CanonicalOrderRow[]>;
  };
  routePlanService: Pick<
    RoutePlanService,
    "createRoutePlan" | "createRoutePlanFromOrderIds"
  >;
};

type RouteOpsMapAssetPaths = {
  appVendorPath: string;
  webPublicPath: string;
};

function redirect(reply: FastifyReply, location: string): unknown {
  return reply.code(303).header("Location", location).send("");
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof WooCommerceOnboardingError) return error.message;
  return "Admin UI request failed";
}

function truncateUiMessage(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 320 ? trimmed : `${trimmed.slice(0, 317)}...`;
}

type RouteOpsMapProviderMode = "public_allowlisted" | "self_hosted";

type RouteOpsMapConfig = {
  allowedHosts: string[];
  attribution: string | null;
  disabledReason?: string;
  providerMode: RouteOpsMapProviderMode | null;
  status: "configured" | "not_configured";
  styleUrl: string | null;
  styleAudit: {
    endpoints: string[];
    externalHosts: string[];
  } | null;
};

function readQueryString(query: unknown, field: string): string | null {
  if (query === null || typeof query !== "object") return null;
  const value = (query as Record<string, unknown>)[field];
  if (Array.isArray(value))
    return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export async function readRouteOpsOrderFilters(input: {
  dependencies: RoutePlanningDependencies;
  query: unknown;
  shopDomain: string;
}): Promise<ListCanonicalOrdersFilters> {
  const scope = normalizeRouteOpsOrderScope(
    readQueryString(input.query, "scope"),
  );
  const tab = normalizeRouteOpsOrderTab(readQueryString(input.query, "tab"));
  const rawServiceType = readQueryString(input.query, "serviceType");
  const rawDeliverySession = readQueryString(input.query, "deliverySession");
  const routeScopeConfig =
    rawServiceType === null && rawDeliverySession === null
      ? null
      : await readRouteOpsRouteScopeConfig(
          input.dependencies,
          input.shopDomain,
        );
  const deliveryArea = normalizeOptionalText(
    readQueryString(input.query, "deliveryArea"),
    "deliveryArea",
  );
  const rawDeliveryDate = normalizeOptionalDate(
    readQueryString(input.query, "deliveryDate"),
  );
  const operateDeliveryStatus = normalizeOperateDeliveryStatus(
    readQueryString(input.query, "deliveryStatus") ??
      readQueryString(input.query, "operateDeliveryStatus"),
  );
  const orderHealth = normalizeOrderHealth(
    readQueryString(input.query, "health") ??
      readQueryString(input.query, "orderHealth"),
  );
  const planned = normalizeRouteOpsPlanningStatus(
    readQueryString(input.query, "status"),
  );
  const serviceType = normalizeRouteOpsServiceTypeFilter(
    rawServiceType,
    routeScopeConfig ?? defaultRouteScopeConfig(),
  );
  const deliverySession = normalizeRouteOpsDeliverySessionFilter(
    rawDeliverySession,
    routeScopeConfig ?? defaultRouteScopeConfig(),
  );
  const search = normalizeOptionalText(
    readQueryString(input.query, "search"),
    "search",
  );
  const effectiveTab =
    tab ??
    (planned === true
      ? "planned"
      : planned === false
        ? "unplanned"
        : orderHealth === "needs_review"
          ? "needs_review"
          : null);
  const deliveryDate =
    orderHealth === "needs_review" || effectiveTab === "needs_review"
      ? null
      : rawDeliveryDate;
  const routeOpsToday =
    scope === "planning"
      ? await resolveShopToday(input.dependencies, input.shopDomain)
      : null;
  const deliveryDateFrom =
    scope === null &&
    deliveryDate === null &&
    planned !== null &&
    orderHealth !== "needs_review"
      ? await resolveShopToday(input.dependencies, input.shopDomain)
      : null;
  return {
    ...(deliveryArea === null ? {} : { deliveryArea }),
    ...(deliveryDate === null ? {} : { deliveryDate }),
    ...(deliveryDateFrom === null ? {} : { deliveryDateFrom }),
    ...(deliverySession === null ? {} : { deliverySession }),
    ...(operateDeliveryStatus === null ? {} : { operateDeliveryStatus }),
    ...(scope !== null && effectiveTab === "needs_review"
      ? {}
      : orderHealth === null
        ? {}
        : { orderHealth }),
    ...(scope === null && planned !== null ? { planned } : {}),
    ...(scope !== null && effectiveTab === "planned" ? { planned: true } : {}),
    ...(scope !== null && effectiveTab === "unplanned"
      ? { planned: false }
      : {}),
    ...(scope === null ? {} : { routeOpsScope: scope }),
    ...(scope === null || effectiveTab === null
      ? {}
      : { routeOpsTab: effectiveTab }),
    ...(routeOpsToday === null ? {} : { routeOpsToday }),
    ...(search === null ? {} : { search }),
    ...(serviceType === null ? {} : { serviceType }),
  };
}

export async function resolveShopToday(
  dependencies: RoutePlanningDependencies,
  shopDomain: string,
): Promise<string> {
  const timezone = await resolveShopTimezone(dependencies, shopDomain);
  return formatDateInTimezone(dependencies.now?.() ?? new Date(), timezone);
}

export async function resolveShopTimezone(
  dependencies: RoutePlanningDependencies,
  shopDomain: string,
): Promise<string> {
  try {
    const connections = await dependencies.onboardingService.listConnections({
      actor: dependencies.actor,
    });
    return (
      connections.find((connection) => connection.shopDomain === shopDomain)
        ?.timezone ?? "America/Toronto"
    );
  } catch {
    return "America/Toronto";
  }
}

export function formatDateInTimezone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year === undefined || month === undefined || day === undefined) {
    return value.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}

export function readRouteOpsBodyObject(
  value: unknown,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "JSON body is required",
      400,
    );
  }
  return value as Record<string, unknown>;
}

export function readRequiredJsonString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      `${field} is required`,
      400,
    );
  }
  return value.trim();
}

export function readRouteEndMode(
  value: unknown,
): RoutePlanSummary["routeEndMode"] {
  if (value !== "END_AT_LAST_STOP" && value !== "RETURN_TO_DEPOT") {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "routeEndMode must be END_AT_LAST_STOP or RETURN_TO_DEPOT",
      400,
    );
  }
  return value;
}

export function readNullableJsonString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Expected string or null",
      400,
    );
  }
  return value.trim() === "" ? null : value.trim();
}

export function readNullableJsonNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Expected finite number or null",
      400,
    );
  }
  return value;
}

export function readRouteOpsLocale(value: unknown): string {
  if (value === undefined || value === null || value === "") return "en-CA";
  if (typeof value !== "string") {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "locale must be a string",
      400,
    );
  }
  return readLocaleField(value);
}

export function readRequiredDepotAddress(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "defaultDepotAddress is required",
      400,
    );
  }
  return value.trim();
}

export function depotAddressToGeocodingAddress(defaultDepotAddress: string): {
  address1: string;
  address2: null;
  city: null;
  countryCode: null;
  postalCode: null;
  province: null;
} {
  return {
    address1: defaultDepotAddress,
    address2: null,
    city: null,
    countryCode: null,
    postalCode: null,
    province: null,
  };
}

export function findRouteOpsOrderByNeutralId(
  orders: CanonicalOrderRow[],
  orderId: string,
): CanonicalOrderRow | null {
  return (
    orders.find(
      (order) =>
        order.orderId === orderId ||
        order.shopifyOrderGid === orderId ||
        order.sourceOrderId === orderId ||
        order.sourceOrderNumber === orderId,
    ) ?? null
  );
}

export async function readRouteOpsRouteScopeConfig(
  dependencies: RoutePlanningDependencies,
  shopDomain: string,
): Promise<RouteScopeConfigDto> {
  if (dependencies.settingsService === undefined) {
    return defaultRouteScopeConfig();
  }
  const settings = await dependencies.settingsService.getSettings({
    shopDomain,
  });
  return settings?.routeScopeConfig ?? defaultRouteScopeConfig();
}

export function readRouteOpsMetadataPatch(
  body: Record<string, unknown>,
  routeScopeConfig: RouteScopeConfigDto,
): RouteOpsCanonicalMetadataPatch {
  const patch: RouteOpsCanonicalMetadataPatch = {};
  copyNullableString(body, patch, "address1");
  copyNullableString(body, patch, "address2");
  copyNullableString(body, patch, "city");
  copyNullableString(body, patch, "countryCode");
  copyNullableString(body, patch, "deliveryArea");
  copyNullableString(body, patch, "postalCode");
  copyNullableString(body, patch, "province");
  copyNullableTime(body, patch, "timeWindowStart");
  copyNullableTime(body, patch, "timeWindowEnd");
  if (Object.hasOwn(body, "deliveryDate"))
    patch.deliveryDate = normalizeOptionalDate(
      readNullableJsonString(body.deliveryDate),
    );
  if (Object.hasOwn(body, "deliverySession"))
    patch.deliverySession = readRouteOpsDeliverySession(
      body.deliverySession,
      routeScopeConfig,
    );
  if (Object.hasOwn(body, "serviceType"))
    patch.serviceType = readRouteOpsServiceType(
      body.serviceType,
      routeScopeConfig,
    );
  if (Object.keys(patch).length === 0) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "At least one metadata field is required",
      400,
    );
  }
  return patch;
}

function copyNullableString<T extends Record<string, unknown>>(
  body: Record<string, unknown>,
  patch: T,
  field: keyof T & string,
): void {
  if (Object.hasOwn(body, field))
    patch[field] = readNullableJsonString(body[field]) as T[keyof T & string];
}

function copyNullableTime<T extends Record<string, unknown>>(
  body: Record<string, unknown>,
  patch: T,
  field: keyof T & string,
): void {
  if (!Object.hasOwn(body, field)) return;
  const value = readNullableJsonString(body[field]);
  if (value !== null && !/^\d{2}:\d{2}$/u.test(value)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      `${field} must be HH:MM`,
      400,
    );
  }
  patch[field] = value as T[keyof T & string];
}

export function readRouteOpsDeliverySession(
  value: unknown,
  routeScopeConfig: RouteScopeConfigDto,
): string | null {
  const text = readNullableJsonString(value);
  if (text === null || isActiveDeliverySession(routeScopeConfig, text)) {
    return text;
  }
  throw new WooCommerceOnboardingError(
    "BAD_REQUEST",
    "deliverySession is not enabled in Settings",
    400,
  );
}

export function readRouteOpsServiceType(
  value: unknown,
  routeScopeConfig: RouteScopeConfigDto,
): string | null {
  const text = readNullableJsonString(value);
  if (text === null || isActiveServiceType(routeScopeConfig, text)) return text;
  throw new WooCommerceOnboardingError(
    "BAD_REQUEST",
    "serviceType is not enabled in Settings",
    400,
  );
}

export function readLatitude(value: unknown): number {
  const latitude = readNullableJsonNumber(value);
  if (latitude === null || latitude < -90 || latitude > 90) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "latitude must be between -90 and 90",
      400,
    );
  }
  return latitude;
}

export function readLongitude(value: unknown): number {
  const longitude = readNullableJsonNumber(value);
  if (longitude === null || longitude < -180 || longitude > 180) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "longitude must be between -180 and 180",
      400,
    );
  }
  return longitude;
}

export function readCoordinateSource(
  value: unknown,
): "geocoder" | "manual" | "map_click" {
  const text =
    value === undefined
      ? "manual"
      : readRequiredJsonString({ source: value }, "source");
  if (text === "geocoder" || text === "manual" || text === "map_click")
    return text;
  throw new WooCommerceOnboardingError(
    "BAD_REQUEST",
    "coordinate source is invalid",
    400,
  );
}

export function readSelectedNeutralOrderIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "orderIds must be an array",
      400,
    );
  }
  const ids = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new WooCommerceOnboardingError(
        "BAD_REQUEST",
        "orderIds must contain non-empty strings",
        400,
      );
    }
    return entry.trim();
  });
  if (ids.length === 0) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Select at least one ready order before creating a route.",
      400,
    );
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new WooCommerceOnboardingError(
        "BAD_REQUEST",
        "Selected orders contain duplicates. Clear the selection and try again.",
        400,
      );
    }
    seen.add(id);
  }
  return ids;
}

export function resolveNeutralOrderIdToGid(
  orderId: string,
  orders: readonly CanonicalOrderRow[],
): string {
  const order = orders.find(
    (candidate) =>
      candidate.orderId === orderId ||
      candidate.sourceOrderId === orderId ||
      candidate.sourceOrderNumber === orderId ||
      candidate.shopifyOrderGid === orderId,
  );
  if (order === undefined) return orderId;
  return order.shopifyOrderGid;
}

export function readRouteOpsStopSequence(
  value: unknown,
  detail: RoutePlanDetail,
): Array<{
  deliveryStopId: string;
  sequence: number;
  shopifyOrderGid: string;
}> {
  if (!Array.isArray(value)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "stops must be an array",
      400,
    );
  }
  const byStopId = new Map(
    detail.stops.map((stop) => [stop.deliveryStopId, stop]),
  );
  const bySource = new Map(
    detail.stops.flatMap(
      (stop) =>
        [
          [stop.shopifyOrderGid, stop],
          [stop.orderId, stop],
        ] as const,
    ),
  );
  if (value.length !== detail.stops.length) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Stop order must include every current route stop exactly once.",
      400,
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WooCommerceOnboardingError(
        "BAD_REQUEST",
        "Each stop must be an object",
        400,
      );
    }
    const object = entry as Record<string, unknown>;
    const deliveryStopId = readNullableJsonString(object.deliveryStopId);
    const sourceOrderId = readNullableJsonString(object.sourceOrderId);
    const stop =
      (deliveryStopId === null ? undefined : byStopId.get(deliveryStopId)) ??
      (sourceOrderId === null ? undefined : bySource.get(sourceOrderId));
    if (stop === undefined || seen.has(stop.deliveryStopId)) {
      throw new WooCommerceOnboardingError(
        "BAD_REQUEST",
        "Stop order contains an unknown or duplicate stop.",
        400,
      );
    }
    seen.add(stop.deliveryStopId);
    return {
      deliveryStopId: stop.deliveryStopId,
      sequence: index + 1,
      shopifyOrderGid: stop.shopifyOrderGid,
    };
  });
}

export function readRouteOpsSaveRoutePayload(
  body: Record<string, unknown>,
  detail: RoutePlanDetail,
): SaveRoutePlanPayload {
  const payload: SaveRoutePlanPayload = {};
  if (Object.hasOwn(body, "driverId")) {
    payload.driverId = readNullableJsonString(body.driverId);
  }
  if (Object.hasOwn(body, "expectedUpdatedAt")) {
    const expectedUpdatedAt = readNullableJsonString(body.expectedUpdatedAt);
    if (expectedUpdatedAt !== null)
      payload.expectedUpdatedAt = expectedUpdatedAt;
  }
  if (Object.hasOwn(body, "routeEndMode")) {
    payload.routeEndMode = readRouteEndMode(body.routeEndMode);
  }
  if (Object.hasOwn(body, "stops")) {
    payload.stops = readRouteOpsStopSequence(body.stops, detail);
  }
  return payload;
}

export function readRouteOpsMapConfig(
  assetPaths: RouteOpsMapAssetPaths,
): RouteOpsMapConfig {
  const styleUrl = process.env.ROUTE_OPS_MAP_STYLE_URL?.trim() ?? "";
  if (styleUrl === "") return notConfiguredMapConfig();

  const allowedHosts = readRouteOpsMapAllowedHosts();
  const styleAudit = auditRouteOpsMapStyle(styleUrl, assetPaths);
  if (styleAudit === null) {
    return notConfiguredMapConfig("style_manifest_unavailable");
  }

  const externalHosts = styleAudit.externalHosts;
  if (externalHosts.length === 0) {
    return {
      allowedHosts: [],
      attribution: readRouteOpsMapAttribution("Self-hosted OpenFreeMap style"),
      providerMode: "self_hosted",
      status: "configured",
      styleAudit,
      styleUrl,
    };
  }

  const providerMode = process.env.ROUTE_OPS_MAP_PROVIDER_MODE?.trim();
  const missingHosts = externalHosts.filter(
    (host) => !allowedHosts.includes(host),
  );
  if (providerMode !== "public_allowlisted" || missingHosts.length > 0) {
    return notConfiguredMapConfig(
      missingHosts.length > 0
        ? `public_style_hosts_not_allowlisted:${missingHosts.join(",")}`
        : "public_provider_mode_not_enabled",
      styleAudit,
    );
  }

  return {
    allowedHosts,
    attribution: readRouteOpsMapAttribution(
      "OpenFreeMap / OpenMapTiles public provider",
    ),
    providerMode: "public_allowlisted",
    status: "configured",
    styleAudit,
    styleUrl,
  };
}

function notConfiguredMapConfig(
  disabledReason?: string,
  styleAudit: RouteOpsMapConfig["styleAudit"] = null,
): RouteOpsMapConfig {
  return {
    allowedHosts: [],
    attribution: null,
    ...(disabledReason === undefined ? {} : { disabledReason }),
    providerMode: null,
    status: "not_configured",
    styleAudit,
    styleUrl: null,
  };
}

export function readRouteOpsMapAllowedHosts(): string[] {
  const hosts = (process.env.ROUTE_OPS_MAP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
  return [...new Set(hosts)];
}

export function readRouteOpsMapAttribution(defaultAttribution: string): string {
  const explicit = process.env.ROUTE_OPS_MAP_ATTRIBUTION?.trim();
  return explicit === undefined || explicit === ""
    ? defaultAttribution
    : explicit;
}

function auditRouteOpsMapStyle(
  styleUrl: string,
  assetPaths: RouteOpsMapAssetPaths,
): RouteOpsMapConfig["styleAudit"] {
  const manifestEndpoints = readStyleManifestEndpoints(styleUrl, assetPaths);
  if (manifestEndpoints === null) {
    if (hostForRouteOpsEndpoint(styleUrl) === null) return null;
    const externalHosts = [hostForRouteOpsEndpoint(styleUrl)]
      .filter((host): host is string => host !== null)
      .sort();
    return { endpoints: [styleUrl], externalHosts };
  }
  const endpoints = [...new Set([styleUrl, ...manifestEndpoints])];
  const externalHosts = [
    ...new Set(
      endpoints
        .map((endpoint) => hostForRouteOpsEndpoint(endpoint))
        .filter((host): host is string => host !== null),
    ),
  ].sort();
  return { endpoints, externalHosts };
}

export function readStyleManifestEndpoints(
  styleUrl: string,
  assetPaths: RouteOpsMapAssetPaths,
): string[] | null {
  if (!styleUrl.startsWith(`${assetPaths.appVendorPath}/`)) {
    return null;
  }
  const relativePath = normalize(
    styleUrl.slice(`${assetPaths.appVendorPath}/`.length),
  ).replace(/^(\.\.(?:\/|\\|$))+/u, "");
  if (relativePath === "" || relativePath.includes("..")) return null;
  const absolute = join(assetPaths.webPublicPath, "vendor", relativePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  try {
    const manifest = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
    if (!isRouteOpsStyleManifest(manifest)) return null;
    return extractStyleEndpointUrls(manifest);
  } catch {
    return null;
  }
}

export function isRouteOpsStyleManifest(
  manifest: unknown,
): manifest is Record<string, unknown> {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  )
    return false;
  const record = manifest as Record<string, unknown>;
  return record.version === 8 && Array.isArray(record.layers);
}

export function extractStyleEndpointUrls(manifest: unknown): string[] {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  )
    return [];
  const record = manifest as Record<string, unknown>;
  const endpoints: string[] = [];
  collectStringEndpoint(record.sprite, endpoints);
  collectStringEndpoint(record.glyphs, endpoints);
  const sources = record.sources;
  if (
    sources !== null &&
    typeof sources === "object" &&
    !Array.isArray(sources)
  ) {
    for (const source of Object.values(sources as Record<string, unknown>)) {
      if (
        source === null ||
        typeof source !== "object" ||
        Array.isArray(source)
      )
        continue;
      const sourceRecord = source as Record<string, unknown>;
      collectStringEndpoint(sourceRecord.url, endpoints);
      const tiles = sourceRecord.tiles;
      if (Array.isArray(tiles)) {
        for (const tile of tiles) collectStringEndpoint(tile, endpoints);
      }
    }
  }
  return endpoints;
}

function collectStringEndpoint(value: unknown, endpoints: string[]): void {
  if (typeof value !== "string" || value.trim() === "") return;
  const endpoint = value.trim();
  endpoints.push(endpoint);
  if (endpoint.startsWith("pmtiles://")) {
    const nested = endpoint.slice("pmtiles://".length);
    if (nested !== "") endpoints.push(nested);
  }
}

function hostForRouteOpsEndpoint(endpoint: string): string | null {
  const normalized = endpoint.startsWith("pmtiles://")
    ? endpoint.slice("pmtiles://".length)
    : endpoint;
  if (!/^https?:\/\//iu.test(normalized)) return null;
  try {
    return new URL(normalized).host.toLowerCase();
  } catch {
    return null;
  }
}

export function buildRouteOpsCsp(mapConfig: RouteOpsMapConfig): string {
  const publicHosts =
    mapConfig.status === "configured" &&
    mapConfig.providerMode === "public_allowlisted"
      ? mapConfig.allowedHosts.map((host) => `https://${host}`)
      : [];
  return [
    "default-src 'none'",
    "base-uri 'self'",
    ["connect-src 'self'", ...publicHosts].join(" "),
    "form-action 'self'",
    "frame-ancestors 'none'",
    ["img-src 'self' data:", ...publicHosts].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "worker-src 'self' blob:",
  ].join("; ");
}

export function readRouteOpsRouterConfig(): {
  coverage: string | null;
  provider: "osrm" | null;
  status: "configured" | "not_configured";
} {
  const configured =
    process.env.OSRM_BASE_URL?.trim() !== "" &&
    process.env.OSRM_BASE_URL !== undefined;
  return configured
    ? {
        coverage: process.env.ROUTE_OPS_ROUTER_COVERAGE?.trim() || "ontario",
        provider: "osrm",
        status: "configured",
      }
    : { coverage: null, provider: null, status: "not_configured" };
}

export function toRouteOpsOrderDto(order: CanonicalOrderRow): {
  blockerReasons: string[];
  coordinates: { latitude: number | null; longitude: number | null };
  customerNote: string | null;
  deliveryArea: string | null;
  deliveryDate: string | null;
  deliverySession: string | null;
  deliveryStatus: OperateDeliveryStatus;
  metadataResolved: boolean;
  geocodeStatus: CanonicalOrderRow["geocodeStatus"];
  geocodeDiagnostics: CanonicalOrderRow["geocodeDiagnostics"] | null;
  health: OrderHealth;
  items: CanonicalOrderRow["items"];
  normalizedPaymentReason: string | null;
  normalizedPaymentStatus: CanonicalOrderRow["normalizedPaymentStatus"] | null;
  orderId: string;
  orderName: string;
  paidAt: string | null;
  paymentMethodFamily: string | null;
  paymentMethodId: string | null;
  paymentMethodTitle: string | null;
  paymentReviewReason: string | null;
  phone: string | null;
  planningStatus: string;
  recipientName: string | null;
  routeEligible: boolean;
  routePlanId: string | null;
  routePlanName: string | null;
  serviceType: string | null;
  sourceCreatedAt: string | null;
  sourceCreatedDate: string | null;
  sourceOrderId: string | null;
  sourceOrderNumber: string | null;
  shippingAddress: CanonicalOrderRow["shippingAddress"];
  sourcePlatform: string | null;
  sourceUpdatedAt: string | null;
  sourceUpdatedDate: string | null;
  status: string | null;
  stopId: string | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
  transactionId: string | null;
  wooOrderStatus: string | null;
} {
  const blockerReasons = readOrderOperateBlockers(order);
  const metadataResolved =
    order.metadataResolved ??
    !blockerReasons.some((reason) =>
      [
        "missing_delivery_date",
        "missing_delivery_area",
        "missing_route_scope",
        "delivery_day_unparsed",
        "delivery_time_window_unparsed",
        "ambiguous_delivery_day",
        "ambiguous_delivery_time_window",
        "delivery_date_weekday_mismatch",
        "delivery_date_weekday_unverified",
        "missing_order_date",
      ].includes(reason),
    );
  const routeEligible = order.routeEligible ?? blockerReasons.length === 0;
  return {
    blockerReasons,
    coordinates: { latitude: order.latitude, longitude: order.longitude },
    customerNote: order.customerNote ?? null,
    deliveryArea: order.deliveryArea,
    deliveryDate: order.deliveryDate,
    deliverySession: order.deliverySession ?? null,
    deliveryStatus: deriveOperateDeliveryStatus(order),
    geocodeStatus: order.geocodeStatus,
    geocodeDiagnostics: order.geocodeDiagnostics ?? null,
    health: deriveOrderHealth(order),
    items: order.items ?? [],
    metadataResolved,
    normalizedPaymentReason: order.normalizedPaymentReason ?? null,
    normalizedPaymentStatus: order.normalizedPaymentStatus ?? null,
    orderId: order.orderId,
    orderName: order.name,
    paidAt: order.paidAt ?? null,
    paymentMethodFamily: order.paymentMethodFamily ?? null,
    paymentMethodId: order.paymentMethodId ?? null,
    paymentMethodTitle: order.paymentMethodTitle ?? null,
    paymentReviewReason: order.paymentReviewReason ?? null,
    phone: order.phone,
    planningStatus: order.planningStatus,
    recipientName: order.recipientName,
    routeEligible,
    routePlanId: order.routePlanId,
    routePlanName: order.routePlanName,
    serviceType: order.serviceType,
    shippingAddress: order.shippingAddress,
    sourceCreatedAt: order.sourceCreatedAt ?? order.processedAt,
    sourceCreatedDate: order.sourceCreatedDate ?? order.orderDateLocal,
    sourceOrderId: order.sourceOrderId ?? null,
    sourceOrderNumber: order.sourceOrderNumber ?? null,
    sourcePlatform: order.sourcePlatform ?? null,
    sourceUpdatedAt: order.sourceUpdatedAt ?? order.updatedAtShopify,
    sourceUpdatedDate:
      order.sourceUpdatedDate ??
      order.sourceCreatedDate ??
      order.orderDateLocal,
    status: order.fulfillmentStatus,
    stopId: order.deliveryStopId,
    timeWindowEnd: order.timeWindowEnd,
    timeWindowStart: order.timeWindowStart,
    transactionId: order.transactionId ?? null,
    wooOrderStatus: order.wooOrderStatus ?? null,
  };
}

export function toRouteOpsBatchCandidateDto(
  candidate: DeliveryBatchCandidate,
): DeliveryBatchCandidate {
  return candidate;
}

export function readOrderOperateBlockers(order: CanonicalOrderRow): string[] {
  const blockers: string[] = [];
  if (order.deliveryDate === null) blockers.push("missing_delivery_date");
  if (order.readiness !== "READY_TO_PLAN") {
    blockers.push(
      ...(order.reviewReasons.length === 0
        ? ["needs_delivery_metadata_review"]
        : order.reviewReasons),
    );
  }
  if (order.planningStatus !== "UNPLANNED" || order.routePlanId !== null)
    blockers.push("already_planned");
  if (
    !order.hasCoordinates ||
    order.latitude === null ||
    order.longitude === null
  )
    blockers.push("missing_coordinates");
  return [...new Set(blockers)];
}

export function toRouteOpsRoutePlanDto(routePlan: RoutePlanSummary): {
  createdAt: string;
  deliveryAreas: string[];
  deliveryDate: string | null;
  driverId: string | null;
  depot: {
    latitude: number | null;
    longitude: number | null;
  };
  id: string;
  itemSummary: RoutePlanSummary["itemSummary"];
  missingCoordinates: number;
  name: string;
  planDate: string;
  routeEndMode: RoutePlanSummary["routeEndMode"];
  status: string;
  stopsCount: number;
  updatedAt: string;
} {
  return {
    createdAt: routePlan.createdAt,
    deliveryAreas: routePlan.deliveryAreas,
    deliveryDate: routePlan.deliveryDate ?? null,
    driverId: routePlan.driverId ?? null,
    depot: routePlan.depot,
    id: routePlan.id,
    itemSummary: routePlan.itemSummary ?? emptyRouteItemSummary(),
    missingCoordinates: routePlan.missingCoordinates,
    name: routePlan.name,
    planDate: routePlan.planDate,
    routeEndMode: routePlan.routeEndMode,
    status: routePlan.status,
    stopsCount: routePlan.stopsCount,
    updatedAt: routePlan.updatedAt,
  };
}

export function toRouteOpsRoutePlanDetailDto(detail: RoutePlanDetail): {
  routeGeometry: RoutePlanDetail["routeGeometry"];
  routeGeometryGeneratedAt: RoutePlanDetail["routeGeometryGeneratedAt"];
  routeGeometrySource: RoutePlanDetail["routeGeometrySource"];
  routeGeometryStatus: RoutePlanDetail["routeGeometryStatus"];
  routeMetrics: RoutePlanDetail["routeMetrics"];
  routeShapeSignature: RoutePlanDetail["routeShapeSignature"];
  routePlan: ReturnType<typeof toRouteOpsRoutePlanDto>;
  routeStopPoints: Array<{
    deliveryStopId: string;
    items: RoutePlanDetail["stops"][number]["items"];
    inputCoordinates: [number, number] | null;
    name: string | null;
    sequence: number;
    snapDistanceMeters: number | null;
    snappedCoordinates: [number, number] | null;
    sourceOrderId: string;
  }>;
  stops: Array<{
    addressLabel: string;
    coordinates: { latitude: number | null; longitude: number | null };
    deliveryArea: string | null;
    deliveryStopId: string;
    orderId: string;
    items: RoutePlanDetail["stops"][number]["items"];
    orderName: string;
    recipientName: string | null;
    sequence: number;
    sourceOrderId: string;
    status: string;
    customerNoteContext: RoutePlanDetail["stops"][number]["customerNoteContext"];
  }>;
} {
  return {
    routeGeometry: detail.routeGeometry,
    routeGeometryGeneratedAt: detail.routeGeometryGeneratedAt ?? null,
    routeGeometrySource: detail.routeGeometrySource ?? null,
    routeGeometryStatus: detail.routeGeometryStatus ?? "missing",
    routeMetrics: detail.routeMetrics,
    routeShapeSignature: detail.routeShapeSignature,
    routePlan: toRouteOpsRoutePlanDto(detail.routePlan),
    routeStopPoints: detail.routeStopPoints.map((point) => ({
      deliveryStopId: point.deliveryStopId,
      items:
        detail.stops.find((stop) => stop.deliveryStopId === point.deliveryStopId)?.items ?? [],
      inputCoordinates: point.inputCoordinates,
      name: point.name,
      sequence: point.sequence,
      snapDistanceMeters: point.snapDistanceMeters,
      snappedCoordinates: point.snappedCoordinates,
      sourceOrderId: point.shopifyOrderGid,
    })),
    stops: detail.stops.map((stop) => ({
      addressLabel: formatAddressLabel(stop.address),
      coordinates: stop.coordinates,
      deliveryArea: stop.deliveryArea,
      deliveryStopId: stop.deliveryStopId,
      items: stop.items ?? [],
      orderId: stop.orderId,
      orderName: stop.orderName,
      recipientName: stop.recipientName,
      sequence: stop.sequence,
      sourceOrderId: stop.shopifyOrderGid,
      status: stop.status,
      customerNoteContext: stop.customerNoteContext,
    })),
  };
}

export function toRouteOpsDriverDto(driver: AdminDriverRow): {
  appLinked: boolean;
  authStatus: string;
  createdAt: string;
  displayName: string;
  id: string;
  inviteCode: string | null;
  inviteCodeExpiresAt: string | null;
  lastSeenAt: string | null;
  phone: string | null;
  recentEventsCount: number;
  status: string;
  updatedAt: string;
} {
  return {
    appLinked: driver.authStatus === "APP_LINKED",
    authStatus: driver.authStatus,
    createdAt: driver.createdAt,
    displayName: driver.displayName,
    id: driver.id,
    inviteCode: driver.inviteCode,
    inviteCodeExpiresAt: driver.inviteCodeExpiresAt,
    lastSeenAt: driver.lastSeenAt,
    phone: driver.phone,
    recentEventsCount: driver.recentEventsCount,
    status: driver.status,
    updatedAt: driver.updatedAt,
  };
}

function emptyRouteItemSummary(): NonNullable<RoutePlanSummary["itemSummary"]> {
  return {
    changedSincePublish: false,
    fingerprint: "",
    itemTypes: 0,
    items: [],
    totalQuantity: 0,
  };
}

export function formatAddressLabel(
  address: RoutePlanDetail["stops"][number]["address"],
): string {
  return [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.postalCode,
    address.countryCode,
  ]
    .filter(
      (part): part is string => typeof part === "string" && part.trim() !== "",
    )
    .join(", ");
}

export function readSelectedOrderGids(value: string): string[] {
  const gids = value
    .split(/[\r\n,]+/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (gids.length === 0) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Select at least one ready order before creating a route.",
      400,
    );
  }
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const gid of gids) {
    if (seen.has(gid)) {
      duplicates.push(gid);
      continue;
    }
    seen.add(gid);
  }
  if (duplicates.length > 0) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Selected orders contain duplicates. Clear the selection and try again.",
      400,
    );
  }
  return gids;
}

export function selectRouteReadyOrders(input: {
  orders: readonly CanonicalOrderRow[];
  planDate: string;
  routeScopeConfig: RouteScopeConfigDto;
  selectedOrderGids: readonly string[];
}): CanonicalOrderRow[] {
  const ordersByGid = new Map(
    input.orders.map((order) => [order.shopifyOrderGid, order]),
  );
  const blockers: string[] = [];
  const selected: CanonicalOrderRow[] = [];

  for (const gid of input.selectedOrderGids) {
    const order = ordersByGid.get(gid);
    if (order === undefined) {
      blockers.push(`${gid}: not found for this shop/date`);
      continue;
    }
    const orderBlockers = readRouteCreationBlockers(
      order,
      input.planDate,
      input.routeScopeConfig,
    );
    if (orderBlockers.length > 0) {
      blockers.push(
        `${order.sourceOrderNumber ?? order.name}: ${orderBlockers.join(", ")}`,
      );
      continue;
    }
    selected.push(order);
  }

  if (blockers.length > 0) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      `Cannot create a partial route. Fix or remove blocked selected orders first: ${blockers.join("; ")}`,
      400,
    );
  }

  return selected;
}

export function readRouteCreationBlockers(
  order: CanonicalOrderRow,
  planDate: string,
  routeScopeConfig: RouteScopeConfigDto,
): string[] {
  const blockers: string[] = [];
  if (order.deliveryDate !== planDate) {
    blockers.push("delivery date does not match the route date");
  }
  if (order.readiness !== "READY_TO_PLAN") {
    const reasons =
      order.reviewReasons.length === 0
        ? "needs delivery metadata review"
        : order.reviewReasons.join(", ");
    blockers.push(`needs review (${reasons})`);
  }
  if (order.planningStatus !== "UNPLANNED" || order.routePlanId !== null) {
    blockers.push("already assigned to a route");
  }
  if (
    !order.hasCoordinates ||
    order.latitude === null ||
    order.longitude === null
  ) {
    blockers.push("missing delivery coordinates");
  }
  if (
    order.serviceType !== null &&
    !isActiveServiceType(routeScopeConfig, order.serviceType)
  ) {
    blockers.push(
      "service type is no longer enabled in Settings; re-enable it or edit the order detail",
    );
  }
  if (
    order.deliverySession !== null &&
    !isActiveDeliverySession(routeScopeConfig, order.deliverySession)
  ) {
    blockers.push(
      "delivery session is no longer enabled in Settings; re-enable it or edit the order detail",
    );
  }
  return blockers;
}

export async function createRoutePlanFromSelectedOrderIds(input: {
  createdBy: string;
  depotAddress: string | null;
  depotLatitude: number | null;
  depotLongitude: number | null;
  orderIds: string[];
  planDate: string;
  routeScopeConfig: RouteScopeConfigDto;
  routeName: string;
  services: RouteUiServices;
  shopDomain: string;
}): Promise<RoutePlanSummary> {
  const allOrders = await input.services.orderSyncService.listCanonicalOrders({
    shopDomain: input.shopDomain,
  });
  const selectedOrderGids = input.orderIds.map((id) =>
    resolveNeutralOrderIdToGid(id, allOrders),
  );
  const selectedOrders = selectRouteReadyOrders({
    orders: allOrders,
    planDate: input.planDate,
    routeScopeConfig: input.routeScopeConfig,
    selectedOrderGids,
  });
  if (
    input.services.routePlanService.createRoutePlanFromOrderIds !== undefined
  ) {
    return input.services.routePlanService.createRoutePlanFromOrderIds({
      createdBy: input.createdBy,
      payload: {
        depot: {
          address: input.depotAddress,
          latitude: input.depotLatitude,
          longitude: input.depotLongitude,
        },
        name: input.routeName,
        orderIds: input.orderIds,
        planDate: input.planDate,
      },
      shopDomain: input.shopDomain,
    });
  }

  return input.services.routePlanService.createRoutePlan({
    createdBy: input.createdBy,
    payload: buildCreateRoutePlanPayload({
      depotAddress: input.depotAddress,
      depotLatitude: input.depotLatitude,
      depotLongitude: input.depotLongitude,
      orders: selectedOrders,
      planDate: input.planDate,
      routeName: input.routeName,
    }),
    shopDomain: input.shopDomain,
  });
}

export function buildCreateRoutePlanPayload(input: {
  depotAddress: string | null;
  depotLatitude: number | null;
  depotLongitude: number | null;
  orders: CanonicalOrderRow[];
  planDate: string;
  routeName: string;
}): CreateRoutePlanPayload {
  const orders = input.orders.map((order) => toRoutePlanOrderInput(order));
  return {
    depot: {
      address: input.depotAddress,
      latitude: input.depotLatitude,
      longitude: input.depotLongitude,
    },
    name: input.routeName,
    orders,
    planDate: input.planDate,
    ...readSharedRouteScope(orders, input.planDate),
  };
}

function toRoutePlanOrderInput(order: CanonicalOrderRow): RoutePlanOrderInput {
  return {
    attributes: [
      ...(order.sourcePlatform === undefined
        ? []
        : [{ key: "sourcePlatform", value: order.sourcePlatform }]),
      ...(order.sourceOrderNumber === undefined ||
      order.sourceOrderNumber === null
        ? []
        : [{ key: "sourceOrderNumber", value: order.sourceOrderNumber }]),
    ],
    currencyCode: order.currencyCode,
    deliveryArea: order.deliveryArea,
    deliveryDate: order.deliveryDate,
    deliveryDay: order.deliveryDayRaw ?? order.deliveryWeekday,
    deliverySession: order.deliverySession,
    email: order.email,
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    latitude: order.latitude,
    longitude: order.longitude,
    name: order.name,
    phone: order.phone,
    planningGroupKey: order.planningGroupKey,
    processedAt:
      order.processedAt === null ? null : new Date(order.processedAt),
    rawPayload: {
      deliveryDate: order.deliveryDate,
      deliverySession: order.deliverySession,
      planningGroupKey: order.planningGroupKey,
      normalizedPaymentReason: order.normalizedPaymentReason ?? null,
      normalizedPaymentStatus: order.normalizedPaymentStatus ?? null,
      paidAt: order.paidAt ?? null,
      paymentMethodFamily: order.paymentMethodFamily ?? null,
      paymentMethodId: order.paymentMethodId ?? null,
      paymentMethodTitle: order.paymentMethodTitle ?? null,
      paymentReviewReason: order.paymentReviewReason ?? null,
      routeScopeKey: order.routeScopeKey,
      serviceType: order.serviceType,
      sourceOrderId: order.sourceOrderId ?? null,
      sourceOrderNumber: order.sourceOrderNumber ?? null,
      sourcePlatform: order.sourcePlatform ?? null,
      sourceSiteUrl: order.sourceSiteUrl ?? null,
      timeWindowEnd: order.timeWindowEnd,
      timeWindowStart: order.timeWindowStart,
      transactionId: order.transactionId ?? null,
      wooOrderStatus: order.wooOrderStatus ?? null,
    },
    recipientName: order.recipientName,
    routeScopeKey: order.routeScopeKey,
    serviceType: order.serviceType,
    shippingAddress: order.shippingAddress,
    shopifyOrderGid: order.shopifyOrderGid,
    timeWindowEnd: order.timeWindowEnd,
    timeWindowStart: order.timeWindowStart,
    totalPriceAmount: order.totalPriceAmount,
  };
}

export function readSharedRouteScope(
  orders: RoutePlanOrderInput[],
  planDate: string,
): { routeScope?: RoutePlanRouteScopeInput } {
  const first = orders[0];
  if (
    first === undefined ||
    first.routeScopeKey === null ||
    first.routeScopeKey === undefined ||
    first.deliveryDate !== planDate ||
    first.deliverySession === null ||
    first.deliverySession === undefined ||
    first.serviceType === null ||
    first.serviceType === undefined
  ) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Selected orders must have an explicit route scope.",
      400,
    );
  }
  if (
    orders.some(
      (order) =>
        order.routeScopeKey !== first.routeScopeKey ||
        order.deliveryDate !== first.deliveryDate ||
        order.deliverySession !== first.deliverySession ||
        order.serviceType !== first.serviceType ||
        order.timeWindowStart !== first.timeWindowStart ||
        order.timeWindowEnd !== first.timeWindowEnd,
    )
  ) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Selected orders must share the same route scope.",
      400,
    );
  }
  return {
    routeScope: {
      deliveryDate: planDate,
      deliverySession: first.deliverySession,
      routeScopeKey: first.routeScopeKey,
      serviceType: first.serviceType,
      timeWindowEnd: first.timeWindowEnd ?? null,
      timeWindowStart: first.timeWindowStart ?? null,
    },
  };
}

export function readStopOrderLines(
  value: string,
  detail: RoutePlanDetail,
): Array<{
  deliveryStopId: string;
  sequence: number;
  shopifyOrderGid: string;
}> {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const byGid = new Map(
    detail.stops.map((stop) => [stop.shopifyOrderGid, stop]),
  );
  if (lines.length !== detail.stops.length) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Stop order must include every current route stop exactly once.",
      400,
    );
  }
  const seen = new Set<string>();
  return lines.map((line, index) => {
    const shopifyOrderGid = line.split(/\s+/u)[0] ?? "";
    const stop = byGid.get(shopifyOrderGid);
    if (stop === undefined || seen.has(shopifyOrderGid)) {
      throw new WooCommerceOnboardingError(
        "BAD_REQUEST",
        "Stop order contains an unknown or duplicate order id.",
        400,
      );
    }
    seen.add(shopifyOrderGid);
    return {
      deliveryStopId: stop.deliveryStopId,
      sequence: index + 1,
      shopifyOrderGid,
    };
  });
}

export type OptimizedStopOrder = {
  missingCoordinateStops: number;
  source: "clever_v1" | "route_engine" | "vroom";
  stops: RouteOptimizationStopSequence[];
};

export async function buildOptimizedStopOrder(input: {
  detail: RoutePlanDetail;
  routeOptimizationService?: RouteOptimizationService | undefined;
  shopDomain: string;
}): Promise<OptimizedStopOrder> {
  if (input.routeOptimizationService !== undefined) {
    try {
      const optimized = await input.routeOptimizationService.optimizeStopOrder({
        detail: input.detail,
        shopDomain: input.shopDomain,
      });
      if (optimized !== null) {
        return optimized;
      }
    } catch {
      // Keep the operator workflow available when the internal solver is degraded.
    }
  }

  return buildCleverV1OptimizedStopOrder(input.detail);
}

export function buildCleverV1OptimizedStopOrder(
  detail: RoutePlanDetail,
): OptimizedStopOrder {
  const sortableStops = detail.stops
    .map((stop) => ({ coordinates: readStopCoordinates(stop), stop }))
    .filter(
      (
        entry,
      ): entry is {
        coordinates: { latitude: number; longitude: number };
        stop: RoutePlanDetail["stops"][number];
      } => entry.coordinates !== null,
    )
    .sort(
      (left, right) =>
        left.stop.sequence - right.stop.sequence ||
        left.stop.shopifyOrderGid.localeCompare(right.stop.shopifyOrderGid),
    );
  const missingStops = detail.stops
    .filter((stop) => readStopCoordinates(stop) === null)
    .sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.shopifyOrderGid.localeCompare(right.shopifyOrderGid),
    );

  const depot = readDepotCoordinates(detail.routePlan);
  let origin = depot ?? sortableStops[0]?.coordinates ?? null;
  const ordered: RoutePlanDetail["stops"][number][] = [];
  const remaining = [...sortableStops];

  while (remaining.length > 0) {
    if (origin === null) {
      ordered.push(...remaining.map((entry) => entry.stop));
      remaining.length = 0;
      break;
    }
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (candidate === undefined) continue;
      const distance = haversineMeters(origin, candidate.coordinates);
      if (
        distance < nearestDistance ||
        (distance === nearestDistance &&
          candidate.stop.shopifyOrderGid.localeCompare(
            remaining[nearestIndex]?.stop.shopifyOrderGid ?? "",
          ) < 0)
      ) {
        nearestIndex = index;
        nearestDistance = distance;
      }
    }
    const [next] = remaining.splice(nearestIndex, 1);
    if (next === undefined) break;
    ordered.push(next.stop);
    origin = next.coordinates;
  }

  const stops = [...ordered, ...missingStops].map((stop, index) => ({
    deliveryStopId: stop.deliveryStopId,
    sequence: index + 1,
    shopifyOrderGid: stop.shopifyOrderGid,
  }));

  return {
    missingCoordinateStops: missingStops.length,
    source: "clever_v1",
    stops,
  };
}

export function buildRouteOptimizeNotice(
  optimized: OptimizedStopOrder,
): string {
  const sourceLabel =
    optimized.source === "route_engine"
      ? "Route Engine"
      : optimized.source === "vroom"
        ? "VROOM"
        : "CLEVER v1";
  return optimized.missingCoordinateStops === 0
    ? `${sourceLabel} optimized sequence saved.`
    : `${sourceLabel} optimized sequence saved; ${optimized.missingCoordinateStops} stop(s) without coordinates stayed at the end.`;
}

export function readDepotCoordinates(
  routePlan: RoutePlanSummary,
): { latitude: number; longitude: number } | null {
  const latitude = routePlan.depot.latitude;
  const longitude = routePlan.depot.longitude;
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

export function readStopCoordinates(
  stop: RoutePlanDetail["stops"][number],
): { latitude: number; longitude: number } | null {
  const latitude = stop.coordinates.latitude;
  const longitude = stop.coordinates.longitude;
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

function haversineMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
): number {
  const earthRadiusMeters = 6_371_000;
  const leftLatitude = toRadians(left.latitude);
  const rightLatitude = toRadians(right.latitude);
  const deltaLatitude = toRadians(right.latitude - left.latitude);
  const deltaLongitude = toRadians(right.longitude - left.longitude);
  const a =
    Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(deltaLongitude / 2) *
      Math.sin(deltaLongitude / 2);
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function normalizeOptionalDate(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  return normalizeRequiredDate(value);
}

export function normalizeOptionalText(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (trimmed.length > 128) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      `${field} is too long`,
      400,
    );
  }
  return trimmed;
}

export function normalizeOperateDeliveryStatus(
  value: string | null | undefined,
): OperateDeliveryStatus | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (isOperateDeliveryStatus(trimmed)) return trimmed;
  throw new WooCommerceOnboardingError(
    "BAD_REQUEST",
    "delivery status filter is invalid",
    400,
  );
}

export function normalizeOrderHealth(
  value: string | null | undefined,
): OrderHealth | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (isOrderHealth(trimmed)) return trimmed;
  throw new WooCommerceOnboardingError(
    "BAD_REQUEST",
    "order health filter is invalid",
    400,
  );
}

export function normalizeRouteOpsOrderScope(
  value: string | null | undefined,
): "history" | "planning" | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "history" || trimmed === "planning") return trimmed;
  throw new WooCommerceOnboardingError(
    "BAD_REQUEST",
    "order scope filter is invalid",
    400,
  );
}

export function normalizeRouteOpsOrderTab(
  value: string | null | undefined,
): "all" | "needs_review" | "planned" | "unplanned" | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed === "all" ||
    trimmed === "needs_review" ||
    trimmed === "planned" ||
    trimmed === "unplanned"
  ) {
    return trimmed;
  }
  throw new WooCommerceOnboardingError(
    "BAD_REQUEST",
    "order tab filter is invalid",
    400,
  );
}

export function normalizeRouteOpsPlanningStatus(
  value: string | null | undefined,
): boolean | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "unplanned") return false;
  if (trimmed === "planned") return true;
  throw new WooCommerceOnboardingError(
    "BAD_REQUEST",
    "order planning status filter is invalid",
    400,
  );
}

export function normalizeRouteOpsServiceTypeFilter(
  value: string | null | undefined,
  routeScopeConfig: RouteScopeConfigDto,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (isActiveServiceType(routeScopeConfig, trimmed)) return trimmed;
  throw new WooCommerceOnboardingError(
    "BAD_REQUEST",
    "service type filter is invalid",
    400,
  );
}

export function normalizeRouteOpsDeliverySessionFilter(
  value: string | null | undefined,
  routeScopeConfig: RouteScopeConfigDto,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (isActiveDeliverySession(routeScopeConfig, trimmed)) return trimmed;
  throw new WooCommerceOnboardingError(
    "BAD_REQUEST",
    "delivery session filter is invalid",
    400,
  );
}

export function normalizeRequiredDate(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "date must be YYYY-MM-DD",
      400,
    );
  }
  const date = new Date(`${trimmed}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== trimmed
  ) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "date must be a real calendar date",
      400,
    );
  }
  return trimmed;
}

export function readOptionalCoordinate(
  value: string | undefined,
): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -180 || parsed > 180) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "coordinate must be a finite number",
      400,
    );
  }
  return parsed;
}

export function readLocaleField(value: string | undefined): string {
  const locale = value?.trim() || "en-CA";
  if (locale !== "en-CA" && locale !== "ko-KR") {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "language must be en-CA or ko-KR",
      400,
    );
  }
  return locale;
}

export function sanitizeRouteUiError(error: unknown): string {
  if (error instanceof RoutePlanBatchInvalidError) {
    return `Cannot create a partial route. Fix or remove blocked selected orders first: ${error.blockers.join("; ")}`;
  }
  if (error instanceof RoutePlanOrderAlreadyPlannedError) {
    return "Some selected orders are already assigned to a route. Refresh the page and try again.";
  }
  if (error instanceof RoutePlanDriverAssignInvalidError) {
    return error.message;
  }
  if (error instanceof RoutePlanStopUpdateInvalidError) {
    return error.message;
  }
  return sanitizeErrorMessage(error);
}

export function countRoutePlanBatchBlockers(
  blockers: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const blocker of blockers) {
    const key = normalizeRoutePlanBatchBlocker(blocker);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function normalizeRoutePlanBatchBlocker(blocker: string): string {
  const normalized = blocker.toLowerCase();
  if (normalized.includes("mixed source")) return "mixed_source_scope";
  if (normalized.includes("mixed route")) return "mixed_route_scope";
  if (normalized.includes("coordinates")) return "missing_coordinates";
  if (normalized.includes("already assigned")) return "already_planned";
  if (normalized.includes("weekday mismatch"))
    return "delivery_date_weekday_mismatch";
  if (normalized.includes("unverified woo delivery day/time"))
    return "delivery_day_unparsed";
  if (normalized.includes("delivery date does not match"))
    return "delivery_date_mismatch";
  if (normalized.includes("missing route scope")) return "missing_route_scope";
  if (normalized.includes("delivery facts not found"))
    return "missing_delivery_facts";
  if (normalized.includes("needs review")) return "needs_review";
  return "other";
}

export function redirectToRoutePlans(
  reply: FastifyReply,
  input: {
    deliveryDate?: string | null;
    error?: string;
    notice?: string;
    routePlanId?: string | null;
    shopDomain?: string | null;
  },
): unknown {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value.trim() !== "") {
      params.set(
        key,
        key === "error" || key === "notice" ? truncateUiMessage(value) : value,
      );
    }
  }
  const query = params.toString();
  if (
    input.routePlanId !== undefined &&
    input.routePlanId !== null &&
    input.routePlanId.trim() !== ""
  ) {
    const routePlanId = input.routePlanId.trim();
    params.delete("routePlanId");
    const routeQuery = params.toString();
    return redirect(
      reply,
      routeQuery === ""
        ? `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/${encodeURIComponent(routePlanId)}`
        : `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/${encodeURIComponent(routePlanId)}?${routeQuery}`,
    );
  }
  return redirect(
    reply,
    query === ""
      ? ADMIN_UI_APP_ROUTE_PLANS_PATH
      : `${ADMIN_UI_APP_ROUTE_PLANS_PATH}?${query}`,
  );
}

export function filterRoutePlansByDate(
  routePlans: readonly RoutePlanSummary[],
  deliveryDate: string | null,
): RoutePlanSummary[] {
  if (deliveryDate === null) return [...routePlans];
  return routePlans.filter((routePlan) =>
    routePlanMatchesDate(routePlan, deliveryDate),
  );
}

function routePlanMatchesDate(
  routePlan: RoutePlanSummary,
  deliveryDate: string | null,
): boolean {
  return (
    deliveryDate === null ||
    routePlan.planDate === deliveryDate ||
    routePlan.deliveryDate === deliveryDate
  );
}
