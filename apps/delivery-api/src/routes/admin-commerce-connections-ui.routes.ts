import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AdminCommerceActor } from "../modules/commerce/admin-commerce-auth.js";
import type { AdminDriverServiceContract } from "../modules/driver/admin-driver.types.js";
import type { SafeWooCommerceConnection } from "../modules/commerce/commerce-connection.service.js";
import type {
  AdminStoreSettings,
  SaveAdminStoreSettingsInput,
} from "../modules/commerce/admin-store-settings.service.js";
import type { AdminWooSyncServiceContract } from "../modules/commerce/admin-woocommerce-sync.service.js";
import type { OrderIngestAuditServiceContract } from "../modules/wordpress-plugin/order-ingest-audit.service.js";
import { validateRouteScopeConfigPayload } from "../modules/route-ops/route-scope-config.js";
import { validateRouteOpsUiSettingsPayload } from "../modules/route-ops/route-ops-ui-settings.js";
import {
  WooCommerceOnboardingError,
  type WooCommerceConnectionOnboardingService,
  type WooCommerceOnboardingResult,
} from "../modules/commerce/woocommerce-connection-onboarding.service.js";
import type { CanonicalOrderRow } from "../modules/shopify/order-sync.mapper.js";
import type {
  DeliveryBatchCandidate,
  ListCanonicalOrdersFilters,
  PatchCanonicalOrderCoordinatesInput,
  PatchCanonicalOrderGeocodeDiagnosticsInput,
  PatchCanonicalOrderInput,
} from "../modules/shopify/order-sync.repository.js";
import {
  RoutePlanConflictError,
  RoutePlanOrderAlreadyPlannedError,
  RoutePlanDriverAssignInvalidError,
  RoutePlanOptionsUpdateInvalidError,
  RoutePlanPublishInvalidError,
  RoutePlanStopUpdateInvalidError,
  type RoutePlanService,
} from "../modules/route-plans/route-plan.types.js";
import type { RouteOptimizationService } from "../modules/route-plans/route-optimization.types.js";
import {
  RouteOptimizationJobActiveError,
  type RouteOptimizationJobDto,
} from "../modules/route-plans/route-optimization-job.types.js";
import type { RouteOptimizationJobService } from "../modules/route-plans/route-optimization-job.service.js";
import {
  RouteGroupingConflictError,
  RouteGroupingRiskConfirmationRequiredError,
  RouteGroupingUnresolvedAssignmentsError,
  RouteGroupingValidationError,
  type RouteGroupingService,
} from "../modules/route-grouping/route-grouping.types.js";
import { runRouteOptimizationJob } from "../modules/route-plans/route-optimization-job-runner.js";
import {
  createBulkGeocodeJob,
  readBulkGeocodeJobForSession,
  readRouteOpsAddress,
  requireBulkGeocodeServices,
  runBulkGeocodeJob,
  toBulkGeocodeJobDto,
  toBulkGeocodeOrderResponse,
  toSafeRouteOpsGeocodeResponse,
} from "./admin-ui-bulk-geocoding.js";
import {
  defaultRouteOpsSettings,
  readRememberedDepotGeocode,
  toRouteOpsSettingsDto,
} from "./admin-ui-commerce-settings.js";
import { readAdminUiFormFields } from "./admin-ui-form.js";
import {
  buildRouteOpsCsp,
  countRoutePlanBatchBlockers,
  createRoutePlanFromSelectedOrderIds,
  depotAddressToGeocodingAddress,
  filterRoutePlansByDate,
  findRouteOpsOrderByNeutralId,
  normalizeOptionalDate,
  normalizeRequiredDate,
  readCoordinateSource,
  readLatitude,
  readLocaleField,
  readLongitude,
  readNullableJsonNumber,
  readNullableJsonString,
  readOptionalCoordinate,
  readRequiredDepotAddress,
  readRequiredJsonString,
  readRouteEndMode,
  readRouteOpsBodyObject,
  readRouteOpsLocale,
  readRouteOpsMapConfig,
  readRouteOpsMetadataPatch,
  readRouteOpsOrderFilters,
  readRouteOpsRouteScopeConfig,
  readRouteOpsRouterConfig,
  readRouteOpsSaveRoutePayload,
  readRouteOpsStopSequence,
  readSelectedNeutralOrderIds,
  readSelectedOrderGids,
  readStopOrderLines,
  redirectToRoutePlans,
  sanitizeRouteUiError,
  selectRouteReadyOrders,
  toRouteOpsBatchCandidateDto,
  toRouteOpsDriverDto,
  toRouteOpsOrderDto,
  toRouteOpsRoutePlanDetailDto,
  toRouteOpsRoutePlanDto,
} from "./admin-ui-route-planning.js";
import {
  createRouteOpsApiResponder,
  createRouteOpsHttpError,
} from "./admin-ui-route-ops-api-response.js";
import {
  isRouteOpsUuid,
  readRouteOpsWooSourceOrderId,
  readRouteOpsWooSyncRequestBody,
  scheduleRouteOpsWooSyncProcessing,
  toRouteOpsWooSyncResponse,
} from "./admin-ui-orders-sync.js";
import {
  createAdminUiShellRenderer,
  escapeHtml,
  type PairingCodeSetupView,
  type SafeConnectionWithDelivery,
  type WebhookSetupView,
} from "./admin-ui-shell-rendering.js";
import {
  assertWpPluginShopAccess,
  isWpPluginSession,
  readWpPluginSessionShopDomain,
  redirectWithClearedSession,
  sessionSetCookieHeaders,
} from "./admin-ui-session-security.js";
import { summarizeGeocodeDiagnostic } from "../modules/geocoding/geocoding.diagnostics.js";
import type { GeocodingService } from "../modules/geocoding/geocoding.service.js";
import type { GeocodingResult } from "../modules/geocoding/geocoding.types.js";
import type { AdminNotificationServiceContract } from "../modules/notifications/admin-notification.service.js";
import type { PrismaDeliveryCustomerProfileService } from "../modules/delivery-customer/delivery-customer-profile.service.js";
import {
  createAdminWebSession,
  verifyAdminWebCsrfToken,
  verifyAdminWebLaunchToken,
  verifyAdminWebLoginSecret,
  verifyAdminWebSessionFromRequest,
  normalizeAdminUiLoginReturnPath,
  type AdminWebSession,
} from "./admin-ui-session.js";

const ADMIN_ROOT_PATH = "/admin";
const ADMIN_UI_ROOT_PATH = "/admin/ui";
const ADMIN_UI_LOGIN_PATH = `${ADMIN_UI_ROOT_PATH}/login`;
const ADMIN_UI_LOGOUT_PATH = `${ADMIN_UI_ROOT_PATH}/logout`;
const ADMIN_UI_PLUGIN_LAUNCH_PATH = `${ADMIN_UI_ROOT_PATH}/plugin-launch`;
const ADMIN_UI_STORE_SESSIONS_PATH = `${ADMIN_UI_ROOT_PATH}/store-sessions`;
const ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT_PATH = `${ADMIN_UI_ROOT_PATH}/assets/woocommerce-test.js`;
const ADMIN_UI_ROUTE_APP_SCRIPT_PATH = `${ADMIN_UI_ROOT_PATH}/assets/route-app.js`;
const ADMIN_UI_COMMERCE_CONNECTIONS_PATH = `${ADMIN_UI_ROOT_PATH}/commerce-connections`;
const ADMIN_UI_WOOCOMMERCE_PATH = `${ADMIN_UI_COMMERCE_CONNECTIONS_PATH}/woocommerce`;
const ADMIN_UI_APP_PATH = `${ADMIN_UI_ROOT_PATH}/app`;
const ADMIN_UI_APP_DASHBOARD_PATH = `${ADMIN_UI_APP_PATH}/dashboard`;
const ADMIN_UI_APP_ORDERS_PATH = `${ADMIN_UI_APP_PATH}/orders`;
const ADMIN_UI_APP_ROUTE_PLANS_PATH = `${ADMIN_UI_APP_PATH}/routes`;
const ADMIN_UI_APP_ROUTE_GROUPS_PATH = `${ADMIN_UI_APP_PATH}/route-groups`;
const ADMIN_UI_APP_DRIVERS_PATH = `${ADMIN_UI_APP_PATH}/drivers`;
const ADMIN_UI_APP_SETTINGS_PATH = `${ADMIN_UI_APP_PATH}/settings`;
const ADMIN_UI_APP_API_PATH = `${ADMIN_UI_APP_PATH}/api`;
const ADMIN_UI_APP_ASSETS_PATH = `${ADMIN_UI_APP_PATH}/assets`;
const ADMIN_UI_APP_VENDOR_PATH = `${ADMIN_UI_APP_PATH}/vendor`;
const DRIVER_APP_INSTALL_PATH = "/driver-app";
const ADMIN_UI_ORDERS_PATH = `${ADMIN_UI_ROOT_PATH}/orders`;
const ADMIN_UI_ROUTE_PLANS_PATH = `${ADMIN_UI_ROOT_PATH}/route-plans`;
const ADMIN_UI_DRIVERS_PATH = `${ADMIN_UI_ROOT_PATH}/drivers`;
const ADMIN_UI_SETTINGS_PATH = `${ADMIN_UI_ROOT_PATH}/settings`;
const LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH = `${ADMIN_UI_WOOCOMMERCE_PATH}/login`;
const LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH = `${ADMIN_UI_WOOCOMMERCE_PATH}/logout`;
const ADMIN_UI_CSP = [
  "default-src 'none'",
  "base-uri 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
].join("; ");
const ROUTE_OPS_WEB_DIST_PATH = resolveRouteOpsWebDistPath();
const ROUTE_OPS_WEB_PUBLIC_PATH = resolveRouteOpsWebPublicPath();
const adminUiShellRenderer = createAdminUiShellRenderer({
  assertSafeConnectionForRender,
  paths: {
    appDashboardPath: ADMIN_UI_APP_DASHBOARD_PATH,
    appDriversPath: ADMIN_UI_APP_DRIVERS_PATH,
    appOrdersPath: ADMIN_UI_APP_ORDERS_PATH,
    appRoutePlansPath: ADMIN_UI_APP_ROUTE_PLANS_PATH,
    appSettingsPath: ADMIN_UI_APP_SETTINGS_PATH,
    commerceConnectionsPath: ADMIN_UI_COMMERCE_CONNECTIONS_PATH,
    loginPath: ADMIN_UI_LOGIN_PATH,
    logoutPath: ADMIN_UI_LOGOUT_PATH,
    rootPath: ADMIN_UI_ROOT_PATH,
    routeAppScriptPath: ADMIN_UI_ROUTE_APP_SCRIPT_PATH,
    storeSessionsPath: ADMIN_UI_STORE_SESSIONS_PATH,
    woocommercePath: ADMIN_UI_WOOCOMMERCE_PATH,
    woocommerceTestScriptPath: ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT_PATH,
  },
  readWpPluginSessionShopDomain,
});
const {
  renderCommerceConnectionsPage,
  renderDashboardPage,
  renderHomePage,
  renderLoginPage,
  renderRouteOpsWorkspaceEntryRequiredPage,
  renderStoreSessionsPage,
  renderWpPluginSessionLandingPage,
} = adminUiShellRenderer;
const routeOpsApiResponder = createRouteOpsApiResponder({
  buildCsp: () => buildRouteOpsCsp(readCurrentRouteOpsMapConfig()),
  countRoutePlanBatchBlockers,
  sanitizeError: sanitizeRouteUiError,
});
const { routeOpsData, sendRouteOpsApiError, withRouteOpsApi } = routeOpsApiResponder;
const DEFAULT_ROUTE_OPTIMIZATION_JOB_TIMEOUT_BUDGET_MS = 180000;
const ADMIN_NOTIFICATION_STREAM_HEARTBEAT_MS = 25000;


function readRouteOpsAdminMemo(body: unknown): string | null {
  const payload = readRouteOpsBodyObject(body);
  const value = payload.adminMemo;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "adminMemo must be a string or null.",
      400,
    );
  }
  return value;
}

function readRouteOpsTargetProfileId(body: unknown): string {
  const payload = readRouteOpsBodyObject(body);
  const value = payload.targetProfileId;
  if (typeof value !== "string" || !isRouteOpsUuid(value)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "targetProfileId must be a UUID.",
      400,
    );
  }
  return value;
}

function readRouteOpsUiSettingsPayload(value: unknown) {
  try {
    return validateRouteOpsUiSettingsPayload(value);
  } catch (error) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      error instanceof Error
        ? error.message
        : "Route Ops UI settings are invalid.",
      400,
    );
  }
}

function readRouteOptimizationJobTimeoutBudgetMs(): number {
  const raw = process.env.ROUTE_OPTIMIZATION_JOB_TIMEOUT_BUDGET_MS?.trim();
  if (raw === undefined || raw === "")
    return DEFAULT_ROUTE_OPTIMIZATION_JOB_TIMEOUT_BUDGET_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed))
    return DEFAULT_ROUTE_OPTIMIZATION_JOB_TIMEOUT_BUDGET_MS;
  return parsed;
}

function readCurrentRouteOpsMapConfig() {
  return readRouteOpsMapConfig({
    appVendorPath: ADMIN_UI_APP_VENDOR_PATH,
    webPublicPath: ROUTE_OPS_WEB_PUBLIC_PATH,
  });
}

function resolveRouteOpsWebDistPath(): string {
  const explicit = process.env.ROUTE_OPS_WEB_DIST_PATH?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;

  const externalArtifactCandidate = join(
    process.cwd(),
    "external/route-ops-web/dist",
  );
  if (process.env.NODE_ENV === "production") return externalArtifactCandidate;

  const localDevCandidate = join(process.cwd(), "../route-ops-web/dist");
  const candidates = [
    externalArtifactCandidate,
    localDevCandidate,
    join(process.cwd(), "apps/route-ops-web/dist"),
    join(process.cwd(), "route-ops-web/dist"),
    fileURLToPath(new URL("../../../route-ops-web/dist/", import.meta.url)),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? localDevCandidate
  );
}

function resolveRouteOpsWebPublicPath(): string {
  const explicit = process.env.ROUTE_OPS_WEB_PUBLIC_PATH?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;

  const externalArtifactCandidate = join(
    process.cwd(),
    "external/route-ops-web/public",
  );
  if (process.env.NODE_ENV === "production") return externalArtifactCandidate;

  const localDevCandidate = join(process.cwd(), "../route-ops-web/public");
  const candidates = [
    externalArtifactCandidate,
    localDevCandidate,
    join(process.cwd(), "apps/route-ops-web/public"),
    join(process.cwd(), "route-ops-web/public"),
    fileURLToPath(new URL("../../../route-ops-web/public/", import.meta.url)),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? localDevCandidate
  );
}

const ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT = `
(() => {
  const form = document.querySelector('[data-woo-credential-form]');
  const button = document.querySelector('[data-test-credentials-button]');
  const result = document.querySelector('[data-test-credential-result]');
  if (!(form instanceof HTMLFormElement) || !(button instanceof HTMLButtonElement) || result === null) return;

  button.addEventListener('click', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const originalText = button.textContent ?? 'Test credentials only';
    button.disabled = true;
    button.textContent = 'Testing...';
    result.hidden = false;
    result.className = 'alert';
    result.textContent = 'Testing WooCommerce credentials without leaving this page...';

    try {
      const response = await fetch(button.formAction, {
        body: new FormData(form),
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        method: 'POST'
      });
      const payload = await response.json().catch(() => null);
      const message = payload !== null && typeof payload.message === 'string'
        ? payload.message
        : 'WooCommerce credential test failed.';
      result.className = response.ok && payload !== null && payload.ok === true ? 'alert success' : 'alert error';
      result.textContent = message;
    } catch {
      result.className = 'alert error';
      result.textContent = 'Credential test failed before the server replied. The values are still on this page; check the network and try again.';
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
})();
`.trim();

const ADMIN_UI_ROUTE_APP_SCRIPT = `
(() => {
  function syncSelectedOrders(form) {
    const hidden = form.querySelector('input[name="selectedOrderGids"]');
    if (!(hidden instanceof HTMLInputElement)) return;
    const selected = Array.from(form.querySelectorAll('[data-order-selector]'))
      .filter((node) => node instanceof HTMLInputElement && node.checked)
      .map((node) => node instanceof HTMLInputElement ? node.value : '')
      .filter((value) => value !== '');
    hidden.value = selected.join('\\n');
    const count = form.querySelector('[data-selected-order-count]');
    if (count !== null) {
      count.textContent = String(selected.length);
    }
  }

  for (const form of document.querySelectorAll('[data-route-selection-form]')) {
    if (!(form instanceof HTMLFormElement)) continue;
    syncSelectedOrders(form);
    form.addEventListener('change', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.matches('[data-order-selector]')) {
        syncSelectedOrders(form);
      }
    });
    form.addEventListener('submit', () => syncSelectedOrders(form));
  }
})();
`.trim();

export type AdminCommerceConnectionsUiDependencies = {
  actor: AdminCommerceActor;
  cookieName?: string;
  deliveryCustomerService?: Pick<
    PrismaDeliveryCustomerProfileService,
    "getOrderCustomerNoteContext" | "mergeProfiles" | "updateAdminMemo"
  >;
  driverService?: Pick<
    AdminDriverServiceContract,
    | "createPendingDriver"
    | "deleteDriver"
    | "listDrivers"
    | "regenerateInviteCode"
  >;
  loginSecret: string;
  now?: () => Date;
  onboardingService: Pick<
    WooCommerceConnectionOnboardingService,
    | "createConnection"
    | "getConnection"
    | "listConnections"
    | "rotateCredentials"
    | "rotateWebhookSecret"
    | "testConnection"
    | "updateStatus"
  >;
  notificationService?: AdminNotificationServiceContract;
  pairingCodeService?: {
    createPairingCode(input: {
      commerceConnectionId: string;
      issuedAt: Date;
      issuedBy: string | null;
      siteUrl: string;
    }): Promise<{ code: string; expiresAt: Date; siteUrl: string }>;
  };
  geocodingService?: Pick<GeocodingService, "geocode" | "status">;
  orderIngestAuditService?: OrderIngestAuditServiceContract;
  orderSyncService?: {
    listDeliveryBatchCandidates?(input: {
      deliveryDate?: string;
      shopDomain: string;
    }): Promise<DeliveryBatchCandidate[]>;
    listCanonicalOrders(input: {
      filters?: ListCanonicalOrdersFilters;
      shopDomain: string;
    }): Promise<CanonicalOrderRow[]>;
    patchCanonicalOrder?(
      input: PatchCanonicalOrderInput,
    ): Promise<CanonicalOrderRow | null>;
    patchCanonicalOrderCoordinates?(
      input: PatchCanonicalOrderCoordinatesInput,
    ): Promise<CanonicalOrderRow | null>;
    patchCanonicalOrderGeocodeDiagnostics?(
      input: PatchCanonicalOrderGeocodeDiagnosticsInput,
    ): Promise<CanonicalOrderRow | null>;
  };
  wooSyncService?: AdminWooSyncServiceContract;
  driverAppDownloadUrl?: string;
  publicBaseUrl?: string;
  routeOptimizationJobService?: Pick<
    RouteOptimizationJobService,
    | "createJob"
    | "findJob"
    | "findLatestJob"
    | "markApplyingResult"
    | "markRunning"
    | "reconcileStaleActiveJobs"
    | "recordEngineOutcome"
  >;
  routeOptimizationService?: RouteOptimizationService;
  routeGroupingService?: RouteGroupingService;
  routePlanService?: Pick<
    RoutePlanService,
    | "assignRoutePlanDriver"
    | "createRoutePlan"
    | "createRoutePlanFromOrderIds"
    | "getRoutePlanDetail"
    | "routePlanExists"
    | "listRoutePlans"
    | "saveRoutePlan"
    | "updateRoutePlanStops"
  > &
    Partial<
      Pick<
        RoutePlanService,
        "deleteRoutePlan" | "publishRoutePlan" | "refreshRouteGeometryForRoutePlan" | "updateRoutePlanOptions"
      >
    >;
  secureCookies: boolean;
  sessionSecret: string;
  sessionTtlMs?: number;
  settingsService?: {
    getSettings(input: {
      shopDomain: string;
    }): Promise<AdminStoreSettings | null>;
    saveSettings(
      input: SaveAdminStoreSettingsInput,
    ): Promise<AdminStoreSettings>;
  };
};

export function registerAdminCommerceConnectionsUiRoutes(
  app: FastifyInstance,
  dependencies: AdminCommerceConnectionsUiDependencies,
): void {
  app.get("/", async (_request, reply) => redirect(reply, ADMIN_UI_ROOT_PATH));

  app.get(ADMIN_ROOT_PATH, async (_request, reply) =>
    redirect(reply, ADMIN_UI_ROOT_PATH),
  );

  app.get(DRIVER_APP_INSTALL_PATH, async (_request, reply) => {
    const downloadUrl = dependencies.driverAppDownloadUrl;
    if (downloadUrl === undefined) {
      return sendJson(reply, 404, {
        ok: false,
        message: "Driver app download is not configured.",
      });
    }
    return reply.code(302).header("Location", downloadUrl).send("");
  });

  app.get(ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT_PATH, async (_request, reply) =>
    reply
      .code(200)
      .type("text/javascript; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT),
  );

  app.get(ADMIN_UI_ROUTE_APP_SCRIPT_PATH, async (_request, reply) =>
    reply
      .code(200)
      .type("text/javascript; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(ADMIN_UI_ROUTE_APP_SCRIPT),
  );

  registerRouteOpsAppRoutes(app, dependencies);

  app.get(ADMIN_UI_PLUGIN_LAUNCH_PATH, async (request, reply) => {
    const token = readQueryString(request.query, "token");
    if (token === null) {
      return sendHtml(
        reply,
        401,
        renderLoginPage({ error: "Invalid plugin launch token" }),
      );
    }
    const launch = verifyAdminWebLaunchToken({
      token,
      sessionSecret: dependencies.sessionSecret,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    if (launch === null) {
      return sendHtml(
        reply,
        401,
        renderLoginPage({ error: "Invalid or expired plugin launch token" }),
      );
    }
    const created = createAdminWebSession({
      sameSite: "Lax",
      secure: dependencies.secureCookies,
      sessionSecret: dependencies.sessionSecret,
      subject: launch.subject,
      ...(dependencies.cookieName === undefined
        ? {}
        : { cookieName: dependencies.cookieName }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.sessionTtlMs === undefined
        ? {}
        : { ttlMs: dependencies.sessionTtlMs }),
    });
    return reply
      .code(303)
      .header(
        "Set-Cookie",
        sessionSetCookieHeaders(dependencies, created.cookieHeader),
      )
      .header("Location", launch.returnPath)
      .send("");
  });

  app.get(ADMIN_UI_ROOT_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    if (isWpPluginSession(session)) {
      return sendHtml(
        reply,
        200,
        renderWpPluginSessionLandingPage({ session }),
      );
    }
    return sendHtml(
      reply,
      200,
      renderDashboardPage({
        actor: dependencies.actor,
        csrfToken: session.csrfToken,
      }),
    );
  });

  app.get(ADMIN_UI_STORE_SESSIONS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    if (isWpPluginSession(session)) {
      return redirectWpPluginSessionToOperate(
        reply,
        session,
        "Store session picker requires CLEVER admin login.",
      );
    }
    return renderStoreSessions(reply, request, dependencies, session);
  });

  app.get(ADMIN_UI_COMMERCE_CONNECTIONS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    if (isWpPluginSession(session)) {
      return redirectWpPluginSessionToOperate(
        reply,
        session,
        "Connection setup requires CLEVER admin login.",
      );
    }
    return sendHtml(
      reply,
      200,
      renderCommerceConnectionsPage({
        actor: dependencies.actor,
        csrfToken: session.csrfToken,
      }),
    );
  });

  app.get(ADMIN_UI_APP_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return rejectDirectRouteOpsWorkspaceLink(reply);
    return renderRouteOpsSpaShell(reply, request, dependencies, session);
  });

  app.get(ADMIN_UI_APP_DASHBOARD_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return rejectDirectRouteOpsWorkspaceLink(reply);
    return renderRouteOpsSpaShell(reply, request, dependencies, session);
  });

  app.get(ADMIN_UI_APP_ORDERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return rejectDirectRouteOpsWorkspaceLink(reply);
    return renderRouteOpsSpaShell(reply, request, dependencies, session);
  });

  app.get(ADMIN_UI_APP_ROUTE_PLANS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return rejectDirectRouteOpsWorkspaceLink(reply);
    return renderRouteOpsSpaShell(reply, request, dependencies, session);
  });

  app.get(`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/new`, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return rejectDirectRouteOpsWorkspaceLink(reply);
    return renderRouteOpsSpaShell(reply, request, dependencies, session);
  });

  app.get<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return rejectDirectRouteOpsWorkspaceLink(reply);
      return renderRouteOpsSpaShell(reply, request, dependencies, session);
    },
  );

  app.get<{ Params: { routeGroupId: string } }>(
    `${ADMIN_UI_APP_ROUTE_GROUPS_PATH}/:routeGroupId`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return rejectDirectRouteOpsWorkspaceLink(reply);
      return renderRouteOpsSpaShell(reply, request, dependencies, session);
    },
  );

  app.post(
    `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/create`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return handleRoutePlanCreate(request, reply, dependencies, session);
    },
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/stops`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return handleRouteStopsUpdate(
        request,
        reply,
        dependencies,
        session,
        request.params.routePlanId,
      );
    },
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/driver`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return handleRouteDriverAssignment(
        request,
        reply,
        dependencies,
        session,
        request.params.routePlanId,
      );
    },
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/optimize`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return handleRouteOptimize(
        request,
        reply,
        dependencies,
        session,
        request.params.routePlanId,
      );
    },
  );

  app.get(ADMIN_UI_APP_DRIVERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return rejectDirectRouteOpsWorkspaceLink(reply);
    return renderRouteOpsSpaShell(reply, request, dependencies, session);
  });

  app.post(ADMIN_UI_APP_DRIVERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return handleDriverCreate(request, reply, dependencies, session);
  });

  app.get(ADMIN_UI_APP_SETTINGS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return rejectDirectRouteOpsWorkspaceLink(reply);
    return renderRouteOpsSpaShell(reply, request, dependencies, session);
  });

  app.post(ADMIN_UI_APP_SETTINGS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return handleSettingsSave(request, reply, dependencies, session);
  });

  app.get(ADMIN_UI_ROUTE_PLANS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return redirectLegacyAdminUiGetPath(
      request,
      reply,
      ADMIN_UI_APP_ROUTE_PLANS_PATH,
    );
  });

  app.post(`${ADMIN_UI_ROUTE_PLANS_PATH}/create`, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return handleRoutePlanCreate(request, reply, dependencies, session);
  });

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_ROUTE_PLANS_PATH}/:routePlanId/stops`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return handleRouteStopsUpdate(
        request,
        reply,
        dependencies,
        session,
        request.params.routePlanId,
      );
    },
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_ROUTE_PLANS_PATH}/:routePlanId/driver`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      return handleRouteDriverAssignment(
        request,
        reply,
        dependencies,
        session,
        request.params.routePlanId,
      );
    },
  );

  app.get(ADMIN_UI_ORDERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return redirectLegacyAdminUiGetPath(
      request,
      reply,
      ADMIN_UI_APP_ORDERS_PATH,
    );
  });

  app.get(ADMIN_UI_DRIVERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return redirectLegacyAdminUiGetPath(
      request,
      reply,
      ADMIN_UI_APP_DRIVERS_PATH,
    );
  });

  app.post(ADMIN_UI_DRIVERS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return handleDriverCreate(request, reply, dependencies, session);
  });

  app.get(ADMIN_UI_SETTINGS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return redirectLegacyAdminUiGetPath(
      request,
      reply,
      ADMIN_UI_APP_SETTINGS_PATH,
    );
  });

  app.post(ADMIN_UI_SETTINGS_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    return handleSettingsSave(request, reply, dependencies, session);
  });

  app.get(LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH, async (_request, reply) =>
    redirect(reply, ADMIN_UI_LOGIN_PATH),
  );
  app.post(LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH, async (_request, reply) =>
    redirect(reply, ADMIN_UI_LOGIN_PATH),
  );

  app.get(ADMIN_UI_LOGIN_PATH, async (request, reply) => {
    const returnTo = readAdminUiLoginReturnTo(request);
    const session = readSession(request, dependencies);
    if (session !== null) {
      return redirect(reply, returnTo);
    }
    return sendHtml(reply, 200, renderLoginPage({ returnTo }));
  });

  app.post(ADMIN_UI_LOGIN_PATH, async (request, reply) => {
    let returnTo = ADMIN_UI_ROOT_PATH;
    try {
      const fields = await readAdminUiFormFields(request, {
        allowedFields: ["loginSecret", "returnTo"],
        maxFields: 2,
      });
      returnTo = normalizeAdminUiLoginReturnPath(
        readOptionalField(fields, "returnTo") ?? ADMIN_UI_ROOT_PATH,
      );
      const loginSecret = readRequiredField(
        fields,
        "loginSecret",
        "login secret",
      );
      if (
        !verifyAdminWebLoginSecret({
          candidate: loginSecret,
          expected: dependencies.loginSecret,
        })
      ) {
        request.log.warn(
          {
            event: "clever_admin_ui_login_rejected",
            surface: "admin_commerce_connections_ui",
          },
          "CLEVER admin UI login rejected",
        );
        return sendHtml(
          reply,
          401,
          renderLoginPage({
            error: "Invalid admin login secret",
            returnTo,
          }),
        );
      }

      const created = createAdminWebSession({
        secure: dependencies.secureCookies,
        sessionSecret: dependencies.sessionSecret,
        subject: dependencies.actor.subject,
        ...(dependencies.cookieName === undefined
          ? {}
          : { cookieName: dependencies.cookieName }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.sessionTtlMs === undefined
          ? {}
          : { ttlMs: dependencies.sessionTtlMs }),
      });
      return reply
        .code(303)
        .header(
          "Set-Cookie",
          sessionSetCookieHeaders(dependencies, created.cookieHeader),
        )
        .header("Location", returnTo)
        .send("");
    } catch (error) {
      if (!(error instanceof WooCommerceOnboardingError)) {
        request.log.error(
          { event: "clever_admin_ui_login_failed" },
          "CLEVER admin UI login failed",
        );
      }
      return sendHtml(
        reply,
        error instanceof WooCommerceOnboardingError ? error.httpStatus : 500,
        renderLoginPage({ error: sanitizeErrorMessage(error), returnTo }),
      );
    }
  });

  app.get(ADMIN_UI_WOOCOMMERCE_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    if (isWpPluginSession(session)) {
      return redirectWpPluginSessionToOperate(
        reply,
        session,
        "Connection setup requires CLEVER admin login.",
      );
    }

    const shopDomain = readQueryString(request.query, "shopDomain");
    const notice = readQueryString(request.query, "notice");
    const error = readQueryString(request.query, "error");
    return renderHome(reply, request, dependencies, session, {
      currentShopDomain: shopDomain,
      ...(error === null ? {} : { error: truncateUiMessage(error) }),
      ...(error === null ? {} : { statusCode: 200 }),
      ...(notice === null ? {} : { notice: truncateUiMessage(notice) }),
    });
  });

  app.get(ADMIN_UI_LOGOUT_PATH, async (_request, reply) =>
    redirectWithClearedSession(reply, dependencies, ADMIN_UI_LOGIN_PATH),
  );
  app.post(ADMIN_UI_LOGOUT_PATH, async (request, reply) =>
    handleLogout(request, reply, dependencies),
  );
  app.get(LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH, async (_request, reply) =>
    redirectWithClearedSession(reply, dependencies, ADMIN_UI_LOGIN_PATH),
  );
  app.post(LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH, async (request, reply) =>
    handleLogout(request, reply, dependencies),
  );

  app.post(`${ADMIN_UI_WOOCOMMERCE_PATH}/test`, async (request, reply) => {
    const session = readSession(request, dependencies);
    const jsonResponse = wantsJson(request);
    if (session === null) {
      if (jsonResponse)
        return sendJson(reply, 401, {
          message: "Admin UI login required",
          ok: false,
        });
      return redirect(reply, ADMIN_UI_LOGIN_PATH);
    }
    if (isWpPluginSession(session)) {
      const message = "Connection setup requires CLEVER admin login.";
      if (jsonResponse) return sendJson(reply, 403, { message, ok: false });
      return redirectWpPluginSessionToOperate(reply, session, message);
    }

    let fields: Record<string, string> | null = null;
    let shopDomain: string | null = null;
    try {
      assertSameOriginMutation(request, dependencies);
      fields = await readAdminUiFormFields(request, {
        allowedFields: credentialFieldNames(),
        maxFields: 8,
      });
      assertValidCsrf(session, fields.csrfToken);
      shopDomain = readOptionalField(fields, "shopDomain");
      const result = await dependencies.onboardingService.testConnection({
        actor: dependencies.actor,
        ...readCredentialFields(fields),
      });
      const message = `WooCommerce credentials verified at ${result.checkedAt}`;
      if (jsonResponse) return sendJson(reply, 200, { message, ok: true });
      return redirectToWooCommerceHome(reply, {
        currentShopDomain: shopDomain,
        notice: message,
      });
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      if (jsonResponse) {
        const statusCode =
          error instanceof WooCommerceOnboardingError ? error.httpStatus : 500;
        return sendJson(reply, statusCode, { message, ok: false });
      }
      return redirectToWooCommerceHome(reply, {
        currentShopDomain:
          shopDomain ?? readOptionalField(fields ?? {}, "shopDomain"),
        error: message,
      });
    }
  });

  app.post(ADMIN_UI_WOOCOMMERCE_PATH, async (request, reply) => {
    const session = readSession(request, dependencies);
    if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
    if (isWpPluginSession(session)) {
      return redirectWpPluginSessionToOperate(
        reply,
        session,
        "Connection setup requires CLEVER admin login.",
      );
    }

    let shopDomain: string | null = null;
    try {
      assertSameOriginMutation(request, dependencies);
      const fields = await readAdminUiFormFields(request, {
        allowedFields: credentialFieldNames(),
        maxFields: 8,
      });
      assertValidCsrf(session, fields.csrfToken);
      shopDomain = readOptionalField(fields, "shopDomain");
      const result = await dependencies.onboardingService.createConnection({
        actor: dependencies.actor,
        ...readCredentialFields(fields),
      });
      return renderHome(reply, request, dependencies, session, {
        currentShopDomain: result.connection.shopDomain,
        notice: "WooCommerce connection saved.",
        webhookSetup: toWebhookSetup(request, dependencies, result),
      });
    } catch (error) {
      return sendUiError(
        reply,
        request,
        dependencies,
        session,
        error,
        shopDomain,
      );
    }
  });

  app.post<{ Params: { connectionId: string } }>(
    `${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/credentials`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      if (isWpPluginSession(session)) {
        return redirectWpPluginSessionToOperate(
          reply,
          session,
          "Connection setup requires CLEVER admin login.",
        );
      }

      let shopDomain: string | null = null;
      try {
        assertSameOriginMutation(request, dependencies);
        const fields = await readAdminUiFormFields(request, {
          allowedFields: [
            "csrfToken",
            "shopDomain",
            "wooConsumerKey",
            "wooConsumerSecret",
          ],
          maxFields: 4,
        });
        assertValidCsrf(session, fields.csrfToken);
        shopDomain = readRequiredField(fields, "shopDomain", "shopDomain");
        await requireConnectionMatchesShop({
          actor: dependencies.actor,
          connectionId: request.params.connectionId,
          dependencies,
          shopDomain,
        });
        const connection =
          await dependencies.onboardingService.rotateCredentials({
            actor: dependencies.actor,
            connectionId: request.params.connectionId,
            consumerKey: readRequiredField(
              fields,
              "wooConsumerKey",
              "WooCommerce consumer key",
            ),
            consumerSecret: readRequiredField(
              fields,
              "wooConsumerSecret",
              "WooCommerce consumer secret",
            ),
          });
        return renderHome(reply, request, dependencies, session, {
          currentShopDomain: connection.shopDomain,
          notice: "WooCommerce REST credentials rotated.",
        });
      } catch (error) {
        return sendUiError(
          reply,
          request,
          dependencies,
          session,
          error,
          shopDomain,
        );
      }
    },
  );

  app.post<{ Params: { connectionId: string } }>(
    `${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/webhook-secret`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      if (isWpPluginSession(session)) {
        return redirectWpPluginSessionToOperate(
          reply,
          session,
          "Connection setup requires CLEVER admin login.",
        );
      }

      let shopDomain: string | null = null;
      try {
        assertSameOriginMutation(request, dependencies);
        const fields = await readAdminUiFormFields(request, {
          allowedFields: ["csrfToken", "shopDomain", "webhookSecret"],
          maxFields: 3,
        });
        assertValidCsrf(session, fields.csrfToken);
        shopDomain = readRequiredField(fields, "shopDomain", "shopDomain");
        await requireConnectionMatchesShop({
          actor: dependencies.actor,
          connectionId: request.params.connectionId,
          dependencies,
          shopDomain,
        });
        const result = await dependencies.onboardingService.rotateWebhookSecret(
          {
            actor: dependencies.actor,
            connectionId: request.params.connectionId,
            webhookSecret: readOptionalField(fields, "webhookSecret"),
          },
        );
        return renderHome(reply, request, dependencies, session, {
          currentShopDomain: result.connection.shopDomain,
          notice: "WooCommerce webhook secret rotated.",
          webhookSetup: toWebhookSetup(request, dependencies, result),
        });
      } catch (error) {
        return sendUiError(
          reply,
          request,
          dependencies,
          session,
          error,
          shopDomain,
        );
      }
    },
  );

  app.post<{ Params: { connectionId: string } }>(
    `${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/pairing-code`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      if (isWpPluginSession(session)) {
        return redirectWpPluginSessionToOperate(
          reply,
          session,
          "Connection setup requires CLEVER admin login.",
        );
      }

      let shopDomain: string | null = null;
      try {
        assertSameOriginMutation(request, dependencies);
        const fields = await readAdminUiFormFields(request, {
          allowedFields: ["csrfToken", "shopDomain"],
          maxFields: 2,
        });
        assertValidCsrf(session, fields.csrfToken);
        shopDomain = readRequiredField(fields, "shopDomain", "shopDomain");
        const connection = await requireConnectionMatchesShop({
          actor: dependencies.actor,
          connectionId: request.params.connectionId,
          dependencies,
          shopDomain,
        });
        const pairingCodeService = requirePairingCodeService(dependencies);
        const pairingCode = await pairingCodeService.createPairingCode({
          commerceConnectionId: connection.id,
          issuedAt: dependencies.now?.() ?? new Date(),
          issuedBy: dependencies.actor.subject,
          siteUrl: connection.siteUrl,
        });
        return renderHome(reply, request, dependencies, session, {
          currentShopDomain: connection.shopDomain,
          notice: "WordPress plugin pairing code generated.",
          pairingCodeSetup: toPairingCodeSetup(pairingCode),
        });
      } catch (error) {
        return sendUiError(
          reply,
          request,
          dependencies,
          session,
          error,
          shopDomain,
        );
      }
    },
  );

  app.post<{ Params: { connectionId: string } }>(
    `${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/status`,
    async (request, reply) => {
      const session = readSession(request, dependencies);
      if (session === null) return redirect(reply, ADMIN_UI_LOGIN_PATH);
      if (isWpPluginSession(session)) {
        return redirectWpPluginSessionToOperate(
          reply,
          session,
          "Connection setup requires CLEVER admin login.",
        );
      }

      let shopDomain: string | null = null;
      try {
        assertSameOriginMutation(request, dependencies);
        const fields = await readAdminUiFormFields(request, {
          allowedFields: ["csrfToken", "shopDomain", "status"],
          maxFields: 3,
        });
        assertValidCsrf(session, fields.csrfToken);
        shopDomain = readRequiredField(fields, "shopDomain", "shopDomain");
        await requireConnectionMatchesShop({
          actor: dependencies.actor,
          connectionId: request.params.connectionId,
          dependencies,
          shopDomain,
        });
        const connection = await dependencies.onboardingService.updateStatus({
          actor: dependencies.actor,
          connectionId: request.params.connectionId,
          status: readStatusField(fields.status),
        });
        return renderHome(reply, request, dependencies, session, {
          currentShopDomain: connection.shopDomain,
          notice: `WooCommerce connection ${connection.status.toLowerCase()}.`,
        });
      } catch (error) {
        return sendUiError(
          reply,
          request,
          dependencies,
          session,
          error,
          shopDomain,
        );
      }
    },
  );

  app.get<{ Params: { "*": string } }>(
    `${ADMIN_UI_APP_PATH}/*`,
    async (request, reply) => redirectAdminUiBrowserFallback(request, reply),
  );

  app.get<{ Params: { "*": string } }>(
    `${ADMIN_UI_ROOT_PATH}/*`,
    async (request, reply) => redirectAdminUiBrowserFallback(request, reply),
  );
}

function registerRouteOpsAppRoutes(
  app: FastifyInstance,
  dependencies: AdminCommerceConnectionsUiDependencies,
): void {
  app.get<{ Params: { "*": string } }>(
    `${ADMIN_UI_APP_ASSETS_PATH}/*`,
    async (request, reply) =>
      sendRouteOpsStaticAsset(reply, request.params["*"]),
  );

  app.get<{ Params: { "*": string } }>(
    `${ADMIN_UI_APP_VENDOR_PATH}/*`,
    async (request, reply) =>
      sendRouteOpsVendorAsset(reply, request.params["*"]),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/bootstrap`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        const shopDomain = readRouteOpsShopDomain(request, session);
        const settings =
          shopDomain === null || dependencies.settingsService === undefined
            ? null
            : await dependencies.settingsService.getSettings({ shopDomain });
        return routeOpsData({
          appUrls: {
            dashboard: ADMIN_UI_APP_DASHBOARD_PATH,
            drivers: ADMIN_UI_APP_DRIVERS_PATH,
            orders: ADMIN_UI_APP_ORDERS_PATH,
            routes: ADMIN_UI_APP_ROUTE_PLANS_PATH,
            settings: ADMIN_UI_APP_SETTINGS_PATH,
          },
          csrfToken: session.csrfToken,
          driverApp: {
            installUrl:
              dependencies.driverAppDownloadUrl === undefined
                ? null
                : `${resolveBaseUrl(request, dependencies)}${DRIVER_APP_INSTALL_PATH}`,
          },
          locale: settings?.locale === "ko-KR" ? "ko-KR" : "en-CA",
          mapConfig: readCurrentRouteOpsMapConfig(),
          mode: isWpPluginSession(session) ? "plugin" : "internal-admin",
          routerConfig: readRouteOpsRouterConfig(),
          shopDomain,
        });
      },
    ),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/notifications`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        const shopDomain = requireRouteOpsShopDomain(request, session);
        if (dependencies.notificationService === undefined) {
          throw new WooCommerceOnboardingError(
            "BAD_REQUEST",
            "Notification service is not enabled in this runtime.",
            400,
          );
        }
        const limit = readRouteOpsNotificationLimit(request.query);
        return routeOpsData(
          await dependencies.notificationService.listNotifications({
            includeRead:
              readQueryString(request.query, "unreadOnly") !== "true",
            ...(limit === undefined ? {} : { limit }),
            shopDomain,
          }),
        );
      },
    ),
  );

  app.get(
    `${ADMIN_UI_APP_API_PATH}/notifications/stream`,
    async (request, reply) =>
      openAdminNotificationStream(request, reply, dependencies),
  );

  app.patch<{ Params: { notificationId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/notifications/:notificationId/read`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.notificationService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Notification service is not enabled in this runtime.",
              400,
            );
          }
          const notification =
            await dependencies.notificationService.markNotificationRead({
              notificationId: request.params.notificationId,
              shopDomain,
            });
          if (notification === null) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Notification not found.",
              404,
            );
          }
          return routeOpsData({ notification });
        },
      ),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/order-ingest-audit`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        const shopDomain = requireRouteOpsShopDomain(request, session);
        if (dependencies.orderIngestAuditService === undefined) {
          throw new WooCommerceOnboardingError(
            "BAD_REQUEST",
            "Order ingest audit service is not enabled in this runtime.",
            400,
          );
        }
        const orderNumber = readQueryString(request.query, "orderNumber");
        if (orderNumber === null) {
          throw new WooCommerceOnboardingError(
            "BAD_REQUEST",
            "orderNumber is required.",
            400,
          );
        }
        return routeOpsData({
          audit: await dependencies.orderIngestAuditService.lookup({
            orderNumber,
            shopDomain,
          }),
        });
      },
    ),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/orders`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        const shopDomain = requireRouteOpsShopDomain(request, session);
        if (dependencies.orderSyncService === undefined) {
          throw new WooCommerceOnboardingError(
            "BAD_REQUEST",
            "Order list service is not enabled in this runtime.",
            400,
          );
        }
        const filters = await readRouteOpsOrderFilters({
          dependencies,
          query: request.query,
          shopDomain,
        });
        const [orders, reviewBlockers] = await Promise.all([
          dependencies.orderSyncService.listCanonicalOrders({
            filters,
            shopDomain,
          }),
          dependencies.orderSyncService.listCanonicalOrders({
            filters: {
              ...(filters.deliveryArea === undefined
                ? {}
                : { deliveryArea: filters.deliveryArea }),
              ...(filters.deliverySession === undefined
                ? {}
                : { deliverySession: filters.deliverySession }),
              ...(filters.routeOpsScope === undefined
                ? {}
                : { routeOpsScope: filters.routeOpsScope }),
              ...(filters.routeOpsToday === undefined
                ? {}
                : { routeOpsToday: filters.routeOpsToday }),
              ...(filters.routeOpsScope === undefined
                ? {}
                : { routeOpsTab: "needs_review" }),
              ...(filters.search === undefined
                ? {}
                : { search: filters.search }),
              ...(filters.serviceType === undefined
                ? {}
                : { serviceType: filters.serviceType }),
              readiness: "NEEDS_REVIEW",
            },
            shopDomain,
          }),
        ]);
        return routeOpsData({
          orders: orders.map(toRouteOpsOrderDto),
          reviewBlockers: reviewBlockers.map(toRouteOpsOrderDto),
        });
      },
    ),
  );

  app.post(`${ADMIN_UI_APP_API_PATH}/orders/sync`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        assertRouteOpsMutationCsrf(request, session);
        const shopDomain = requireRouteOpsShopDomain(request, session);
        if (dependencies.wooSyncService === undefined) {
          throw new WooCommerceOnboardingError(
            "BAD_REQUEST",
            "WooCommerce sync is not enabled in this runtime.",
            400,
          );
        }
        const accepted = await dependencies.wooSyncService.requestSync({
          payload: readRouteOpsWooSyncRequestBody(request.body),
          shopDomain,
        });
        scheduleRouteOpsWooSyncProcessing({
          accepted,
          request,
          sanitizeError: sanitizeRouteUiError,
          service: dependencies.wooSyncService,
          shopDomain,
        });
        return routeOpsData(toRouteOpsWooSyncResponse(accepted), 202);
      },
    ),
  );

  app.get(
    `${ADMIN_UI_APP_API_PATH}/orders/sync/latest`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.wooSyncService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "WooCommerce sync is not enabled in this runtime.",
              400,
            );
          }
          const syncRun = await dependencies.wooSyncService.readLatestSyncRun({
            shopDomain,
          });
          return routeOpsData({ syncRun });
        },
      ),
  );

  app.get<{ Params: { syncRunId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/sync/:syncRunId`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.wooSyncService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "WooCommerce sync is not enabled in this runtime.",
              400,
            );
          }
          if (!isRouteOpsUuid(request.params.syncRunId)) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Sync run id must be a UUID",
              400,
            );
          }
          const syncRun = await dependencies.wooSyncService.readSyncRun({
            shopDomain,
            syncRunId: request.params.syncRunId,
          });
          if (syncRun === null) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Sync run not found",
              404,
            );
          }
          return routeOpsData({ syncRun });
        },
      ),
  );

  app.post<{ Params: { sourceOrderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/woo/:sourceOrderId/sync`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.wooSyncService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "WooCommerce sync is not enabled in this runtime.",
              400,
            );
          }
          const result = await dependencies.wooSyncService.syncSingleOrder({
            shopDomain,
            sourceOrderId: readRouteOpsWooSourceOrderId(
              request.params.sourceOrderId,
            ),
          });
          const order = result.orders[0] ?? null;
          return routeOpsData({
            order: order === null ? null : toRouteOpsOrderDto(order),
            sync: result.sync,
          });
        },
      ),
  );

  app.post(
    `${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const services = requireBulkGeocodeServices(dependencies);
          const filters = await readRouteOpsOrderFilters({
            dependencies,
            query: request.query,
            shopDomain,
          });
          const job = createBulkGeocodeJob({ filters, shopDomain });
          void runBulkGeocodeJob({
            actor: dependencies.actor.subject,
            job,
            services,
            toOrderDto: toRouteOpsOrderDto,
          });

          return routeOpsData(toBulkGeocodeOrderResponse(job), 202);
        },
      ),
  );

  app.get<{ Params: { jobId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode/:jobId`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        (session) => {
          const job = readBulkGeocodeJobForSession(
            request.params.jobId,
            requireRouteOpsShopDomain(request, session),
          );
          return routeOpsData(toBulkGeocodeOrderResponse(job));
        },
      ),
  );

  app.post(`${ADMIN_UI_APP_API_PATH}/orders/geocode`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        assertRouteOpsMutationCsrf(request, session);
        const shopDomain = requireRouteOpsShopDomain(request, session);
        const services = requireBulkGeocodeServices(dependencies);
        const filters = await readRouteOpsOrderFilters({
          dependencies,
          query: request.query,
          shopDomain,
        });
        const job = createBulkGeocodeJob({ filters, shopDomain });
        void runBulkGeocodeJob({
          actor: dependencies.actor.subject,
          job,
          services,
          toOrderDto: toRouteOpsOrderDto,
        });

        return routeOpsData(
          {
            geocode: toBulkGeocodeJobDto(job),
          },
          202,
        );
      },
    ),
  );

  app.get<{ Params: { jobId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/geocode/:jobId`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        (session) => {
          const job = readBulkGeocodeJobForSession(
            request.params.jobId,
            requireRouteOpsShopDomain(request, session),
          );
          return routeOpsData({ geocode: toBulkGeocodeJobDto(job) });
        },
      ),
  );

  app.get<{ Params: { orderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/:orderId`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.orderSyncService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Order list service is not enabled in this runtime.",
              400,
            );
          }
          const orders =
            await dependencies.orderSyncService.listCanonicalOrders({
              shopDomain,
            });
          const order = findRouteOpsOrderByNeutralId(
            orders,
            request.params.orderId,
          );
          if (order === null)
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Order not found",
              404,
            );
          return routeOpsData({ order: toRouteOpsOrderDto(order) });
        },
      ),
  );

  app.post<{ Params: { orderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/:orderId/customer-note-context`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.deliveryCustomerService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Delivery customer note context is not enabled in this runtime.",
              400,
            );
          }
          if (!isRouteOpsUuid(request.params.orderId)) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Order id must be a UUID",
              400,
            );
          }
          const context =
            await dependencies.deliveryCustomerService.getOrderCustomerNoteContext({
              orderId: request.params.orderId,
              shopDomain,
            });
          if (context === null) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Order not found",
              404,
            );
          }
          return routeOpsData(context);
        },
      ),
  );

  app.patch<{ Params: { profileId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/delivery-customers/:profileId/admin-memo`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.deliveryCustomerService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Delivery customer memo editing is not enabled in this runtime.",
              400,
            );
          }
          if (!isRouteOpsUuid(request.params.profileId)) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Delivery customer profile id must be a UUID",
              400,
            );
          }
          const result = await dependencies.deliveryCustomerService.updateAdminMemo({
            adminMemo: readRouteOpsAdminMemo(request.body),
            profileId: request.params.profileId,
            shopDomain,
          });
          if (result === null) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Delivery customer profile not found",
              404,
            );
          }
          return routeOpsData(result);
        },
      ),
  );

  app.post<{ Params: { sourceProfileId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/delivery-customers/:sourceProfileId/merge`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.deliveryCustomerService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Delivery customer merge is not enabled in this runtime.",
              400,
            );
          }
          if (!isRouteOpsUuid(request.params.sourceProfileId)) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Source delivery customer profile id must be a UUID",
              400,
            );
          }
          const targetProfileId = readRouteOpsTargetProfileId(request.body);
          const result = await dependencies.deliveryCustomerService.mergeProfiles({
            sourceProfileId: request.params.sourceProfileId,
            targetProfileId,
            shopDomain,
          });
          if (result === null) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Delivery customer profiles not found",
              404,
            );
          }
          return routeOpsData(result);
        },
      ),
  );

  app.get<{ Params: { orderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata-diagnostics`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.orderSyncService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Order diagnostics service is not enabled in this runtime.",
              400,
            );
          }
          const orders =
            await dependencies.orderSyncService.listCanonicalOrders({
              shopDomain,
            });
          const order = findRouteOpsOrderByNeutralId(
            orders,
            request.params.orderId,
          );
          if (order === null)
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Order not found",
              404,
            );
          return routeOpsData({
            diagnostics: order.deliveryMetadataDiagnostics ?? null,
            order: toRouteOpsOrderDto(order),
          });
        },
      ),
  );

  app.patch<{ Params: { orderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (
            dependencies.orderSyncService?.patchCanonicalOrder === undefined
          ) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Order metadata editing is not enabled in this runtime.",
              400,
            );
          }
          const body = readRouteOpsBodyObject(request.body);
          const routeScopeConfig = await readRouteOpsRouteScopeConfig(
            dependencies,
            shopDomain,
          );
          const order = await dependencies.orderSyncService.patchCanonicalOrder(
            {
              actor: dependencies.actor.subject,
              orderId: request.params.orderId,
              patch: readRouteOpsMetadataPatch(body, routeScopeConfig),
              shopDomain,
            },
          );
          if (order === null)
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Order not found",
              404,
            );
          return routeOpsData({ order: toRouteOpsOrderDto(order) });
        },
      ),
  );

  app.patch<{ Params: { orderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/:orderId/coordinates`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (
            dependencies.orderSyncService?.patchCanonicalOrderCoordinates ===
            undefined
          ) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Order coordinate editing is not enabled in this runtime.",
              400,
            );
          }
          const body = readRouteOpsBodyObject(request.body);
          const order =
            await dependencies.orderSyncService.patchCanonicalOrderCoordinates({
              actor: dependencies.actor.subject,
              latitude: readLatitude(body.latitude),
              longitude: readLongitude(body.longitude),
              orderId: request.params.orderId,
              shopDomain,
              source: readCoordinateSource(body.source),
            });
          if (order === null)
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Order not found",
              404,
            );
          return routeOpsData({ order: toRouteOpsOrderDto(order) });
        },
      ),
  );

  app.post<{ Params: { orderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/:orderId/geocode`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.orderSyncService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Order list service is not enabled in this runtime.",
              400,
            );
          }
          if (dependencies.geocodingService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Geocoding is not enabled in this runtime.",
              400,
            );
          }
          const body = readRouteOpsBodyObject(request.body);
          const orders =
            await dependencies.orderSyncService.listCanonicalOrders({
              shopDomain,
            });
          const current = findRouteOpsOrderByNeutralId(
            orders,
            request.params.orderId,
          );
          if (current === null)
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Order not found",
              404,
            );
          const address = readRouteOpsAddress(
            body.address,
            current.shippingAddress,
          );
          const geocode = await dependencies.geocodingService.geocode({
            address,
            shopDomain,
          });
          if (!geocode.ok) {
            if (
              dependencies.orderSyncService
                .patchCanonicalOrderGeocodeDiagnostics !== undefined
            ) {
              await dependencies.orderSyncService.patchCanonicalOrderGeocodeDiagnostics(
                {
                  actor: dependencies.actor.subject,
                  diagnostic: summarizeGeocodeDiagnostic(
                    geocode,
                    "single_order_geocode",
                  ),
                  geocodeStatus:
                    geocode.code === "BLANK_ADDRESS" ? "PENDING" : "FAILED",
                  orderId: current.orderId,
                  shopDomain,
                  source: "single_order_geocode",
                },
              );
            }
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              geocode.message,
              400,
            );
          }
          if (body.save === true) {
            if (
              dependencies.orderSyncService.patchCanonicalOrderCoordinates ===
              undefined
            ) {
              throw new WooCommerceOnboardingError(
                "BAD_REQUEST",
                "Order coordinate editing is not enabled in this runtime.",
                400,
              );
            }
            const order =
              await dependencies.orderSyncService.patchCanonicalOrderCoordinates(
                {
                  actor: dependencies.actor.subject,
                  geocodeDiagnostic: {
                    diagnostic: summarizeGeocodeDiagnostic(
                      geocode,
                      "single_order_geocode",
                    ),
                    source: "single_order_geocode",
                  },
                  latitude: geocode.result.latitude,
                  longitude: geocode.result.longitude,
                  orderId: request.params.orderId,
                  provider: geocode.result.provider,
                  providerPlaceId: geocode.result.providerPlaceId,
                  shopDomain,
                  source: "geocoder",
                },
              );
            if (order === null)
              throw new WooCommerceOnboardingError(
                "NOT_FOUND",
                "Order not found",
                404,
              );
            return routeOpsData({
              geocode: toSafeRouteOpsGeocodeResponse(geocode),
              order: toRouteOpsOrderDto(order),
            });
          }
          return routeOpsData({
            geocode: toSafeRouteOpsGeocodeResponse(geocode),
          });
        },
      ),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/order-batches`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        const shopDomain = requireRouteOpsShopDomain(request, session);
        if (
          dependencies.orderSyncService?.listDeliveryBatchCandidates ===
          undefined
        ) {
          return routeOpsData({ candidates: [] });
        }
        const deliveryDate = normalizeOptionalDate(
          readQueryString(request.query, "deliveryDate"),
        );
        const candidates =
          await dependencies.orderSyncService.listDeliveryBatchCandidates({
            ...(deliveryDate === null ? {} : { deliveryDate }),
            shopDomain,
          });
        return routeOpsData({
          candidates: candidates.map(toRouteOpsBatchCandidateDto),
        });
      },
    ),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/routes`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        const services = requireRouteUiServices(dependencies);
        const shopDomain = requireRouteOpsShopDomain(request, session);
        const deliveryDate = normalizeOptionalDate(
          readQueryString(request.query, "deliveryDate"),
        );
        const routePlans = await services.routePlanService.listRoutePlans({
          ...(deliveryDate === null ? {} : { deliveryDate }),
          shopDomain,
        });
        const routeGroups =
          services.routeGroupingService === undefined
            ? []
            : await services.routeGroupingService.listGroupings({
                ...(deliveryDate === null ? {} : { deliveryDate }),
                shopDomain,
              });
        const childRoutePlanIds = new Set(
          routeGroups.flatMap((group) =>
            group.children
              .map((child) => child.routePlanId)
              .filter((routePlanId): routePlanId is string => routePlanId !== null),
          ),
        );
        const standaloneRoutes = filterRoutePlansByDate(
          routePlans.filter((routePlan) => !childRoutePlanIds.has(routePlan.id)),
          deliveryDate,
        ).map(toRouteOpsRoutePlanDto);
        return routeOpsData({
          routeGroups,
          routePlans: standaloneRoutes,
          standaloneRoutes,
        });
      },
    ),
  );

  app.post(`${ADMIN_UI_APP_API_PATH}/routes`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        assertRouteOpsMutationCsrf(request, session);
        const services = requireRouteUiServices(dependencies);
        const shopDomain = requireRouteOpsShopDomain(request, session);
        const body = readRouteOpsBodyObject(request.body);
        const planDate = normalizeRequiredDate(
          readRequiredJsonString(body, "planDate"),
        );
        const selectedOrderIds = readSelectedNeutralOrderIds(body.orderIds);
        const routeScopeConfig = await readRouteOpsRouteScopeConfig(
          dependencies,
          shopDomain,
        );
        const routePlan = await createRoutePlanFromSelectedOrderIds({
          createdBy: dependencies.actor.subject,
          depotAddress: readNullableJsonString(body.depotAddress),
          depotLatitude: readNullableJsonNumber(body.depotLatitude),
          depotLongitude: readNullableJsonNumber(body.depotLongitude),
          orderIds: selectedOrderIds,
          planDate,
          routeScopeConfig,
          routeName: readRequiredJsonString(body, "routeName"),
          services,
          shopDomain,
        });
        return routeOpsData(
          { routePlan: toRouteOpsRoutePlanDto(routePlan) },
          201,
        );
      },
    ),
  );

  app.post(`${ADMIN_UI_APP_API_PATH}/route-groups`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        assertRouteOpsMutationCsrf(request, session);
        const services = requireRouteUiServices(dependencies);
        const routeGroupingService = requireRouteGroupingService(services);
        const shopDomain = requireRouteOpsShopDomain(request, session);
        const body = readRouteOpsBodyObject(request.body);
        try {
          const grouping = await routeGroupingService.createGrouping({
            createdBy: dependencies.actor.subject,
            name: readRequiredJsonString(body, "groupingName"),
            orderIds: readSelectedNeutralOrderIds(body.orderIds),
            planDate: normalizeRequiredDate(readRequiredJsonString(body, "planDate")),
            shopDomain,
          });
          return routeOpsData({ routeGroup: grouping }, 201);
        } catch (error) {
          throw toRouteGroupingHttpError(error);
        }
      },
    ),
  );

  app.get<{ Params: { routeGroupId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/route-groups/:routeGroupId`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          const routeGroupingService = requireRouteGroupingService(requireRouteUiServices(dependencies));
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const grouping = await routeGroupingService.getGrouping({
            groupingId: request.params.routeGroupId,
            shopDomain,
          });
          if (grouping === null) {
            throw new WooCommerceOnboardingError("NOT_FOUND", "Route grouping not found", 404);
          }
          return routeOpsData({ routeGroup: grouping });
        },
      ),
  );

  app.patch<{ Params: { routeGroupId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/route-groups/:routeGroupId/polygons`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const routeGroupingService = requireRouteGroupingService(requireRouteUiServices(dependencies));
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const body = readRouteOpsBodyObject(request.body);
          try {
            const deletePolygonIds = readOptionalJsonStringArray(body, "deletePolygonIds");
            const grouping = await routeGroupingService.savePolygons({
              ...(deletePolygonIds === undefined ? {} : { deletePolygonIds }),
              expectedUpdatedAt: readRequiredJsonString(body, "expectedUpdatedAt"),
              groupingId: request.params.routeGroupId,
              polygons: readRouteGroupPolygons(body.polygons),
              shopDomain,
            });
            if (grouping === null) throw new WooCommerceOnboardingError("NOT_FOUND", "Route grouping not found", 404);
            return routeOpsData({ routeGroup: grouping });
          } catch (error) {
            throw toRouteGroupingHttpError(error);
          }
        },
      ),
  );

  app.patch<{ Params: { routeGroupId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/route-groups/:routeGroupId/assignments`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const routeGroupingService = requireRouteGroupingService(requireRouteUiServices(dependencies));
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const body = readRouteOpsBodyObject(request.body);
          try {
            const grouping = await routeGroupingService.resolveAssignments({
              assignments: readRouteGroupAssignments(body.assignments),
              groupingId: request.params.routeGroupId,
              shopDomain,
            });
            if (grouping === null) throw new WooCommerceOnboardingError("NOT_FOUND", "Route grouping not found", 404);
            return routeOpsData({ routeGroup: grouping });
          } catch (error) {
            throw toRouteGroupingHttpError(error);
          }
        },
      ),
  );

  app.post<{ Params: { routeGroupId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/route-groups/:routeGroupId/generate-child-routes`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const routeGroupingService = requireRouteGroupingService(requireRouteUiServices(dependencies));
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const body = readRouteOpsBodyObject(request.body);
          try {
            const grouping = await routeGroupingService.generateChildRoutes({
              actor: dependencies.actor.subject,
              confirmRisk: body.confirmRisk === true,
              groupingId: request.params.routeGroupId,
              shopDomain,
            });
            if (grouping === null) throw new WooCommerceOnboardingError("NOT_FOUND", "Route grouping not found", 404);
            return routeOpsData({ routeGroup: grouping });
          } catch (error) {
            throw toRouteGroupingHttpError(error);
          }
        },
      ),
  );

  app.post<{ Params: { routeGroupId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/route-groups/:routeGroupId/rollback`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const routeGroupingService = requireRouteGroupingService(requireRouteUiServices(dependencies));
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const body = readRouteOpsBodyObject(request.body);
          try {
            const grouping = await routeGroupingService.rollback({
              actor: dependencies.actor.subject,
              groupingId: request.params.routeGroupId,
              shopDomain,
              version: readRequiredJsonNumber(body, "version"),
            });
            if (grouping === null) throw new WooCommerceOnboardingError("NOT_FOUND", "Route grouping not found", 404);
            return routeOpsData({ routeGroup: grouping });
          } catch (error) {
            throw toRouteGroupingHttpError(error);
          }
        },
      ),
  );

  app.get<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          const services = requireRouteUiServices(dependencies);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const detail = await services.routePlanService.getRoutePlanDetail({
            routePlanId: request.params.routePlanId,
            shopDomain,
          });
          if (detail === null) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Route plan not found",
              404,
            );
          }
          return routeOpsData(toRouteOpsRoutePlanDetailDto(detail));
        },
      ),
  );

  app.delete<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const services = requireRouteUiServices(dependencies);
          if (services.routePlanService.deleteRoutePlan === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Route deletion is not enabled in this runtime.",
              400,
            );
          }
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const result = await services.routePlanService.deleteRoutePlan({
            routePlanId: request.params.routePlanId,
            shopDomain,
          });
          return routeOpsData(result);
        },
      ),
  );

  app.patch<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const services = requireRouteUiServices(dependencies);
          if (services.routePlanService.saveRoutePlan === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Aggregate route save is not enabled in this runtime.",
              400,
            );
          }
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const body = readRouteOpsBodyObject(request.body);
          const detail = await services.routePlanService.getRoutePlanDetail({
            routePlanId: request.params.routePlanId,
            shopDomain,
          });
          if (detail === null) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Route plan not found",
              404,
            );
          }
          try {
            const saved = await services.routePlanService.saveRoutePlan({
              payload: readRouteOpsSaveRoutePayload(body, detail),
              routePlanId: request.params.routePlanId,
              shopDomain,
            });
            if (saved === null) {
              throw new WooCommerceOnboardingError(
                "NOT_FOUND",
                "Route plan not found",
                404,
              );
            }
            request.log.info(
              {
                operations: saved.operations.map((operation) => ({
                  name: operation.name,
                  reason: operation.reason,
                  status: operation.status,
                })),
                routePlanId: request.params.routePlanId,
                shopDomain,
              },
              "route ops aggregate route save completed",
            );
            return routeOpsData({
              ...toRouteOpsRoutePlanDetailDto(saved.detail),
              saveOperations: saved.operations,
            });
          } catch (error) {
            if (error instanceof RouteOptimizationJobActiveError) {
              throw createRouteOpsHttpError(error.code, error.message, 409);
            }
            if (
              error instanceof RoutePlanConflictError ||
              error instanceof RoutePlanDriverAssignInvalidError ||
              error instanceof RoutePlanOrderAlreadyPlannedError ||
              error instanceof RoutePlanOptionsUpdateInvalidError ||
              error instanceof RoutePlanPublishInvalidError ||
              error instanceof RoutePlanStopUpdateInvalidError
            ) {
              const isAlreadyPlanned =
                error instanceof RoutePlanOrderAlreadyPlannedError;
              const httpStatus =
                error instanceof RoutePlanConflictError || isAlreadyPlanned
                  ? 409
                  : 400;
              const code = isAlreadyPlanned
                ? "ROUTE_ORDER_ALREADY_PLANNED"
                : error.code;
              const message = isAlreadyPlanned
                ? sanitizeRouteUiError(error)
                : error.message;
              request.log.warn(
                {
                  code,
                  error: sanitizeRouteUiError(error),
                  routePlanId: request.params.routePlanId,
                  shopDomain,
                  statusCode: httpStatus,
                },
                "route ops aggregate route save rejected",
              );
              throw createRouteOpsHttpError(code, message, httpStatus);
            }
            throw error;
          }
        },
      ),
  );

  app.patch<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/stops`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const services = requireRouteUiServices(dependencies);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const body = readRouteOpsBodyObject(request.body);
          const detail = await services.routePlanService.getRoutePlanDetail({
            routePlanId: request.params.routePlanId,
            shopDomain,
          });
          if (detail === null) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Route plan not found",
              404,
            );
          }
          try {
            const updated =
              await services.routePlanService.updateRoutePlanStops({
                payload: {
                  stops: readRouteOpsStopSequence(body.stops, detail),
                },
                routePlanId: request.params.routePlanId,
                shopDomain,
              });
            if (updated === null) {
              throw new WooCommerceOnboardingError(
                "NOT_FOUND",
                "Route plan not found",
                404,
              );
            }
            return routeOpsData(toRouteOpsRoutePlanDetailDto(updated));
          } catch (error) {
            if (error instanceof RouteOptimizationJobActiveError) {
              throw createRouteOpsHttpError(error.code, error.message, 409);
            }
            throw error;
          }
        },
      ),
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize-jobs`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const services = requireRouteUiServices(dependencies);
          const job = await createRouteOptimizationJobForRequest({
            request,
            routePlanId: request.params.routePlanId,
            services,
            session,
          });
          return routeOpsData({ job }, 202);
        },
      ),
  );

  app.get<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize-jobs/latest`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          const services = requireRouteUiServices(dependencies);
          const jobService = requireRouteOptimizationJobService(services);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          await assertRoutePlanExistsForOptimizationRead({
            routePlanId: request.params.routePlanId,
            services,
            shopDomain,
          });
          const job = await jobService.findLatestJob({
            routePlanId: request.params.routePlanId,
            shopDomain,
          });
          return routeOpsData({ job });
        },
      ),
  );

  app.get<{ Params: { jobId: string; routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize-jobs/:jobId`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          const services = requireRouteUiServices(dependencies);
          const jobService = requireRouteOptimizationJobService(services);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          await assertRoutePlanExistsForOptimizationRead({
            routePlanId: request.params.routePlanId,
            services,
            shopDomain,
          });
          const job = await jobService.findJob({
            jobId: request.params.jobId,
            routePlanId: request.params.routePlanId,
            shopDomain,
          });
          if (job === null) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Route optimization job not found",
              404,
            );
          }
          return routeOpsData({ job });
        },
      ),
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const services = requireRouteUiServices(dependencies);
          const job = await createRouteOptimizationJobForRequest({
            request,
            routePlanId: request.params.routePlanId,
            services,
            session,
          });
          return routeOpsData({ job }, 202);
        },
      ),
  );

  app.patch<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/driver`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const services = requireRouteUiServices(dependencies);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const body = readRouteOpsBodyObject(request.body);
          const updated = await services.routePlanService.assignRoutePlanDriver(
            {
              payload: { driverId: readNullableJsonString(body.driverId) },
              routePlanId: request.params.routePlanId,
              shopDomain,
            },
          );
          if (updated === null) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Route plan not found",
              404,
            );
          }
          return routeOpsData(toRouteOpsRoutePlanDetailDto(updated));
        },
      ),
  );

  app.patch<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/options`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const services = requireRouteUiServices(dependencies);
          if (services.routePlanService.updateRoutePlanOptions === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Route options are not enabled in this runtime.",
              400,
            );
          }
          const shopDomain = requireRouteOpsShopDomain(request, session);
          const body = readRouteOpsBodyObject(request.body);
          try {
            const updated =
              await services.routePlanService.updateRoutePlanOptions({
                payload: { routeEndMode: readRouteEndMode(body.routeEndMode) },
                routePlanId: request.params.routePlanId,
                shopDomain,
              });
            if (updated === null) {
              throw new WooCommerceOnboardingError(
                "NOT_FOUND",
                "Route plan not found",
                404,
              );
            }
            return routeOpsData(toRouteOpsRoutePlanDetailDto(updated));
          } catch (error) {
            if (error instanceof RoutePlanOptionsUpdateInvalidError) {
              throw new WooCommerceOnboardingError(
                error.code,
                error.message,
                400,
              );
            }
            throw error;
          }
        },
      ),
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/publish`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const services = requireRouteUiServices(dependencies);
          if (services.routePlanService.publishRoutePlan === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Route publishing is not enabled in this runtime.",
              400,
            );
          }
          const shopDomain = requireRouteOpsShopDomain(request, session);
          try {
            const updated = await services.routePlanService.publishRoutePlan({
              routePlanId: request.params.routePlanId,
              shopDomain,
            });
            if (updated === null) {
              throw new WooCommerceOnboardingError(
                "NOT_FOUND",
                "Route plan not found",
                404,
              );
            }
            await services.routeGroupingService?.recordChildRoutePublished({
              routePlanId: request.params.routePlanId,
              shopDomain,
            });
            return routeOpsData(toRouteOpsRoutePlanDetailDto(updated));
          } catch (error) {
            if (error instanceof RoutePlanPublishInvalidError) {
              throw new WooCommerceOnboardingError(
                error.code,
                error.message,
                400,
              );
            }
            throw error;
          }
        },
      ),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/drivers`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        const shopDomain = requireRouteOpsShopDomain(request, session);
        if (dependencies.driverService === undefined) {
          return routeOpsData({ drivers: [] });
        }
        const drivers = await dependencies.driverService.listDrivers({
          shopDomain,
        });
        return routeOpsData({ drivers: drivers.map(toRouteOpsDriverDto) });
      },
    ),
  );

  app.post(`${ADMIN_UI_APP_API_PATH}/drivers`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        assertRouteOpsMutationCsrf(request, session);
        const shopDomain = requireRouteOpsShopDomain(request, session);
        if (dependencies.driverService === undefined) {
          throw new WooCommerceOnboardingError(
            "BAD_REQUEST",
            "Driver management service is not enabled in this runtime.",
            400,
          );
        }
        const body = readRouteOpsBodyObject(request.body);
        await dependencies.driverService.createPendingDriver({
          createdBy: dependencies.actor.subject,
          displayName: readNullableJsonString(body.displayName),
          inviteLink: null,
          phone: readRequiredJsonString(body, "phone"),
          shopDomain,
          source: "clever-app-driver-invite",
        });
        const drivers = await dependencies.driverService.listDrivers({
          shopDomain,
        });
        return routeOpsData({ drivers: drivers.map(toRouteOpsDriverDto) }, 201);
      },
    ),
  );

  app.post<{ Params: { driverId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/drivers/:driverId/regenerate-invite-code`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.driverService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Driver management service is not enabled in this runtime.",
              400,
            );
          }
          const currentDrivers = await dependencies.driverService.listDrivers({
            shopDomain,
          });
          if (
            !currentDrivers.some(
              (driver) => driver.id === request.params.driverId,
            )
          ) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Driver not found",
              404,
            );
          }
          await dependencies.driverService.regenerateInviteCode({
            driverId: request.params.driverId,
            shopDomain,
          });
          const drivers = await dependencies.driverService.listDrivers({
            shopDomain,
          });
          return routeOpsData({ drivers: drivers.map(toRouteOpsDriverDto) });
        },
      ),
  );

  app.delete<{ Params: { driverId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/drivers/:driverId`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.driverService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Driver management service is not enabled in this runtime.",
              400,
            );
          }
          const currentDrivers = await dependencies.driverService.listDrivers({
            shopDomain,
          });
          if (
            !currentDrivers.some(
              (driver) => driver.id === request.params.driverId,
            )
          ) {
            throw new WooCommerceOnboardingError(
              "NOT_FOUND",
              "Driver not found",
              404,
            );
          }
          await dependencies.driverService.deleteDriver({
            driverId: request.params.driverId,
            shopDomain,
          });
          const drivers = await dependencies.driverService.listDrivers({
            shopDomain,
          });
          return routeOpsData({ drivers: drivers.map(toRouteOpsDriverDto) });
        },
      ),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/settings`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        const shopDomain = requireRouteOpsShopDomain(request, session);
        const settings =
          dependencies.settingsService === undefined
            ? null
            : await dependencies.settingsService.getSettings({ shopDomain });
        return routeOpsData({
          settings:
            settings === null
              ? defaultRouteOpsSettings(shopDomain)
              : toRouteOpsSettingsDto(settings),
        });
      },
    ),
  );

  app.patch(`${ADMIN_UI_APP_API_PATH}/settings`, async (request, reply) =>
    withRouteOpsApi(
      request,
      reply,
      readSession(request, dependencies),
      async (session) => {
        assertRouteOpsMutationCsrf(request, session);
        const shopDomain = requireRouteOpsShopDomain(request, session);
        if (dependencies.settingsService === undefined) {
          throw new WooCommerceOnboardingError(
            "BAD_REQUEST",
            "Store settings service is not enabled in this runtime.",
            400,
          );
        }
        const body = readRouteOpsBodyObject(request.body);
        const settings = await dependencies.settingsService.saveSettings({
          defaultDepotAddress: readNullableJsonString(body.defaultDepotAddress),
          defaultDepotLatitude: readNullableJsonNumber(
            body.defaultDepotLatitude,
          ),
          defaultDepotLongitude: readNullableJsonNumber(
            body.defaultDepotLongitude,
          ),
          locale: readRouteOpsLocale(body.locale),
          ...(Object.hasOwn(body, "routeOpsUiSettings")
            ? {
                routeOpsUiSettings: readRouteOpsUiSettingsPayload(
                  body.routeOpsUiSettings,
                ),
              }
            : {}),
          ...(Object.hasOwn(body, "routeScopeConfig")
            ? {
                routeScopeConfig: validateRouteScopeConfigPayload(
                  body.routeScopeConfig,
                ),
              }
            : {}),
          shopDomain,
        });
        return routeOpsData({ settings: toRouteOpsSettingsDto(settings) });
      },
    ),
  );

  app.post(
    `${ADMIN_UI_APP_API_PATH}/settings/geocode`,
    async (request, reply) =>
      withRouteOpsApi(
        request,
        reply,
        readSession(request, dependencies),
        async (session) => {
          assertRouteOpsMutationCsrf(request, session);
          const shopDomain = requireRouteOpsShopDomain(request, session);
          if (dependencies.settingsService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Store settings service is not enabled in this runtime.",
              400,
            );
          }
          const body = readRouteOpsBodyObject(request.body);
          const defaultDepotAddress = readRequiredDepotAddress(
            body.defaultDepotAddress,
          );
          const currentSettings =
            await dependencies.settingsService.getSettings({
              shopDomain,
            });
          const remembered = readRememberedDepotGeocode(
            currentSettings,
            defaultDepotAddress,
          );
          if (remembered !== null) {
            if (currentSettings === null) {
              throw new WooCommerceOnboardingError(
                "BAD_REQUEST",
                "Remembered depot coordinates are not available.",
                400,
              );
            }
            const rememberedGeocode: Extract<GeocodingResult, { ok: true }> =
              remembered;
            return routeOpsData({
              geocode: toSafeRouteOpsGeocodeResponse(rememberedGeocode),
              settings: toRouteOpsSettingsDto(currentSettings),
            });
          }
          if (dependencies.geocodingService === undefined) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              "Geocoding is not enabled in this runtime.",
              400,
            );
          }
          const geocode = await dependencies.geocodingService.geocode({
            address: depotAddressToGeocodingAddress(defaultDepotAddress),
            shopDomain,
          });
          if (!geocode.ok) {
            throw new WooCommerceOnboardingError(
              "BAD_REQUEST",
              geocode.message,
              400,
            );
          }
          const draftResponseSettings =
            currentSettings ?? defaultRouteOpsSettings(shopDomain);
          return routeOpsData({
            geocode: toSafeRouteOpsGeocodeResponse(geocode),
            settings: toRouteOpsSettingsDto(draftResponseSettings),
          });
        },
      ),
  );

  app.get(ADMIN_UI_APP_API_PATH, async (_request, reply) =>
    reply.callNotFound(),
  );

  app.get<{ Params: { "*": string } }>(
    `${ADMIN_UI_APP_API_PATH}/*`,
    async (_request, reply) => reply.callNotFound(),
  );
}

async function openAdminNotificationStream(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
): Promise<unknown> {
  const session = readSession(request, dependencies);
  if (session === null) {
    return sendRouteOpsApiError(
      reply,
      401,
      "UNAUTHORIZED",
      "Admin UI login required",
    );
  }
  let cleanup: (() => void) | null = null;
  try {
    const shopDomain = requireRouteOpsShopDomain(request, session);
    if (dependencies.notificationService === undefined) {
      throw new WooCommerceOnboardingError(
        "BAD_REQUEST",
        "Notification service is not enabled in this runtime.",
        400,
      );
    }

    let closed = request.raw.destroyed;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let pendingInvalidation = false;
    let streamOpen = false;
    let unsubscribe: (() => void) | null = null;
    cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    };
    request.raw.once("close", cleanup);

    const subscribedUnsubscribe =
      await dependencies.notificationService.subscribeToNotificationChanges({
        listener: (event) => {
          if (event.type !== "notifications_changed") return;
          if (streamOpen) {
            writeAdminNotificationStreamEvent(reply);
            return;
          }
          pendingInvalidation = true;
        },
        shopDomain,
      });
    if (subscribedUnsubscribe === null) {
      request.raw.removeListener("close", cleanup);
      cleanup = null;
      throw new WooCommerceOnboardingError(
        "NOT_FOUND",
        "Notification stream shop not found.",
        404,
      );
    }
    if (closed) {
      subscribedUnsubscribe();
      request.raw.removeListener("close", cleanup);
      cleanup = null;
      return reply;
    }
    unsubscribe = subscribedUnsubscribe;
    if (request.raw.destroyed) {
      cleanup();
      return reply;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "Content-Security-Policy": buildRouteOpsCsp(readCurrentRouteOpsMapConfig()),
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    streamOpen = true;
    writeAdminNotificationStreamHeartbeat(reply);
    if (pendingInvalidation) {
      pendingInvalidation = false;
      writeAdminNotificationStreamEvent(reply);
    }

    heartbeat = setInterval(
      () => writeAdminNotificationStreamHeartbeat(reply),
      ADMIN_NOTIFICATION_STREAM_HEARTBEAT_MS,
    );
    return reply;
  } catch (error) {
    if (cleanup !== null) {
      request.raw.removeListener("close", cleanup);
      cleanup();
    }
    const statusCode =
      error instanceof WooCommerceOnboardingError ? error.httpStatus : 500;
    const code =
      error instanceof WooCommerceOnboardingError
        ? error.code
        : "ADMIN_UI_REQUEST_FAILED";
    if (!(error instanceof WooCommerceOnboardingError)) {
      request.log.error({ err: error }, "notification stream request failed");
    }
    return sendRouteOpsApiError(
      reply,
      statusCode,
      code,
      sanitizeRouteUiError(error),
    );
  }
}

function writeAdminNotificationStreamHeartbeat(reply: FastifyReply): void {
  if (reply.raw.destroyed) return;
  reply.raw.write(": heartbeat\n\n");
}

function writeAdminNotificationStreamEvent(reply: FastifyReply): void {
  if (reply.raw.destroyed) return;
  reply.raw.write('event: notifications_changed\n');
  reply.raw.write('data: {"type":"notifications_changed"}\n\n');
}

function renderRouteOpsSpaShell(
  reply: FastifyReply,
  request: FastifyRequest,
  _dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
): unknown {
  try {
    readRouteOpsShopDomain(request, session);
  } catch (error) {
    return sendRouteOpsHtml(
      reply,
      error instanceof WooCommerceOnboardingError ? error.httpStatus : 500,
      renderRouteOpsShellError(error),
    );
  }
  return sendRouteOpsHtml(
    reply,
    200,
    renderRouteOpsShellHtml(readRouteOpsManifestAssets()),
  );
}

function renderRouteOpsShellHtml(assets: {
  css: string[];
  entry: string | null;
  missing: boolean;
}): string {
  const css = assets.css
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join("\n");
  const script =
    assets.entry === null
      ? ""
      : `<script type="module" src="${escapeHtml(assets.entry)}"></script>`;
  const missing = assets.missing
    ? '<div id="route-ops-build-missing">Route Ops build assets are not present yet. Run npm --prefix apps/route-ops-web run build.</div>'
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CLEVER Route Ops</title>
    ${css}
  </head>
  <body>
    <div id="clever-route-ops-root" data-route-ops-build="${assets.missing ? "missing" : "present"}">
      ${missing}
      <noscript>CLEVER Route App requires JavaScript for map-first route operations.</noscript>
    </div>
    ${script}
  </body>
</html>`;
}

function renderRouteOpsShellError(error: unknown): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CLEVER Route Ops</title></head><body><main id="clever-route-ops-root"><h1>CLEVER Route App</h1><p>${escapeHtml(sanitizeRouteUiError(error))}</p></main></body></html>`;
}

function readRouteOpsManifestAssets(): {
  css: string[];
  entry: string | null;
  missing: boolean;
} {
  const manifestPath = join(ROUTE_OPS_WEB_DIST_PATH, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    return { css: [], entry: null, missing: true };
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      { css?: string[]; file?: string }
    >;
    const entry = manifest["index.html"] ?? manifest["src/main.tsx"];
    const file = entry?.file;
    return {
      css: (entry?.css ?? []).map((asset) => `${ADMIN_UI_APP_PATH}/${asset}`),
      entry: typeof file === "string" ? `${ADMIN_UI_APP_PATH}/${file}` : null,
      missing: false,
    };
  } catch {
    return { css: [], entry: null, missing: true };
  }
}

function sendRouteOpsStaticAsset(
  reply: FastifyReply,
  rawAssetPath: string,
): unknown {
  const assetPath = normalize(rawAssetPath).replace(/^(\.\.(?:\/|\\|$))+/u, "");
  if (assetPath === "" || assetPath.includes("..")) {
    return reply.code(404).send("");
  }
  const absolute = join(ROUTE_OPS_WEB_DIST_PATH, "assets", basename(assetPath));
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    return reply.code(404).send("");
  }
  return reply
    .code(200)
    .type(contentTypeForAsset(absolute))
    .header("Cache-Control", "public, max-age=31536000, immutable")
    .send(readFileSync(absolute));
}

function sendRouteOpsVendorAsset(
  reply: FastifyReply,
  rawAssetPath: string,
): unknown {
  const assetPath = normalize(rawAssetPath).replace(/^(\.\.(?:\/|\\|$))+/u, "");
  if (assetPath === "" || assetPath.includes("..")) {
    return reply.code(404).send("");
  }
  const absolute = join(ROUTE_OPS_WEB_PUBLIC_PATH, "vendor", assetPath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    return reply.code(404).send("");
  }
  return reply
    .code(200)
    .type(contentTypeForAsset(absolute))
    .header("Cache-Control", "public, max-age=31536000, immutable")
    .send(readFileSync(absolute));
}

function contentTypeForAsset(path: string): string {
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".pbf")) return "application/x-protobuf";
  if (path.endsWith(".pmtiles")) return "application/octet-stream";
  return "application/octet-stream";
}

async function handleDriverCreate(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
): Promise<unknown> {
  let shopDomain: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    if (dependencies.driverService === undefined) {
      throw new WooCommerceOnboardingError(
        "BAD_REQUEST",
        "Driver management service is not enabled in this runtime.",
        400,
      );
    }
    const fields = await readAdminUiFormFields(request, {
      allowedFields: ["csrfToken", "shopDomain", "displayName", "phone"],
      maxFields: 4,
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(
      readRequiredField(fields, "shopDomain", "shopDomain"),
    );
    assertWpPluginShopAccess(session, shopDomain);
    await dependencies.driverService.createPendingDriver({
      createdBy: dependencies.actor.subject,
      displayName: readOptionalField(fields, "displayName"),
      inviteLink: null,
      phone: readRequiredField(fields, "phone", "driver phone"),
      shopDomain,
      source: "clever-app-driver-invite",
    });
    return redirectToAdminModule(reply, ADMIN_UI_APP_DRIVERS_PATH, {
      notice: "Driver invite created.",
      shopDomain,
    });
  } catch (error) {
    return redirectToAdminModule(reply, ADMIN_UI_APP_DRIVERS_PATH, {
      error: sanitizeErrorMessage(error),
      ...(shopDomain === null ? {} : { shopDomain }),
    });
  }
}

async function handleSettingsSave(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
): Promise<unknown> {
  let shopDomain: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    if (dependencies.settingsService === undefined) {
      throw new WooCommerceOnboardingError(
        "BAD_REQUEST",
        "Store settings service is not enabled in this runtime.",
        400,
      );
    }
    const fields = await readAdminUiFormFields(request, {
      allowedFields: [
        "csrfToken",
        "shopDomain",
        "defaultDepotAddress",
        "defaultDepotLatitude",
        "defaultDepotLongitude",
        "locale",
      ],
      maxFields: 6,
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(
      readRequiredField(fields, "shopDomain", "shopDomain"),
    );
    assertWpPluginShopAccess(session, shopDomain);
    await dependencies.settingsService.saveSettings({
      defaultDepotAddress: readOptionalField(fields, "defaultDepotAddress"),
      defaultDepotLatitude: readOptionalCoordinate(fields.defaultDepotLatitude),
      defaultDepotLongitude: readOptionalCoordinate(
        fields.defaultDepotLongitude,
      ),
      locale: readLocaleField(fields.locale),
      shopDomain,
    });
    return redirectToAdminModule(reply, ADMIN_UI_APP_SETTINGS_PATH, {
      notice: "Store settings saved.",
      shopDomain,
    });
  } catch (error) {
    return redirectToAdminModule(reply, ADMIN_UI_APP_SETTINGS_PATH, {
      error: sanitizeErrorMessage(error),
      ...(shopDomain === null ? {} : { shopDomain }),
    });
  }
}

async function handleRoutePlanCreate(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
): Promise<unknown> {
  let shopDomain: string | null = null;
  let planDate: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    const services = requireRouteUiServices(dependencies);
    const fields = await readAdminUiFormFields(request, {
      allowedFields: [
        "csrfToken",
        "shopDomain",
        "planDate",
        "routeName",
        "depotAddress",
        "depotLatitude",
        "depotLongitude",
        "selectedOrderGids",
      ],
      maxFields: 8,
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(
      readRequiredField(fields, "shopDomain", "shopDomain"),
    );
    assertWpPluginShopAccess(session, shopDomain);
    planDate = normalizeRequiredDate(
      readRequiredField(fields, "planDate", "plan date"),
    );
    const selectedOrderGids = readSelectedOrderGids(
      readRequiredField(fields, "selectedOrderGids", "selected orders"),
    );
    const candidateOrders = await services.orderSyncService.listCanonicalOrders(
      {
        filters: { deliveryDate: planDate },
        shopDomain,
      },
    );
    const routeScopeConfig = await readRouteOpsRouteScopeConfig(
      dependencies,
      shopDomain,
    );
    const selectedOrders = selectRouteReadyOrders({
      orders: candidateOrders,
      planDate,
      routeScopeConfig,
      selectedOrderGids,
    });

    const routePlan = await createRoutePlanFromSelectedOrderIds({
      createdBy: dependencies.actor.subject,
      depotAddress: readOptionalField(fields, "depotAddress"),
      depotLatitude: readOptionalCoordinate(fields.depotLatitude),
      depotLongitude: readOptionalCoordinate(fields.depotLongitude),
      orderIds: selectedOrders.map((order) => order.orderId),
      planDate,
      routeScopeConfig,
      routeName: readRequiredField(fields, "routeName", "route name"),
      services,
      shopDomain,
    });
    return redirectToRoutePlans(reply, {
      deliveryDate: planDate,
      notice: `Route created from ${selectedOrders.length} selected ready orders.`,
      routePlanId: routePlan.id,
      shopDomain,
    });
  } catch (error) {
    return redirectToRoutePlans(reply, {
      ...(planDate === null ? {} : { deliveryDate: planDate }),
      error: sanitizeRouteUiError(error),
      ...(shopDomain === null ? {} : { shopDomain }),
    });
  }
}

async function handleRouteStopsUpdate(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  routePlanId: string,
): Promise<unknown> {
  let shopDomain: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    const services = requireRouteUiServices(dependencies);
    const fields = await readAdminUiFormFields(request, {
      allowedFields: ["csrfToken", "shopDomain", "stopOrder"],
      maxFields: 3,
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(
      readRequiredField(fields, "shopDomain", "shopDomain"),
    );
    assertWpPluginShopAccess(session, shopDomain);
    const detail = await services.routePlanService.getRoutePlanDetail({
      routePlanId,
      shopDomain,
    });
    if (detail === null) {
      return redirectToRoutePlans(reply, {
        error: "Route plan not found for this shop.",
        shopDomain,
      });
    }
    const stops = readStopOrderLines(
      readRequiredField(fields, "stopOrder", "stop order"),
      detail,
    );
    await services.routePlanService.updateRoutePlanStops({
      payload: { stops },
      routePlanId,
      shopDomain,
    });
    return redirectToRoutePlans(reply, {
      deliveryDate: detail.routePlan.deliveryDate ?? detail.routePlan.planDate,
      notice: "Route stop order saved.",
      routePlanId,
      shopDomain,
    });
  } catch (error) {
    return redirectToRoutePlans(reply, {
      error: sanitizeRouteUiError(error),
      routePlanId,
      ...(shopDomain === null ? {} : { shopDomain }),
    });
  }
}

async function handleRouteDriverAssignment(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  routePlanId: string,
): Promise<unknown> {
  let shopDomain: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    const services = requireRouteUiServices(dependencies);
    const fields = await readAdminUiFormFields(request, {
      allowedFields: ["csrfToken", "shopDomain", "driverId"],
      maxFields: 3,
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(
      readRequiredField(fields, "shopDomain", "shopDomain"),
    );
    assertWpPluginShopAccess(session, shopDomain);
    const detail = await services.routePlanService.assignRoutePlanDriver({
      payload: { driverId: readOptionalField(fields, "driverId") },
      routePlanId,
      shopDomain,
    });
    if (detail === null) {
      return redirectToRoutePlans(reply, {
        error: "Route plan not found for this shop.",
        shopDomain,
      });
    }
    return redirectToRoutePlans(reply, {
      deliveryDate: detail.routePlan.deliveryDate ?? detail.routePlan.planDate,
      notice:
        detail.routePlan.driverId === null
          ? "Route driver assignment removed."
          : "Route driver assigned.",
      routePlanId,
      shopDomain,
    });
  } catch (error) {
    return redirectToRoutePlans(reply, {
      error: sanitizeRouteUiError(error),
      routePlanId,
      ...(shopDomain === null ? {} : { shopDomain }),
    });
  }
}

async function handleRouteOptimize(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  routePlanId: string,
): Promise<unknown> {
  let shopDomain: string | null = null;
  try {
    assertSameOriginMutation(request, dependencies);
    const services = requireRouteUiServices(dependencies);
    const fields = await readAdminUiFormFields(request, {
      allowedFields: ["csrfToken", "shopDomain"],
      maxFields: 2,
    });
    assertValidCsrf(session, fields.csrfToken);
    shopDomain = normalizeRequiredShopDomain(
      readRequiredField(fields, "shopDomain", "shopDomain"),
    );
    assertWpPluginShopAccess(session, shopDomain);
    const job = await createRouteOptimizationJobForRequest({
      request,
      routePlanId,
      services,
      session,
      shopDomainOverride: shopDomain,
    });
    return redirectToRoutePlans(reply, {
      notice: `Route optimization started. Job ${job.id} is running in the background.`,
      routePlanId,
      shopDomain,
    });
  } catch (error) {
    return redirectToRoutePlans(reply, {
      error: sanitizeRouteUiError(error),
      routePlanId,
      ...(shopDomain === null ? {} : { shopDomain }),
    });
  }
}

function readSession(
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
): AdminWebSession | null {
  const session = verifyAdminWebSessionFromRequest({
    request,
    sessionSecret: dependencies.sessionSecret,
    ...(dependencies.cookieName === undefined
      ? {}
      : { cookieName: dependencies.cookieName }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  if (session === null) return null;
  return session;
}

async function handleLogout(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
): Promise<unknown> {
  const session = readSession(request, dependencies);
  if (session === null) {
    return redirectWithClearedSession(reply, dependencies, ADMIN_UI_LOGIN_PATH);
  }

  try {
    assertSameOriginMutation(request, dependencies);
    const fields = await readAdminUiFormFields(request, {
      allowedFields: ["csrfToken"],
      maxFields: 1,
    });
    assertValidCsrf(session, fields.csrfToken);
    return redirectWithClearedSession(reply, dependencies, ADMIN_UI_LOGIN_PATH);
  } catch (error) {
    return sendUiError(reply, request, dependencies, session, error);
  }
}

function rejectDirectRouteOpsWorkspaceLink(reply: FastifyReply): unknown {
  return sendHtml(reply, 401, renderRouteOpsWorkspaceEntryRequiredPage());
}

function readAdminUiLoginReturnTo(request: FastifyRequest): string {
  return normalizeAdminUiLoginReturnPath(
    readQueryString(request.query, "returnTo") ?? ADMIN_UI_STORE_SESSIONS_PATH,
  );
}

async function renderHome(
  reply: FastifyReply,
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
  input: {
    currentShopDomain?: string | null;
    error?: string;
    notice?: string;
    pairingCodeSetup?: PairingCodeSetupView;
    statusCode?: number;
    webhookSetup?: WebhookSetupView;
  },
): Promise<unknown> {
  let connections: SafeConnectionWithDelivery[] = [];
  let error = input.error;
  let statusCode = input.statusCode;
  let currentShopDomain: string | null = null;

  try {
    currentShopDomain = normalizeOptionalShopDomain(input.currentShopDomain);
  } catch (normalizeError) {
    error = error ?? sanitizeErrorMessage(normalizeError);
    statusCode =
      statusCode ??
      (normalizeError instanceof WooCommerceOnboardingError
        ? normalizeError.httpStatus
        : 400);
  }

  if (currentShopDomain !== null) {
    try {
      const listed = await dependencies.onboardingService.listConnections({
        actor: dependencies.actor,
        shopDomain: currentShopDomain,
      });
      connections = listed.map((connection) =>
        withWebhookDelivery(request, dependencies, connection),
      );
    } catch (loadError) {
      error = error ?? sanitizeErrorMessage(loadError);
    }
  }

  return sendHtml(
    reply,
    error === undefined ? 200 : (statusCode ?? 400),
    renderHomePage({
      actor: dependencies.actor,
      connections,
      csrfToken: session.csrfToken,
      currentShopDomain,
      canGeneratePairingCode: dependencies.pairingCodeService !== undefined,
      ...(error === undefined ? {} : { error }),
      ...(input.notice === undefined ? {} : { notice: input.notice }),
      ...(input.pairingCodeSetup === undefined
        ? {}
        : { pairingCodeSetup: input.pairingCodeSetup }),
      ...(input.webhookSetup === undefined
        ? {}
        : { webhookSetup: input.webhookSetup }),
    }),
  );
}

async function renderStoreSessions(
  reply: FastifyReply,
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession,
): Promise<unknown> {
  let connections: SafeConnectionWithDelivery[] = [];
  let currentShopDomain: string | null = null;
  let error: string | undefined;
  let statusCode = 200;

  const requestedShopDomain = readQueryString(request.query, "shopDomain");
  if (requestedShopDomain !== null) {
    try {
      currentShopDomain = normalizeOptionalShopDomain(requestedShopDomain);
      if (currentShopDomain !== null) {
        const listed = await dependencies.onboardingService.listConnections({
          actor: dependencies.actor,
          shopDomain: currentShopDomain,
        });
        connections = listed.map((connection) =>
          withWebhookDelivery(request, dependencies, connection),
        );
      }
    } catch (loadError) {
      error = sanitizeErrorMessage(loadError);
      statusCode =
        loadError instanceof WooCommerceOnboardingError
          ? loadError.httpStatus
          : 500;
    }
  }

  return sendHtml(
    reply,
    statusCode,
    renderStoreSessionsPage({
      actor: dependencies.actor,
      connections,
      csrfToken: session.csrfToken,
      currentShopDomain,
      ...(error === undefined ? {} : { error }),
    }),
  );
}

function sendUiError(
  reply: FastifyReply,
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  session: AdminWebSession | null,
  error: unknown,
  currentShopDomain?: string | null,
): unknown {
  const status =
    error instanceof WooCommerceOnboardingError ? error.httpStatus : 500;
  if (!(error instanceof WooCommerceOnboardingError)) {
    request.log.error(
      { event: "admin_commerce_connection_ui_failed" },
      "admin commerce connection UI failed",
    );
  }
  if (session === null) {
    return sendHtml(
      reply,
      status,
      renderLoginPage({ error: sanitizeErrorMessage(error) }),
    );
  }
  return renderHome(reply, request, dependencies, session, {
    error: sanitizeErrorMessage(error),
    statusCode: status,
    ...(currentShopDomain === undefined ? {} : { currentShopDomain }),
  });
}

function sendHtml(
  reply: FastifyReply,
  statusCode: number,
  body: string,
): unknown {
  return reply
    .code(statusCode)
    .type("text/html; charset=utf-8")
    .header("Cache-Control", "no-store")
    .header("Content-Security-Policy", ADMIN_UI_CSP)
    .send(body);
}

function sendRouteOpsHtml(
  reply: FastifyReply,
  statusCode: number,
  body: string,
): unknown {
  return reply
    .code(statusCode)
    .type("text/html; charset=utf-8")
    .header("Cache-Control", "no-store")
    .header(
      "Content-Security-Policy",
      buildRouteOpsCsp(readCurrentRouteOpsMapConfig()),
    )
    .send(body);
}

function sendJson(
  reply: FastifyReply,
  statusCode: number,
  body: { message: string; ok: boolean },
): unknown {
  return reply
    .code(statusCode)
    .type("application/json; charset=utf-8")
    .header("Cache-Control", "no-store")
    .send(body);
}

function redirect(reply: FastifyReply, location: string): unknown {
  return reply.code(303).header("Location", location).send("");
}

function redirectLegacyAdminUiGetPath(
  request: FastifyRequest,
  reply: FastifyReply,
  targetPath: string,
): unknown {
  const queryStart = request.url.indexOf("?");
  const query = queryStart >= 0 ? request.url.slice(queryStart) : "";
  return redirect(reply, `${targetPath}${query}`);
}

function redirectAdminUiBrowserFallback(
  request: FastifyRequest,
  reply: FastifyReply,
): unknown {
  if (!shouldRedirectAdminUiBrowserFallback(request)) {
    reply.callNotFound();
    return undefined;
  }
  return redirect(reply, ADMIN_UI_ROOT_PATH);
}

function shouldRedirectAdminUiBrowserFallback(
  request: FastifyRequest,
): boolean {
  if (wantsJson(request)) return false;

  const pathname = request.url.split("?", 1)[0] ?? request.url;
  if (
    pathname === ADMIN_UI_APP_API_PATH ||
    pathname.startsWith(`${ADMIN_UI_APP_API_PATH}/`)
  ) {
    return false;
  }

  return !isFileLikeAdminUiPath(pathname);
}

function isFileLikeAdminUiPath(pathname: string): boolean {
  const segment = pathname.split("/").at(-1) ?? "";
  return /\.[A-Za-z0-9]{1,12}$/u.test(segment);
}

function redirectToWooCommerceHome(
  reply: FastifyReply,
  input: { currentShopDomain?: string | null; error?: string; notice?: string },
): unknown {
  const params = new URLSearchParams();
  if (
    input.currentShopDomain !== undefined &&
    input.currentShopDomain !== null &&
    input.currentShopDomain.trim() !== ""
  ) {
    params.set("shopDomain", input.currentShopDomain.trim());
  }
  if (input.error !== undefined && input.error.trim() !== "") {
    params.set("error", truncateUiMessage(input.error));
  }
  if (input.notice !== undefined && input.notice.trim() !== "") {
    params.set("notice", truncateUiMessage(input.notice));
  }
  const query = params.toString();
  return redirect(
    reply,
    query === ""
      ? ADMIN_UI_WOOCOMMERCE_PATH
      : `${ADMIN_UI_WOOCOMMERCE_PATH}?${query}`,
  );
}

function redirectToAdminModule(
  reply: FastifyReply,
  path: string,
  input: {
    deliveryDate?: string | null;
    error?: string;
    notice?: string;
    shopDomain?: string | null;
  },
): unknown {
  const params = new URLSearchParams();
  if (
    input.shopDomain !== undefined &&
    input.shopDomain !== null &&
    input.shopDomain.trim() !== ""
  ) {
    params.set("shopDomain", input.shopDomain.trim());
  }
  if (
    input.deliveryDate !== undefined &&
    input.deliveryDate !== null &&
    input.deliveryDate.trim() !== ""
  ) {
    params.set("deliveryDate", input.deliveryDate.trim());
  }
  if (input.error !== undefined && input.error.trim() !== "") {
    params.set("error", truncateUiMessage(input.error));
  }
  if (input.notice !== undefined && input.notice.trim() !== "") {
    params.set("notice", truncateUiMessage(input.notice));
  }
  const query = params.toString();
  return redirect(reply, query === "" ? path : `${path}?${query}`);
}

function redirectWpPluginSessionToOperate(
  reply: FastifyReply,
  session: AdminWebSession,
  error?: string,
): unknown {
  return redirectToAdminModule(reply, ADMIN_UI_APP_ORDERS_PATH, {
    ...(error === undefined ? {} : { error }),
    shopDomain: readWpPluginSessionShopDomain(session),
  });
}

function assertValidCsrf(
  session: AdminWebSession,
  token: string | null | undefined,
): void {
  if (!verifyAdminWebCsrfToken({ session, token })) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Invalid admin UI CSRF token",
      400,
    );
  }
}

function assertSameOriginMutation(
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
): void {
  const fetchSite = readHeader(
    request.headers["sec-fetch-site"],
  )?.toLowerCase();
  const expectedOrigin = normalizeOrigin(resolveBaseUrl(request, dependencies));
  const origin = readHeader(request.headers.origin)?.replace(/\/+$/u, "");
  const referer = readHeader(request.headers.referer);

  if (
    fetchSite !== undefined &&
    fetchSite !== "same-origin" &&
    fetchSite !== "same-site" &&
    fetchSite !== "none"
  ) {
    request.log.warn(
      {
        event: "admin_ui_fetch_metadata_false_positive",
        fetchSite,
        originMatches:
          origin === undefined
            ? null
            : normalizeOrigin(origin) === expectedOrigin,
        refererMatches:
          referer === undefined
            ? null
            : normalizeOrigin(referer) === expectedOrigin,
      },
      "Admin UI browser metadata did not match the canonical origin; CSRF remains the mutation gate",
    );
  }

  // Browser origin/fetch metadata is inconsistent in Safari and behind
  // reverse proxies, especially after form-resubmission prompts. The admin UI
  // uses SameSite=Strict HttpOnly sessions plus per-session CSRF tokens as the
  // authoritative mutation gate, so metadata is diagnostic only.
}

async function requireConnectionMatchesShop(input: {
  actor: AdminCommerceActor;
  connectionId: string;
  dependencies: AdminCommerceConnectionsUiDependencies;
  shopDomain: string;
}): Promise<SafeWooCommerceConnection> {
  const expectedShopDomain = normalizeRequiredShopDomain(input.shopDomain);
  const connection = await input.dependencies.onboardingService.getConnection({
    actor: input.actor,
    connectionId: input.connectionId,
  });
  if (connection.shopDomain !== expectedShopDomain) {
    throw new WooCommerceOnboardingError(
      "FORBIDDEN",
      "Connection shopDomain does not match the current admin UI context",
      403,
    );
  }
  return connection;
}

function requirePairingCodeService(
  dependencies: AdminCommerceConnectionsUiDependencies,
): NonNullable<AdminCommerceConnectionsUiDependencies["pairingCodeService"]> {
  if (dependencies.pairingCodeService === undefined) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "WordPress plugin pairing code generation is not enabled in this runtime.",
      400,
    );
  }
  return dependencies.pairingCodeService;
}

function readCredentialFields(fields: Record<string, string>): {
  consumerKey: string;
  consumerSecret: string;
  label: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone: string | null;
  webhookSecret: string | null;
} {
  return {
    consumerKey: readRequiredField(
      fields,
      "wooConsumerKey",
      "WooCommerce consumer key",
    ),
    consumerSecret: readRequiredField(
      fields,
      "wooConsumerSecret",
      "WooCommerce consumer secret",
    ),
    label: readOptionalField(fields, "label"),
    shopDomain: readRequiredField(fields, "shopDomain", "shopDomain"),
    siteUrl: readRequiredField(fields, "siteUrl", "WooCommerce site URL"),
    timezone: readOptionalField(fields, "timezone"),
    webhookSecret: readOptionalField(fields, "webhookSecret"),
  };
}

function credentialFieldNames(): readonly string[] {
  return [
    "csrfToken",
    "label",
    "shopDomain",
    "siteUrl",
    "timezone",
    "wooConsumerKey",
    "wooConsumerSecret",
    "webhookSecret",
  ];
}

function readRequiredField(
  fields: Record<string, string>,
  field: string,
  label: string,
): string {
  const value = fields[field];
  if (value === undefined || value.trim() === "") {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      `${label} is required`,
      400,
    );
  }
  return value.trim();
}

function readOptionalField(
  fields: Record<string, string>,
  field: string,
): string | null {
  const value = fields[field];
  if (value === undefined || value.trim() === "") return null;
  return value.trim();
}

function readStatusField(value: string | undefined): "ACTIVE" | "DISABLED" {
  if (value === "ACTIVE" || value === "DISABLED") return value;
  throw new WooCommerceOnboardingError(
    "BAD_REQUEST",
    "status must be ACTIVE or DISABLED",
    400,
  );
}

function readQueryString(query: unknown, field: string): string | null {
  if (query === null || typeof query !== "object") return null;
  const value = (query as Record<string, unknown>)[field];
  if (Array.isArray(value))
    return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readRouteOpsNotificationLimit(query: unknown): number | undefined {
  const raw = readQueryString(query, "limit");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "limit must be an integer from 1 to 100",
      400,
    );
  }
  return parsed;
}

function truncateUiMessage(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 320 ? trimmed : `${trimmed.slice(0, 317)}...`;
}

function normalizeOptionalShopDomain(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  return normalizeRequiredShopDomain(value);
}

function normalizeRequiredShopDomain(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//iu, "")
    .replace(/\/.*$/u, "");
  if (
    normalized === "" ||
    normalized.length > 255 ||
    !/^[a-z0-9.-]+$/u.test(normalized)
  ) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "shopDomain is invalid",
      400,
    );
  }
  return normalized;
}

function withWebhookDelivery(
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  connection: SafeWooCommerceConnection,
): SafeConnectionWithDelivery {
  assertSafeConnectionForRender(connection);
  const deliveryPath = `/woocommerce/webhooks/${connection.id}/orders`;
  return {
    ...connection,
    webhook: {
      ...connection.webhook,
      deliveryPath,
      deliveryUrl: `${resolveBaseUrl(request, dependencies)}${deliveryPath}`,
    },
  };
}

function toWebhookSetup(
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
  result: WooCommerceOnboardingResult,
): WebhookSetupView {
  const connection = withWebhookDelivery(
    request,
    dependencies,
    result.connection,
  );
  return {
    deliveryPath: connection.webhook.deliveryPath,
    deliveryUrl: connection.webhook.deliveryUrl,
    oneTimeSecret: result.webhookSetup?.oneTimeSecret ?? null,
  };
}

function toPairingCodeSetup(input: {
  code: string;
  expiresAt: Date;
  siteUrl: string;
}): PairingCodeSetupView {
  return {
    code: input.code,
    expiresAt: input.expiresAt.toISOString(),
    siteUrl: input.siteUrl,
  };
}

function resolveBaseUrl(
  request: FastifyRequest,
  dependencies: AdminCommerceConnectionsUiDependencies,
): string {
  const configured = dependencies.publicBaseUrl?.trim().replace(/\/+$/u, "");
  if (configured !== undefined && configured !== "") return configured;

  const forwardedHost = readHeader(request.headers["x-forwarded-host"]);
  const host = forwardedHost ?? readHeader(request.headers.host) ?? "localhost";
  const forwardedProto = readHeader(request.headers["x-forwarded-proto"]);
  const proto = forwardedProto ?? "http";
  return `${proto}://${host}`.replace(/\/+$/u, "");
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.trim().replace(/\/+$/u, "");
  }
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}

function wantsJson(request: FastifyRequest): boolean {
  return (
    readHeader(request.headers.accept)
      ?.toLowerCase()
      .includes("application/json") ?? false
  );
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof WooCommerceOnboardingError) return error.message;
  return "Admin UI request failed";
}

function assertSafeConnectionForRender(
  connection: SafeWooCommerceConnection,
): void {
  const unsafe = connection as Record<string, unknown>;
  for (const field of [
    "consumerKey",
    "consumerKeyCiphertext",
    "consumerSecret",
    "consumerSecretCiphertext",
    "webhookSecret",
    "webhookSecretCiphertext",
  ]) {
    if (Object.prototype.hasOwnProperty.call(unsafe, field)) {
      throw new WooCommerceOnboardingError(
        "BAD_REQUEST",
        "Unsafe commerce connection render payload",
        400,
      );
    }
  }
}

type RouteUiServices = {
  driverService?: NonNullable<
    AdminCommerceConnectionsUiDependencies["driverService"]
  >;
  orderSyncService: NonNullable<
    AdminCommerceConnectionsUiDependencies["orderSyncService"]
  >;
  routeOptimizationJobService?: NonNullable<
    AdminCommerceConnectionsUiDependencies["routeOptimizationJobService"]
  >;
  routeOptimizationService?: NonNullable<
    AdminCommerceConnectionsUiDependencies["routeOptimizationService"]
  >;
  routeGroupingService?: NonNullable<
    AdminCommerceConnectionsUiDependencies["routeGroupingService"]
  >;
  routePlanService: NonNullable<
    AdminCommerceConnectionsUiDependencies["routePlanService"]
  >;
};

function readRouteUiServices(
  dependencies: AdminCommerceConnectionsUiDependencies,
): RouteUiServices | null {
  if (
    dependencies.orderSyncService === undefined ||
    dependencies.routePlanService === undefined
  ) {
    return null;
  }
  return {
    ...(dependencies.driverService === undefined
      ? {}
      : { driverService: dependencies.driverService }),
    orderSyncService: dependencies.orderSyncService,
    ...(dependencies.routeOptimizationJobService === undefined
      ? {}
      : {
          routeOptimizationJobService: dependencies.routeOptimizationJobService,
        }),
    ...(dependencies.routeOptimizationService === undefined
      ? {}
      : { routeOptimizationService: dependencies.routeOptimizationService }),
    ...(dependencies.routeGroupingService === undefined
      ? {}
      : { routeGroupingService: dependencies.routeGroupingService }),
    routePlanService: dependencies.routePlanService,
  };
}

function requireRouteUiServices(
  dependencies: AdminCommerceConnectionsUiDependencies,
): RouteUiServices {
  const services = readRouteUiServices(dependencies);
  if (services === null) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Route planning services are not enabled in this runtime.",
      400,
    );
  }
  return services;
}

function requireRouteGroupingService(
  services: RouteUiServices,
): NonNullable<RouteUiServices["routeGroupingService"]> {
  if (services.routeGroupingService === undefined) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Route grouping services are not enabled in this runtime.",
      400,
    );
  }
  return services.routeGroupingService;
}

function toRouteGroupingHttpError(error: unknown): Error {
  if (error instanceof RouteGroupingConflictError) {
    return createRouteOpsHttpError(error.code, error.message, 409);
  }
  if (error instanceof RouteGroupingValidationError) {
    return createRouteOpsHttpError(error.code, error.message, 400);
  }
  if (error instanceof RouteGroupingUnresolvedAssignmentsError) {
    return createRouteOpsHttpError(error.code, error.message, 409);
  }
  if (error instanceof RouteGroupingRiskConfirmationRequiredError) {
    return createRouteOpsHttpError(error.code, `${error.message} ${JSON.stringify({ warnings: error.warnings })}`, 409);
  }
  if (error instanceof WooCommerceOnboardingError) return error;
  return error instanceof Error ? error : new Error("Route grouping request failed");
}

function readRequiredJsonNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WooCommerceOnboardingError("BAD_REQUEST", `${field} must be a number`, 400);
  }
  return Math.floor(value);
}

function readOptionalJsonStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new WooCommerceOnboardingError("BAD_REQUEST", `${field} must be an array`, 400);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new WooCommerceOnboardingError("BAD_REQUEST", `${field} entries must be strings`, 400);
    }
    return entry.trim();
  });
}

function readRouteGroupPolygons(value: unknown): Array<{
  closed: boolean;
  color?: string | null;
  driverId?: string | null;
  geometry: unknown;
  id?: string | null;
  label: string;
}> {
  if (!Array.isArray(value)) {
    throw new WooCommerceOnboardingError("BAD_REQUEST", "polygons must be an array", 400);
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WooCommerceOnboardingError("BAD_REQUEST", "polygon must be an object", 400);
    }
    const row = entry as Record<string, unknown>;
    const label = typeof row.label === "string" && row.label.trim() !== "" ? row.label.trim() : `Polygon ${index + 1}`;
    return {
      closed: row.closed === true,
      color: typeof row.color === "string" ? row.color : null,
      driverId: typeof row.driverId === "string" && row.driverId.trim() !== "" ? row.driverId.trim() : null,
      geometry: row.geometry,
      id: typeof row.id === "string" && row.id.trim() !== "" ? row.id.trim() : null,
      label,
    };
  });
}

function readRouteGroupAssignments(value: unknown): Array<{ assignedDriverId: string; orderId: string }> {
  if (!Array.isArray(value)) {
    throw new WooCommerceOnboardingError("BAD_REQUEST", "assignments must be an array", 400);
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WooCommerceOnboardingError("BAD_REQUEST", "assignment must be an object", 400);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.orderId !== "string" || typeof row.assignedDriverId !== "string") {
      throw new WooCommerceOnboardingError("BAD_REQUEST", "assignment orderId and assignedDriverId are required", 400);
    }
    return { assignedDriverId: row.assignedDriverId.trim(), orderId: row.orderId.trim() };
  });
}

function requireRouteOptimizationJobService(
  services: RouteUiServices,
): NonNullable<RouteUiServices["routeOptimizationJobService"]> {
  if (services.routeOptimizationJobService === undefined) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Route optimization jobs are not enabled in this runtime.",
      400,
    );
  }
  return services.routeOptimizationJobService;
}

type CreateRouteOptimizationJobRequestInput = {
  request: FastifyRequest;
  routePlanId: string;
  services: RouteUiServices;
  session: AdminWebSession;
  shopDomainOverride?: string | undefined;
};

async function createRouteOptimizationJobForRequest(
  input: CreateRouteOptimizationJobRequestInput,
): Promise<RouteOptimizationJobDto> {
  const jobService = requireRouteOptimizationJobService(input.services);
  const shopDomain =
    input.shopDomainOverride ??
    requireRouteOpsShopDomain(input.request, input.session);
  let job: RouteOptimizationJobDto | null;
  try {
    job = await jobService.createJob({
      createdBy: input.session.subject,
      routePlanId: input.routePlanId,
      shopDomain,
      timeoutBudgetMs: readRouteOptimizationJobTimeoutBudgetMs(),
      traceId: `route-opt:${input.routePlanId}:${Date.now().toString(36)}`,
    });
  } catch (error) {
    if (error instanceof RouteOptimizationJobActiveError) {
      throw createRouteOpsHttpError(error.code, error.message, 409);
    }
    throw error;
  }
  if (job === null) {
    throw new WooCommerceOnboardingError(
      "NOT_FOUND",
      "Route plan not found",
      404,
    );
  }

  const detail = await input.services.routePlanService.getRoutePlanDetail({
    routePlanId: input.routePlanId,
    shopDomain,
  });
  void runRouteOptimizationJob({
    initialDetail: detail,
    job,
    logger: input.request.log,
    sanitizeError: sanitizeRouteUiError,
    services: {
      routeOptimizationJobService: jobService,
      routeOptimizationService: input.services.routeOptimizationService,
      routePlanService: input.services.routePlanService,
    },
    shopDomain,
  }).catch((error: unknown) => {
    input.request.log.error(
      {
        error: sanitizeRouteUiError(error),
        jobId: job.id,
        routePlanId: job.routePlanId,
        shopDomain,
      },
      "route optimization job background runner crashed",
    );
  });

  return job;
}

async function assertRoutePlanExistsForOptimizationRead(input: {
  routePlanId: string;
  services: RouteUiServices;
  shopDomain: string;
}): Promise<void> {
  const exists = input.services.routePlanService.routePlanExists === undefined
    ? await input.services.routePlanService.getRoutePlanDetail({
        routePlanId: input.routePlanId,
        shopDomain: input.shopDomain,
      }).then((detail) => detail !== null)
    : await input.services.routePlanService.routePlanExists({
        routePlanId: input.routePlanId,
        shopDomain: input.shopDomain,
      });
  if (!exists) {
    throw new WooCommerceOnboardingError(
      "NOT_FOUND",
      "Route plan not found",
      404,
    );
  }
}

function readRouteOpsShopDomain(
  request: FastifyRequest,
  session: AdminWebSession,
): string | null {
  const sessionShopDomain = readWpPluginSessionShopDomain(session);
  const requestedShopDomain = normalizeOptionalShopDomain(
    readQueryString(request.query, "shopDomain"),
  );
  assertWpPluginShopAccess(session, requestedShopDomain);
  return sessionShopDomain ?? requestedShopDomain;
}

function requireRouteOpsShopDomain(
  request: FastifyRequest,
  session: AdminWebSession,
): string {
  const shopDomain = readRouteOpsShopDomain(request, session);
  if (shopDomain === null) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "shopDomain is required for this workspace.",
      400,
    );
  }
  return shopDomain;
}

function assertRouteOpsMutationCsrf(
  request: FastifyRequest,
  session: AdminWebSession,
): void {
  const headerToken = readHeader(request.headers["x-csrf-token"]);
  const bodyToken =
    typeof request.body === "object" &&
    request.body !== null &&
    !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>).csrfToken
      : undefined;
  const token =
    headerToken ?? (typeof bodyToken === "string" ? bodyToken : undefined);
  if (!verifyAdminWebCsrfToken({ session, token })) {
    throw new WooCommerceOnboardingError(
      "FORBIDDEN",
      "Invalid admin UI CSRF token",
      403,
    );
  }
}
