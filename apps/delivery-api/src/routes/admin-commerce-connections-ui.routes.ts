import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AdminCommerceActor } from "../modules/commerce/admin-commerce-auth.js";
import type {
  AdminDriverRow,
  AdminDriverServiceContract,
} from "../modules/driver/admin-driver.types.js";
import type { SafeWooCommerceConnection } from "../modules/commerce/commerce-connection.service.js";
import type {
  AdminStoreSettings,
  SaveAdminStoreSettingsInput,
} from "../modules/commerce/admin-store-settings.service.js";
import type { AdminWooSyncServiceContract } from "../modules/commerce/admin-woocommerce-sync.service.js";
import {
  RouteScopeConfigValidationError,
  defaultRouteScopeConfig,
  isActiveDeliverySession,
  isActiveServiceType,
  validateRouteScopeConfigPayload,
  type RouteScopeConfigDto,
} from "../modules/route-ops/route-scope-config.js";
import {
  WooCommerceOnboardingError,
  type WooCommerceConnectionOnboardingService,
  type WooCommerceOnboardingResult,
} from "../modules/commerce/woocommerce-connection-onboarding.service.js";
import type { CanonicalOrderRow } from "../modules/shopify/order-sync.mapper.js";
import type {
  WordPressPluginSyncRequestInput,
  WordPressPluginSyncRun,
} from "../modules/wordpress-plugin/wordpress-plugin.types.js";
import type {
  DeliveryBatchCandidate,
  ListCanonicalOrdersFilters,
  PatchCanonicalOrderCoordinatesInput,
  PatchCanonicalOrderGeocodeDiagnosticsInput,
  PatchCanonicalOrderInput,
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
  RoutePlanConflictError,
  RoutePlanOrderAlreadyPlannedError,
  RoutePlanDriverAssignInvalidError,
  RoutePlanOptionsUpdateInvalidError,
  RoutePlanPublishInvalidError,
  RoutePlanStopUpdateInvalidError,
  type CreateRoutePlanPayload,
  type RoutePlanDetail,
  type RoutePlanOrderInput,
  type RoutePlanRouteScopeInput,
  type SaveRoutePlanPayload,
  type RoutePlanService,
  type RoutePlanSummary,
} from "../modules/route-plans/route-plan.types.js";
import type {
  RouteOptimizationService,
  RouteOptimizationStopSequence,
} from "../modules/route-plans/route-engine-route-optimizer.client.js";
import { readAdminUiFormFields } from "./admin-ui-form.js";
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
import type { GeocodingService } from "../modules/geocoding/geocoding.service.js";
import type { GeocodingResult } from "../modules/geocoding/geocoding.types.js";
import { summarizeGeocodeDiagnostic } from "../modules/geocoding/geocoding.diagnostics.js";
import type { AdminNotificationServiceContract } from "../modules/notifications/admin-notification.service.js";
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
const ADMIN_UI_APP_DRIVERS_PATH = `${ADMIN_UI_APP_PATH}/drivers`;
const ADMIN_UI_APP_SETTINGS_PATH = `${ADMIN_UI_APP_PATH}/settings`;
const ADMIN_UI_APP_API_PATH = `${ADMIN_UI_APP_PATH}/api`;
const ADMIN_UI_APP_ASSETS_PATH = `${ADMIN_UI_APP_PATH}/assets`;
const ADMIN_UI_APP_VENDOR_PATH = `${ADMIN_UI_APP_PATH}/vendor`;
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

type BulkGeocodeJobStatus = "accepted" | "running" | "completed" | "failed";

type BulkGeocodeResult =
  | {
      cached: boolean;
      order: ReturnType<typeof toRouteOpsOrderDto>;
      orderId: string;
      orderName: string;
      status: "resolved";
    }
  | {
      code: string;
      message: string;
      orderId: string;
      orderName: string;
      status: "failed" | "no_address" | "skipped_policy";
    };

type BulkGeocodeServices = {
  geocodingService: Pick<GeocodingService, "geocode" | "status">;
  orderSyncService: NonNullable<
    AdminCommerceConnectionsUiDependencies["orderSyncService"]
  > & {
    patchCanonicalOrderCoordinates: NonNullable<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderSyncService"]
      >["patchCanonicalOrderCoordinates"]
    >;
    patchCanonicalOrderGeocodeDiagnostics?: (
      input: PatchCanonicalOrderGeocodeDiagnosticsInput,
    ) => Promise<CanonicalOrderRow | null>;
  };
};

type BulkGeocodeJob = {
  completedAt: string | null;
  counts: {
    attempted: number;
    failed: number;
    matched: number;
    noAddress: number;
    skippedByPolicy: number;
    skippedAlreadyGeocoded: number;
    succeeded: number;
  };
  createdAt: string;
  error: string | null;
  filters: ListCanonicalOrdersFilters;
  jobId: string;
  policyLimit: {
    active: boolean;
    attemptedLimit: number | null;
    reached: boolean;
  };
  results: BulkGeocodeResult[];
  shopDomain: string;
  status: BulkGeocodeJobStatus;
  updatedAt: string;
};

const bulkGeocodeJobs = new Map<string, BulkGeocodeJob>();

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
  publicBaseUrl?: string;
  routeOptimizationService?: RouteOptimizationService;
  routePlanService?: Pick<
    RoutePlanService,
    | "assignRoutePlanDriver"
    | "createRoutePlan"
    | "createRoutePlanFromOrderIds"
    | "getRoutePlanDetail"
    | "listRoutePlans"
    | "saveRoutePlan"
    | "updateRoutePlanStops"
  > &
    Partial<Pick<RoutePlanService, "deleteRoutePlan" | "publishRoutePlan" | "updateRoutePlanOptions">>;
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
    withRouteOpsApi(request, reply, dependencies, async (session) => {
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
        locale: settings?.locale === "ko-KR" ? "ko-KR" : "en-CA",
        mapConfig: readRouteOpsMapConfig(),
        mode: isWpPluginSession(session) ? "plugin" : "internal-admin",
        routerConfig: readRouteOpsRouterConfig(),
        shopDomain,
      });
    }),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/notifications`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
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
    }),
  );

  app.patch<{ Params: { notificationId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/notifications/:notificationId/read`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
      }),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/orders`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
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
            ...(filters.search === undefined ? {} : { search: filters.search }),
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
    }),
  );

  app.post(`${ADMIN_UI_APP_API_PATH}/orders/sync`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
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
        dependencies,
        request,
        shopDomain,
      });
      return routeOpsData(toRouteOpsWooSyncResponse(accepted), 202);
    }),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/orders/sync/latest`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
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
    }),
  );

  app.get<{ Params: { syncRunId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/sync/:syncRunId`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
      }),
  );

  app.post<{ Params: { sourceOrderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/woo/:sourceOrderId/sync`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
      }),
  );

  app.post(
    `${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
        });

        return routeOpsData(toBulkGeocodeOrderResponse(job), 202);
      }),
  );

  app.get<{ Params: { jobId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode/:jobId`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, (session) => {
        const job = readBulkGeocodeJobForSession(
          request.params.jobId,
          requireRouteOpsShopDomain(request, session),
        );
        return routeOpsData(toBulkGeocodeOrderResponse(job));
      }),
  );

  app.post(`${ADMIN_UI_APP_API_PATH}/orders/geocode`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
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
      });

      return routeOpsData(
        {
          geocode: toBulkGeocodeJobDto(job),
        },
        202,
      );
    }),
  );

  app.get<{ Params: { jobId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/geocode/:jobId`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, (session) => {
        const job = readBulkGeocodeJobForSession(
          request.params.jobId,
          requireRouteOpsShopDomain(request, session),
        );
        return routeOpsData({ geocode: toBulkGeocodeJobDto(job) });
      }),
  );

  app.get<{ Params: { orderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/:orderId`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
        const shopDomain = requireRouteOpsShopDomain(request, session);
        if (dependencies.orderSyncService === undefined) {
          throw new WooCommerceOnboardingError(
            "BAD_REQUEST",
            "Order list service is not enabled in this runtime.",
            400,
          );
        }
        const orders = await dependencies.orderSyncService.listCanonicalOrders({
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
      }),
  );

  app.get<{ Params: { orderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata-diagnostics`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
        const shopDomain = requireRouteOpsShopDomain(request, session);
        if (dependencies.orderSyncService === undefined) {
          throw new WooCommerceOnboardingError(
            "BAD_REQUEST",
            "Order diagnostics service is not enabled in this runtime.",
            400,
          );
        }
        const orders = await dependencies.orderSyncService.listCanonicalOrders({
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
      }),
  );

  app.patch<{ Params: { orderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
        assertRouteOpsMutationCsrf(request, session);
        const shopDomain = requireRouteOpsShopDomain(request, session);
        if (dependencies.orderSyncService?.patchCanonicalOrder === undefined) {
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
        const order = await dependencies.orderSyncService.patchCanonicalOrder({
          actor: dependencies.actor.subject,
          orderId: request.params.orderId,
          patch: readRouteOpsMetadataPatch(body, routeScopeConfig),
          shopDomain,
        });
        if (order === null)
          throw new WooCommerceOnboardingError(
            "NOT_FOUND",
            "Order not found",
            404,
          );
        return routeOpsData({ order: toRouteOpsOrderDto(order) });
      }),
  );

  app.patch<{ Params: { orderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/:orderId/coordinates`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
      }),
  );

  app.post<{ Params: { orderId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/orders/:orderId/geocode`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
        const orders = await dependencies.orderSyncService.listCanonicalOrders({
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
            await dependencies.orderSyncService.patchCanonicalOrderCoordinates({
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
            });
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
      }),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/order-batches`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
      const shopDomain = requireRouteOpsShopDomain(request, session);
      if (
        dependencies.orderSyncService?.listDeliveryBatchCandidates === undefined
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
    }),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/routes`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
      const services = requireRouteUiServices(dependencies);
      const shopDomain = requireRouteOpsShopDomain(request, session);
      const deliveryDate = normalizeOptionalDate(
        readQueryString(request.query, "deliveryDate"),
      );
      const routePlans = await services.routePlanService.listRoutePlans({
        ...(deliveryDate === null ? {} : { deliveryDate }),
        shopDomain,
      });
      return routeOpsData({
        routePlans: filterRoutePlansByDate(routePlans, deliveryDate).map(
          toRouteOpsRoutePlanDto,
        ),
      });
    }),
  );

  app.post(`${ADMIN_UI_APP_API_PATH}/routes`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
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
    }),
  );

  app.get<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
      }),
  );

  app.delete<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
      }),
  );

  app.patch<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
            throw new RouteOpsHttpError(code, message, httpStatus);
          }
          throw error;
        }
      }),
  );

  app.patch<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/stops`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
        const updated = await services.routePlanService.updateRoutePlanStops({
          payload: { stops: readRouteOpsStopSequence(body.stops, detail) },
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
      }),
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
        assertRouteOpsMutationCsrf(request, session);
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
        const optimized = await buildOptimizedStopOrder({
          detail,
          routeOptimizationService: services.routeOptimizationService,
          shopDomain,
        });
        const updated = await services.routePlanService.updateRoutePlanStops({
          payload: { stops: optimized.stops },
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
      }),
  );

  app.patch<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/driver`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
        assertRouteOpsMutationCsrf(request, session);
        const services = requireRouteUiServices(dependencies);
        const shopDomain = requireRouteOpsShopDomain(request, session);
        const body = readRouteOpsBodyObject(request.body);
        const updated = await services.routePlanService.assignRoutePlanDriver({
          payload: { driverId: readNullableJsonString(body.driverId) },
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
      }),
  );

  app.patch<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/options`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
          const updated = await services.routePlanService.updateRoutePlanOptions({
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
      }),
  );

  app.post<{ Params: { routePlanId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/publish`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
      }),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/drivers`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
      const shopDomain = requireRouteOpsShopDomain(request, session);
      if (dependencies.driverService === undefined) {
        return routeOpsData({ drivers: [] });
      }
      const drivers = await dependencies.driverService.listDrivers({
        shopDomain,
      });
      return routeOpsData({ drivers: drivers.map(toRouteOpsDriverDto) });
    }),
  );

  app.post(`${ADMIN_UI_APP_API_PATH}/drivers`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
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
    }),
  );

  app.post<{ Params: { driverId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/drivers/:driverId/regenerate-invite-code`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
      }),
  );

  app.delete<{ Params: { driverId: string } }>(
    `${ADMIN_UI_APP_API_PATH}/drivers/:driverId`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
      }),
  );

  app.get(`${ADMIN_UI_APP_API_PATH}/settings`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
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
    }),
  );

  app.patch(`${ADMIN_UI_APP_API_PATH}/settings`, async (request, reply) =>
    withRouteOpsApi(request, reply, dependencies, async (session) => {
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
        defaultDepotLatitude: readNullableJsonNumber(body.defaultDepotLatitude),
        defaultDepotLongitude: readNullableJsonNumber(
          body.defaultDepotLongitude,
        ),
        locale: readRouteOpsLocale(body.locale),
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
    }),
  );

  app.post(
    `${ADMIN_UI_APP_API_PATH}/settings/geocode`,
    async (request, reply) =>
      withRouteOpsApi(request, reply, dependencies, async (session) => {
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
        const currentSettings = await dependencies.settingsService.getSettings({
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
        const settings = await dependencies.settingsService.saveSettings({
          defaultDepotAddress,
          defaultDepotLatitude: geocode.result.latitude,
          defaultDepotLongitude: geocode.result.longitude,
          locale: readRouteOpsLocale(
            body.locale ?? currentSettings?.locale ?? "en-CA",
          ),
          shopDomain,
        });
        return routeOpsData({
          geocode: toSafeRouteOpsGeocodeResponse(geocode),
          settings: toRouteOpsSettingsDto(settings),
        });
      }),
  );

  app.get(ADMIN_UI_APP_API_PATH, async (_request, reply) =>
    reply.callNotFound(),
  );

  app.get<{ Params: { "*": string } }>(
    `${ADMIN_UI_APP_API_PATH}/*`,
    async (_request, reply) => reply.callNotFound(),
  );
}

async function withRouteOpsApi<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminCommerceConnectionsUiDependencies,
  handler: (
    session: AdminWebSession,
  ) => Promise<RouteOpsApiResponse<T>> | RouteOpsApiResponse<T>,
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
  try {
    const response = await handler(session);
    return reply
      .code(response.statusCode)
      .type("application/json; charset=utf-8")
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        buildRouteOpsCsp(readRouteOpsMapConfig()),
      )
      .send({ data: response.data, error: null });
  } catch (error) {
    if (error instanceof RoutePlanBatchInvalidError) {
      request.log.warn(
        {
          blockerCounts: countRoutePlanBatchBlockers(error.blockers),
          blockersCount: error.blockers.length,
        },
        "route plan batch creation hard-failed",
      );
      return sendRouteOpsApiError(
        reply,
        400,
        error.code,
        sanitizeRouteUiError(error),
        {
          blockerCounts: countRoutePlanBatchBlockers(error.blockers),
          blockers: error.blockers,
        },
      );
    }
    if (error instanceof RouteScopeConfigValidationError) {
      return sendRouteOpsApiError(reply, 400, error.code, error.message);
    }
    if (error instanceof RouteOpsHttpError) {
      return sendRouteOpsApiError(
        reply,
        error.httpStatus,
        error.code,
        error.message,
      );
    }
    const statusCode =
      error instanceof WooCommerceOnboardingError ? error.httpStatus : 500;
    const code =
      error instanceof WooCommerceOnboardingError
        ? error.code
        : "ADMIN_UI_REQUEST_FAILED";
    return sendRouteOpsApiError(
      reply,
      statusCode,
      code,
      sanitizeRouteUiError(error),
    );
  }
}

class RouteOpsHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "RouteOpsHttpError";
  }
}

type RouteOpsApiResponse<T> = {
  data: T;
  statusCode: number;
};

function routeOpsData<T>(data: T, statusCode = 200): RouteOpsApiResponse<T> {
  return { data, statusCode };
}

type RouteOpsWooSyncAccepted = Awaited<
  ReturnType<NonNullable<AdminCommerceConnectionsUiDependencies["wooSyncService"]>["requestSync"]>
>;

function toRouteOpsWooSyncResponse(
  accepted: RouteOpsWooSyncAccepted,
): {
  alreadyRunning: boolean;
  message: string;
  syncRun: WordPressPluginSyncRun;
} {
  return {
    alreadyRunning: accepted.alreadyRunning,
    message: accepted.message,
    syncRun: accepted.syncRun,
  };
}

function scheduleRouteOpsWooSyncProcessing(input: {
  accepted: RouteOpsWooSyncAccepted;
  dependencies: AdminCommerceConnectionsUiDependencies;
  request: FastifyRequest;
  shopDomain: string;
}): void {
  if (
    input.accepted.startBackgroundProcessing !== true ||
    input.dependencies.wooSyncService === undefined
  ) {
    return;
  }
  const syncRunId = input.accepted.syncRun.syncRunId;
  input.request.log.info(
    { shopDomain: input.shopDomain, syncRunId },
    "route ops admin WooCommerce sync background processing scheduled",
  );
  void input.dependencies.wooSyncService
    .processSyncRun({ shopDomain: input.shopDomain, syncRunId })
    .then((run) => {
      input.request.log.info(
        {
          pagesRead: run?.result?.pagesRead ?? null,
          received: run?.result?.sync.received ?? null,
          shopDomain: input.shopDomain,
          status: run?.status ?? null,
          syncRunId,
        },
        "route ops admin WooCommerce sync processed",
      );
    })
    .catch((error: unknown) => {
      input.request.log.error(
        {
          error: sanitizeRouteUiError(error),
          shopDomain: input.shopDomain,
          syncRunId,
        },
        "route ops admin WooCommerce sync failed",
      );
    });
}

function readRouteOpsWooSyncRequestBody(
  value: unknown,
): WordPressPluginSyncRequestInput {
  const body =
    value === undefined || value === null ? {} : readRouteOpsBodyObject(value);
  const rawPageSize = body.pageSize ?? 100;
  if (
    typeof rawPageSize !== "number" ||
    !Number.isInteger(rawPageSize) ||
    rawPageSize < 1 ||
    rawPageSize > 100
  ) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "pageSize must be an integer from 1 to 100",
      400,
    );
  }
  return {
    modifiedAfter: readRouteOpsSyncModifiedAfter(body.modifiedAfter),
    pageSize: rawPageSize,
    status: readRouteOpsSyncStatus(body.status),
  };
}

function readRouteOpsWooSourceOrderId(value: string): string {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/u.test(trimmed)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "WooCommerce source order id must be a positive integer",
      400,
    );
  }
  return trimmed;
}

function readRouteOpsSyncModifiedAfter(value: unknown): Date | null {
  const raw = readNullableJsonString(value);
  if (raw === null) return null;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "modifiedAfter must be an ISO date-time string",
      400,
    );
  }
  return parsed;
}

function readRouteOpsSyncStatus(value: unknown): string | null {
  const status = readNullableJsonString(value);
  if (status === null) return null;
  if (status.length > 64) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "status is too long",
      400,
    );
  }
  return status;
}

function isRouteOpsUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function toSafeRouteOpsGeocodeResponse(
  geocode: Extract<GeocodingResult, { ok: true }>,
): Extract<GeocodingResult, { ok: true }> {
  return {
    ...geocode,
    result: {
      ...geocode.result,
      addressLabel: safeGeocodeAddressLabel(geocode.result.addressLabel),
      rawLabel: null,
    },
  };
}

function safeGeocodeAddressLabel(value: string): string {
  return value === "freeform" ||
    value === "freeform_without_unit" ||
    value === "structured" ||
    value === "structured_without_unit" ||
    value === "store_settings"
    ? value
    : "geocoded_address";
}

function sendRouteOpsApiError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): unknown {
  return reply
    .code(statusCode)
    .type("application/json; charset=utf-8")
    .header("Cache-Control", "no-store")
    .header(
      "Content-Security-Policy",
      buildRouteOpsCsp(readRouteOpsMapConfig()),
    )
    .send({
      data: null,
      error: { code, ...(details === undefined ? {} : { details }), message },
    });
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
    const optimized = await buildOptimizedStopOrder({
      detail,
      routeOptimizationService: services.routeOptimizationService,
      shopDomain,
    });
    await services.routePlanService.updateRoutePlanStops({
      payload: { stops: optimized.stops },
      routePlanId,
      shopDomain,
    });
    return redirectToRoutePlans(reply, {
      deliveryDate: detail.routePlan.deliveryDate ?? detail.routePlan.planDate,
      notice: buildRouteOptimizeNotice(optimized),
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
      buildRouteOpsCsp(readRouteOpsMapConfig()),
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
  routeOptimizationService?: NonNullable<
    AdminCommerceConnectionsUiDependencies["routeOptimizationService"]
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
    ...(dependencies.routeOptimizationService === undefined
      ? {}
      : { routeOptimizationService: dependencies.routeOptimizationService }),
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

async function readRouteOpsOrderFilters(input: {
  dependencies: AdminCommerceConnectionsUiDependencies;
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

async function resolveShopToday(
  dependencies: AdminCommerceConnectionsUiDependencies,
  shopDomain: string,
): Promise<string> {
  const timezone = await resolveShopTimezone(dependencies, shopDomain);
  return formatDateInTimezone(dependencies.now?.() ?? new Date(), timezone);
}

async function resolveShopTimezone(
  dependencies: AdminCommerceConnectionsUiDependencies,
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

function formatDateInTimezone(value: Date, timeZone: string): string {
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

function readRouteOpsBodyObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "JSON body is required",
      400,
    );
  }
  return value as Record<string, unknown>;
}

function readRequiredJsonString(
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

function readRouteEndMode(value: unknown): RoutePlanSummary["routeEndMode"] {
  if (value !== "END_AT_LAST_STOP" && value !== "RETURN_TO_DEPOT") {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "routeEndMode must be END_AT_LAST_STOP or RETURN_TO_DEPOT",
      400,
    );
  }
  return value;
}

function readNullableJsonString(value: unknown): string | null {
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

function readNullableJsonNumber(value: unknown): number | null {
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

function readRouteOpsLocale(value: unknown): string {
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

function readRequiredDepotAddress(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "defaultDepotAddress is required",
      400,
    );
  }
  return value.trim();
}

function depotAddressToGeocodingAddress(defaultDepotAddress: string): {
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

function readRememberedDepotGeocode(
  settings: AdminStoreSettings | null,
  defaultDepotAddress: string,
): {
  cached: true;
  ok: true;
  result: {
    addressLabel: string;
    latitude: number;
    longitude: number;
    provider: "store_settings";
    providerPlaceId: null;
    rawLabel: null;
  };
} | null {
  if (
    settings === null ||
    settings.defaultDepotAddress === null ||
    normalizeDepotAddressText(settings.defaultDepotAddress) !==
      normalizeDepotAddressText(defaultDepotAddress) ||
    !isStoredLatitude(settings.defaultDepotLatitude) ||
    !isStoredLongitude(settings.defaultDepotLongitude)
  ) {
    return null;
  }
  return {
    cached: true,
    ok: true,
    result: {
      addressLabel: "store_settings",
      latitude: settings.defaultDepotLatitude,
      longitude: settings.defaultDepotLongitude,
      provider: "store_settings",
      providerPlaceId: null,
      rawLabel: null,
    },
  };
}

function normalizeDepotAddressText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function isStoredLatitude(value: number | null): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -90 &&
    value <= 90
  );
}

function isStoredLongitude(value: number | null): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -180 &&
    value <= 180
  );
}

function requireBulkGeocodeServices(
  dependencies: AdminCommerceConnectionsUiDependencies,
): BulkGeocodeServices {
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
  if (
    dependencies.orderSyncService.patchCanonicalOrderCoordinates === undefined
  ) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Order coordinate editing is not enabled in this runtime.",
      400,
    );
  }
  const orderSyncService = dependencies.orderSyncService;
  const patchCanonicalOrderCoordinates = (
    input: PatchCanonicalOrderCoordinatesInput,
  ): Promise<CanonicalOrderRow | null> =>
    orderSyncService.patchCanonicalOrderCoordinates === undefined
      ? Promise.resolve(null)
      : orderSyncService.patchCanonicalOrderCoordinates(input);
  const patchCanonicalOrderGeocodeDiagnostics =
    orderSyncService.patchCanonicalOrderGeocodeDiagnostics === undefined
      ? undefined
      : (input: PatchCanonicalOrderGeocodeDiagnosticsInput) =>
          orderSyncService.patchCanonicalOrderGeocodeDiagnostics === undefined
            ? Promise.resolve(null)
            : orderSyncService.patchCanonicalOrderGeocodeDiagnostics(input);
  return {
    geocodingService: dependencies.geocodingService,
    orderSyncService: {
      listCanonicalOrders:
        orderSyncService.listCanonicalOrders.bind(orderSyncService),
      patchCanonicalOrderCoordinates,
      ...(patchCanonicalOrderGeocodeDiagnostics === undefined
        ? {}
        : { patchCanonicalOrderGeocodeDiagnostics }),
    },
  };
}

function createBulkGeocodeJob(input: {
  filters: ListCanonicalOrdersFilters;
  shopDomain: string;
}): BulkGeocodeJob {
  const now = new Date().toISOString();
  const job: BulkGeocodeJob = {
    completedAt: null,
    counts: {
      attempted: 0,
      failed: 0,
      matched: 0,
      noAddress: 0,
      skippedByPolicy: 0,
      skippedAlreadyGeocoded: 0,
      succeeded: 0,
    },
    createdAt: now,
    error: null,
    filters: input.filters,
    jobId: randomUUID(),
    policyLimit: {
      active: false,
      attemptedLimit: null,
      reached: false,
    },
    results: [],
    shopDomain: input.shopDomain,
    status: "accepted",
    updatedAt: now,
  };
  bulkGeocodeJobs.set(job.jobId, job);
  return job;
}

async function runBulkGeocodeJob(input: {
  actor: string;
  job: BulkGeocodeJob;
  services: BulkGeocodeServices;
}): Promise<void> {
  updateBulkGeocodeJob(input.job, { status: "running" });
  try {
    const orders = await input.services.orderSyncService.listCanonicalOrders({
      filters: input.job.filters,
      shopDomain: input.job.shopDomain,
    });
    input.job.counts.matched = orders.length;
    const publicAttemptLimit =
      input.services.geocodingService.status.providerPolicy ===
      "public_nominatim"
        ? (input.services.geocodingService.status.publicBulkAttemptLimit ??
          null)
        : null;
    input.job.policyLimit = {
      active: publicAttemptLimit !== null,
      attemptedLimit: publicAttemptLimit,
      reached: false,
    };
    touchBulkGeocodeJob(input.job);

    for (const order of orders) {
      if (hasRouteOpsCoordinates(order)) {
        input.job.counts.skippedAlreadyGeocoded += 1;
        touchBulkGeocodeJob(input.job);
        continue;
      }

      if (
        publicAttemptLimit !== null &&
        input.job.counts.attempted >= publicAttemptLimit
      ) {
        input.job.policyLimit.reached = true;
        input.job.counts.skippedByPolicy += 1;
        input.job.results.push({
          code: "GEOCODER_PUBLIC_BULK_LIMIT",
          message:
            "Public geocoder limit reached for this job. Run again later or configure a private provider.",
          orderId: order.orderId,
          orderName: order.name,
          status: "skipped_policy",
        });
        touchBulkGeocodeJob(input.job);
        continue;
      }

      const geocode = await input.services.geocodingService.geocode({
        address: readRouteOpsAddress(undefined, order.shippingAddress),
        shopDomain: input.job.shopDomain,
      });
      if (!geocode.ok) {
        if (geocode.code === "BLANK_ADDRESS") input.job.counts.noAddress += 1;
        else input.job.counts.failed += 1;
        input.job.counts.attempted += 1;
        input.job.results.push({
          code: geocode.code,
          message: geocode.message,
          orderId: order.orderId,
          orderName: order.name,
          status: geocode.code === "BLANK_ADDRESS" ? "no_address" : "failed",
        });
        await input.services.orderSyncService.patchCanonicalOrderGeocodeDiagnostics?.(
          {
            actor: input.actor,
            diagnostic: summarizeGeocodeDiagnostic(geocode, "bulk_geocode"),
            geocodeStatus:
              geocode.code === "BLANK_ADDRESS" ? "PENDING" : "FAILED",
            orderId: order.orderId,
            shopDomain: input.job.shopDomain,
            source: "bulk_geocode",
          },
        );
        touchBulkGeocodeJob(input.job);
        continue;
      }

      input.job.counts.attempted += 1;
      const updatedOrder =
        await input.services.orderSyncService.patchCanonicalOrderCoordinates({
          actor: input.actor,
          geocodeDiagnostic: {
            diagnostic: summarizeGeocodeDiagnostic(geocode, "bulk_geocode"),
            source: "bulk_geocode",
          },
          latitude: geocode.result.latitude,
          longitude: geocode.result.longitude,
          orderId: order.orderId,
          provider: geocode.result.provider,
          providerPlaceId: geocode.result.providerPlaceId,
          shopDomain: input.job.shopDomain,
          source: "geocoder",
        });
      if (updatedOrder === null) {
        input.job.counts.failed += 1;
        input.job.results.push({
          code: "ORDER_NOT_FOUND",
          message: "Order not found while saving geocoded coordinates.",
          orderId: order.orderId,
          orderName: order.name,
          status: "failed",
        });
        touchBulkGeocodeJob(input.job);
        continue;
      }

      input.job.counts.succeeded += 1;
      input.job.results.push({
        cached: geocode.cached,
        order: toRouteOpsOrderDto(updatedOrder),
        orderId: order.orderId,
        orderName: order.name,
        status: "resolved",
      });
      touchBulkGeocodeJob(input.job);
    }

    updateBulkGeocodeJob(input.job, { status: "completed" });
  } catch (error) {
    updateBulkGeocodeJob(input.job, {
      error: error instanceof Error ? error.message : "Bulk geocode failed.",
      status: "failed",
    });
  }
}

function updateBulkGeocodeJob(
  job: BulkGeocodeJob,
  patch: Partial<Pick<BulkGeocodeJob, "error" | "status">>,
): void {
  if (patch.status !== undefined) job.status = patch.status;
  if (patch.error !== undefined) job.error = patch.error;
  if (patch.status === "completed" || patch.status === "failed") {
    job.completedAt = new Date().toISOString();
  }
  touchBulkGeocodeJob(job);
}

function touchBulkGeocodeJob(job: BulkGeocodeJob): void {
  job.updatedAt = new Date().toISOString();
}

function readBulkGeocodeJobForSession(
  jobId: string,
  shopDomain: string,
): BulkGeocodeJob {
  const job = bulkGeocodeJobs.get(jobId) ?? null;
  if (job === null || job.shopDomain !== shopDomain) {
    throw new WooCommerceOnboardingError(
      "NOT_FOUND",
      "Bulk geocode job not found",
      404,
    );
  }
  return job;
}

function toBulkGeocodeOrderResponse(job: BulkGeocodeJob): {
  jobId: string;
  status: BulkGeocodeJobStatus;
  summary: {
    alreadyHasCoordinates: number;
    attempted: number;
    failed: number;
    noAddress: number;
    resolved: number;
    skippedByPolicy: number;
    skipped: number;
  };
  policyLimit: BulkGeocodeJob["policyLimit"];
} {
  return {
    jobId: job.jobId,
    policyLimit: job.policyLimit,
    status: job.status,
    summary: {
      alreadyHasCoordinates: job.counts.skippedAlreadyGeocoded,
      attempted: job.counts.attempted,
      failed: job.counts.failed,
      noAddress: job.counts.noAddress,
      resolved: job.counts.succeeded,
      skippedByPolicy: job.counts.skippedByPolicy,
      skipped:
        job.counts.skippedAlreadyGeocoded +
        job.counts.noAddress +
        job.counts.skippedByPolicy,
    },
  };
}

function toBulkGeocodeJobDto(job: BulkGeocodeJob): {
  completedAt: string | null;
  counts: BulkGeocodeJob["counts"];
  createdAt: string;
  error: string | null;
  jobId: string;
  policyLimit: BulkGeocodeJob["policyLimit"];
  results: BulkGeocodeResult[];
  status: BulkGeocodeJobStatus;
  updatedAt: string;
} {
  return {
    completedAt: job.completedAt,
    counts: job.counts,
    createdAt: job.createdAt,
    error: job.error,
    jobId: job.jobId,
    policyLimit: job.policyLimit,
    results: job.results,
    status: job.status,
    updatedAt: job.updatedAt,
  };
}

function hasRouteOpsCoordinates(order: CanonicalOrderRow): boolean {
  return (
    order.hasCoordinates && order.latitude !== null && order.longitude !== null
  );
}

function findRouteOpsOrderByNeutralId(
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

async function readRouteOpsRouteScopeConfig(
  dependencies: AdminCommerceConnectionsUiDependencies,
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

function readRouteOpsMetadataPatch(
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

function readRouteOpsDeliverySession(
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

function readRouteOpsServiceType(
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

function readLatitude(value: unknown): number {
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

function readLongitude(value: unknown): number {
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

function readCoordinateSource(
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

function readRouteOpsAddress(
  value: unknown,
  fallback: CanonicalOrderRow["shippingAddress"],
): CanonicalOrderRow["shippingAddress"] {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "address must be an object",
      400,
    );
  }
  const body = value as Record<string, unknown>;
  return {
    address1: Object.hasOwn(body, "address1")
      ? readNullableJsonString(body.address1)
      : fallback.address1,
    address2: Object.hasOwn(body, "address2")
      ? readNullableJsonString(body.address2)
      : fallback.address2,
    city: Object.hasOwn(body, "city")
      ? readNullableJsonString(body.city)
      : fallback.city,
    countryCode: Object.hasOwn(body, "countryCode")
      ? readNullableJsonString(body.countryCode)
      : fallback.countryCode,
    postalCode: Object.hasOwn(body, "postalCode")
      ? readNullableJsonString(body.postalCode)
      : fallback.postalCode,
    province: Object.hasOwn(body, "province")
      ? readNullableJsonString(body.province)
      : fallback.province,
  };
}

function readSelectedNeutralOrderIds(value: unknown): string[] {
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

function resolveNeutralOrderIdToGid(
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

function readRouteOpsStopSequence(
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

function readRouteOpsSaveRoutePayload(
  body: Record<string, unknown>,
  detail: RoutePlanDetail,
): SaveRoutePlanPayload {
  const payload: SaveRoutePlanPayload = {};
  if (Object.hasOwn(body, "driverId")) {
    payload.driverId = readNullableJsonString(body.driverId);
  }
  if (Object.hasOwn(body, "expectedUpdatedAt")) {
    const expectedUpdatedAt = readNullableJsonString(body.expectedUpdatedAt);
    if (expectedUpdatedAt !== null) payload.expectedUpdatedAt = expectedUpdatedAt;
  }
  if (Object.hasOwn(body, "routeEndMode")) {
    payload.routeEndMode = readRouteEndMode(body.routeEndMode);
  }
  if (Object.hasOwn(body, "stops")) {
    payload.stops = readRouteOpsStopSequence(body.stops, detail);
  }
  return payload;
}

function readRouteOpsMapConfig(): RouteOpsMapConfig {
  const styleUrl = process.env.ROUTE_OPS_MAP_STYLE_URL?.trim() ?? "";
  if (styleUrl === "") return notConfiguredMapConfig();

  const allowedHosts = readRouteOpsMapAllowedHosts();
  const styleAudit = auditRouteOpsMapStyle(styleUrl);
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

function readRouteOpsMapAllowedHosts(): string[] {
  const hosts = (process.env.ROUTE_OPS_MAP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
  return [...new Set(hosts)];
}

function readRouteOpsMapAttribution(defaultAttribution: string): string {
  const explicit = process.env.ROUTE_OPS_MAP_ATTRIBUTION?.trim();
  return explicit === undefined || explicit === ""
    ? defaultAttribution
    : explicit;
}

function auditRouteOpsMapStyle(
  styleUrl: string,
): RouteOpsMapConfig["styleAudit"] {
  const manifestEndpoints = readStyleManifestEndpoints(styleUrl);
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

function readStyleManifestEndpoints(styleUrl: string): string[] | null {
  if (!styleUrl.startsWith(`${ADMIN_UI_APP_VENDOR_PATH}/`)) {
    return null;
  }
  const relativePath = normalize(
    styleUrl.slice(`${ADMIN_UI_APP_VENDOR_PATH}/`.length),
  ).replace(/^(\.\.(?:\/|\\|$))+/u, "");
  if (relativePath === "" || relativePath.includes("..")) return null;
  const absolute = join(ROUTE_OPS_WEB_PUBLIC_PATH, "vendor", relativePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  try {
    const manifest = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
    if (!isRouteOpsStyleManifest(manifest)) return null;
    return extractStyleEndpointUrls(manifest);
  } catch {
    return null;
  }
}

function isRouteOpsStyleManifest(
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

function extractStyleEndpointUrls(manifest: unknown): string[] {
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

function buildRouteOpsCsp(mapConfig: RouteOpsMapConfig): string {
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

function readRouteOpsRouterConfig(): {
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

function toRouteOpsOrderDto(order: CanonicalOrderRow): {
  blockerReasons: string[];
  coordinates: { latitude: number | null; longitude: number | null };
  deliveryArea: string | null;
  deliveryDate: string | null;
  deliverySession: string | null;
  deliveryStatus: OperateDeliveryStatus;
  metadataResolved: boolean;
  geocodeStatus: CanonicalOrderRow["geocodeStatus"];
  geocodeDiagnostics: CanonicalOrderRow["geocodeDiagnostics"] | null;
  health: OrderHealth;
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
    deliveryArea: order.deliveryArea,
    deliveryDate: order.deliveryDate,
    deliverySession: order.deliverySession ?? null,
    deliveryStatus: deriveOperateDeliveryStatus(order),
    geocodeStatus: order.geocodeStatus,
    geocodeDiagnostics: order.geocodeDiagnostics ?? null,
    health: deriveOrderHealth(order),
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
      order.sourceUpdatedDate ?? order.sourceCreatedDate ?? order.orderDateLocal,
    status: order.fulfillmentStatus,
    stopId: order.deliveryStopId,
    timeWindowEnd: order.timeWindowEnd,
    timeWindowStart: order.timeWindowStart,
    transactionId: order.transactionId ?? null,
    wooOrderStatus: order.wooOrderStatus ?? null,
  };
}

function toRouteOpsBatchCandidateDto(
  candidate: DeliveryBatchCandidate,
): DeliveryBatchCandidate {
  return candidate;
}

function readOrderOperateBlockers(order: CanonicalOrderRow): string[] {
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

function toRouteOpsRoutePlanDto(routePlan: RoutePlanSummary): {
  createdAt: string;
  deliveryAreas: string[];
  deliveryDate: string | null;
  driverId: string | null;
  depot: {
    latitude: number | null;
    longitude: number | null;
  };
  id: string;
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
    missingCoordinates: routePlan.missingCoordinates,
    name: routePlan.name,
    planDate: routePlan.planDate,
    routeEndMode: routePlan.routeEndMode,
    status: routePlan.status,
    stopsCount: routePlan.stopsCount,
    updatedAt: routePlan.updatedAt,
  };
}

function toRouteOpsRoutePlanDetailDto(detail: RoutePlanDetail): {
  routeGeometry: RoutePlanDetail["routeGeometry"];
  routeMetrics: RoutePlanDetail["routeMetrics"];
  routePlan: ReturnType<typeof toRouteOpsRoutePlanDto>;
  routeStopPoints: Array<{
    deliveryStopId: string;
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
    orderName: string;
    recipientName: string | null;
    sequence: number;
    sourceOrderId: string;
    status: string;
  }>;
} {
  return {
    routeGeometry: detail.routeGeometry,
    routeMetrics: detail.routeMetrics,
    routePlan: toRouteOpsRoutePlanDto(detail.routePlan),
    routeStopPoints: detail.routeStopPoints.map((point) => ({
      deliveryStopId: point.deliveryStopId,
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
      orderId: stop.orderId,
      orderName: stop.orderName,
      recipientName: stop.recipientName,
      sequence: stop.sequence,
      sourceOrderId: stop.shopifyOrderGid,
      status: stop.status,
    })),
  };
}

function toRouteOpsDriverDto(driver: AdminDriverRow): {
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

function defaultRouteOpsSettings(shopDomain: string): AdminStoreSettings {
  return {
    defaultDepotAddress: null,
    defaultDepotLatitude: null,
    defaultDepotLongitude: null,
    locale: "en-CA",
    routeScopeConfig: defaultRouteScopeConfig(),
    shopDomain,
  };
}

function toRouteOpsSettingsDto(
  settings: AdminStoreSettings,
): AdminStoreSettings {
  return {
    defaultDepotAddress: settings.defaultDepotAddress,
    defaultDepotLatitude: settings.defaultDepotLatitude,
    defaultDepotLongitude: settings.defaultDepotLongitude,
    locale: settings.locale === "ko-KR" ? "ko-KR" : "en-CA",
    routeScopeConfig: settings.routeScopeConfig,
    shopDomain: settings.shopDomain,
  };
}

function formatAddressLabel(
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

function readSelectedOrderGids(value: string): string[] {
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

function selectRouteReadyOrders(input: {
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

function readRouteCreationBlockers(
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

async function createRoutePlanFromSelectedOrderIds(input: {
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

function buildCreateRoutePlanPayload(input: {
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

function readSharedRouteScope(
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

function readStopOrderLines(
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

type OptimizedStopOrder = {
  missingCoordinateStops: number;
  source: "clever_v1" | "route_engine";
  stops: RouteOptimizationStopSequence[];
};

async function buildOptimizedStopOrder(input: {
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

function buildCleverV1OptimizedStopOrder(detail: RoutePlanDetail): OptimizedStopOrder {
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

  return { missingCoordinateStops: missingStops.length, source: "clever_v1", stops };
}

function buildRouteOptimizeNotice(optimized: OptimizedStopOrder): string {
  if (optimized.source === "route_engine") {
    return optimized.missingCoordinateStops === 0
      ? "Route Engine optimized sequence saved."
      : `Route Engine optimized sequence saved; ${optimized.missingCoordinateStops} stop(s) without coordinates stayed at the end.`;
  }
  return optimized.missingCoordinateStops === 0
    ? "CLEVER v1 optimized sequence saved."
    : `CLEVER v1 optimized sequence saved; ${optimized.missingCoordinateStops} stop(s) without coordinates stayed at the end.`;
}

function readDepotCoordinates(
  routePlan: RoutePlanSummary,
): { latitude: number; longitude: number } | null {
  const latitude = routePlan.depot.latitude;
  const longitude = routePlan.depot.longitude;
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

function readStopCoordinates(
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

function normalizeOptionalDate(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  return normalizeRequiredDate(value);
}

function normalizeOptionalText(
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

function normalizeOperateDeliveryStatus(
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

function normalizeOrderHealth(
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

function normalizeRouteOpsOrderScope(
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

function normalizeRouteOpsOrderTab(
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

function normalizeRouteOpsPlanningStatus(
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

function normalizeRouteOpsServiceTypeFilter(
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

function normalizeRouteOpsDeliverySessionFilter(
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

function normalizeRequiredDate(value: string): string {
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

function readOptionalCoordinate(value: string | undefined): number | null {
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

function readLocaleField(value: string | undefined): string {
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

function sanitizeRouteUiError(error: unknown): string {
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

function countRoutePlanBatchBlockers(
  blockers: string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const blocker of blockers) {
    const key = normalizeRoutePlanBatchBlocker(blocker);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function normalizeRoutePlanBatchBlocker(blocker: string): string {
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

function redirectToRoutePlans(
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

function filterRoutePlansByDate(
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
