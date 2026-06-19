import { existsSync, readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AdminCommerceActor } from "../src/modules/commerce/admin-commerce-auth.js";
import { loadAdminCommerceConnectionsUiDependencies } from "../src/modules/commerce/admin-commerce-connections.dependencies.js";
import type { SafeWooCommerceConnection } from "../src/modules/commerce/commerce-connection.service.js";
import { DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES } from "../src/modules/wordpress-plugin/wordpress-plugin-auth.service.js";
import {
  RoutePlanBatchInvalidError,
  RoutePlanConflictError,
  RoutePlanOrderAlreadyPlannedError,
  type RoutePlanService,
} from "../src/modules/route-plans/route-plan.types.js";
import { defaultRouteScopeConfig } from "../src/modules/route-ops/route-scope-config.js";
import { defaultRouteOpsUiSettings } from "../src/modules/route-ops/route-ops-ui-settings.js";
import type { AdminCommerceConnectionsDependencies } from "../src/routes/admin-commerce-connections.routes.js";
import type { RouteOptimizationJobDto } from "../src/modules/route-plans/route-optimization-job.types.js";
import type { AdminCommerceConnectionsUiDependencies } from "../src/routes/admin-commerce-connections-ui.routes.js";
import {
  createAdminWebLaunchToken,
  MIN_ADMIN_WEB_LOGIN_SECRET_BYTES,
  MIN_ADMIN_WEB_SECRET_BYTES,
  verifyAdminWebLoginSecret,
} from "../src/routes/admin-ui-session.js";

const adminApiToken = `api_${"a".repeat(48)}`;
const webLoginSecret = `web_login_${"b".repeat(48)}`;
const webSessionSecret = `web_session_${"c".repeat(48)}`;
const csrfFieldPattern = /name="csrfToken" value="([^"]+)"/u;

type TestResponseLike = { body: string };
type ApiErrorBody = { code?: string; message: string };
type ApiSuccessEnvelope<T> = { data: T; error: null };
type ApiErrorEnvelope = { data: null; error: ApiErrorBody };

function readApiData<T>(response: TestResponseLike): T {
  const payload = JSON.parse(response.body) as unknown as ApiSuccessEnvelope<T>;
  expect(payload.error).toBeNull();
  return payload.data;
}

function readApiError(response: TestResponseLike): ApiErrorBody {
  const payload = JSON.parse(response.body) as unknown as ApiErrorEnvelope;
  expect(payload.data).toBeNull();
  return payload.error;
}

function routeOptimizationJob(
  overrides: Partial<RouteOptimizationJobDto> = {},
): RouteOptimizationJobDto {
  return {
    appliedAt: null,
    createdAt: "2026-06-10T07:00:00.000Z",
    createdBy: "web-operator",
    currentStep: "QUEUED",
    elapsedMs: null,
    engineResultSequence: null,
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    id: "job-id",
    invalidatedReason: null,
    routePlanId: "route-plan-id",
    shopId: "shop-id",
    startedAt: null,
    status: "QUEUED",
    timeoutBudgetMs: 30000,
    traceId: "route-opt:route-plan-id:test",
    updatedAt: "2026-06-10T07:00:00.000Z",
    ...overrides,
  };
}

function routeOptimizationJobServiceMock(
  overrides: Partial<
    NonNullable<
      AdminCommerceConnectionsUiDependencies["routeOptimizationJobService"]
    >
  > = {},
): NonNullable<
  AdminCommerceConnectionsUiDependencies["routeOptimizationJobService"]
> {
  return {
    createJob: vi.fn(() => Promise.resolve(routeOptimizationJob())),
    findJob: vi.fn(() =>
      Promise.resolve(routeOptimizationJob({ status: "RUNNING" })),
    ),
    findLatestJob: vi.fn(() =>
      Promise.resolve(routeOptimizationJob({ status: "RUNNING" })),
    ),
    markApplyingResult: vi.fn(() =>
      Promise.resolve(
        routeOptimizationJob({
          currentStep: "APPLYING_RESULT",
          status: "RUNNING",
        }),
      ),
    ),
    markRunning: vi.fn(() =>
      Promise.resolve(
        routeOptimizationJob({
          currentStep: "CALLING_ENGINE",
          status: "RUNNING",
        }),
      ),
    ),
    reconcileStaleActiveJobs: vi.fn(() => Promise.resolve([])),
    recordEngineOutcome: vi.fn(() =>
      Promise.resolve(routeOptimizationJob({ status: "APPLIED" })),
    ),
    ...overrides,
  };
}

async function waitForExpectation(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe("Admin WooCommerce connection UI routes", () => {
  test("does not register UI dependencies without dedicated strong web secrets or through JWT fallback", () => {
    const base = createBaseAdminCommerceDependencies();

    expect(
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_API_TOKEN: adminApiToken,
          JWT_SECRET: webSessionSecret,
        } as never,
        nodeEnv: "production",
      }),
    ).toBeUndefined();
    expect(
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_API_TOKEN: adminApiToken,
          CLEVER_ADMIN_WEB_LOGIN_SECRET: "short",
          CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
        },
        nodeEnv: "production",
      }),
    ).toBeUndefined();
    expect(
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_API_TOKEN: adminApiToken,
          CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
          CLEVER_ADMIN_WEB_SESSION_SECRET: "short",
        },
        nodeEnv: "production",
      }),
    ).toBeUndefined();
    expect(
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
          CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
        },
        nodeEnv: "production",
      }),
    ).toBeUndefined();
    expect(
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_WEB_LOGIN_SECRET: "abcdefghij",
          CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
          DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
        },
        nodeEnv: "production",
      }),
    ).toBeDefined();
    expect(
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
          CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
          DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
        },
        nodeEnv: "production",
      }),
    ).toBeDefined();
  });

  test("loads the driver app download URL without exposing it as the install URL", () => {
    const base = createBaseAdminCommerceDependencies();

    const dependencies = loadAdminCommerceConnectionsUiDependencies({
      adminCommerceConnections: base.dependencies,
      env: {
        CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
        CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
        DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
        DRIVER_APP_DOWNLOAD_URL:
          "https://drive.example.test/uc?id=apk&export=download",
      },
      nodeEnv: "production",
    });

    expect(dependencies?.driverAppDownloadUrl).toBe(
      "https://drive.example.test/uc?id=apk&export=download",
    );
    expect(() =>
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
          CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
          DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
          DRIVER_APP_DOWNLOAD_URL: "file:///tmp/driver.apk",
        },
        nodeEnv: "production",
      }),
    ).toThrow("DRIVER_APP_DOWNLOAD_URL must be an http(s) URL");
  });

  test("enables route_engine optimization only with base URL and internal token", () => {
    const base = createBaseAdminCommerceDependencies();

    expect(() =>
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
          CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
          DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
          ROUTE_ENGINE_BASE_URL: "http://route-engine:8080",
        },
        nodeEnv: "production",
      }),
    ).toThrow(
      "ROUTE_ENGINE_INTERNAL_TOKEN is required when ROUTE_ENGINE_BASE_URL is set",
    );

    const dependencies = loadAdminCommerceConnectionsUiDependencies({
      adminCommerceConnections: base.dependencies,
      env: {
        CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
        CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
        DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
        ROUTE_ENGINE_BASE_URL: "http://route-engine:8080",
        ROUTE_ENGINE_INTERNAL_TOKEN: "internal-token",
        ROUTE_ENGINE_MODE: "road_graph",
        ROUTE_ENGINE_OBJECTIVE: "minimize_duration",
        ROUTE_ENGINE_TIMEOUT_MS: "5000",
      },
      nodeEnv: "production",
    });

    expect(dependencies?.routeOptimizationService).toBeDefined();
  });

  test("enables VROOM optimization with base URL and rejects mixed optimizer configuration", () => {
    const base = createBaseAdminCommerceDependencies();

    const dependencies = loadAdminCommerceConnectionsUiDependencies({
      adminCommerceConnections: base.dependencies,
      env: {
        CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
        CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
        DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
        VROOM_BASE_URL: "http://vroom:3000",
        VROOM_TIMEOUT_MS: "3000",
      },
      nodeEnv: "production",
    });

    expect(dependencies?.routeOptimizationService).toBeDefined();
    expect(() =>
      loadAdminCommerceConnectionsUiDependencies({
        adminCommerceConnections: base.dependencies,
        env: {
          CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
          CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
          DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
          ROUTE_ENGINE_BASE_URL: "http://route-engine:8080",
          ROUTE_ENGINE_INTERNAL_TOKEN: "internal-token",
          VROOM_BASE_URL: "http://vroom:3000",
        },
        nodeEnv: "production",
      }),
    ).toThrow("VROOM_BASE_URL and ROUTE_ENGINE_BASE_URL cannot both be set");
  });

  test("uses Woo-compatible Route Ops repositories even when legacy Shopify admin dependencies are configured", async () => {
    const base = createBaseAdminCommerceDependencies();
    const shopFindUnique = vi.fn(() => Promise.resolve({ id: "shop-id" }));
    const orderFindMany = vi.fn(() => Promise.resolve([]));
    const routePlanFindMany = vi.fn(() => Promise.resolve([]));
    const legacyAdminOrderList = vi.fn(() =>
      Promise.reject(
        new Error("legacy Shopify order service must not handle Woo domains"),
      ),
    );
    const legacyAdminRoutePlanList = vi.fn(() =>
      Promise.reject(
        new Error(
          "legacy Shopify route plan service must not handle Woo domains",
        ),
      ),
    );
    const uiDependencies = loadAdminCommerceConnectionsUiDependencies({
      adminCommerceConnections: base.dependencies,
      adminOrders: {
        orderSyncService: { listCanonicalOrders: legacyAdminOrderList },
      } as never,
      adminRoutePlans: {
        routePlanService: { listRoutePlans: legacyAdminRoutePlanList },
      } as never,
      env: {
        CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
        CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
        DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
      },
      nodeEnv: "production",
      prisma: {
        order: { findMany: orderFindMany },
        routePlan: { findMany: routePlanFindMany },
        shop: { findUnique: shopFindUnique },
      } as never,
    });

    expect(uiDependencies?.orderSyncService).toBeDefined();
    expect(uiDependencies?.routePlanService).toBeDefined();
    await expect(
      uiDependencies?.orderSyncService?.listCanonicalOrders({
        shopDomain: "dev1.tomatonofood.com",
      }),
    ).resolves.toEqual([]);
    await expect(
      uiDependencies?.routePlanService?.listRoutePlans({
        shopDomain: "dev1.tomatonofood.com",
      }),
    ).resolves.toEqual([]);
    expect(legacyAdminOrderList).not.toHaveBeenCalled();
    expect(legacyAdminRoutePlanList).not.toHaveBeenCalled();
    expect(shopFindUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: { shopDomain: "dev1.tomatonofood.com" },
    });
  });

  test("keeps the delivery-api design contract scoped and trademark-safe", () => {
    const designPath = new URL("../DESIGN.md", import.meta.url);
    expect(existsSync(designPath)).toBe(true);
    const design = readFileSync(designPath, "utf8");

    expect(design).toContain(
      "applies only to the Fastify SSR browser admin UI",
    );
    expect(design).toContain(
      "Do not use Apple logos, Apple product imagery, Apple marks, copied Apple layouts/assets, or external Apple-hosted assets.",
    );
    expect(design).toContain("Guided setup pages");
    expect(design).toContain("one consolidated credential form");
    expect(design).toContain("checklist before secret fields");
    expect(design).not.toContain("Apple 2030");
    expect(design).not.toContain("the Apple logo centers");
    expect(design).not.toContain("Add to Bag");
  });

  test("keeps /admin API namespace separate from exact /admin browser redirect", async () => {
    const base = createBaseAdminCommerceDependencies();
    const uiDependencies = loadAdminCommerceConnectionsUiDependencies({
      adminCommerceConnections: base.dependencies,
      env: {
        CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
        CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
        DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
      },
      nodeEnv: "test",
    });
    expect(uiDependencies).toBeDefined();
    if (uiDependencies === undefined)
      throw new Error("Expected admin UI dependencies");
    const app = await buildApp({
      adminCommerceConnections: base.dependencies,
      adminCommerceConnectionsUi: uiDependencies,
    });

    try {
      const exactAdmin = await app.inject({ method: "GET", url: "/admin" });
      const jsonApi = await app.inject({
        method: "GET",
        url: "/admin/commerce-connections/woocommerce",
      });
      const unknownAdmin = await app.inject({
        method: "GET",
        url: "/admin/some-unknown-path",
      });

      expect(exactAdmin.statusCode).toBe(303);
      expect(exactAdmin.headers.location).toBe("/admin/ui");
      expect(jsonApi.statusCode).toBe(401);
      expect(jsonApi.headers.location).toBeUndefined();
      expect(jsonApi.headers["content-type"]).toContain("application/json");
      expect(JSON.parse(jsonApi.body)).toEqual({
        data: null,
        error: {
          code: "UNAUTHORIZED",
          message: "Missing CLEVER admin bearer token",
        },
      });
      expect(unknownAdmin.statusCode).toBe(404);
      expect(unknownAdmin.headers.location).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  test("compares web login secret safely and never accepts the API token by default", () => {
    expect(MIN_ADMIN_WEB_SECRET_BYTES).toBe(32);
    expect(MIN_ADMIN_WEB_LOGIN_SECRET_BYTES).toBe(10);
    expect(
      verifyAdminWebLoginSecret({
        candidate: webLoginSecret,
        expected: webLoginSecret,
      }),
    ).toBe(true);
    expect(
      verifyAdminWebLoginSecret({
        candidate: "abcdefghij",
        expected: "abcdefghij",
      }),
    ).toBe(true);
    expect(
      verifyAdminWebLoginSecret({
        candidate: adminApiToken,
        expected: webLoginSecret,
      }),
    ).toBe(false);
    expect(
      verifyAdminWebLoginSecret({
        candidate: webLoginSecret,
        expected: "short",
      }),
    ).toBe(false);
  });

  test("requires login, renders the canonical dashboard, and scopes session cookies to admin UI", async () => {
    const { app } = await createUiHarness();

    try {
      const adminEntry = await app.inject({ method: "GET", url: "/admin" });
      expect(adminEntry.statusCode).toBe(303);
      expect(adminEntry.headers.location).toBe("/admin/ui");

      const rootEntry = await app.inject({ method: "GET", url: "/" });
      expect(rootEntry.statusCode).toBe(303);
      expect(rootEntry.headers.location).toBe("/admin/ui");

      const dashboardRedirect = await app.inject({
        method: "GET",
        url: "/admin/ui",
      });
      expect(dashboardRedirect.statusCode).toBe(303);
      expect(dashboardRedirect.headers.location).toBe("/admin/ui/login");

      const unknownUiPage = await app.inject({
        method: "GET",
        url: "/admin/ui/unknown",
      });
      expect(unknownUiPage.statusCode).toBe(303);
      expect(unknownUiPage.headers.location).toBe("/admin/ui");

      const unknownRouteOpsPage = await app.inject({
        method: "GET",
        url: "/admin/ui/app/unknown",
      });
      expect(unknownRouteOpsPage.statusCode).toBe(303);
      expect(unknownRouteOpsPage.headers.location).toBe("/admin/ui");

      const unknownNestedRouteOpsPage = await app.inject({
        method: "GET",
        url: "/admin/ui/app/routes/route-id/extra",
      });
      expect(unknownNestedRouteOpsPage.statusCode).toBe(303);
      expect(unknownNestedRouteOpsPage.headers.location).toBe("/admin/ui");

      const unknownUiJson = await app.inject({
        headers: { accept: "application/json" },
        method: "GET",
        url: "/admin/ui/unknown",
      });
      expect(unknownUiJson.statusCode).toBe(404);
      expect(unknownUiJson.headers.location).toBeUndefined();
      expect(unknownUiJson.headers["content-type"]).toContain(
        "application/json",
      );

      const unknownRouteOpsApi = await app.inject({
        method: "GET",
        url: "/admin/ui/app/api/unknown",
      });
      expect(unknownRouteOpsApi.statusCode).toBe(404);
      expect(unknownRouteOpsApi.headers.location).toBeUndefined();
      expect(unknownRouteOpsApi.headers["content-type"]).toContain(
        "application/json",
      );

      const unknownRouteOpsAssetLikePath = await app.inject({
        method: "GET",
        url: "/admin/ui/app/unknown.js",
      });
      expect(unknownRouteOpsAssetLikePath.statusCode).toBe(404);
      expect(unknownRouteOpsAssetLikePath.headers.location).toBeUndefined();

      const redirected = await app.inject({
        method: "GET",
        url: "/admin/ui/commerce-connections/woocommerce",
      });
      expect(redirected.statusCode).toBe(303);
      expect(redirected.headers.location).toBe("/admin/ui/login");

      const legacyLogin = await app.inject({
        method: "GET",
        url: "/admin/ui/commerce-connections/woocommerce/login",
      });
      expect(legacyLogin.statusCode).toBe(303);
      expect(legacyLogin.headers.location).toBe("/admin/ui/login");
      const legacyLoginPost = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/login",
        ...multipartRequest({ loginSecret: webLoginSecret }),
      });
      expect(legacyLoginPost.statusCode).toBe(303);
      expect(legacyLoginPost.headers.location).toBe("/admin/ui/login");
      expect(legacyLoginPost.headers["set-cookie"]).toBeUndefined();

      const loginPage = await app.inject({
        method: "GET",
        url: "/admin/ui/login",
      });
      expect(loginPage.statusCode).toBe(200);
      expect(loginPage.body).toContain("CLEVER Admin login");
      expect(loginPage.body).not.toContain(adminApiToken);

      const routeOpsDeepLink =
        "/admin/ui/app/orders?shopDomain=tomatonofood.com";
      const routeOpsRedirect = await app.inject({
        method: "GET",
        url: routeOpsDeepLink,
      });
      expect(routeOpsRedirect.statusCode).toBe(401);
      expect(routeOpsRedirect.headers.location).toBeUndefined();
      expect(routeOpsRedirect.body).toContain("Store session entry required");
      expect(routeOpsRedirect.body).not.toContain('name="loginSecret"');

      const unauthenticatedBootstrap = await app.inject({
        method: "GET",
        url: "/admin/ui/app/api/bootstrap?shopDomain=tomatonofood.com",
      });
      expect(unauthenticatedBootstrap.statusCode).toBe(401);
      expect(unauthenticatedBootstrap.headers.location).toBeUndefined();
      expect(readApiError(unauthenticatedBootstrap)).toEqual({
        code: "UNAUTHORIZED",
        message: "Admin UI login required",
      });

      const deepLinkLoginPage = await app.inject({
        method: "GET",
        url: "/admin/ui/login?returnTo=%2Fadmin%2Fui%2Fapp%2Forders%3FshopDomain%3Dtomatonofood.com",
      });
      expect(deepLinkLoginPage.statusCode).toBe(200);
      expect(deepLinkLoginPage.body).toContain(
        'name="returnTo" value="/admin/ui/store-sessions"',
      );
      expect(deepLinkLoginPage.body).not.toContain("https://evil.example");

      const apiTokenLogin = await app.inject({
        method: "POST",
        url: "/admin/ui/login",
        ...multipartRequest({ loginSecret: adminApiToken }),
      });
      expect(apiTokenLogin.statusCode).toBe(401);
      expect(apiTokenLogin.headers["set-cookie"]).toBeUndefined();
      expect(apiTokenLogin.body).not.toContain(adminApiToken);

      const login = await app.inject({
        method: "POST",
        url: "/admin/ui/login",
        ...multipartRequest({ loginSecret: webLoginSecret }),
      });
      expect(login.statusCode).toBe(303);
      expect(login.headers.location).toBe("/admin/ui/store-sessions");
      const setCookies = readSetCookies(login);

      const deepLinkLogin = await app.inject({
        method: "POST",
        url: "/admin/ui/login",
        ...multipartRequest({
          loginSecret: webLoginSecret,
          returnTo: "/admin/ui/app/orders?shopDomain=tomatonofood.com",
        }),
      });
      expect(deepLinkLogin.statusCode).toBe(303);
      expect(deepLinkLogin.headers.location).toBe("/admin/ui/store-sessions");

      const externalReturnLogin = await app.inject({
        method: "POST",
        url: "/admin/ui/login",
        ...multipartRequest({
          loginSecret: webLoginSecret,
          returnTo: "https://evil.example/admin/ui/app/orders",
        }),
      });
      expect(externalReturnLogin.statusCode).toBe(303);
      expect(externalReturnLogin.headers.location).toBe(
        "/admin/ui/store-sessions",
      );

      const loginEndpointReturnLogin = await app.inject({
        method: "POST",
        url: "/admin/ui/login",
        ...multipartRequest({
          loginSecret: webLoginSecret,
          returnTo: "/admin/ui/login",
        }),
      });
      expect(loginEndpointReturnLogin.statusCode).toBe(303);
      expect(loginEndpointReturnLogin.headers.location).toBe(
        "/admin/ui/store-sessions",
      );

      const dotSegmentReturnLogin = await app.inject({
        method: "POST",
        url: "/admin/ui/login",
        ...multipartRequest({
          loginSecret: webLoginSecret,
          returnTo: "/admin/ui/app/orders/../settings",
        }),
      });
      expect(dotSegmentReturnLogin.statusCode).toBe(303);
      expect(dotSegmentReturnLogin.headers.location).toBe(
        "/admin/ui/store-sessions",
      );

      expect(setCookies).toHaveLength(4);
      const cookie = setCookies[0] ?? "";
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/admin/ui");
      expect(cookie).not.toContain("Secure");
      expectCookieClearPaths(setCookies, [
        "/admin/ui/commerce-connections/woocommerce",
        "/admin",
        "/",
      ]);

      const dashboard = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui",
      });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.body).toContain("Store sessions");
      expect(dashboard.body).toContain("/admin/ui/store-sessions");
      expect(dashboard.body).toContain("WooCommerce connection setup");
      expect(dashboard.body).toContain(
        "/admin/ui/commerce-connections/woocommerce",
      );
      expect(dashboard.body).not.toContain("/admin/ui/app/orders");
      expect(dashboard.body).not.toContain("/admin/ui/app/routes");
      expect(dashboard.body).not.toContain("/admin/ui/app/drivers");
      expect(dashboard.body).not.toContain("/admin/ui/app/settings");
      expect(dashboard.body).not.toContain(">Orders<");
      expect(dashboard.body).not.toContain(">Routes<");
      expect(dashboard.body).not.toContain(">Drivers<");
      expect(dashboard.body).not.toContain(">Settings<");
      expect(dashboard.body).toContain("-apple-system");

      const storeSessions = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/store-sessions",
      });
      expect(storeSessions.statusCode).toBe(200);
      expect(storeSessions.body).toContain("Store sessions");
      expect(storeSessions.body).toContain("Choose store domain");
      expect(storeSessions.body).not.toContain(
        "/admin/ui/app/orders?shopDomain=",
      );

      const storeSessionForShop = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/store-sessions?shopDomain=tenant-a.example.test",
      });
      expect(storeSessionForShop.statusCode).toBe(200);
      expect(storeSessionForShop.body).toContain("tenant-a.example.test");
      expect(storeSessionForShop.body).toContain(
        "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      );
      expect(storeSessionForShop.body).toContain(
        "/admin/ui/app/routes?shopDomain=tenant-a.example.test",
      );

      const commerce = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/commerce-connections",
      });
      expect(commerce.statusCode).toBe(200);
      expect(commerce.body).toContain("Commerce Connections");

      const logout = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/logout",
      });
      expect(logout.statusCode).toBe(303);
      expect(logout.headers.location).toBe("/admin/ui/login");
      expectCookieClearPaths(readSetCookies(logout), [
        "/admin/ui",
        "/admin/ui/commerce-connections/woocommerce",
        "/admin",
        "/",
      ]);

      const malformedCookie = await app.inject({
        headers: { cookie: "clever_admin_ui=%" },
        method: "GET",
        url: "/admin/ui/commerce-connections/woocommerce",
      });
      expect(malformedCookie.statusCode).toBe(303);
      expect(malformedCookie.headers.location).toBe("/admin/ui/login");
    } finally {
      await app.close();
    }
  });

  test("accepts a plugin launch token and enters admin UI without the web login secret", async () => {
    const { app } = await createUiHarness();
    const { token } = createAdminWebLaunchToken({
      returnPath: "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      sessionSecret: webSessionSecret,
      shopDomain: "tenant-a.example.test",
      subject: "wordpress-plugin:tenant-a.example.test",
    });

    try {
      const launch = await app.inject({
        method: "GET",
        url: `/admin/ui/plugin-launch?token=${encodeURIComponent(token)}`,
      });

      expect(launch.statusCode).toBe(303);
      expect(launch.headers.location).toBe(
        "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      );
      const cookie = readSetCookie(launch);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");

      const orders = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      });
      expect(orders.statusCode).toBe(200);
      expect(orders.body).toContain('id="clever-route-ops-root"');
      expect(orders.body).toContain("/admin/ui/app/assets/");
      expect(orders.body).toContain("CLEVER Route App");
      expect(orders.body).not.toContain("CLEVER Admin login");
      expect(orders.body).not.toContain("Connection setup");

      const root = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui",
      });
      expect(root.statusCode).toBe(200);
      expect(root.headers.location).toBeUndefined();
      expect(root.body).toContain("Store workspace session active");
      expect(root.body).toContain("tenant-a.example.test");
      expect(root.body).toContain(
        "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      );
      expect(root.body).not.toContain('id="clever-route-ops-root"');

      const bootstrap = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/bootstrap?shopDomain=tenant-a.example.test",
      });
      expect(bootstrap.statusCode).toBe(200);
      const bootstrapData = readApiData<{
        mapConfig: {
          providerMode: string | null;
          status: string;
          styleUrl: string | null;
        };
        mode: string;
        routerConfig: { status: string };
        shopDomain: string | null;
      }>(bootstrap);
      expect(bootstrapData.mode).toBe("plugin");
      expect(bootstrapData.shopDomain).toBe("tenant-a.example.test");
      expect(bootstrapData.mapConfig).toEqual(
        expect.objectContaining({
          providerMode: null,
          status: "not_configured",
          styleUrl: null,
        }),
      );
      expect(bootstrapData.routerConfig).toEqual(
        expect.objectContaining({ status: "not_configured" }),
      );
    } finally {
      await app.close();
    }
  });

  test("exposes a stable driver app install link and redirects it to the configured download", async () => {
    const rawDownloadUrl =
      "https://drive.example.test/uc?id=driver-apk&export=download";
    const { app } = await createUiHarness({
      driverAppDownloadUrl: rawDownloadUrl,
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const bootstrap = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/bootstrap?shopDomain=tenant-a.example.test",
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(
        readApiData<{ driverApp: { installUrl: string | null } }>(bootstrap)
          .driverApp,
      ).toEqual({
        installUrl: "https://clever-route.cleversystem.ai/driver-app",
      });
      expect(bootstrap.body).not.toContain("drive.example.test");
      expect(bootstrap.body).not.toContain("driver-apk");

      const redirect = await app.inject({ method: "GET", url: "/driver-app" });
      expect(redirect.statusCode).toBe(302);
      expect(redirect.headers.location).toBe(rawDownloadUrl);
    } finally {
      await app.close();
    }
  });

  test("keeps the driver app install link disabled until a download URL is configured", async () => {
    const { app } = await createUiHarness({ driverAppDownloadUrl: null });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const bootstrap = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/bootstrap?shopDomain=tenant-a.example.test",
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(
        readApiData<{ driverApp: { installUrl: string | null } }>(bootstrap)
          .driverApp,
      ).toEqual({
        installUrl: null,
      });

      const redirect = await app.inject({ method: "GET", url: "/driver-app" });
      expect(redirect.statusCode).toBe(404);
      expect(redirect.body).toContain("Driver app download is not configured.");
    } finally {
      await app.close();
    }
  });

  test("reports configured OSRM router bootstrap state without exposing the private base URL", async () => {
    await withRouteOpsRouterEnv(
      {
        OSRM_BASE_URL: "http://osrm-ontario:5000",
        ROUTE_OPS_ROUTER_COVERAGE: "ontario",
      },
      async () => {
        const { app } = await createUiHarness();

        try {
          const { cookie } = await loginAndReadCsrf(app);
          const response = await app.inject({
            headers: { cookie, accept: "application/json" },
            method: "GET",
            url: "/admin/ui/app/api/bootstrap?shopDomain=tenant-a.example.test",
          });

          expect(response.statusCode).toBe(200);
          const bootstrapData = readApiData<{
            routerConfig: {
              coverage: string | null;
              provider: string | null;
              status: string;
            };
          }>(response);
          expect(bootstrapData.routerConfig).toEqual({
            coverage: "ontario",
            provider: "osrm",
            status: "configured",
          });
          expect(response.body).not.toContain("osrm-ontario");
          expect(response.body).not.toContain("5000");
          expect(response.body).not.toContain("OSRM_BASE_URL");
        } finally {
          await app.close();
        }
      },
    );
  });

  test("redirects legacy operation GET paths to SPA routes after auth", async () => {
    const { app } = await createUiHarness();
    const cases: Array<readonly [string, string]> = [
      [
        "/admin/ui/orders?shopDomain=tenant-a.example.test&notice=ready&search=%231001",
        "/admin/ui/app/orders?shopDomain=tenant-a.example.test&notice=ready&search=%231001",
      ],
      [
        "/admin/ui/route-plans?shopDomain=tenant-a.example.test&deliveryDate=2026-05-30&routePlanId=route-1",
        "/admin/ui/app/routes?shopDomain=tenant-a.example.test&deliveryDate=2026-05-30&routePlanId=route-1",
      ],
      [
        "/admin/ui/drivers?shopDomain=tenant-a.example.test&notice=driver",
        "/admin/ui/app/drivers?shopDomain=tenant-a.example.test&notice=driver",
      ],
      [
        "/admin/ui/settings?shopDomain=tenant-a.example.test&error=check",
        "/admin/ui/app/settings?shopDomain=tenant-a.example.test&error=check",
      ],
    ];

    try {
      for (const [legacyPath] of cases) {
        const response = await app.inject({ method: "GET", url: legacyPath });
        expect(response.statusCode).toBe(303);
        expect(response.headers.location).toBe("/admin/ui/login");
      }

      const { cookie } = await loginAndReadCsrf(app);
      for (const [legacyPath, spaPath] of cases) {
        const response = await app.inject({
          headers: { cookie },
          method: "GET",
          url: legacyPath,
        });
        expect(response.statusCode).toBe(303);
        expect(response.headers.location).toBe(spaPath);
        expect(response.body).not.toContain("Imported order list");
      }
    } finally {
      await app.close();
    }
  });

  test("redirects WordPress-launched legacy operation GET paths while preserving query params", async () => {
    const { app } = await createUiHarness();
    const { token } = createAdminWebLaunchToken({
      returnPath: "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      sessionSecret: webSessionSecret,
      shopDomain: "tenant-a.example.test",
      subject: "wordpress-plugin:tenant-a.example.test",
    });

    try {
      const launch = await app.inject({
        method: "GET",
        url: `/admin/ui/plugin-launch?token=${encodeURIComponent(token)}`,
      });
      expect(launch.statusCode).toBe(303);
      const cookie = readSetCookie(launch);
      const response = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/route-plans?shopDomain=tenant-a.example.test&deliveryDate=2026-05-30&source=wp",
      });
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe(
        "/admin/ui/app/routes?shopDomain=tenant-a.example.test&deliveryDate=2026-05-30&source=wp",
      );

      const root = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui?shopDomain=tenant-a.example.test",
      });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain("Store workspace session active");
      expect(root.body).toContain(
        "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      );
    } finally {
      await app.close();
    }
  });

  test.each([
    ["orders", "/admin/ui/app/orders"],
    ["route-plans", "/admin/ui/app/routes"],
    ["drivers", "/admin/ui/app/drivers"],
    ["settings", "/admin/ui/app/settings"],
  ])(
    "accepts plugin app launch return path for %s without internal login",
    async (_section, path) => {
      const { app } = await createUiHarness();
      const { token } = createAdminWebLaunchToken({
        returnPath: `${path}?shopDomain=tenant-a.example.test`,
        sessionSecret: webSessionSecret,
        shopDomain: "tenant-a.example.test",
        subject: "wordpress-plugin:tenant-a.example.test",
      });

      try {
        const launch = await app.inject({
          method: "GET",
          url: `/admin/ui/plugin-launch?token=${encodeURIComponent(token)}`,
        });
        expect(launch.statusCode).toBe(303);
        expect(launch.headers.location).toBe(
          `${path}?shopDomain=tenant-a.example.test`,
        );
        const page = await app.inject({
          headers: { cookie: readSetCookie(launch) },
          method: "GET",
          url: `${path}?shopDomain=tenant-a.example.test`,
        });
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('id="clever-route-ops-root"');
        expect(page.body).toContain("/admin/ui/app/assets/");
        expect(page.body).not.toContain("CLEVER Admin login");
        expect(page.body).not.toContain("Connection setup");
      } finally {
        await app.close();
      }
    },
  );

  test("Route Ops bootstrap defaults to no map provider and self-only CSP", async () => {
    await withRouteOpsMapEnv({}, async () => {
      const { app } = await createUiHarness();
      try {
        const { cookie } = await loginAndReadCsrf(app);
        const bootstrap = await app.inject({
          headers: { cookie, accept: "application/json" },
          method: "GET",
          url: "/admin/ui/app/api/bootstrap?shopDomain=tenant-a.example.test",
        });
        expect(bootstrap.statusCode).toBe(200);
        expect(
          readApiData<{ mapConfig: unknown }>(bootstrap).mapConfig,
        ).toEqual(
          expect.objectContaining({
            allowedHosts: [],
            providerMode: null,
            status: "not_configured",
            styleUrl: null,
          }),
        );

        const shell = await app.inject({
          headers: { cookie },
          method: "GET",
          url: "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
        });
        const csp = String(shell.headers["content-security-policy"]);
        expect(csp).toContain("connect-src 'self'");
        expect(csp).not.toContain("tiles.openfreemap.org");
        expect(csp).not.toContain("router.project-osrm.org");
      } finally {
        await app.close();
      }
    });
  });

  test("Route Ops same-host vendor style is audited and public endpoints require explicit allowlist", async () => {
    await withRouteOpsMapEnv(
      {
        ROUTE_OPS_MAP_STYLE_URL:
          "/admin/ui/app/vendor/openfreemap-clever-lite.json",
      },
      async () => {
        const { app } = await createUiHarness();
        try {
          const { cookie } = await loginAndReadCsrf(app);
          const bootstrap = await app.inject({
            headers: { cookie, accept: "application/json" },
            method: "GET",
            url: "/admin/ui/app/api/bootstrap?shopDomain=tenant-a.example.test",
          });
          const data = readApiData<{
            mapConfig: {
              disabledReason?: string;
              providerMode: string | null;
              status: string;
              styleAudit: { externalHosts: string[] } | null;
              styleUrl: string | null;
            };
          }>(bootstrap);
          expect(data.mapConfig.status).toBe("not_configured");
          expect(data.mapConfig.styleUrl).toBeNull();
          expect(data.mapConfig.providerMode).toBeNull();
          expect(data.mapConfig.disabledReason).toContain(
            "public_style_hosts_not_allowlisted",
          );
          expect(data.mapConfig.styleAudit?.externalHosts).toContain(
            "tiles.openfreemap.org",
          );
        } finally {
          await app.close();
        }
      },
    );
  });

  test("Route Ops public OpenFreeMap mode returns provider metadata and CSP only when allowlisted", async () => {
    await withRouteOpsMapEnv(
      {
        ROUTE_OPS_MAP_ALLOWED_HOSTS:
          "tiles.openfreemap.org,overturemaps-tiles-us-west-2-beta.s3.amazonaws.com",
        ROUTE_OPS_MAP_PROVIDER_MODE: "public_allowlisted",
        ROUTE_OPS_MAP_STYLE_URL:
          "/admin/ui/app/vendor/openfreemap-clever-lite.json",
      },
      async () => {
        const { app } = await createUiHarness();
        try {
          const { cookie } = await loginAndReadCsrf(app);
          const bootstrap = await app.inject({
            headers: { cookie, accept: "application/json" },
            method: "GET",
            url: "/admin/ui/app/api/bootstrap?shopDomain=tenant-a.example.test",
          });
          const data = readApiData<{
            mapConfig: {
              allowedHosts: string[];
              providerMode: string | null;
              status: string;
              styleUrl: string | null;
            };
          }>(bootstrap);
          expect(data.mapConfig).toEqual(
            expect.objectContaining({
              allowedHosts: [
                "tiles.openfreemap.org",
                "overturemaps-tiles-us-west-2-beta.s3.amazonaws.com",
              ],
              providerMode: "public_allowlisted",
              status: "configured",
              styleUrl: "/admin/ui/app/vendor/openfreemap-clever-lite.json",
            }),
          );

          const shell = await app.inject({
            headers: { cookie },
            method: "GET",
            url: "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
          });
          const csp = String(shell.headers["content-security-policy"]);
          expect(csp).toContain("https://tiles.openfreemap.org");
          expect(csp).toContain(
            "https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com",
          );
          expect(csp).toContain("worker-src 'self' blob:");
        } finally {
          await app.close();
        }
      },
    );
  });

  test("Route Ops self-hosted vendor style configures map with self-only CSP", async () => {
    await withRouteOpsMapEnv(
      {
        ROUTE_OPS_MAP_STYLE_URL:
          "/admin/ui/app/vendor/openfreemap-self-hosted-fixture.json",
      },
      async () => {
        const { app } = await createUiHarness();
        try {
          const { cookie } = await loginAndReadCsrf(app);
          const bootstrap = await app.inject({
            headers: { cookie, accept: "application/json" },
            method: "GET",
            url: "/admin/ui/app/api/bootstrap?shopDomain=tenant-a.example.test",
          });
          const data = readApiData<{
            mapConfig: {
              allowedHosts: string[];
              providerMode: string | null;
              status: string;
              styleAudit: {
                endpoints: string[];
                externalHosts: string[];
              } | null;
              styleUrl: string | null;
            };
          }>(bootstrap);
          expect(data.mapConfig).toEqual(
            expect.objectContaining({
              allowedHosts: [],
              providerMode: "self_hosted",
              status: "configured",
              styleUrl:
                "/admin/ui/app/vendor/openfreemap-self-hosted-fixture.json",
            }),
          );
          expect(data.mapConfig.styleAudit?.externalHosts).toEqual([]);
          expect(data.mapConfig.styleAudit?.endpoints).toContain(
            "/admin/ui/app/vendor/tiles/{z}/{x}/{y}.pbf",
          );

          const shell = await app.inject({
            headers: { cookie },
            method: "GET",
            url: "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
          });
          const csp = String(shell.headers["content-security-policy"]);
          expect(csp).toContain("connect-src 'self'");
          expect(csp).not.toContain("tiles.openfreemap.org");
        } finally {
          await app.close();
        }
      },
    );
  });

  test("Route Ops rejects missing or malformed same-host style manifests", async () => {
    for (const styleUrl of [
      "/admin/ui/app/vendor/missing-style.json",
      "/admin/ui/app/vendor/maplibre-gl.css",
      "/admin/ui/app/not-vendor/style.json",
    ]) {
      await withRouteOpsMapEnv(
        { ROUTE_OPS_MAP_STYLE_URL: styleUrl },
        async () => {
          const { app } = await createUiHarness();
          try {
            const { cookie } = await loginAndReadCsrf(app);
            const bootstrap = await app.inject({
              headers: { cookie, accept: "application/json" },
              method: "GET",
              url: "/admin/ui/app/api/bootstrap?shopDomain=tenant-a.example.test",
            });
            const data = readApiData<{
              mapConfig: {
                disabledReason?: string;
                providerMode: string | null;
                status: string;
                styleAudit: unknown;
                styleUrl: string | null;
              };
            }>(bootstrap);
            expect(data.mapConfig).toEqual(
              expect.objectContaining({
                disabledReason: "style_manifest_unavailable",
                providerMode: null,
                status: "not_configured",
                styleAudit: null,
                styleUrl: null,
              }),
            );
          } finally {
            await app.close();
          }
        },
      );
    }
  });

  test("serves Route Ops vendor map assets with correct content type", async () => {
    const { app } = await createUiHarness();
    try {
      const css = await app.inject({
        method: "GET",
        url: "/admin/ui/app/vendor/maplibre-gl.css",
      });
      expect(css.statusCode).toBe(200);
      expect(css.headers["content-type"]).toContain("text/css");
      const style = await app.inject({
        method: "GET",
        url: "/admin/ui/app/vendor/openfreemap-clever-lite.json",
      });
      expect(style.statusCode).toBe(200);
      expect(style.headers["content-type"]).toContain("application/json");
      expect(style.body).toContain("tiles.openfreemap.org");
    } finally {
      await app.close();
    }
  });

  test("redacts plugin launch tokens from request logs", async () => {
    const logLines: string[] = [];
    const { app } = await createUiHarness(
      {},
      {
        logger: {
          level: "info",
          stream: { write: (line: string) => logLines.push(line) },
        },
      },
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/ui/plugin-launch?token=super-secret-launch-token",
      });

      expect(response.statusCode).toBe(401);
      const joinedLogs = logLines.join("\n");
      expect(joinedLogs).toContain(
        "/admin/ui/plugin-launch?token=%5Bredacted%5D",
      );
      expect(joinedLogs).not.toContain("super-secret-launch-token");
    } finally {
      await app.close();
    }
  });

  test("limits WP-launched operate sessions to the launched shop domain", async () => {
    const listCanonicalOrders = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderSyncService"]
      >["listCanonicalOrders"]
    >(() => Promise.resolve([canonicalOrder()]));
    const createPendingDriver = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["createPendingDriver"]
    >(() => Promise.resolve(driverRow()));
    const { app, createConnection, listConnections, testConnection } =
      await createUiHarness({
        driverService: {
          createPendingDriver,
          deleteDriver: vi.fn(),
          listDrivers: vi.fn(() => Promise.resolve([])),
          regenerateInviteCode: vi.fn(),
        },
        orderSyncService: { listCanonicalOrders },
      });
    const { token } = createAdminWebLaunchToken({
      returnPath: "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      sessionSecret: webSessionSecret,
      shopDomain: "tenant-a.example.test",
      subject: "wordpress-plugin:tenant-a.example.test",
    });

    try {
      const launch = await app.inject({
        method: "GET",
        url: `/admin/ui/plugin-launch?token=${encodeURIComponent(token)}`,
      });
      const cookie = readSetCookie(launch);
      const matching = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/app/drivers?shopDomain=tenant-a.example.test",
      });
      expect(matching.body).toContain('id="clever-route-ops-root"');
      expect(matching.body).not.toContain("Connection setup");
      const bootstrap = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/bootstrap?shopDomain=tenant-a.example.test",
      });
      const bootstrapData = readApiData<{
        csrfToken: string;
        mode: string;
        shopDomain: string;
      }>(bootstrap);
      const csrfToken = bootstrapData.csrfToken;
      expect(bootstrapData).toEqual(
        expect.objectContaining({
          mode: "plugin",
          shopDomain: "tenant-a.example.test",
        }),
      );
      listCanonicalOrders.mockClear();

      const mismatched = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-b.example.test",
      });
      const wooSetup = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/commerce-connections/woocommerce?shopDomain=tenant-b.example.test",
      });
      const wooTest = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/test",
        ...authenticatedMultipartRequest(
          cookie,
          credentialFormFields({ csrfToken }),
          undefined,
          {
            accept: "application/json",
          },
        ),
      });
      const mismatchedPost = await app.inject({
        method: "POST",
        url: "/admin/ui/app/drivers",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          displayName: "Wrong Shop Driver",
          phone: "+14165550999",
          shopDomain: "tenant-b.example.test",
        }),
      });

      expect(mismatched.statusCode).toBe(403);
      expect(readApiError(mismatched).message).toContain(
        "WordPress-launched admin session is limited to its connected shopDomain.",
      );
      expect(listCanonicalOrders).not.toHaveBeenCalled();
      expect(wooSetup.statusCode).toBe(303);
      expect(String(wooSetup.headers.location)).toContain(
        "/admin/ui/app/orders?",
      );
      expect(String(wooSetup.headers.location)).toContain(
        "shopDomain=tenant-a.example.test",
      );
      expect(String(wooSetup.headers.location)).toContain("error=");
      expect(wooTest.statusCode).toBe(403);
      expect(wooTest.json()).toEqual({
        message: "Connection setup requires CLEVER admin login.",
        ok: false,
      });
      expect(listConnections).not.toHaveBeenCalled();
      expect(testConnection).not.toHaveBeenCalled();
      expect(createConnection).not.toHaveBeenCalled();
      expect(mismatchedPost.statusCode).toBe(303);
      expect(String(mismatchedPost.headers.location)).toContain("error=");
      expect(createPendingDriver).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("serves scoped order ingest audit lookup without raw payload fields", async () => {
    const lookup = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderIngestAuditService"]
      >["lookup"]
    >(() =>
      Promise.resolve({
        canonicalOrder: { id: "order-1", name: "#11815", sourceOrderId: "11815", sourceOrderNumber: "11815", sourcePlatform: "WOOCOMMERCE", sourceSiteUrl: "https://woo.example.test" },
        evidenceKinds: ["raw_ingest", "event", "canonical_order"],
        events: [
          {
            code: "WOO_STATUS_CANCELLED",
            commerceConnectionId: "connection-id",
            createdAt: "2026-06-19T03:00:02.000Z",
            decision: "SKIP_RAW",
            id: "event-1",
            message: "Cancelled Woo order skipped.",
            metadata: { reason: "cancelled" },
            rawPayloadSha256: "sha256:raw",
            severity: "info",
            sourceLine: "WOOCOMMERCE",
            sourceOrderId: "11815",
            sourceOrderNumber: "11815",
            sourceSiteUrl: "https://woo.example.test",
            stage: "woo_status",
          },
        ],
        found: true,
        latestDecision: {
          code: "WOO_STATUS_CANCELLED",
          commerceConnectionId: "connection-id",
          createdAt: "2026-06-19T03:00:02.000Z",
          decision: "SKIP_RAW",
          id: "event-1",
          message: "Cancelled Woo order skipped.",
          metadata: { reason: "cancelled" },
          rawPayloadSha256: "sha256:raw",
          severity: "info",
          sourceLine: "WOOCOMMERCE",
          sourceOrderId: "11815",
          sourceOrderNumber: "11815",
          sourceSiteUrl: "https://woo.example.test",
          stage: "woo_status",
        },
        orderNumber: "11815",
        rawIngest: {
          canonicalOrderId: "order-1",
          commerceConnectionId: "connection-id",
          failureCode: null,
          failureMessage: null,
          id: "raw-1",
          platform: "WOOCOMMERCE",
          processedAt: "2026-06-19T03:00:01.000Z",
          rawPayloadSha256: "sha256:raw",
          receivedAt: "2026-06-19T02:59:59.000Z",
          sourceOrderId: "11815",
          sourceOrderNumber: "11815",
          sourceSiteUrl: "https://woo.example.test",
          status: "SKIPPED",
          syncRun: { completedAt: "2026-06-19T03:00:00.000Z", id: "sync-run-1", status: "COMPLETED" },
        },
        shopDomain: "tenant-a.example.test",
        status: "raw_ingest",
        syncRun: { completedAt: "2026-06-19T03:00:00.000Z", id: "sync-run-1", status: "COMPLETED" },
      }),
    );
    const { app } = await createUiHarness({
      orderIngestAuditService: { lookup },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/order-ingest-audit?shopDomain=tenant-a.example.test&orderNumber=11815",
      });

      expect(response.statusCode).toBe(200);
      const data = readApiData<{
        audit: {
          found: boolean;
          latestDecision: { code: string };
          rawIngest: { status: string };
        };
      }>(response);
      expect(data.audit.found).toBe(true);
      expect(data.audit.latestDecision.code).toBe("WOO_STATUS_CANCELLED");
      expect(data.audit.rawIngest.status).toBe("SKIPPED");
      expect(JSON.stringify(data)).not.toContain("\"rawPayload\":");
      expect(lookup).toHaveBeenCalledWith({
        orderNumber: "11815",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("rejects cross-shop WP sessions before order ingest audit lookup", async () => {
    const lookup = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderIngestAuditService"]
      >["lookup"]
    >();
    const { app } = await createUiHarness({
      orderIngestAuditService: { lookup },
    });
    const { token } = createAdminWebLaunchToken({
      returnPath: "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      sessionSecret: webSessionSecret,
      shopDomain: "tenant-a.example.test",
      subject: "wordpress-plugin:tenant-a.example.test",
    });

    try {
      const launch = await app.inject({
        method: "GET",
        url: `/admin/ui/plugin-launch?token=${encodeURIComponent(token)}`,
      });
      const cookie = readSetCookie(launch);
      const response = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/order-ingest-audit?shopDomain=tenant-b.example.test&orderNumber=11815",
      });

      expect(response.statusCode).toBe(403);
      expect(readApiError(response).message).toContain(
        "WordPress-launched admin session is limited to its connected shopDomain.",
      );
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("serves the Route Ops SPA shell and WP-session JSON APIs for orders, routes, drivers, and settings", async () => {
    const listCanonicalOrders = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderSyncService"]
      >["listCanonicalOrders"]
    >((input) => {
      if (input.filters?.readiness === "NEEDS_REVIEW") {
        return Promise.resolve([
          canonicalOrder({
            readiness: "NEEDS_REVIEW",
            reviewReasons: ["missing_delivery_date"],
          }),
        ]);
      }
      return Promise.resolve([canonicalOrder()]);
    });
    const listDrivers = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["listDrivers"]
    >(() => Promise.resolve([driverRow()]));
    const getSettings = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["settingsService"]
      >["getSettings"]
    >(() => Promise.resolve(storeSettings({ locale: "ko-KR" })));
    const { app } = await createUiHarness({
      driverService: {
        createPendingDriver: vi.fn(),
        deleteDriver: vi.fn(),
        listDrivers,
        regenerateInviteCode: vi.fn(),
      },
      orderSyncService: { listCanonicalOrders },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail: vi.fn(),
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        updateRoutePlanStops: vi.fn(),
      },
      settingsService: {
        getSettings,
        saveSettings: vi.fn(() =>
          Promise.resolve(storeSettings({ locale: "ko-KR" })),
        ),
      },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const shell = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      });
      const orders = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test",
      });
      const bootstrap = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/bootstrap?shopDomain=tenant-a.example.test",
      });
      const routes = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/routes?shopDomain=tenant-a.example.test&deliveryDate=2026-05-26",
      });
      const drivers = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/drivers?shopDomain=tenant-a.example.test",
      });
      const settings = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/settings?shopDomain=tenant-a.example.test",
      });

      expect(shell.statusCode).toBe(200);
      expect(shell.body).toContain('id="clever-route-ops-root"');
      expect(shell.body).toContain("/admin/ui/app/assets/");
      expect(shell.body).not.toContain("Connection setup");
      expect(orders.statusCode).toBe(200);
      expect(
        readApiData<{
          orders: Array<{
            blockerReasons: string[];
            deliveryArea: string | null;
            orderName: string;
            sourcePlatform: string;
          }>;
          reviewBlockers: Array<{ blockerReasons: string[] }>;
        }>(orders).orders[0],
      ).toEqual(
        expect.objectContaining({
          blockerReasons: [],
          deliveryArea: "Toronto",
          orderName: "#1001",
          sourcePlatform: "WOOCOMMERCE",
        }),
      );
      expect(
        readApiData<{
          orders: unknown[];
          reviewBlockers: Array<{ blockerReasons: string[] }>;
        }>(orders).reviewBlockers[0]?.blockerReasons,
      ).toContain("missing_delivery_date");
      expect(bootstrap.statusCode).toBe(200);
      expect(
        readApiData<{
          locale: string;
        }>(bootstrap).locale,
      ).toBe("ko-KR");
      expect(routes.statusCode).toBe(200);
      expect(
        readApiData<{
          routePlans: Array<{ name: string; stopsCount: number }>;
        }>(routes).routePlans[0],
      ).toEqual(
        expect.objectContaining({ name: "Route draft", stopsCount: 2 }),
      );
      expect(drivers.statusCode).toBe(200);
      const driverData = readApiData<{
        drivers: Array<{
          appLinked: boolean;
          authStatus: string;
          createdAt: string;
          displayName: string;
          inviteCode: string | null;
          inviteCodeExpiresAt: string | null;
          recentEventsCount: number;
        }>;
      }>(drivers).drivers[0];
      expect(driverData).toEqual(
        expect.objectContaining({
          appLinked: false,
          authStatus: "INVITE_PENDING",
          createdAt: "2026-05-26T12:00:00.000Z",
          displayName: "Alex Driver",
          inviteCode: "DRV123",
          inviteCodeExpiresAt: "2026-05-27T12:00:00.000Z",
          recentEventsCount: 0,
        }),
      );
      expect(JSON.stringify(driverData)).not.toContain("authSubject");
      expect(settings.statusCode).toBe(200);
      expect(
        readApiData<{
          settings: { defaultDepotAddress: string | null; locale: string };
        }>(settings).settings,
      ).toEqual(
        expect.objectContaining({
          defaultDepotAddress: "123 Depot St, Toronto, ON",
          locale: "ko-KR",
        }),
      );
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: {},
        shopDomain: "tenant-a.example.test",
      });
      expect(listDrivers).toHaveBeenCalledWith({
        shopDomain: "tenant-a.example.test",
      });
      expect(getSettings).toHaveBeenCalledWith({
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("normalizes operate order filters through the Route Ops orders API", async () => {
    const listCanonicalOrders = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderSyncService"]
      >["listCanonicalOrders"]
    >((input) => {
      if (input.filters?.readiness === "NEEDS_REVIEW") {
        return Promise.resolve([
          canonicalOrder({
            readiness: "NEEDS_REVIEW",
            reviewReasons: ["missing_coordinates"],
          }),
        ]);
      }
      return Promise.resolve([canonicalOrder()]);
    });
    const { app } = await createUiHarness({
      now: () => new Date("2026-05-29T12:00:00.000Z"),
      orderSyncService: { listCanonicalOrders },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&deliveryDate=2026-05-28&deliveryArea=Toronto&deliveryStatus=ready&health=normal&status=unplanned&search=%231001",
      });

      expect(response.statusCode).toBe(200);
      expect(
        readApiData<{ orders: Array<{ orderName: string; health: string }> }>(
          response,
        ).orders[0],
      ).toEqual(
        expect.objectContaining({ orderName: "#1001", health: "normal" }),
      );
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: {
          deliveryArea: "Toronto",
          deliveryDate: "2026-05-28",
          operateDeliveryStatus: "ready",
          orderHealth: "normal",
          planned: false,
          search: "#1001",
        },
        shopDomain: "tenant-a.example.test",
      });
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: {
          deliveryArea: "Toronto",
          readiness: "NEEDS_REVIEW",
          search: "#1001",
        },
        shopDomain: "tenant-a.example.test",
      });

      const planned = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&status=planned",
      });
      expect(planned.statusCode).toBe(200);
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: { deliveryDateFrom: "2026-05-29", planned: true },
        shopDomain: "tenant-a.example.test",
      });

      listCanonicalOrders.mockClear();
      const unplanned = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&status=unplanned",
      });
      expect(unplanned.statusCode).toBe(200);
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: { deliveryDateFrom: "2026-05-29", planned: false },
        shopDomain: "tenant-a.example.test",
      });

      listCanonicalOrders.mockClear();
      const needsReview = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&deliveryDate=2026-05-01&health=needs_review",
      });
      expect(needsReview.statusCode).toBe(200);
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: { orderHealth: "needs_review" },
        shopDomain: "tenant-a.example.test",
      });

      const invalid = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&status=archived",
      });
      expect(invalid.statusCode).toBe(400);

      listCanonicalOrders.mockClear();
      const scoped = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&scope=planning&tab=unplanned&serviceType=DELIVERY&deliverySession=DAY&search=%231001",
      });
      expect(scoped.statusCode).toBe(200);
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: {
          deliverySession: "DAY",
          planned: false,
          routeOpsScope: "planning",
          routeOpsTab: "unplanned",
          routeOpsToday: "2026-05-29",
          search: "#1001",
          serviceType: "DELIVERY",
        },
        shopDomain: "tenant-a.example.test",
      });

      listCanonicalOrders.mockClear();
      const allPlanning = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&scope=planning&tab=all",
      });
      expect(allPlanning.statusCode).toBe(200);
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: {
          routeOpsScope: "planning",
          routeOpsTab: "all",
          routeOpsToday: "2026-05-29",
        },
        shopDomain: "tenant-a.example.test",
      });

      for (const tab of ["planned", "needs_review"] as const) {
        listCanonicalOrders.mockClear();
        const planningTab = await app.inject({
          headers: { cookie, accept: "application/json" },
          method: "GET",
          url: `/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&scope=planning&tab=${tab}`,
        });
        expect(planningTab.statusCode).toBe(200);
        expect(listCanonicalOrders).toHaveBeenCalledWith({
          filters: {
            ...(tab === "planned" ? { planned: true } : {}),
            routeOpsScope: "planning",
            routeOpsTab: tab,
            routeOpsToday: "2026-05-29",
          },
          shopDomain: "tenant-a.example.test",
        });
      }

      listCanonicalOrders.mockClear();
      const history = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&scope=history&tab=all&search=past",
      });
      expect(history.statusCode).toBe(200);
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: {
          routeOpsScope: "history",
          routeOpsTab: "all",
          search: "past",
        },
        shopDomain: "tenant-a.example.test",
      });

      for (const tab of ["unplanned", "planned", "needs_review"] as const) {
        listCanonicalOrders.mockClear();
        const historyTab = await app.inject({
          headers: { cookie, accept: "application/json" },
          method: "GET",
          url: `/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&scope=history&tab=${tab}`,
        });
        expect(historyTab.statusCode).toBe(200);
        expect(listCanonicalOrders).toHaveBeenCalledWith({
          filters: {
            ...(tab === "planned" ? { planned: true } : {}),
            ...(tab === "unplanned" ? { planned: false } : {}),
            routeOpsScope: "history",
            routeOpsTab: tab,
          },
          shopDomain: "tenant-a.example.test",
        });
      }

      for (const query of [
        "scope=everything",
        "tab=archived",
        "serviceType=BOGUS",
        "deliverySession=OVERNIGHT",
      ]) {
        const invalidScoped = await app.inject({
          headers: { cookie, accept: "application/json" },
          method: "GET",
          url: `/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&${query}`,
        });
        expect(invalidScoped.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  test("lets Route Ops admin sessions trigger the stored WooCommerce REST sync", async () => {
    const queuedSyncRun = {
      acceptedAt: "2026-05-24T00:00:00.000Z",
      completedAt: null,
      errorMessage: null,
      request: {
        modifiedAfter: null,
        pageSize: 50,
        status: null,
      },
      result: null,
      startedAt: null,
      status: "QUEUED" as const,
      syncRunId: "22222222-2222-4222-8222-222222222222",
    };
    const requestSync = vi.fn(() =>
      Promise.resolve({
        alreadyRunning: false,
        message: "Sync accepted. Processing is running in the background.",
        startBackgroundProcessing: true,
        syncRun: queuedSyncRun,
      }),
    );
    const processSyncRun = vi.fn(() =>
      Promise.resolve({
        ...queuedSyncRun,
        completedAt: "2026-05-24T00:00:02.000Z",
        result: {
          geocode: { failed: 0, notRequired: 0, pending: 0, resolved: 0 },
          pagesRead: 2,
          sync: {
            created: 3,
            needsReview: 1,
            readyToPlan: 2,
            received: 3,
            skipped: 0,
            unchanged: 0,
            updated: 0,
          },
          warnings: [
            "1 synced orders need delivery metadata review before routing.",
          ],
        },
        startedAt: "2026-05-24T00:00:01.000Z",
        status: "SUCCEEDED" as const,
      }),
    );
    const readLatestSyncRun = vi.fn(() => Promise.resolve(queuedSyncRun));
    const readSyncRun = vi.fn(() => Promise.resolve(queuedSyncRun));
    const syncSingleOrder = vi.fn(() =>
      Promise.resolve({
        orders: [
          canonicalOrder({
            name: "#11432",
            orderId: "order-11432",
            sourceOrderId: "11432",
            sourceOrderNumber: "11432",
          }),
        ],
        sync: {
          created: 0,
          needsReview: 0,
          readyToPlan: 1,
          received: 1,
          skipped: 0,
          unchanged: 0,
          updated: 1,
        },
      }),
    );
    const { app } = await createUiHarness({
      wooSyncService: {
        processSyncRun,
        readLatestSyncRun,
        readSyncRun,
        requestSync,
        syncSingleOrder,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/orders/sync?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, { pageSize: 50 }, csrfToken),
      });

      expect(response.statusCode).toBe(202);
      expect(response.body).not.toContain("startBackgroundProcessing");
      expect(
        readApiData<{
          alreadyRunning: boolean;
          message: string;
          syncRun: { status: string; syncRunId: string };
        }>(response),
      ).toEqual({
        alreadyRunning: false,
        message: "Sync accepted. Processing is running in the background.",
        syncRun: {
          ...queuedSyncRun,
        },
      });
      expect(requestSync).toHaveBeenCalledWith({
        payload: {
          modifiedAfter: null,
          pageSize: 50,
          status: null,
        },
        shopDomain: "tenant-a.example.test",
      });
      expect(processSyncRun).toHaveBeenCalledWith({
        shopDomain: "tenant-a.example.test",
        syncRunId: queuedSyncRun.syncRunId,
      });

      const latest = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders/sync/latest?shopDomain=tenant-a.example.test",
      });
      expect(latest.statusCode).toBe(200);
      expect(readApiData<{ syncRun: { syncRunId: string } }>(latest)).toEqual({
        syncRun: queuedSyncRun,
      });
      expect(readLatestSyncRun).toHaveBeenCalledWith({
        shopDomain: "tenant-a.example.test",
      });

      const singleOrderResponse = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/orders/woo/11432/sync?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });
      expect(singleOrderResponse.statusCode).toBe(200);
      const singleOrderData = readApiData<{
        order: { orderId: string; sourceOrderId: string | null } | null;
        sync: { received: number; updated: number };
      }>(singleOrderResponse);
      expect(singleOrderData.order?.orderId).toBe("order-11432");
      expect(singleOrderData.order?.sourceOrderId).toBe("11432");
      expect(singleOrderData.sync.received).toBe(1);
      expect(singleOrderData.sync.updated).toBe(1);
      expect(syncSingleOrder).toHaveBeenCalledWith({
        shopDomain: "tenant-a.example.test",
        sourceOrderId: "11432",
      });
    } finally {
      await app.close();
    }
  });

  test("persists Route Ops route-scope settings through the Settings API", async () => {
    const baseConfig = defaultRouteScopeConfig();
    const routeScopeConfig = {
      ...baseConfig,
      deliverySessions: [
        ...baseConfig.deliverySessions,
        {
          builtIn: false,
          description: "Morning deliveries",
          enabled: true,
          example: "MORNING",
          label: "Morning",
          value: "MORNING",
        },
      ],
      serviceTypes: [
        ...baseConfig.serviceTypes,
        {
          builtIn: false,
          description: "Morning delivery route",
          enabled: true,
          example: "MORNING_DELIVERY",
          label: "Morning delivery",
          value: "MORNING_DELIVERY",
        },
      ],
    };
    const saveSettings = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["settingsService"]
        >["saveSettings"]
      >
    >((input) => Promise.resolve(storeSettings(input)));
    const { app } = await createUiHarness({
      settingsService: {
        getSettings: vi.fn(() => Promise.resolve(storeSettings())),
        saveSettings,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/settings?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            defaultDepotAddress: "123 Depot St, Toronto, ON",
            defaultDepotLatitude: 43.6532,
            defaultDepotLongitude: -79.3832,
            locale: "en-CA",
            routeScopeConfig,
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(200);
      expect(
        readApiData<{
          settings: {
            routeScopeConfig: { serviceTypes: Array<{ value: string }> };
          };
        }>(response).settings.routeScopeConfig.serviceTypes,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "MORNING_DELIVERY" }),
        ]),
      );
      const savedInput = saveSettings.mock.calls[0]?.[0];
      expect(savedInput?.routeScopeConfig?.version).toBe(1);
    } finally {
      await app.close();
    }
  });

  test("persists valid phase-one Route Ops UI settings", async () => {
    const saveSettings = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["settingsService"]
        >["saveSettings"]
      >
    >((input) => Promise.resolve(storeSettings(input)));
    const { app } = await createUiHarness({
      settingsService: {
        getSettings: vi.fn(() => Promise.resolve(storeSettings())),
        saveSettings,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/settings?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            defaultDepotAddress: "123 Depot St, Toronto, ON",
            defaultDepotLatitude: 43.6532,
            defaultDepotLongitude: -79.3832,
            locale: "en-CA",
            routeOpsUiSettings: {
              destinationDwellMinutes: 12,
              emailNotifications: {
                enabled: true,
                reminderPlans: [
                  { daysBefore: 1, id: "plan-1", timeOfDay: "09:30" },
                ],
                template: {
                  body: "Hi {{customerName}}, delivery is {{deliveryDate}}.",
                  subject: "Order {{orderNumber}} delivery",
                },
              },
              version: 1,
            },
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(200);
      const payload = readApiData<{
        settings: { routeOpsUiSettings: { destinationDwellMinutes: number } };
      }>(response);
      expect(payload.settings.routeOpsUiSettings.destinationDwellMinutes).toBe(
        12,
      );
      expect(saveSettings.mock.calls[0]?.[0].routeOpsUiSettings).toEqual(
        expect.objectContaining({ destinationDwellMinutes: 12 }),
      );
      expect(saveSettings.mock.calls[0]?.[0]).not.toHaveProperty(
        "customerEmailProvider",
      );
    } finally {
      await app.close();
    }
  });

  test("rejects invalid phase-one Route Ops UI settings before persistence", async () => {
    const saveSettings = vi.fn();
    const { app } = await createUiHarness({
      settingsService: {
        getSettings: vi.fn(() => Promise.resolve(storeSettings())),
        saveSettings,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      for (const routeOpsUiSettings of [
        {
          ...defaultRouteOpsUiSettings(),
          destinationDwellMinutes: 241,
        },
        {
          ...defaultRouteOpsUiSettings(),
          emailNotifications: {
            ...defaultRouteOpsUiSettings().emailNotifications,
            reminderPlans: [
              { daysBefore: 1, id: "a", timeOfDay: "09:00" },
              { daysBefore: 1, id: "b", timeOfDay: "09:00" },
            ],
          },
        },
        {
          ...defaultRouteOpsUiSettings(),
          emailNotifications: {
            ...defaultRouteOpsUiSettings().emailNotifications,
            template: { body: "Bad {{unknownToken}}", subject: "Subject" },
          },
        },
      ]) {
        const response = await app.inject({
          method: "PATCH",
          url: "/admin/ui/app/api/settings?shopDomain=tenant-a.example.test",
          ...authenticatedJsonRequest(
            cookie,
            {
              defaultDepotAddress: "123 Depot St, Toronto, ON",
              defaultDepotLatitude: 43.6532,
              defaultDepotLongitude: -79.3832,
              locale: "en-CA",
              routeOpsUiSettings,
            },
            csrfToken,
          ),
        });

        expect(response.statusCode).toBe(400);
      }
      expect(saveSettings).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("omits routeScopeConfig from Settings saves when the frontend does not send it", async () => {
    const saveSettings = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["settingsService"]
        >["saveSettings"]
      >
    >((input) => Promise.resolve(storeSettings(input)));
    const { app } = await createUiHarness({
      settingsService: {
        getSettings: vi.fn(() => Promise.resolve(storeSettings())),
        saveSettings,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/settings?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            defaultDepotAddress: "123 Depot St, Toronto, ON",
            defaultDepotLatitude: 43.6532,
            defaultDepotLongitude: -79.3832,
            locale: "en-CA",
            routeOpsUiSettings: defaultRouteOpsUiSettings(),
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(200);
      expect(saveSettings.mock.calls[0]?.[0]).not.toHaveProperty(
        "routeScopeConfig",
      );
    } finally {
      await app.close();
    }
  });

  test("returns default route-scope settings when no Settings row exists", async () => {
    const { app } = await createUiHarness({
      settingsService: {
        getSettings: vi.fn(() => Promise.resolve(null)),
        saveSettings: vi.fn(),
      },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/settings?shopDomain=tenant-a.example.test",
      });

      expect(response.statusCode).toBe(200);
      const payload = readApiData<{
        settings: {
          routeScopeConfig: {
            deliverySessions: Array<{ value: string }>;
            serviceTypes: Array<{ value: string }>;
          };
          shopDomain: string;
        };
      }>(response);
      expect(payload.settings.shopDomain).toBe("tenant-a.example.test");
      expect(payload.settings.routeScopeConfig.serviceTypes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "DELIVERY" }),
        ]),
      );
      expect(payload.settings.routeScopeConfig.deliverySessions).toEqual(
        expect.arrayContaining([expect.objectContaining({ value: "EVENING" })]),
      );
    } finally {
      await app.close();
    }
  });

  test("rejects route-scope Settings saves that disable built-ins before partial save", async () => {
    const baseConfig = defaultRouteScopeConfig();
    const firstServiceType = baseConfig.serviceTypes[0];
    if (firstServiceType === undefined)
      throw new Error("missing built-in service type");
    const saveSettings = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["settingsService"]
        >["saveSettings"]
      >
    >((input) => Promise.resolve(storeSettings(input)));
    const { app } = await createUiHarness({
      settingsService: {
        getSettings: vi.fn(() => Promise.resolve(storeSettings())),
        saveSettings,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/settings?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            defaultDepotAddress: "123 Depot St, Toronto, ON",
            defaultDepotLatitude: 43.6532,
            defaultDepotLongitude: -79.3832,
            locale: "en-CA",
            routeScopeConfig: {
              ...baseConfig,
              serviceTypes: [
                { ...firstServiceType, enabled: false },
                ...baseConfig.serviceTypes.slice(1),
              ],
            },
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as ApiErrorEnvelope;
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(saveSettings).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("returns protected Route Builder API state with ready and review order buckets", async () => {
    const listCanonicalOrders = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderSyncService"]
      >["listCanonicalOrders"]
    >((input) => {
      if (input.filters?.readiness === "READY_TO_PLAN")
        return Promise.resolve([canonicalOrder()]);
      if (input.filters?.readiness === "NEEDS_REVIEW")
        return Promise.resolve([
          canonicalOrder({
            readiness: "NEEDS_REVIEW",
            reviewReasons: ["missing_delivery_date"],
          }),
        ]);
      return Promise.resolve([]);
    });
    const listRoutePlans = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["listRoutePlans"]
    >(() =>
      Promise.resolve([
        routePlanSummary(),
        {
          ...routePlanSummary(),
          deliveryDate: "2026-05-27",
          id: "other-route-plan-id",
          name: "Other day route",
          planDate: "2026-05-27",
        },
      ]),
    );
    const { app } = await createUiHarness({
      orderSyncService: { listCanonicalOrders },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail: vi.fn(),
        listRoutePlans,
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const routes = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/routes?shopDomain=tenant-a.example.test&deliveryDate=2026-05-26",
      });
      const orders = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test&deliveryDate=2026-05-26",
      });

      expect(routes.statusCode).toBe(200);
      expect(
        readApiData<{ routePlans: Array<{ name: string }> }>(
          routes,
        ).routePlans.map((routePlan) => routePlan.name),
      ).toEqual(["Route draft"]);
      expect(orders.statusCode).toBe(200);
      expect(
        readApiData<{
          orders: unknown[];
          reviewBlockers: Array<{ blockerReasons: string[] }>;
        }>(orders).reviewBlockers[0]?.blockerReasons,
      ).toContain("missing_delivery_date");
      expect(listRoutePlans).toHaveBeenCalledWith({
        deliveryDate: "2026-05-26",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("patches Route Ops canonical metadata and saves geocoded coordinates through protected APIs", async () => {
    const patchedOrder = canonicalOrder({
      deliveryArea: "Mississauga",
      deliveryDate: "2026-05-28",
      deliverySession: "EVENING",
      routeScopeKey: "2026-05-28|EVENING_DELIVERY|17:00|21:00",
      serviceType: "EVENING_DELIVERY",
      timeWindowEnd: "21:00",
      timeWindowStart: "17:00",
    });
    const geocodedOrder = canonicalOrder({
      latitude: 43.589045,
      longitude: -79.644119,
    });
    const patchCanonicalOrder = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["orderSyncService"]
        >["patchCanonicalOrder"]
      >
    >(() => Promise.resolve(patchedOrder));
    const patchCanonicalOrderCoordinates = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["orderSyncService"]
        >["patchCanonicalOrderCoordinates"]
      >
    >(() => Promise.resolve(geocodedOrder));
    const geocode = vi.fn(() =>
      Promise.resolve({
        attemptCount: 2,
        cached: false,
        ok: true as const,
        queryShapes: ["structured_without_unit" as const],
        result: {
          addressLabel: "100 King St W, Toronto, ON, M5H 1J9, CA",
          latitude: 43.589045,
          longitude: -79.644119,
          provider: "mock",
          providerPlaceId: "place-1",
          rawLabel: "Mock place",
        },
      }),
    );
    const { app } = await createUiHarness({
      geocodingService: {
        geocode,
        status: { mode: "nominatim_compatible", persistentCacheEnabled: true },
      },
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([canonicalOrder()])),
        patchCanonicalOrder,
        patchCanonicalOrderCoordinates,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const metadataResponse = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/orders/order-1/metadata?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            deliveryArea: "Mississauga",
            deliveryDate: "2026-05-28",
            deliverySession: "EVENING",
            serviceType: "EVENING_DELIVERY",
            timeWindowEnd: "21:00",
            timeWindowStart: "17:00",
          },
          csrfToken,
        ),
      });
      expect(metadataResponse.statusCode).toBe(200);
      expect(
        readApiData<{ order: { deliveryArea: string; deliveryDate: string } }>(
          metadataResponse,
        ).order,
      ).toEqual(
        expect.objectContaining({
          deliveryArea: "Mississauga",
          deliveryDate: "2026-05-28",
        }),
      );
      expect(patchCanonicalOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "web-operator",
          orderId: "order-1",
          shopDomain: "tenant-a.example.test",
        }),
      );

      patchCanonicalOrder.mockClear();
      const historyMetadataResponse = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/orders/order-1/metadata?shopDomain=tenant-a.example.test&scope=history",
        ...authenticatedJsonRequest(
          cookie,
          { deliveryDate: "2026-05-28" },
          csrfToken,
        ),
      });
      expect(historyMetadataResponse.statusCode).toBe(200);
      expect(patchCanonicalOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "web-operator",
          orderId: "order-1",
          shopDomain: "tenant-a.example.test",
        }),
      );

      const geocodeResponse = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/orders/order-1/geocode?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, { save: true }, csrfToken),
      });
      expect(geocodeResponse.statusCode).toBe(200);
      expect(
        readApiData<{
          order: { coordinates: { latitude: number; longitude: number } };
        }>(geocodeResponse).order.coordinates,
      ).toEqual({
        latitude: 43.589045,
        longitude: -79.644119,
      });
      expect(geocode).toHaveBeenCalledWith(
        expect.objectContaining({ shopDomain: "tenant-a.example.test" }),
      );
      expect(patchCanonicalOrderCoordinates).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "web-operator",
          latitude: 43.589045,
          longitude: -79.644119,
          provider: "mock",
          source: "geocoder",
        }),
      );
    } finally {
      await app.close();
    }
  });

  test("bulk geocodes only current-view orders missing coordinates", async () => {
    const geocodedOrder = canonicalOrder({
      geocodeStatus: "RESOLVED",
      hasCoordinates: true,
      latitude: 43.589045,
      longitude: -79.644119,
      orderId: "order-missing",
      shopifyOrderGid: "gid://woocommerce/Order/missing",
    });
    const listCanonicalOrders = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderSyncService"]
      >["listCanonicalOrders"]
    >(() =>
      Promise.resolve([
        canonicalOrder({
          geocodeStatus: "PENDING",
          hasCoordinates: false,
          latitude: null,
          longitude: null,
          orderId: "order-missing",
          reviewReasons: ["missing_coordinates"],
          shopifyOrderGid: "gid://woocommerce/Order/missing",
        }),
        canonicalOrder({
          orderId: "order-resolved",
          shopifyOrderGid: "gid://woocommerce/Order/resolved",
        }),
      ]),
    );
    const patchCanonicalOrderCoordinates = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["orderSyncService"]
        >["patchCanonicalOrderCoordinates"]
      >
    >(() => Promise.resolve(geocodedOrder));
    const geocode = vi.fn(() =>
      Promise.resolve({
        attemptCount: 2,
        cached: false,
        ok: true as const,
        queryShapes: ["structured_without_unit" as const],
        result: {
          addressLabel: "100 King St W, Toronto, ON, M5H 1J9, CA",
          latitude: 43.589045,
          longitude: -79.644119,
          provider: "mock",
          providerPlaceId: "place-1",
          rawLabel: "Mock place",
        },
      }),
    );
    const { app } = await createUiHarness({
      geocodingService: {
        geocode,
        status: { mode: "nominatim_compatible", persistentCacheEnabled: true },
      },
      orderSyncService: {
        listCanonicalOrders,
        patchCanonicalOrderCoordinates,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/orders/bulk-geocode?shopDomain=tenant-a.example.test&deliveryDate=2026-05-28&deliveryArea=Toronto&status=unplanned&search=%231001",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(response.statusCode).toBe(202);
      const accepted = readApiData<{ jobId: string; status: string }>(response);
      expect(accepted).toEqual(
        expect.objectContaining({
          jobId: expect.any(String) as string,
          status: expect.stringMatching(
            /accepted|running|completed/u,
          ) as string,
        }),
      );

      type BulkGeocodeStatus = {
        status: string;
        summary: {
          alreadyHasCoordinates: number;
          attempted: number;
          failed: number;
          matched: number;
          noAddress: number;
          resolved: number;
        };
      };
      let completed: BulkGeocodeStatus | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const statusResponse = await app.inject({
          headers: { cookie, accept: "application/json" },
          method: "GET",
          url: `/admin/ui/app/api/orders/bulk-geocode/${accepted.jobId}?shopDomain=tenant-a.example.test`,
        });
        expect(statusResponse.statusCode).toBe(200);
        const geocode = readApiData<BulkGeocodeStatus>(statusResponse);
        if (geocode.status === "completed") {
          completed = geocode;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(completed).toEqual(
        expect.objectContaining({
          status: "completed",
        }),
      );
      expect(completed?.summary).toEqual(
        expect.objectContaining({
          alreadyHasCoordinates: 1,
          attempted: 1,
          failed: 0,
          matched: 2,
          noAddress: 0,
          resolved: 1,
        }),
      );
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: {
          deliveryArea: "Toronto",
          deliveryDate: "2026-05-28",
          planned: false,
          search: "#1001",
        },
        shopDomain: "tenant-a.example.test",
      });
      expect(geocode).toHaveBeenCalledTimes(1);
      expect(patchCanonicalOrderCoordinates).toHaveBeenCalledTimes(1);
      expect(patchCanonicalOrderCoordinates).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "web-operator",
          geocodeDiagnostic: {
            diagnostic: expect.objectContaining({
              attemptCount: 2,
              code: "RESOLVED",
              ok: true,
              provider: "mock",
              providerPlaceId: "place-1",
              queryShapes: ["structured_without_unit"],
              source: "bulk_geocode",
            }) as unknown,
            source: "bulk_geocode",
          },
          latitude: 43.589045,
          longitude: -79.644119,
          orderId: "order-missing",
          provider: "mock",
          shopDomain: "tenant-a.example.test",
          source: "geocoder",
        }),
      );
      expect(
        JSON.stringify(patchCanonicalOrderCoordinates.mock.calls),
      ).not.toContain("Mock place");
    } finally {
      await app.close();
    }
  });

  test("accepts bulk geocode mutations in history scope", async () => {
    const listCanonicalOrders = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderSyncService"]
      >["listCanonicalOrders"]
    >(() => Promise.resolve([]));
    const { app } = await createUiHarness({
      geocodingService: {
        geocode: vi.fn(),
        status: { mode: "nominatim_compatible", persistentCacheEnabled: true },
      },
      orderSyncService: {
        listCanonicalOrders,
        patchCanonicalOrderCoordinates: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/orders/geocode?shopDomain=tenant-a.example.test&scope=history&tab=all",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(response.statusCode).toBe(202);
      expect(
        readApiData<{ geocode: { status: string } }>(response).geocode.status,
      ).toMatch(/^(accepted|running)$/u);
    } finally {
      await app.close();
    }
  });

  test("bulk geocode persists redacted failure diagnostics", async () => {
    const listCanonicalOrders = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderSyncService"]
      >["listCanonicalOrders"]
    >(() =>
      Promise.resolve([
        canonicalOrder({
          geocodeStatus: "PENDING",
          hasCoordinates: false,
          latitude: null,
          longitude: null,
          orderId: "order-missing",
          reviewReasons: ["missing_coordinates"],
        }),
      ]),
    );
    const patchCanonicalOrderCoordinates = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["orderSyncService"]
        >["patchCanonicalOrderCoordinates"]
      >
    >(() => Promise.resolve(null));
    const patchCanonicalOrderGeocodeDiagnostics = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["orderSyncService"]
        >["patchCanonicalOrderGeocodeDiagnostics"]
      >
    >(() => Promise.resolve(canonicalOrder({ geocodeStatus: "FAILED" })));
    const geocode = vi.fn(() =>
      Promise.resolve({
        attemptCount: 1,
        code: "GEOCODER_NO_RESULT" as const,
        message: "No geocoding result was found.",
        ok: false as const,
        queryShapes: ["structured_without_unit" as const],
      }),
    );
    const { app } = await createUiHarness({
      geocodingService: {
        geocode,
        status: { mode: "nominatim_compatible", persistentCacheEnabled: true },
      },
      orderSyncService: {
        listCanonicalOrders,
        patchCanonicalOrderCoordinates,
        patchCanonicalOrderGeocodeDiagnostics,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/orders/bulk-geocode?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });
      expect(response.statusCode).toBe(202);
      const accepted = readApiData<{ jobId: string }>(response);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const statusResponse = await app.inject({
          headers: { cookie, accept: "application/json" },
          method: "GET",
          url: `/admin/ui/app/api/orders/bulk-geocode/${accepted.jobId}?shopDomain=tenant-a.example.test`,
        });
        if (
          readApiData<{ status: string }>(statusResponse).status === "completed"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const diagnosticPatch =
        patchCanonicalOrderGeocodeDiagnostics.mock.calls[0]?.[0];
      expect(diagnosticPatch).toEqual(
        expect.objectContaining({
          geocodeStatus: "FAILED",
          orderId: "order-missing",
          source: "bulk_geocode",
        }),
      );
      expect(diagnosticPatch?.diagnostic).toEqual(
        expect.objectContaining({
          attemptCount: 1,
          code: "GEOCODER_NO_RESULT",
          ok: false,
          queryShapes: ["structured_without_unit"],
        }),
      );
      expect(JSON.stringify(diagnosticPatch)).not.toContain("Mock place");
    } finally {
      await app.close();
    }
  });

  test("public bulk geocode attempts every missing-coordinate order", async () => {
    const listCanonicalOrders = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderSyncService"]
      >["listCanonicalOrders"]
    >(() =>
      Promise.resolve([
        canonicalOrder({
          hasCoordinates: false,
          latitude: null,
          longitude: null,
          orderId: "order-a",
        }),
        canonicalOrder({
          hasCoordinates: false,
          latitude: null,
          longitude: null,
          orderId: "order-b",
        }),
      ]),
    );
    const patchCanonicalOrderCoordinates = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["orderSyncService"]
        >["patchCanonicalOrderCoordinates"]
      >
    >(() => Promise.resolve(canonicalOrder({ orderId: "order-a" })));
    const geocode = vi.fn(() =>
      Promise.resolve({
        cached: false,
        ok: true as const,
        result: {
          addressLabel: "structured_without_unit",
          latitude: 43.589045,
          longitude: -79.644119,
          provider: "mock",
          providerPlaceId: "place-1",
          rawLabel: null,
        },
      }),
    );
    const { app } = await createUiHarness({
      geocodingService: {
        geocode,
        status: {
          mode: "nominatim_compatible",
          persistentCacheEnabled: true,
          providerPolicy: "public_nominatim",
        },
      },
      orderSyncService: {
        listCanonicalOrders,
        patchCanonicalOrderCoordinates,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/orders/bulk-geocode?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });
      const accepted = readApiData<{ jobId: string }>(response);
      type BulkGeocodeJobBody = {
        counts: {
          attempted: number;
          failed: number;
          matched: number;
          succeeded: number;
        };
        status: string;
      };
      let completed: BulkGeocodeJobBody | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const statusResponse = await app.inject({
          headers: { cookie, accept: "application/json" },
          method: "GET",
          url: `/admin/ui/app/api/orders/geocode/${accepted.jobId}?shopDomain=tenant-a.example.test`,
        });
        const body = readApiData<{ geocode: BulkGeocodeJobBody }>(
          statusResponse,
        ).geocode;
        if (body?.status === "completed") {
          completed = body;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(geocode).toHaveBeenCalledTimes(2);
      expect(completed?.counts).toEqual(
        expect.objectContaining({
          attempted: 2,
          failed: 0,
          matched: 2,
          succeeded: 2,
        }),
      );
      expect(completed).not.toHaveProperty("policyLimit");
    } finally {
      await app.close();
    }
  });

  test("accepts configured custom route-scope values for manual metadata repair", async () => {
    const baseConfig = defaultRouteScopeConfig();
    const routeScopeConfig = {
      ...baseConfig,
      deliverySessions: [
        ...baseConfig.deliverySessions,
        {
          builtIn: false,
          description: "Morning deliveries",
          enabled: true,
          example: "MORNING",
          label: "Morning",
          value: "MORNING",
        },
      ],
      serviceTypes: [
        ...baseConfig.serviceTypes,
        {
          builtIn: false,
          description: "Morning delivery route",
          enabled: true,
          example: "MORNING_DELIVERY",
          label: "Morning delivery",
          value: "MORNING_DELIVERY",
        },
      ],
    };
    const patchCanonicalOrder = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["orderSyncService"]
        >["patchCanonicalOrder"]
      >
    >(() =>
      Promise.resolve(
        canonicalOrder({
          deliverySession: "MORNING",
          routeScopeKey: "2026-05-28|MORNING_DELIVERY|08:00|12:00",
          serviceType: "MORNING_DELIVERY",
        }),
      ),
    );
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([canonicalOrder()])),
        patchCanonicalOrder,
      },
      settingsService: {
        getSettings: vi.fn(() =>
          Promise.resolve(storeSettings({ routeScopeConfig })),
        ),
        saveSettings: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/orders/order-1/metadata?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            deliverySession: "MORNING",
            serviceType: "MORNING_DELIVERY",
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(200);
      const patchedInput = patchCanonicalOrder.mock.calls[0]?.[0];
      expect(patchedInput?.patch.deliverySession).toBe("MORNING");
      expect(patchedInput?.patch.serviceType).toBe("MORNING_DELIVERY");
    } finally {
      await app.close();
    }
  });

  test.each([
    {
      label: "unconfigured",
      routeScopeConfig: defaultRouteScopeConfig(),
    },
    {
      label: "disabled",
      routeScopeConfig: (() => {
        const baseConfig = defaultRouteScopeConfig();
        return {
          ...baseConfig,
          deliverySessions: [
            ...baseConfig.deliverySessions,
            {
              builtIn: false,
              description: "Morning deliveries",
              enabled: false,
              example: "MORNING",
              label: "Morning",
              value: "MORNING",
            },
          ],
          serviceTypes: [
            ...baseConfig.serviceTypes,
            {
              builtIn: false,
              description: "Morning delivery route",
              enabled: false,
              example: "MORNING_DELIVERY",
              label: "Morning delivery",
              value: "MORNING_DELIVERY",
            },
          ],
        };
      })(),
    },
  ])(
    "rejects $label route-scope values for manual metadata repair",
    async ({ routeScopeConfig }) => {
      const patchCanonicalOrder = vi.fn<
        NonNullable<
          NonNullable<
            AdminCommerceConnectionsUiDependencies["orderSyncService"]
          >["patchCanonicalOrder"]
        >
      >(() => Promise.resolve(canonicalOrder()));
      const { app } = await createUiHarness({
        orderSyncService: {
          listCanonicalOrders: vi.fn(() => Promise.resolve([canonicalOrder()])),
          patchCanonicalOrder,
        },
        settingsService: {
          getSettings: vi.fn(() =>
            Promise.resolve(storeSettings({ routeScopeConfig })),
          ),
          saveSettings: vi.fn(),
        },
      });

      try {
        const { cookie, csrfToken } = await loginAndReadCsrf(app);
        const response = await app.inject({
          method: "PATCH",
          url: "/admin/ui/app/api/orders/order-1/metadata?shopDomain=tenant-a.example.test",
          ...authenticatedJsonRequest(
            cookie,
            {
              deliverySession: "MORNING",
              serviceType: "MORNING_DELIVERY",
            },
            csrfToken,
          ),
        });

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body) as ApiErrorEnvelope;
        expect(body.error.message).toContain("not enabled in Settings");
        expect(patchCanonicalOrder).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  test("marks missing delivery area as unresolved metadata while keeping coordinates operational", async () => {
    const order = canonicalOrder({
      deliveryArea: null,
      metadataResolved: false,
      readiness: "NEEDS_REVIEW",
      reviewReasons: ["missing_delivery_area"],
      routeEligible: false,
    });
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([order])),
      },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { accept: "application/json", cookie },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test",
      });

      expect(response.statusCode).toBe(200);
      const data = readApiData<{
        orders: Array<{
          blockerReasons: string[];
          metadataResolved: boolean;
          routeEligible: boolean;
        }>;
      }>(response);
      expect(data.orders[0]).toEqual(
        expect.objectContaining({
          blockerReasons: expect.arrayContaining([
            "missing_delivery_area",
          ]) as unknown,
          metadataResolved: false,
          routeEligible: false,
        }),
      );
    } finally {
      await app.close();
    }
  });

  test("marks ambiguous delivery time windows as unresolved metadata in Route Ops DTO fallback", async () => {
    const order = canonicalOrder({
      readiness: "NEEDS_REVIEW",
      reviewReasons: ["ambiguous_delivery_time_window"],
      routeEligible: false,
    });
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([order])),
      },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { accept: "application/json", cookie },
        method: "GET",
        url: "/admin/ui/app/api/orders?shopDomain=tenant-a.example.test",
      });

      expect(response.statusCode).toBe(200);
      const data = readApiData<{
        orders: Array<{
          blockerReasons: string[];
          metadataResolved: boolean;
          routeEligible: boolean;
        }>;
      }>(response);
      expect(data.orders[0]).toEqual(
        expect.objectContaining({
          blockerReasons: expect.arrayContaining([
            "ambiguous_delivery_time_window",
          ]) as unknown,
          metadataResolved: false,
          routeEligible: false,
        }),
      );
    } finally {
      await app.close();
    }
  });

  test("returns redacted Route Ops order metadata diagnostics without raw payload", async () => {
    const diagnosticsOrder = canonicalOrder({
      deliveryMetadataDiagnostics: {
        candidates: [
          {
            parseStatus: "PARSED",
            path: "shipping_lines[0].method_title",
            source: "shipping_label",
            trust: "low",
            valuePreview: "Thursday Delivery",
            weekday: "THURSDAY",
          },
        ],
        conflictTimeWindows: [],
        conflictWeekdays: [],
        current: {
          deliveryDate: "2026-05-28",
          deliveryDateWeekday: "THURSDAY",
          deliveryDayParseStatus: "PARSED",
          deliveryWeekday: "THURSDAY",
          rawDeliveryDatePreview: null,
          rawDeliveryDayPreview: "Thursday Delivery",
          rawDeliveryTimeWindowPreview: null,
          reviewReasons: [],
          routeScopeKey: "2026-05-28|DELIVERY||",
          serviceType: "DELIVERY",
          timeWindowEnd: null,
          timeWindowStart: null,
        },
        matchedMappingPaths: { deliveryDay: "shipping_lines[0].method_title" },
        status: "RESOLVED",
        unsupportedValueCounts: { object: 1 },
      },
      metadataResolved: true,
      routeEligible: true,
    });
    const listCanonicalOrders = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["orderSyncService"]
      >["listCanonicalOrders"]
    >(() => Promise.resolve([diagnosticsOrder]));
    const { app } = await createUiHarness({
      orderSyncService: { listCanonicalOrders },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { accept: "application/json", cookie },
        method: "GET",
        url: "/admin/ui/app/api/orders/order-1/metadata-diagnostics?shopDomain=tenant-a.example.test",
      });

      expect(response.statusCode).toBe(200);
      const data = readApiData<{
        diagnostics: unknown;
        order: { metadataResolved: boolean; routeEligible: boolean };
      }>(response);
      expect(data.order).toEqual(
        expect.objectContaining({
          metadataResolved: true,
          routeEligible: true,
        }),
      );
      expect(data.diagnostics).toEqual(
        expect.objectContaining({
          candidates: [
            expect.objectContaining({
              path: "shipping_lines[0].method_title",
              valuePreview: "Thursday Delivery",
            }),
          ],
          matchedMappingPaths: {
            deliveryDay: "shipping_lines[0].method_title",
          },
          status: "RESOLVED",
        }),
      );
      expect(response.body).toContain("rawDeliveryDayPreview");
      expect(response.body).not.toContain('"rawDeliveryDay":');
      expect(response.body).not.toContain('"rawDeliveryDate":');
      expect(response.body).not.toContain('"rawDeliveryTimeWindow":');
      expect(response.body).not.toContain("\"rawPayload\":");
      expect(response.body).not.toContain("customer@example.test");
      expect(response.body).not.toContain("consumer_secret");
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("geocodes Route Ops settings depot coordinates as draft without saving", async () => {
    const geocode = vi.fn(() =>
      Promise.resolve({
        cached: false,
        ok: true as const,
        result: {
          addressLabel: "300 City Centre Dr, Mississauga, ON, L5B 3C1, CA",
          latitude: 43.589045,
          longitude: -79.644119,
          provider: "mock",
          providerPlaceId: "place-1",
          rawLabel: "Mock depot",
        },
      }),
    );
    const saveSettings = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["settingsService"]
        >["saveSettings"]
      >
    >(() =>
      Promise.resolve(
        storeSettings({
          defaultDepotAddress: "300 City Centre Dr, Mississauga, ON",
          defaultDepotLatitude: 43.589045,
          defaultDepotLongitude: -79.644119,
          locale: "ko-KR",
        }),
      ),
    );
    const { app } = await createUiHarness({
      geocodingService: {
        geocode,
        status: { mode: "nominatim_compatible", persistentCacheEnabled: true },
      },
      settingsService: {
        getSettings: vi.fn(() => Promise.resolve(storeSettings())),
        saveSettings,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/settings/geocode?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            defaultDepotAddress: "300 City Centre Dr, Mississauga, ON",
            locale: "ko-KR",
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(200);
      const payload = readApiData<{
        geocode: {
          cached: boolean;
          result: { latitude: number; longitude: number };
        };
        settings: { defaultDepotLatitude: number; locale: string };
      }>(response);
      expect(payload.geocode.cached).toBe(false);
      expect(payload.geocode.result).toEqual(
        expect.objectContaining({ latitude: 43.589045, longitude: -79.644119 }),
      );
      expect(payload.settings).toEqual(
        expect.objectContaining({
          defaultDepotLatitude: 43.6532,
          locale: "en-CA",
        }),
      );
      expect(geocode).toHaveBeenCalledWith(
        expect.objectContaining({ shopDomain: "tenant-a.example.test" }),
      );
      expect(saveSettings).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("reuses remembered Route Ops settings depot coordinates without calling the geocoder", async () => {
    const geocode = vi.fn();
    const saveSettings = vi.fn();
    const { app } = await createUiHarness({
      geocodingService: {
        geocode,
        status: { mode: "nominatim_compatible", persistentCacheEnabled: true },
      },
      settingsService: {
        getSettings: vi.fn(() =>
          Promise.resolve(
            storeSettings({
              defaultDepotAddress: " 123 Depot St, Toronto, ON ",
              defaultDepotLatitude: 43.6532,
              defaultDepotLongitude: -79.3832,
              locale: "en-CA",
            }),
          ),
        ),
        saveSettings,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/settings/geocode?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          { defaultDepotAddress: "123 Depot St, Toronto, ON", locale: "en-CA" },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(200);
      const payload = readApiData<{
        geocode: { cached: boolean; result: { provider: string } };
        settings: { defaultDepotLatitude: number };
      }>(response);
      expect(payload.geocode.cached).toBe(true);
      expect(payload.geocode.result.provider).toBe("store_settings");
      expect(payload.settings.defaultDepotLatitude).toBe(43.6532);
      expect(geocode).not.toHaveBeenCalled();
      expect(saveSettings).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("returns route detail through the Route Ops API using neutral stop field names", async () => {
    const detail = {
      ...routePlanDetail(),
      routeGeometry: {
        coordinates: [
          [-79.3832, 43.6532],
          [-79.4, 43.7],
        ] as [number, number][],
        type: "LineString" as const,
      },
      routeStopPoints: [
        {
          deliveryStopId: "stop-1",
          inputCoordinates: [-79.3832, 43.6532] as [number, number],
          name: "Road snap",
          sequence: 1,
          shopifyOrderGid: "gid://woocommerce/Order/1001",
          snapDistanceMeters: 5.5,
          snappedCoordinates: [-79.3833, 43.6533] as [number, number],
        },
      ],
    };
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() => Promise.resolve(detail));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/routes/route-plan-id?shopDomain=tenant-a.example.test",
      });

      expect(response.statusCode).toBe(200);
      const detailData = readApiData<{
        routeGeometry: { coordinates: [number, number][]; type: string } | null;
        routePlan: { id: string; name: string };
        routeStopPoints: Array<{
          deliveryStopId: string;
          sourceOrderId: string;
        }>;
        stops: Array<{
          deliveryStopId: string;
          orderName: string;
          sourceOrderId: string;
        }>;
      }>(response);
      expect(detailData.routePlan).toEqual(
        expect.objectContaining({ id: "route-plan-id", name: "Route draft" }),
      );
      expect(detailData.routeGeometry).toEqual({
        coordinates: [
          [-79.3832, 43.6532],
          [-79.4, 43.7],
        ] as [number, number][],
        type: "LineString",
      });
      expect(detailData.routeStopPoints[0]).toEqual(
        expect.objectContaining({
          deliveryStopId: "stop-1",
          sourceOrderId: "gid://woocommerce/Order/1001",
        }),
      );
      expect(detailData.stops[0]).toEqual(
        expect.objectContaining({
          deliveryStopId: "stop-1",
          orderName: "#1001",
          sourceOrderId: "gid://woocommerce/Order/1001",
        }),
      );
      expect(JSON.stringify(detailData.stops[0])).not.toContain(
        "shopifyOrderGid",
      );
      expect(JSON.stringify(detailData.routeStopPoints[0])).not.toContain(
        "shopifyOrderGid",
      );
      expect(getRoutePlanDetail).toHaveBeenCalledWith({
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("returns route stops for published route details even when road geometry is null", async () => {
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() =>
      Promise.resolve({
        ...routePlanDetail(),
        routeGeometry: null,
        routeMetrics: null,
        routePlan: {
          ...routePlanSummary(),
          driverId: "driver-id",
          planDate: "2026-05-21",
          status: "ASSIGNED",
        },
        routeStopPoints: [],
      }),
    );
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/routes/route-plan-id?shopDomain=tenant-a.example.test",
      });

      expect(response.statusCode, response.body).toBe(200);
      const detailData = readApiData<{
        routeGeometry: null;
        routePlan: { driverId: string; planDate: string; status: string };
        routeStopPoints: unknown[];
        stops: Array<{ deliveryStopId: string; orderName: string }>;
      }>(response);
      expect(detailData.routeGeometry).toBeNull();
      expect(detailData.routeStopPoints).toEqual([]);
      expect(detailData.stops).toEqual([
        expect.objectContaining({
          deliveryStopId: "stop-1",
          orderName: "#1001",
        }),
        expect.objectContaining({
          deliveryStopId: "stop-2",
          orderName: "#1002",
        }),
      ]);
      expect(detailData.routePlan).toEqual(
        expect.objectContaining({
          driverId: "driver-id",
          planDate: "2026-05-21",
          status: "ASSIGNED",
        }),
      );
      expect(getRoutePlanDetail).toHaveBeenCalledWith({
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("deletes a route through the protected Route Ops API for the current shop", async () => {
    const deleteRoutePlan = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["routePlanService"]
        >["deleteRoutePlan"]
      >
    >(() => Promise.resolve({ deleted: true, routePlanId: "route-plan-id" }));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        deleteRoutePlan,
        getRoutePlanDetail: vi.fn(),
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "DELETE",
        url: "/admin/ui/app/api/routes/route-plan-id?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(response.statusCode).toBe(200);
      expect(
        readApiData<{ deleted: boolean; routePlanId: string }>(response),
      ).toEqual({ deleted: true, routePlanId: "route-plan-id" });
      expect(deleteRoutePlan).toHaveBeenCalledWith({
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("creates a date route from selected ready unplanned orders in the admin web UI", async () => {
    const createRoutePlan = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["createRoutePlan"]
    >(() => Promise.resolve(routePlanSummary()));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() =>
          Promise.resolve([
            canonicalOrder(),
            canonicalOrder({
              name: "#1002",
              orderId: "order-2",
              shopifyOrderGid: "gid://woocommerce/Order/1002",
              shopifyOrderLegacyId: "1002",
              sourceOrderId: "1002",
              sourceOrderNumber: "1002",
            }),
          ]),
        ),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan,
        getRoutePlanDetail: vi.fn(),
        listRoutePlans: vi.fn(() => Promise.resolve([])),
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/routes/create",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          depotAddress: "Toronto depot",
          depotLatitude: "43.6532",
          depotLongitude: "-79.3832",
          planDate: "2026-05-26",
          routeName: "2026-05-26 Toronto route",
          selectedOrderGids: "gid://woocommerce/Order/1001",
          shopDomain: "tenant-a.example.test",
        }),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain(
        "/admin/ui/app/routes/route-plan-id?",
      );
      expect(response.headers.location).toContain(
        "/admin/ui/app/routes/route-plan-id",
      );
      expect(createRoutePlan).toHaveBeenCalledOnce();
      const createInput = createRoutePlan.mock.calls[0]?.[0];
      expect(createInput).toBeDefined();
      expect(createInput?.createdBy).toBe("web-operator");
      expect(createInput?.shopDomain).toBe("tenant-a.example.test");
      expect(createInput?.payload).toEqual(
        expect.objectContaining({
          depot: {
            address: "Toronto depot",
            latitude: 43.6532,
            longitude: -79.3832,
          },
          name: "2026-05-26 Toronto route",
          orders: [
            expect.objectContaining({
              deliveryDate: "2026-05-26",
              name: "#1001",
              routeScopeKey: "2026-05-26|DELIVERY||",
              shopifyOrderGid: "gid://woocommerce/Order/1001",
            }),
          ],
          planDate: "2026-05-26",
          routeScope: {
            deliveryDate: "2026-05-26",
            deliverySession: "DAY",
            routeScopeKey: "2026-05-26|DELIVERY||",
            serviceType: "DELIVERY",
            timeWindowEnd: null,
            timeWindowStart: null,
          },
        }),
      );
    } finally {
      await app.close();
    }
  });

  test("updates route stop order from the protected route detail page", async () => {
    const detail = routePlanDetail();
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() => Promise.resolve(detail));
    const updateRoutePlanStops = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["updateRoutePlanStops"]
    >(() => Promise.resolve(detail));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        listRoutePlans: vi.fn(() => Promise.resolve([])),
        updateRoutePlanStops,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/routes/route-plan-id/stops",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          shopDomain: "tenant-a.example.test",
          stopOrder:
            "gid://woocommerce/Order/1002\ngid://woocommerce/Order/1001",
        }),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain(
        "/admin/ui/app/routes/route-plan-id",
      );
      expect(updateRoutePlanStops).toHaveBeenCalledWith({
        payload: {
          stops: [
            {
              deliveryStopId: "stop-2",
              sequence: 1,
              shopifyOrderGid: "gid://woocommerce/Order/1002",
            },
            {
              deliveryStopId: "stop-1",
              sequence: 2,
              shopifyOrderGid: "gid://woocommerce/Order/1001",
            },
          ],
        },
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("creates a pending Route Ops driver and returns the admin-visible invite code", async () => {
    const createdDriver = {
      ...driverRow(),
      inviteCode: "FACE12",
      inviteCodeExpiresAt: "2026-05-28T12:00:00.000Z",
    };
    const createPendingDriver = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["createPendingDriver"]
    >(() => Promise.resolve(createdDriver));
    const listDrivers = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["listDrivers"]
    >(() => Promise.resolve([createdDriver]));
    const { app } = await createUiHarness({
      driverService: {
        createPendingDriver,
        deleteDriver: vi.fn(),
        listDrivers,
        regenerateInviteCode: vi.fn(),
      },
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/drivers?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          { displayName: "Alex Driver", phone: "+14165550123" },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(201);
      expect(createPendingDriver).toHaveBeenCalledWith({
        createdBy: "web-operator",
        displayName: "Alex Driver",
        inviteLink: null,
        phone: "+14165550123",
        shopDomain: "tenant-a.example.test",
        source: "clever-app-driver-invite",
      });
      const driverData = readApiData<{
        drivers: Array<{ appLinked: boolean; inviteCode: string | null }>;
      }>(response).drivers[0];
      expect(driverData).toEqual(
        expect.objectContaining({ appLinked: false, inviteCode: "FACE12" }),
      );
      expect(JSON.stringify(driverData)).not.toContain("authSubject");
    } finally {
      await app.close();
    }
  });

  test("regenerates a Route Ops driver invite code behind CSRF without exposing raw auth subject", async () => {
    const regeneratedDriver = {
      ...driverRow(),
      inviteCode: "BEE123",
      inviteCodeExpiresAt: "2026-05-28T12:00:00.000Z",
      updatedAt: "2026-05-26T13:00:00.000Z",
    };
    const regenerateInviteCode = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["regenerateInviteCode"]
    >(() => Promise.resolve(regeneratedDriver));
    const listDrivers = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["listDrivers"]
    >(() => Promise.resolve([regeneratedDriver]));
    const { app } = await createUiHarness({
      driverService: {
        createPendingDriver: vi.fn(),
        deleteDriver: vi.fn(),
        listDrivers,
        regenerateInviteCode,
      },
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/drivers/driver-id/regenerate-invite-code?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(response.statusCode).toBe(200);
      expect(regenerateInviteCode).toHaveBeenCalledWith({
        driverId: "driver-id",
        shopDomain: "tenant-a.example.test",
      });
      const driverData = readApiData<{
        drivers: Array<{ appLinked: boolean; inviteCode: string | null }>;
      }>(response).drivers[0];
      expect(driverData).toEqual(
        expect.objectContaining({ appLinked: false, inviteCode: "BEE123" }),
      );
      expect(JSON.stringify(driverData)).not.toContain("authSubject");

      const blocked = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/drivers/driver-id/regenerate-invite-code?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}),
      });
      expect(blocked.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  test("returns a safe not found response when regenerating an unknown Route Ops driver", async () => {
    const regenerateInviteCode = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["regenerateInviteCode"]
    >(() => Promise.resolve(driverRow()));
    const listDrivers = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["listDrivers"]
    >(() => Promise.resolve([]));
    const { app } = await createUiHarness({
      driverService: {
        createPendingDriver: vi.fn(),
        deleteDriver: vi.fn(),
        listDrivers,
        regenerateInviteCode,
      },
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/drivers/other-shop-driver/regenerate-invite-code?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(response.statusCode).toBe(404);
      expect(readApiError(response)).toEqual(
        expect.objectContaining({
          code: "NOT_FOUND",
          message: "Driver not found",
        }),
      );
      expect(regenerateInviteCode).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("deletes a Route Ops driver behind CSRF and returns the refreshed driver list", async () => {
    const deleteDriver = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["deleteDriver"]
    >(() => Promise.resolve("driver-id"));
    const listDrivers = vi
      .fn<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["driverService"]
        >["listDrivers"]
      >()
      .mockResolvedValueOnce([driverRow()])
      .mockResolvedValueOnce([]);
    const { app } = await createUiHarness({
      driverService: {
        createPendingDriver: vi.fn(),
        deleteDriver,
        listDrivers,
        regenerateInviteCode: vi.fn(),
      },
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "DELETE",
        url: "/admin/ui/app/api/drivers/driver-id?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(response.statusCode).toBe(200);
      expect(deleteDriver).toHaveBeenCalledWith({
        driverId: "driver-id",
        shopDomain: "tenant-a.example.test",
      });
      expect(readApiData<{ drivers: unknown[] }>(response).drivers).toEqual([]);

      const blocked = await app.inject({
        method: "DELETE",
        url: "/admin/ui/app/api/drivers/driver-id?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}),
      });
      expect(blocked.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  test("returns a safe not found response when deleting an unknown Route Ops driver", async () => {
    const deleteDriver = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["deleteDriver"]
    >(() => Promise.resolve("other-shop-driver"));
    const listDrivers = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["listDrivers"]
    >(() => Promise.resolve([]));
    const { app } = await createUiHarness({
      driverService: {
        createPendingDriver: vi.fn(),
        deleteDriver,
        listDrivers,
        regenerateInviteCode: vi.fn(),
      },
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "DELETE",
        url: "/admin/ui/app/api/drivers/other-shop-driver?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(response.statusCode).toBe(404);
      expect(readApiError(response)).toEqual(
        expect.objectContaining({
          code: "NOT_FOUND",
          message: "Driver not found",
        }),
      );
      expect(deleteDriver).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("assigns drivers from the protected Route Ops API", async () => {
    const assignedDetail = {
      ...routePlanDetail(),
      routePlan: { ...routePlanSummary(), driverId: "driver-id" },
    };
    const assignRoutePlanDriver = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["assignRoutePlanDriver"]
    >(() => Promise.resolve(assignedDetail));
    const listDrivers = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["driverService"]
      >["listDrivers"]
    >(() => Promise.resolve([driverRow()]));
    const { app } = await createUiHarness({
      driverService: {
        createPendingDriver: vi.fn(),
        deleteDriver: vi.fn(),
        listDrivers,
        regenerateInviteCode: vi.fn(),
      },
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routePlanService: {
        assignRoutePlanDriver,
        createRoutePlan: vi.fn(),
        getRoutePlanDetail: vi.fn(),
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const drivers = await app.inject({
        headers: { cookie, accept: "application/json" },
        method: "GET",
        url: "/admin/ui/app/api/drivers?shopDomain=tenant-a.example.test",
      });
      expect(drivers.statusCode).toBe(200);
      expect(
        readApiData<{ drivers: Array<{ displayName: string }> }>(drivers)
          .drivers[0],
      ).toEqual(expect.objectContaining({ displayName: "Alex Driver" }));
      expect(listDrivers).toHaveBeenCalledWith({
        shopDomain: "tenant-a.example.test",
      });

      const response = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/routes/route-plan-id/driver?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          { driverId: "driver-id" },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(200);
      expect(
        readApiData<{ routePlan: { driverId: string } }>(response).routePlan
          .driverId,
      ).toBe("driver-id");
      expect(assignRoutePlanDriver).toHaveBeenCalledWith({
        payload: { driverId: "driver-id" },
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("publishes a driver-assigned draft route from the protected Route Ops API", async () => {
    const publishedDetail = {
      ...routePlanDetail(),
      routePlan: {
        ...routePlanSummary(),
        driverId: "driver-id",
        status: "ASSIGNED",
      },
    };
    const publishRoutePlan = vi.fn<RoutePlanService["publishRoutePlan"]>(() =>
      Promise.resolve(publishedDetail),
    );
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail: vi.fn(),
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        publishRoutePlan,
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/routes/route-plan-id/publish?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(response.statusCode).toBe(200);
      expect(
        readApiData<{ routePlan: { driverId: string; status: string } }>(
          response,
        ).routePlan,
      ).toEqual(
        expect.objectContaining({
          driverId: "driver-id",
          status: "ASSIGNED",
        }),
      );
      expect(publishRoutePlan).toHaveBeenCalledWith({
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("saves route driver, options, and stop order through the aggregate Route Ops API", async () => {
    const detail = routePlanDetail();
    const savedDetail = {
      ...detail,
      routePlan: {
        ...detail.routePlan,
        driverId: "driver-id",
        routeEndMode: "RETURN_TO_DEPOT" as const,
        status: "ASSIGNED",
      },
    };
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() => Promise.resolve(detail));
    const saveRoutePlan = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["routePlanService"]
        >["saveRoutePlan"]
      >
    >(() =>
      Promise.resolve({
        detail: savedDetail,
        operations: [
          {
            name: "options",
            reason: "route_end_mode_changed",
            status: "applied",
          },
          { name: "stops", reason: "sequence_changed", status: "applied" },
          { name: "driver", reason: "driver_changed", status: "applied" },
          {
            name: "publish",
            reason: "draft_ready_for_driver",
            status: "applied",
          },
        ],
      }),
    );
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        saveRoutePlan,
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/routes/route-plan-id?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            driverId: "driver-id",
            expectedUpdatedAt: "2026-05-26T12:00:00.000Z",
            routeEndMode: "RETURN_TO_DEPOT",
            stops: [
              {
                deliveryStopId: "stop-2",
                sourceOrderId: "gid://woocommerce/Order/1002",
              },
              {
                deliveryStopId: "stop-1",
                sourceOrderId: "gid://woocommerce/Order/1001",
              },
            ],
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(200);
      expect(saveRoutePlan).toHaveBeenCalledWith({
        payload: {
          driverId: "driver-id",
          expectedUpdatedAt: "2026-05-26T12:00:00.000Z",
          routeEndMode: "RETURN_TO_DEPOT",
          stops: [
            {
              deliveryStopId: "stop-2",
              sequence: 1,
              shopifyOrderGid: "gid://woocommerce/Order/1002",
            },
            {
              deliveryStopId: "stop-1",
              sequence: 2,
              shopifyOrderGid: "gid://woocommerce/Order/1001",
            },
          ],
        },
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
      const data = readApiData<{
        routePlan: { driverId: string; routeEndMode: string; status: string };
        saveOperations: Array<{ name: string; status: string }>;
      }>(response);
      expect(data.routePlan).toEqual(
        expect.objectContaining({
          driverId: "driver-id",
          routeEndMode: "RETURN_TO_DEPOT",
          status: "ASSIGNED",
        }),
      );
      expect(data.saveOperations.map((operation) => operation.name)).toEqual([
        "options",
        "stops",
        "driver",
        "publish",
      ]);

      const blocked = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/routes/route-plan-id?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, { driverId: "driver-id" }),
      });
      expect(blocked.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  test("returns 409 when aggregate route save is based on a stale route version", async () => {
    const detail = routePlanDetail();
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() => Promise.resolve(detail));
    const saveRoutePlan = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["routePlanService"]
        >["saveRoutePlan"]
      >
    >(() => Promise.reject(new RoutePlanConflictError()));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        saveRoutePlan,
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/routes/route-plan-id?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            driverId: "driver-id",
            expectedUpdatedAt: "2026-05-26T11:59:59.000Z",
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(409);
      expect(readApiError(response)).toMatchObject({
        code: "ROUTE_PLAN_CONFLICT",
      });
      expect(saveRoutePlan).toHaveBeenCalledWith({
        payload: {
          driverId: "driver-id",
          expectedUpdatedAt: "2026-05-26T11:59:59.000Z",
        },
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("returns 409 when aggregate route save includes an already planned order", async () => {
    const detail = routePlanDetail();
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() => Promise.resolve(detail));
    const saveRoutePlan = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["routePlanService"]
        >["saveRoutePlan"]
      >
    >(() => Promise.reject(new RoutePlanOrderAlreadyPlannedError()));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        saveRoutePlan,
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/routes/route-plan-id?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            expectedUpdatedAt: "2026-05-26T12:00:00.000Z",
            stops: [
              {
                deliveryStopId: "stop-2",
                sourceOrderId: "gid://woocommerce/Order/1002",
              },
              {
                deliveryStopId: "stop-1",
                sourceOrderId: "gid://woocommerce/Order/1001",
              },
            ],
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(409);
      expect(readApiError(response)).toMatchObject({
        code: "ROUTE_ORDER_ALREADY_PLANNED",
        message:
          "Some selected orders are already assigned to a route. Refresh the page and try again.",
      });
    } finally {
      await app.close();
    }
  });

  test("blocks selected route creation when any selected order is not route-ready", async () => {
    const blockedOrder = canonicalOrder({
      deliveryStopId: "stop-2",
      hasCoordinates: false,
      latitude: null,
      longitude: null,
      name: "#1002",
      readiness: "NEEDS_REVIEW",
      reviewReasons: ["missing_coordinates"],
      shopifyOrderGid: "gid://woocommerce/Order/1002",
      shopifyOrderLegacyId: "1002",
      sourceOrderId: "1002",
      sourceOrderNumber: "1002",
    });
    const createRoutePlan = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["createRoutePlan"]
    >(() => Promise.resolve(routePlanSummary()));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() =>
          Promise.resolve([canonicalOrder(), blockedOrder]),
        ),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan,
        getRoutePlanDetail: vi.fn(),
        listRoutePlans: vi.fn(() => Promise.resolve([])),
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/routes/create",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          planDate: "2026-05-26",
          routeName: "Blocked route",
          selectedOrderGids:
            "gid://woocommerce/Order/1001\ngid://woocommerce/Order/1002",
          shopDomain: "tenant-a.example.test",
        }),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain("/admin/ui/app/routes?");
      expect(response.headers.location).toContain("error=");
      expect(
        decodeURIComponent(String(response.headers.location)).replace(
          /\+/gu,
          " ",
        ),
      ).toContain("Cannot create a partial route");
      expect(
        decodeURIComponent(String(response.headers.location)).replace(
          /\+/gu,
          " ",
        ),
      ).toContain("missing_coordinates");
      expect(createRoutePlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("Route Ops API returns sanitized batch blockers for selected-order route hard failures", async () => {
    const createRoutePlanFromOrderIds = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["routePlanService"]
        >["createRoutePlanFromOrderIds"]
      >
    >(() =>
      Promise.reject(
        new RoutePlanBatchInvalidError([
          "#1002: missing delivery coordinates",
          "selected orders have mixed route scope",
        ]),
      ),
    );
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() =>
          Promise.resolve([
            canonicalOrder(),
            canonicalOrder({
              name: "#1002",
              orderId: "order-2",
              shopifyOrderGid: "gid://woocommerce/Order/1002",
              shopifyOrderLegacyId: "1002",
              sourceOrderId: "1002",
              sourceOrderNumber: "1002",
            }),
          ]),
        ),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        createRoutePlanFromOrderIds,
        getRoutePlanDetail: vi.fn(),
        listRoutePlans: vi.fn(() => Promise.resolve([])),
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/routes?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            orderIds: ["order-1", "order-2"],
            planDate: "2026-05-26",
            routeName: "Bad batch",
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as ApiErrorEnvelope & {
        error: {
          code: string;
          details: {
            blockerCounts: Record<string, number>;
            blockers: string[];
          };
          message: string;
        };
      };
      expect(body.error.code).toBe("ROUTE_PLAN_BATCH_INVALID");
      expect(body.error.message).toContain("Cannot create a partial route");
      expect(body.error.details.blockerCounts).toEqual(
        expect.objectContaining({
          missing_coordinates: 1,
          mixed_route_scope: 1,
        }),
      );
      expect(createRoutePlanFromOrderIds).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test("allows Route Ops route creation from history scope when selected orders are valid", async () => {
    const createRoutePlanFromOrderIds = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["routePlanService"]
        >["createRoutePlanFromOrderIds"]
      >
    >(() => Promise.resolve(routePlanSummary()));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([canonicalOrder()])),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        createRoutePlanFromOrderIds,
        getRoutePlanDetail: vi.fn(),
        listRoutePlans: vi.fn(() => Promise.resolve([])),
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/routes?shopDomain=tenant-a.example.test&scope=history",
        ...authenticatedJsonRequest(
          cookie,
          {
            orderIds: ["order-1"],
            planDate: "2026-05-26",
            routeName: "History route",
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(201);
      expect(createRoutePlanFromOrderIds).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test("blocks route creation when selected orders use disabled configured route-scope values", async () => {
    const baseConfig = defaultRouteScopeConfig();
    const routeScopeConfig = {
      ...baseConfig,
      deliverySessions: [
        ...baseConfig.deliverySessions,
        {
          builtIn: false,
          description: "Morning deliveries",
          enabled: false,
          example: "MORNING",
          label: "Morning",
          value: "MORNING",
        },
      ],
      serviceTypes: [
        ...baseConfig.serviceTypes,
        {
          builtIn: false,
          description: "Morning delivery route",
          enabled: false,
          example: "MORNING_DELIVERY",
          label: "Morning delivery",
          value: "MORNING_DELIVERY",
        },
      ],
    };
    const createRoutePlanFromOrderIds = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["routePlanService"]
        >["createRoutePlanFromOrderIds"]
      >
    >(() => Promise.resolve(routePlanSummary()));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() =>
          Promise.resolve([
            canonicalOrder({
              deliverySession: "MORNING",
              routeScopeKey: "2026-05-26|MORNING_DELIVERY|08:00|12:00",
              serviceType: "MORNING_DELIVERY",
              timeWindowEnd: "12:00",
              timeWindowStart: "08:00",
            }),
          ]),
        ),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        createRoutePlanFromOrderIds,
        getRoutePlanDetail: vi.fn(),
        listRoutePlans: vi.fn(() => Promise.resolve([])),
        updateRoutePlanStops: vi.fn(),
      },
      settingsService: {
        getSettings: vi.fn(() =>
          Promise.resolve(storeSettings({ routeScopeConfig })),
        ),
        saveSettings: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/routes?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            orderIds: ["order-1"],
            planDate: "2026-05-26",
            routeName: "Morning route",
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as ApiErrorEnvelope;
      expect(body.error.message).toContain("no longer enabled in Settings");
      expect(createRoutePlanFromOrderIds).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("blocks route creation when selected orders use unconfigured route-scope values", async () => {
    const createRoutePlanFromOrderIds = vi.fn<
      NonNullable<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["routePlanService"]
        >["createRoutePlanFromOrderIds"]
      >
    >(() => Promise.resolve(routePlanSummary()));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() =>
          Promise.resolve([
            canonicalOrder({
              deliverySession: "MORNING",
              routeScopeKey: "2026-05-26|MORNING_DELIVERY|08:00|12:00",
              serviceType: "MORNING_DELIVERY",
              timeWindowEnd: "12:00",
              timeWindowStart: "08:00",
            }),
          ]),
        ),
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        createRoutePlanFromOrderIds,
        getRoutePlanDetail: vi.fn(),
        listRoutePlans: vi.fn(() => Promise.resolve([])),
        updateRoutePlanStops: vi.fn(),
      },
      settingsService: {
        getSettings: vi.fn(() => Promise.resolve(storeSettings())),
        saveSettings: vi.fn(),
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/routes?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          {
            orderIds: ["order-1"],
            planDate: "2026-05-26",
            routeName: "Morning route",
          },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as ApiErrorEnvelope;
      expect(body.error.message).toContain("no longer enabled in Settings");
      expect(createRoutePlanFromOrderIds).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("serves static Route Ops assets and saves CLEVER v1 optimized stop order via API", async () => {
    const baseDetail = routePlanDetail();
    const firstStop = baseDetail.stops[0];
    const secondStop = baseDetail.stops[1];
    if (firstStop === undefined || secondStop === undefined) {
      throw new Error("routePlanDetail test fixture must include two stops");
    }
    const detail = {
      ...baseDetail,
      routePlan: {
        ...routePlanSummary(),
        depot: { latitude: 43.6, longitude: -79.3 },
      },
      stops: [
        {
          ...firstStop,
          coordinates: { latitude: 44.2, longitude: -79.9 },
          sequence: 1,
        },
        {
          ...secondStop,
          coordinates: { latitude: 43.61, longitude: -79.31 },
          sequence: 2,
        },
      ],
    };
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() => Promise.resolve(detail));
    const updateRoutePlanStops = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["updateRoutePlanStops"]
    >(() => Promise.resolve(detail));
    const recordEngineOutcome = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routeOptimizationJobService"]
      >["recordEngineOutcome"]
    >(() => Promise.resolve(routeOptimizationJob({ status: "FAILED" })));
    const routeOptimizationJobService = routeOptimizationJobServiceMock({
      recordEngineOutcome,
    });
    const { app } = await createUiHarness({
      driverService: {
        createPendingDriver: vi.fn(),
        deleteDriver: vi.fn(),
        listDrivers: vi.fn(() => Promise.resolve([driverRow()])),
        regenerateInviteCode: vi.fn(),
      },
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routeOptimizationJobService,
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        updateRoutePlanStops,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const page = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/app/routes/route-plan-id?shopDomain=tenant-a.example.test",
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('id="clever-route-ops-root"');
      expect(page.body).toContain("/admin/ui/app/assets/");
      expect(page.body).not.toContain("router.project-osrm.org");
      const assetPath = /src="([^"]+\.js)"/u.exec(page.body)?.[1];
      expect(assetPath).toBeDefined();
      const asset = await app.inject({
        method: "GET",
        url: assetPath ?? "/missing.js",
      });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain("text/javascript");

      const optimized = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/routes/route-plan-id/optimize?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(optimized.statusCode).toBe(202);
      expect(
        readApiData<{ job: RouteOptimizationJobDto }>(optimized).job.id,
      ).toBe("job-id");
      await waitForExpectation(() => {
        expect(recordEngineOutcome).toHaveBeenCalled();
        const call = recordEngineOutcome.mock.calls[0]?.[0];
        expect(call?.jobId).toBe("job-id");
        expect(call?.outcome.ok).toBe(false);
        if (call?.outcome.ok === false) {
          expect(call.outcome.failure.code).toBe("route_engine_unavailable");
        }
      });
      expect(updateRoutePlanStops).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("saves external optimizer stop order via API when configured", async () => {
    const baseDetail = routePlanDetail();
    const detail = {
      ...baseDetail,
      routePlan: {
        ...routePlanSummary(),
        depot: { latitude: 43.6, longitude: -79.3 },
      },
    };
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() => Promise.resolve(detail));
    const updateRoutePlanStops = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["updateRoutePlanStops"]
    >(() => Promise.resolve(detail));
    const optimizeStopOrder = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routeOptimizationService"]
      >["optimizeStopOrder"]
    >(() =>
      Promise.resolve({
        missingCoordinateStops: 0,
        source: "vroom",
        stops: [
          {
            deliveryStopId: "stop-2",
            sequence: 1,
            shopifyOrderGid: "gid://woocommerce/Order/1002",
          },
          {
            deliveryStopId: "stop-1",
            sequence: 2,
            shopifyOrderGid: "gid://woocommerce/Order/1001",
          },
        ],
      }),
    );
    const recordEngineOutcome = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routeOptimizationJobService"]
      >["recordEngineOutcome"]
    >(() => Promise.resolve(routeOptimizationJob({ status: "APPLIED" })));
    const routeOptimizationJobService = routeOptimizationJobServiceMock({
      recordEngineOutcome,
    });
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routeOptimizationJobService,
      routeOptimizationService: { optimizeStopOrder },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        updateRoutePlanStops,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const optimized = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/routes/route-plan-id/optimize?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(optimized.statusCode).toBe(202);
      expect(
        readApiData<{ job: RouteOptimizationJobDto }>(optimized).job.id,
      ).toBe("job-id");
      expect(routeOptimizationJobService.createJob).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutBudgetMs: 180000 }),
      );
      await waitForExpectation(() =>
        expect(optimizeStopOrder).toHaveBeenCalledWith({
          detail,
          shopDomain: "tenant-a.example.test",
        }),
      );
      expect(updateRoutePlanStops).toHaveBeenCalledWith({
        mutationContext: {
          jobId: "job-id",
          source: "route_optimization_job",
        },
        payload: {
          stops: [
            {
              deliveryStopId: "stop-2",
              sequence: 1,
              shopifyOrderGid: "gid://woocommerce/Order/1002",
            },
            {
              deliveryStopId: "stop-1",
              sequence: 2,
              shopifyOrderGid: "gid://woocommerce/Order/1001",
            },
          ],
        },
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
      const recordCall = recordEngineOutcome.mock.calls.at(-1)?.[0];
      expect(recordCall?.jobId).toBe("job-id");
      expect(recordCall?.outcome.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("records thrown route_engine optimizer errors as failed jobs", async () => {
    const detail = routePlanDetail();
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() => Promise.resolve(detail));
    const updateRoutePlanStops = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["updateRoutePlanStops"]
    >(() => Promise.resolve(detail));
    const recordEngineOutcome = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routeOptimizationJobService"]
      >["recordEngineOutcome"]
    >(() => Promise.resolve(routeOptimizationJob({ status: "FAILED" })));
    const routeOptimizationJobService = routeOptimizationJobServiceMock({
      recordEngineOutcome,
    });
    const optimizeStopOrderWithDiagnostics = vi.fn(() =>
      Promise.reject(new Error("route engine boom")),
    );
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routeOptimizationJobService,
      routeOptimizationService: {
        optimizeStopOrder: vi.fn(() => Promise.resolve(null)),
        optimizeStopOrderWithDiagnostics,
      },
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        updateRoutePlanStops,
      },
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/routes/route-plan-id/optimize-jobs?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(response.statusCode).toBe(202);
      await waitForExpectation(() => {
        const call = recordEngineOutcome.mock.calls[0]?.[0];
        expect(call?.jobId).toBe("job-id");
        expect(call?.outcome.ok).toBe(false);
        if (call?.outcome.ok === false) {
          expect(call.outcome.failure.code).toBe("route_engine_unavailable");
          expect(call.outcome.failure.message).toContain(
            "Route optimization failed unexpectedly",
          );
        }
      });
      expect(updateRoutePlanStops).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("reads route optimization jobs via Route Ops API", async () => {
    const routeOptimizationJobService = routeOptimizationJobServiceMock({
      findJob: vi.fn(() =>
        Promise.resolve(routeOptimizationJob({ id: "job-id" })),
      ),
      findLatestJob: vi.fn(() =>
        Promise.resolve(routeOptimizationJob({ id: "latest-job-id" })),
      ),
    });
    const getRoutePlanDetail = vi.fn(() => Promise.resolve(routePlanDetail()));
    const routePlanExists = vi.fn(() => Promise.resolve(true));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routeOptimizationJobService,
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        routePlanExists,
        listRoutePlans: vi.fn(() => Promise.resolve([routePlanSummary()])),
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const latest = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/app/api/routes/route-plan-id/optimize-jobs/latest?shopDomain=tenant-a.example.test",
      });
      const byId = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/app/api/routes/route-plan-id/optimize-jobs/job-id?shopDomain=tenant-a.example.test",
      });

      expect(latest.statusCode).toBe(200);
      expect(readApiData<{ job: RouteOptimizationJobDto }>(latest).job.id).toBe(
        "latest-job-id",
      );
      expect(byId.statusCode).toBe(200);
      expect(readApiData<{ job: RouteOptimizationJobDto }>(byId).job.id).toBe(
        "job-id",
      );
      expect(routePlanExists).toHaveBeenCalledTimes(2);
      expect(routePlanExists).toHaveBeenCalledWith({
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
      expect(getRoutePlanDetail).not.toHaveBeenCalled();
      expect(routeOptimizationJobService.findLatestJob).toHaveBeenCalledWith({
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
      expect(routeOptimizationJobService.findJob).toHaveBeenCalledWith({
        jobId: "job-id",
        routePlanId: "route-plan-id",
        shopDomain: "tenant-a.example.test",
      });
      expect(
        routeOptimizationJobService.reconcileStaleActiveJobs,
      ).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("returns not found when reading latest route optimization job for a missing route", async () => {
    const routeOptimizationJobService = routeOptimizationJobServiceMock({
      findLatestJob: vi.fn(() => Promise.resolve(null)),
    });
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() => Promise.resolve(routePlanDetail()));
    const routePlanExists = vi.fn(() => Promise.resolve(false));
    const { app } = await createUiHarness({
      orderSyncService: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      },
      routeOptimizationJobService,
      routePlanService: {
        assignRoutePlanDriver: vi.fn(),
        createRoutePlan: vi.fn(),
        getRoutePlanDetail,
        routePlanExists,
        listRoutePlans: vi.fn(() => Promise.resolve([])),
        updateRoutePlanStops: vi.fn(),
      },
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const latest = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/app/api/routes/missing-route-id/optimize-jobs/latest?shopDomain=tenant-a.example.test",
      });

      expect(latest.statusCode).toBe(404);
      expect(routePlanExists).toHaveBeenCalledWith({
        routePlanId: "missing-route-id",
        shopDomain: "tenant-a.example.test",
      });
      expect(getRoutePlanDetail).not.toHaveBeenCalled();
      expect(routeOptimizationJobService.findLatestJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("renders guided Woo onboarding copy with one credential entry form", async () => {
    const { app } = await createUiHarness();

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/commerce-connections/woocommerce",
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Connect a WooCommerce store");
      expect(response.body).toContain("What you need from WordPress");
      expect(response.body).toContain(
        "WooCommerce → Settings → Advanced → REST API",
      );
      expect(response.body).toContain(
        "WooCommerce → Settings → Advanced → Webhooks",
      );
      expect(response.body).toContain("Test credentials only");
      expect(response.body).toContain("Save connection");
      expect(response.body).toContain("/admin/ui/assets/woocommerce-test.js");
      expect(response.body).toContain("data-woo-credential-form");
      expect(response.body).toContain("data-test-credentials-button");
      expect(response.body).toContain("data-test-credential-result");
      expect(response.body).toContain("Order created");
      expect(response.body).toContain("Order updated");
      expect(response.body).toContain(
        "initial WooCommerce ping is not the final CLEVER readiness signal",
      );
      expect(response.body).toContain(
        "CLEVER will generate a one-time secret after save",
      );
      expect(response.body).toContain("Customer shop domain");
      expect(response.body).toContain(
        "No https:// and no path. Example: estherlist.com.",
      );
      expect(response.body).toContain("WordPress/WooCommerce site URL");
      expect(response.body).toContain(
        "Example: https://estherlist.com or https://estherlist.com/shop.",
      );
      expect(response.body).not.toContain("Current shop context");
      expect(response.body).not.toContain("Test Woo credentials");
      expect(response.body).not.toContain("Create Woo connection");
      expect(countOccurrences(response.body, 'name="wooConsumerKey"')).toBe(1);
      expect(countOccurrences(response.body, 'name="wooConsumerSecret"')).toBe(
        1,
      );
      expect(response.body).toContain(
        'formaction="/admin/ui/commerce-connections/woocommerce/test"',
      );

      const script = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/assets/woocommerce-test.js",
      });
      expect(script.statusCode).toBe(200);
      expect(script.headers["content-type"]).toContain("text/javascript");
      expect(script.body).toContain("new FormData(form)");
      expect(script.body).toContain("Accept: 'application/json'");
    } finally {
      await app.close();
    }
  });

  test("derives the UI actor from admin env and never verifies the JSON API bearer token for browser flows", async () => {
    const base = createBaseAdminCommerceDependencies();
    const uiDependencies = loadAdminCommerceConnectionsUiDependencies({
      adminCommerceConnections: base.dependencies,
      env: {
        CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS: "*",
        CLEVER_ADMIN_API_ACTOR: "web-operator",
        CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
        CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
        DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
      },
      nodeEnv: "test",
    });
    expect(uiDependencies).toBeDefined();
    if (uiDependencies === undefined)
      throw new Error("Expected admin UI dependencies");
    const app = await buildApp({ adminCommerceConnectionsUi: uiDependencies });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/test",
        ...authenticatedMultipartRequest(
          cookie,
          credentialFormFields({ csrfToken }),
        ),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain(
        "/admin/ui/commerce-connections/woocommerce?",
      );
      expect(response.headers.location).toContain(
        "shopDomain=tenant-a.example.test",
      );
      expect(response.headers.location).toContain("notice=");
      expect(base.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { allowedShopDomains: "*", subject: "web-operator" },
          consumerKey: "ck_SHOULD_NOT_RENDER",
          consumerSecret: "cs_SHOULD_NOT_RENDER",
          shopDomain: "tenant-a.example.test",
        }),
      );
      expect(base.adminTokenVerifier.verify).not.toHaveBeenCalled();
      expect(String(response.headers.location)).toContain(
        "WooCommerce+credentials+verified+at+2026-05-24T00%3A00%3A00.000Z",
      );
      expect(String(response.headers.location)).not.toContain(
        "ck_SHOULD_NOT_RENDER",
      );
      expect(String(response.headers.location)).not.toContain(
        "cs_SHOULD_NOT_RENDER",
      );
    } finally {
      await app.close();
    }
  });

  test("supports in-place JSON credential tests so typed secrets stay in the browser form", async () => {
    const { app, testConnection } = await createUiHarness();

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/test",
        ...authenticatedMultipartRequest(
          cookie,
          credentialFormFields({ csrfToken }),
          undefined,
          {
            accept: "application/json",
          },
        ),
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.location).toBeUndefined();
      expect(JSON.parse(response.body)).toEqual({
        message: "WooCommerce credentials verified at 2026-05-24T00:00:00.000Z",
        ok: true,
      });
      expect(response.body).not.toContain("ck_SHOULD_NOT_RENDER");
      expect(response.body).not.toContain("cs_SHOULD_NOT_RENDER");
      expect(testConnection).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  test("requires CSRF before create/test service calls", async () => {
    const { app, createConnection } = await createUiHarness();

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce",
        ...authenticatedMultipartRequest(
          cookie,
          credentialFormFields({ csrfToken: "tampered-token" }),
        ),
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("Invalid admin UI CSRF token");
      expect(createConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("uses CSRF as the browser mutation gate when origin metadata is unreliable", async () => {
    const { app, testConnection } = await createUiHarness();

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/test",
        ...authenticatedMultipartRequest(
          cookie,
          credentialFormFields({ csrfToken }),
          undefined,
          {
            origin: "https://evil.example.test",
            "sec-fetch-site": "cross-site",
          },
        ),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain("notice=");
      expect(testConnection).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  test("redirects test credential posts after accepting Safari/proxy origin metadata variants", async () => {
    const { app, testConnection } = await createUiHarness();

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/test",
        ...authenticatedMultipartRequest(
          cookie,
          credentialFormFields({ csrfToken }),
          undefined,
          {
            origin: "https://clever-route.cleversystem.ai",
            "sec-fetch-site": "same-site",
          },
        ),
      });
      const missingOrigin = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/test",
        ...authenticatedMultipartRequest(
          cookie,
          credentialFormFields({ csrfToken }),
          undefined,
          {
            "sec-fetch-site": "same-site",
          },
        ),
      });
      const defaultPortOrigin = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/test",
        ...authenticatedMultipartRequest(
          cookie,
          credentialFormFields({ csrfToken }),
          undefined,
          {
            origin: "https://clever-route.cleversystem.ai:443",
            "sec-fetch-site": "same-origin",
          },
        ),
      });
      const defaultPortReferer = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/test",
        ...authenticatedMultipartRequest(
          cookie,
          credentialFormFields({ csrfToken }),
          undefined,
          {
            referer:
              "https://clever-route.cleversystem.ai:443/admin/ui/commerce-connections/woocommerce",
            "sec-fetch-site": "same-origin",
          },
        ),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain("notice=");
      expect(missingOrigin.statusCode).toBe(303);
      expect(missingOrigin.headers.location).toContain("notice=");
      expect(defaultPortOrigin.statusCode).toBe(303);
      expect(defaultPortOrigin.headers.location).toContain("notice=");
      expect(defaultPortReferer.statusCode).toBe(303);
      expect(defaultPortReferer.headers.location).toContain("notice=");
      expect(testConnection).toHaveBeenCalledTimes(4);
    } finally {
      await app.close();
    }
  });

  test("creates a connection, shows one-time webhook setup, and never renders submitted Woo secrets", async () => {
    const { app } = await createUiHarness();

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce",
        ...authenticatedMultipartRequest(
          cookie,
          credentialFormFields({ csrfToken }),
        ),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("WooCommerce connection saved.");
      expect(response.body).toContain("Copy this generated webhook secret now");
      expect(response.body).toContain(
        "https://clever-route.cleversystem.ai/woocommerce/webhooks/11111111-1111-4111-8111-111111111111/orders",
      );
      expect(response.body).toContain("generated-whsec");
      expect(countOccurrences(response.body, "generated-whsec")).toBe(1);
      expect(response.body).not.toContain("ck_SHOULD_NOT_RENDER");
      expect(response.body).not.toContain("cs_SHOULD_NOT_RENDER");
      expect(response.body).not.toContain(adminApiToken);
    } finally {
      await app.close();
    }
  });

  test("renders connection readiness states from safe metadata only", async () => {
    const { app } = await createUiHarness({
      listConnections: vi.fn(() =>
        Promise.resolve([
          safeConnection({
            id: "11111111-1111-4111-8111-111111111111",
            lastWebhookAt: null,
            verification: { lastVerifiedAt: null, status: null },
          }),
          safeConnection({
            id: "22222222-2222-4222-8222-222222222222",
            lastWebhookAt: null,
          }),
          safeConnection({
            id: "33333333-3333-4333-8333-333333333333",
            lastWebhookAt: "2026-05-24T01:00:00.000Z",
          }),
          safeConnection({
            id: "44444444-4444-4444-8444-444444444444",
            status: "DISABLED",
          }),
        ]),
      ),
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/commerce-connections/woocommerce?shopDomain=tenant-a.example.test",
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Test REST credentials");
      expect(response.body).toContain("Create/verify Woo webhook");
      expect(response.body).toContain("Ready");
      expect(response.body).toContain("Disabled");
      expect(response.body).toContain("Last webhook");
      expect(response.body).toContain("Last REST sync");
      expect(response.body).toContain("Generate WordPress plugin pairing code");
      expect(response.body).toContain(
        'action="/admin/ui/commerce-connections/woocommerce/33333333-3333-4333-8333-333333333333/pairing-code"',
      );
      expect(response.body).toContain(
        `Creates a ${DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES}-minute one-time code`,
      );
      expect(response.body).not.toContain("crp-pair-");
      expect(response.body).not.toContain("generated-whsec");
      expect(response.body).not.toContain("ck_SHOULD_NOT_RENDER");
      expect(response.body).not.toContain("cs_SHOULD_NOT_RENDER");
    } finally {
      await app.close();
    }
  });

  test("rejects ciphertext-bearing renderer payloads instead of exposing repository records", async () => {
    const unsafeConnection = {
      ...safeConnection(),
      consumerKey: "ck_RAW_SHOULD_NOT_RENDER",
      consumerKeyCiphertext: "ciphertext_SHOULD_NOT_RENDER",
      consumerSecret: "cs_RAW_SHOULD_NOT_RENDER",
      consumerSecretCiphertext: "ciphertext_SHOULD_NOT_RENDER",
      webhookSecret: "whsec_RAW_SHOULD_NOT_RENDER",
      webhookSecretCiphertext: "ciphertext_SHOULD_NOT_RENDER",
    } as SafeWooCommerceConnection;
    const { app } = await createUiHarness({
      listConnections: vi.fn(() => Promise.resolve([unsafeConnection])),
    });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/commerce-connections/woocommerce?shopDomain=tenant-a.example.test",
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain(
        "Unsafe commerce connection render payload",
      );
      expect(response.body).not.toContain("ciphertext_SHOULD_NOT_RENDER");
      expect(response.body).not.toContain("ck_RAW_SHOULD_NOT_RENDER");
      expect(response.body).not.toContain("cs_RAW_SHOULD_NOT_RENDER");
      expect(response.body).not.toContain("whsec_RAW_SHOULD_NOT_RENDER");
    } finally {
      await app.close();
    }
  });

  test("rejects invalid shopDomain query as a safe 400 UI error", async () => {
    const listConnections = vi.fn(() => Promise.resolve([safeConnection()]));
    const { app } = await createUiHarness({ listConnections });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/commerce-connections/woocommerce?shopDomain=bad_domain",
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("shopDomain is invalid");
      expect(listConnections).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("generates a server-side WordPress plugin pairing code once without redisplay", async () => {
    const issuedAt = new Date("2026-06-04T01:00:00.000Z");
    const expiresAt = new Date(
      issuedAt.getTime() +
        DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES * 60_000,
    );
    const pairingCodeService = {
      createPairingCode: vi.fn(() =>
        Promise.resolve({
          code: "crp-pair-test-code",
          expiresAt,
          siteUrl: "https://woo.example.test",
        }),
      ),
    };
    const { app } = await createUiHarness({
      now: () => issuedAt,
      pairingCodeService,
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/pairing-code",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          shopDomain: "tenant-a.example.test",
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        "WordPress plugin pairing code generated.",
      );
      expect(response.body).toContain("WordPress plugin pairing code");
      expect(response.body).toContain("Copy the generated pairing code now");
      expect(response.body).toContain("https://woo.example.test");
      expect(response.body).toContain(expiresAt.toISOString());
      expect(response.body).toContain("shown only in this response");
      expect(countOccurrences(response.body, "crp-pair-test-code")).toBe(1);
      expect(pairingCodeService.createPairingCode).toHaveBeenCalledWith({
        commerceConnectionId: "11111111-1111-4111-8111-111111111111",
        issuedAt,
        issuedBy: "web-operator",
        siteUrl: "https://woo.example.test",
      });
      expect(response.body).not.toContain("ck_SHOULD_NOT_RENDER");
      expect(response.body).not.toContain("cs_SHOULD_NOT_RENDER");
      expect(response.body).not.toContain(adminApiToken);
      expect(response.body).not.toContain("codeHash");
      expect(response.body).not.toContain("consumerSecret");
      expect(response.body).not.toContain("tokenPrefix");

      const refresh = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/commerce-connections/woocommerce?shopDomain=tenant-a.example.test",
      });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.body).not.toContain("crp-pair-test-code");
      expect(pairingCodeService.createPairingCode).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  test("requires CSRF and enabled service before generating a pairing code", async () => {
    const pairingCodeService = {
      createPairingCode: vi.fn(() =>
        Promise.resolve({
          code: "crp-pair-should-not-render",
          expiresAt: new Date("2026-06-04T01:15:00.000Z"),
          siteUrl: "https://woo.example.test",
        }),
      ),
    };
    const { app } = await createUiHarness({ pairingCodeService });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const csrfResponse = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/pairing-code",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken: "tampered",
          shopDomain: "tenant-a.example.test",
        }),
      });

      expect(csrfResponse.statusCode).toBe(400);
      expect(csrfResponse.body).toContain("Invalid admin UI CSRF token");
      expect(csrfResponse.body).not.toContain("crp-pair-should-not-render");
      expect(pairingCodeService.createPairingCode).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }

    const missingService = await createUiHarness({ pairingCodeService: null });
    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(missingService.app);
      const response = await missingService.app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/pairing-code",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          shopDomain: "tenant-a.example.test",
        }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain(
        "WordPress plugin pairing code generation is not enabled in this runtime.",
      );
      expect(response.body).not.toContain(
        'action="/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/pairing-code"',
      );
      expect(response.body).not.toContain("crp-pair-");
      expect(response.body).not.toContain("Error:");
      expect(response.body).not.toContain("requirePairingCodeService");
      expect(response.body).not.toContain(adminApiToken);
    } finally {
      await missingService.app.close();
    }
  });

  test("rejects WordPress-plugin sessions before pairing code generation", async () => {
    const pairingCodeService = {
      createPairingCode: vi.fn(() =>
        Promise.resolve({
          code: "crp-pair-should-not-render",
          expiresAt: new Date("2026-06-04T01:15:00.000Z"),
          siteUrl: "https://woo.example.test",
        }),
      ),
    };
    const { app } = await createUiHarness({ pairingCodeService });
    const { token } = createAdminWebLaunchToken({
      returnPath: "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      sessionSecret: webSessionSecret,
      shopDomain: "tenant-a.example.test",
      subject: "wordpress-plugin:tenant-a.example.test",
    });

    try {
      const launch = await app.inject({
        method: "GET",
        url: `/admin/ui/plugin-launch?token=${encodeURIComponent(token)}`,
      });
      expect(launch.statusCode).toBe(303);
      const cookie = readSetCookie(launch);
      const bootstrap = await app.inject({
        headers: { cookie },
        method: "GET",
        url: "/admin/ui/app/orders?shopDomain=tenant-a.example.test",
      });
      expect(bootstrap.statusCode).toBe(200);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/pairing-code",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken: "plugin-session-has-no-admin-csrf",
          shopDomain: "tenant-a.example.test",
        }),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain("/admin/ui/app/orders?");
      expect(response.headers.location).toContain(
        "Connection+setup+requires+CLEVER+admin+login",
      );
      expect(pairingCodeService.createPairingCode).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("rejects tampered hidden shopDomain before connection-id mutations", async () => {
    const getConnection = vi.fn(() =>
      Promise.resolve(safeConnection({ shopDomain: "tenant-b.example.test" })),
    );
    const rotateCredentials = vi.fn(() => Promise.resolve(safeConnection()));
    const rotateWebhookSecret = vi.fn(() =>
      Promise.resolve({
        connection: safeConnection(),
        webhookSetup: { oneTimeSecret: "new-whsec" },
      }),
    );
    const updateStatus = vi.fn(() =>
      Promise.resolve(safeConnection({ status: "DISABLED" })),
    );
    const pairingCodeService = {
      createPairingCode: vi.fn(() =>
        Promise.resolve({
          code: "crp-pair-should-not-render",
          expiresAt: new Date("2026-06-04T01:15:00.000Z"),
          siteUrl: "https://woo.example.test",
        }),
      ),
    };
    const { app } = await createUiHarness({
      getConnection,
      pairingCodeService,
      rotateCredentials,
      rotateWebhookSecret,
      updateStatus,
    });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const credentialResponse = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/credentials",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          shopDomain: "tenant-a.example.test",
          wooConsumerKey: "ck_rotated_SHOULD_NOT_RENDER",
          wooConsumerSecret: "cs_rotated_SHOULD_NOT_RENDER",
        }),
      });
      const webhookResponse = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/webhook-secret",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          shopDomain: "tenant-a.example.test",
          webhookSecret: "",
        }),
      });
      const statusResponse = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/status",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          shopDomain: "tenant-a.example.test",
          status: "DISABLED",
        }),
      });
      const pairingResponse = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/11111111-1111-4111-8111-111111111111/pairing-code",
        ...authenticatedMultipartRequest(cookie, {
          csrfToken,
          shopDomain: "tenant-a.example.test",
        }),
      });

      expect(credentialResponse.statusCode).toBe(403);
      expect(webhookResponse.statusCode).toBe(403);
      expect(statusResponse.statusCode).toBe(403);
      expect(pairingResponse.statusCode).toBe(403);
      expect(rotateCredentials).not.toHaveBeenCalled();
      expect(rotateWebhookSecret).not.toHaveBeenCalled();
      expect(updateStatus).not.toHaveBeenCalled();
      expect(pairingCodeService.createPairingCode).not.toHaveBeenCalled();
      expect(
        `${credentialResponse.body}${webhookResponse.body}${statusResponse.body}${pairingResponse.body}`,
      ).not.toContain("ck_rotated_SHOULD_NOT_RENDER");
      expect(
        `${credentialResponse.body}${webhookResponse.body}${statusResponse.body}${pairingResponse.body}`,
      ).not.toContain("crp-pair-should-not-render");
      expect(getConnection).toHaveBeenCalledTimes(4);
    } finally {
      await app.close();
    }
  });

  test("rejects file uploads and unexpected fields before service calls", async () => {
    const { app, testConnection } = await createUiHarness();

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/test",
        ...authenticatedMultipartRequest(
          cookie,
          credentialFormFields({ csrfToken }),
          {
            file: {
              content: "not allowed",
              filename: "secret.txt",
              name: "attachment",
            },
          },
        ),
      });
      const unexpected = await app.inject({
        method: "POST",
        url: "/admin/ui/commerce-connections/woocommerce/test",
        ...authenticatedMultipartRequest(cookie, {
          ...credentialFormFields({ csrfToken }),
          unexpected: "value",
        }),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain("error=");
      expect(unexpected.statusCode).toBe(303);
      expect(unexpected.headers.location).toContain("error=");
      expect(testConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("lists Route Ops notifications through the browser app API with tenant scoping", async () => {
    const notificationService = {
      createNotificationOnce: vi.fn(),
      listNotifications: vi.fn(() =>
        Promise.resolve({
          notifications: [
            {
              body: "Woo changed the destination after routing.",
              createdAt: "2026-06-05T07:00:00.000Z",
              href: "/admin/ui/app/routes/route-plan-id",
              id: "notification-id",
              orderId: "order-id",
              payload: { afterAddressHash: "hash-after" },
              readAt: null,
              routePlanId: "route-plan-id",
              severity: "critical" as const,
              title: "Route assigned order address changed",
              type: "WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED",
            },
          ],
          unreadCount: 1,
        }),
      ),
      markNotificationRead: vi.fn(),
    };
    const { app } = await createUiHarness({ notificationService });

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { accept: "application/json", cookie },
        method: "GET",
        url: "/admin/ui/app/api/notifications?shopDomain=tenant-a.example.test&limit=10",
      });

      expect(response.statusCode).toBe(200);
      expect(readApiData<{ unreadCount: number }>(response).unreadCount).toBe(
        1,
      );
      expect(notificationService.listNotifications).toHaveBeenCalledWith({
        includeRead: true,
        limit: 10,
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("does not hide missing Route Ops notification service as an empty notification list", async () => {
    const { app } = await createUiHarness();

    try {
      const { cookie } = await loginAndReadCsrf(app);
      const response = await app.inject({
        headers: { accept: "application/json", cookie },
        method: "GET",
        url: "/admin/ui/app/api/notifications?shopDomain=tenant-a.example.test",
      });

      expect(response.statusCode).toBe(400);
      expect(readApiError(response)).toEqual(
        expect.objectContaining({
          code: "BAD_REQUEST",
          message: "Notification service is not enabled in this runtime.",
        }),
      );
    } finally {
      await app.close();
    }
  });


  test("reads order customer note context through the authenticated shop context", async () => {
    const deliveryCustomerService = {
      getOrderCustomerNoteContext: vi.fn(() =>
        Promise.resolve({
          customerNote: "Please ring once.",
          deliveryCustomer: {
            adminMemo: "Prefers evening drop-off",
            matchReasons: ["same_address_phone_exact"],
            matchStatus: "AUTO_MATCHED" as const,
            profileId: "11111111-1111-4111-8111-111111111201",
          },
          orderId: "11111111-1111-4111-8111-111111111101",
        }),
      ),
      mergeProfiles: vi.fn(),
      updateAdminMemo: vi.fn(),
    };
    const { app } = await createUiHarness({ deliveryCustomerService });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/orders/11111111-1111-4111-8111-111111111101/customer-note-context?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(response.statusCode).toBe(200);
      expect(readApiData<{ customerNote: string | null }>(response).customerNote).toBe(
        "Please ring once.",
      );
      expect(
        deliveryCustomerService.getOrderCustomerNoteContext,
      ).toHaveBeenCalledWith({
        orderId: "11111111-1111-4111-8111-111111111101",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("updates delivery customer admin memo without mutating the source order note", async () => {
    const updateAdminMemo = vi.fn(() =>
      Promise.resolve({
        deliveryCustomer: {
          adminMemo: "Gate code 1234",
          profileId: "11111111-1111-4111-8111-111111111201",
        },
      }),
    );
    const deliveryCustomerService = {
      getOrderCustomerNoteContext: vi.fn(),
      mergeProfiles: vi.fn(),
      updateAdminMemo,
    };
    const { app } = await createUiHarness({ deliveryCustomerService });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/delivery-customers/11111111-1111-4111-8111-111111111201/admin-memo?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          { adminMemo: "Gate code 1234" },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(200);
      expect(
        readApiData<{ deliveryCustomer: { adminMemo: string | null } }>(response)
          .deliveryCustomer.adminMemo,
      ).toBe("Gate code 1234");
      expect(updateAdminMemo).toHaveBeenCalledWith({
        adminMemo: "Gate code 1234",
        profileId: "11111111-1111-4111-8111-111111111201",
        shopDomain: "tenant-a.example.test",
      });
      expect(
        deliveryCustomerService.getOrderCustomerNoteContext,
      ).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("keeps delivery customer merge backend-only behind CSRF", async () => {
    const mergeProfiles = vi.fn(() =>
      Promise.resolve({
        deliveryCustomer: {
          adminMemo: null,
          profileId: "11111111-1111-4111-8111-111111111202",
        },
        mergedProfileId: "11111111-1111-4111-8111-111111111201",
      }),
    );
    const deliveryCustomerService = {
      getOrderCustomerNoteContext: vi.fn(),
      mergeProfiles,
      updateAdminMemo: vi.fn(),
    };
    const { app } = await createUiHarness({ deliveryCustomerService });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "POST",
        url: "/admin/ui/app/api/delivery-customers/11111111-1111-4111-8111-111111111201/merge?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(
          cookie,
          { targetProfileId: "11111111-1111-4111-8111-111111111202" },
          csrfToken,
        ),
      });

      expect(response.statusCode).toBe(200);
      expect(mergeProfiles).toHaveBeenCalledWith({
        sourceProfileId: "11111111-1111-4111-8111-111111111201",
        targetProfileId: "11111111-1111-4111-8111-111111111202",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("marks Route Ops notifications read only through the authenticated shop context", async () => {
    const notificationService = {
      createNotificationOnce: vi.fn(),
      listNotifications: vi.fn(),
      markNotificationRead: vi.fn(() =>
        Promise.resolve({
          body: null,
          createdAt: "2026-06-05T07:00:00.000Z",
          href: null,
          id: "notification-id",
          orderId: null,
          payload: null,
          readAt: "2026-06-05T07:01:00.000Z",
          routePlanId: null,
          severity: "info" as const,
          title: "Read notification",
          type: "SYSTEM",
        }),
      ),
    };
    const { app } = await createUiHarness({ notificationService });

    try {
      const { cookie, csrfToken } = await loginAndReadCsrf(app);
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/ui/app/api/notifications/notification-id/read?shopDomain=tenant-a.example.test",
        ...authenticatedJsonRequest(cookie, {}, csrfToken),
      });

      expect(response.statusCode).toBe(200);
      expect(
        readApiData<{ notification: { readAt: string | null } }>(response)
          .notification.readAt,
      ).toBe("2026-06-05T07:01:00.000Z");
      expect(notificationService.markNotificationRead).toHaveBeenCalledWith({
        notificationId: "notification-id",
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });
});

async function createUiHarness(
  overrides: Partial<{
    actor: AdminCommerceActor;
    createConnection: ReturnType<typeof vi.fn>;
    driverAppDownloadUrl: string | null;
    deliveryCustomerService: AdminCommerceConnectionsUiDependencies["deliveryCustomerService"];
    driverService: AdminCommerceConnectionsUiDependencies["driverService"];
    geocodingService: AdminCommerceConnectionsUiDependencies["geocodingService"];
    getConnection: ReturnType<typeof vi.fn>;
    listConnections: ReturnType<typeof vi.fn>;
    orderIngestAuditService: AdminCommerceConnectionsUiDependencies["orderIngestAuditService"];
    orderSyncService: AdminCommerceConnectionsUiDependencies["orderSyncService"];
    notificationService: AdminCommerceConnectionsUiDependencies["notificationService"];
    pairingCodeService:
      | AdminCommerceConnectionsUiDependencies["pairingCodeService"]
      | null;
    rotateCredentials: ReturnType<typeof vi.fn>;
    rotateWebhookSecret: ReturnType<typeof vi.fn>;
    routeOptimizationJobService: AdminCommerceConnectionsUiDependencies["routeOptimizationJobService"];
    routeOptimizationService: AdminCommerceConnectionsUiDependencies["routeOptimizationService"];
    routePlanService: AdminCommerceConnectionsUiDependencies["routePlanService"];
    settingsService: AdminCommerceConnectionsUiDependencies["settingsService"];
    testConnection: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    wooSyncService: AdminCommerceConnectionsUiDependencies["wooSyncService"];
    now: () => Date;
  }> = {},
  options: {
    logger?: Exclude<Parameters<typeof buildApp>[0], undefined>["logger"];
  } = {},
) {
  const listConnections =
    overrides.listConnections ??
    vi.fn(() => Promise.resolve([safeConnection()]));
  const testConnection =
    overrides.testConnection ??
    vi.fn(() =>
      Promise.resolve({
        checkedAt: "2026-05-24T00:00:00.000Z",
        status: "VERIFIED" as const,
      }),
    );
  const createConnection =
    overrides.createConnection ??
    vi.fn(() =>
      Promise.resolve({
        connection: safeConnection(),
        webhookSetup: { oneTimeSecret: "generated-whsec" },
      }),
    );
  const getConnection =
    overrides.getConnection ?? vi.fn(() => Promise.resolve(safeConnection()));
  const rotateCredentials =
    overrides.rotateCredentials ??
    vi.fn(() => Promise.resolve(safeConnection()));
  const rotateWebhookSecret =
    overrides.rotateWebhookSecret ??
    vi.fn(() =>
      Promise.resolve({
        connection: safeConnection(),
        webhookSetup: { oneTimeSecret: "new-whsec" },
      }),
    );
  const updateStatus =
    overrides.updateStatus ??
    vi.fn(() => Promise.resolve(safeConnection({ status: "DISABLED" })));
  const pairingCodeService =
    overrides.pairingCodeService === null
      ? undefined
      : (overrides.pairingCodeService ?? {
          createPairingCode: vi.fn(() =>
            Promise.resolve({
              code: "crp-pair-default-test-code",
              expiresAt: new Date("2026-06-04T01:15:00.000Z"),
              siteUrl: "https://woo.example.test",
            }),
          ),
        });
  const onboardingService: AdminCommerceConnectionsUiDependencies["onboardingService"] =
    {
      createConnection:
        createConnection as unknown as AdminCommerceConnectionsUiDependencies["onboardingService"]["createConnection"],
      getConnection:
        getConnection as unknown as AdminCommerceConnectionsUiDependencies["onboardingService"]["getConnection"],
      listConnections:
        listConnections as unknown as AdminCommerceConnectionsUiDependencies["onboardingService"]["listConnections"],
      rotateCredentials:
        rotateCredentials as unknown as AdminCommerceConnectionsUiDependencies["onboardingService"]["rotateCredentials"],
      rotateWebhookSecret:
        rotateWebhookSecret as unknown as AdminCommerceConnectionsUiDependencies["onboardingService"]["rotateWebhookSecret"],
      testConnection:
        testConnection as unknown as AdminCommerceConnectionsUiDependencies["onboardingService"]["testConnection"],
      updateStatus:
        updateStatus as unknown as AdminCommerceConnectionsUiDependencies["onboardingService"]["updateStatus"],
    };
  const dependencies: AdminCommerceConnectionsUiDependencies = {
    actor: overrides.actor ?? {
      allowedShopDomains: "*",
      subject: "web-operator",
    },
    loginSecret: webLoginSecret,
    ...(overrides.driverAppDownloadUrl === null ||
    overrides.driverAppDownloadUrl === undefined
      ? {}
      : { driverAppDownloadUrl: overrides.driverAppDownloadUrl }),
    ...(overrides.geocodingService === undefined
      ? {}
      : { geocodingService: overrides.geocodingService }),
    onboardingService,
    ...(pairingCodeService === undefined ? {} : { pairingCodeService }),
    ...(overrides.deliveryCustomerService === undefined
      ? {}
      : { deliveryCustomerService: overrides.deliveryCustomerService }),
    ...(overrides.driverService === undefined
      ? {}
      : { driverService: overrides.driverService }),
    ...(overrides.orderIngestAuditService === undefined
      ? {}
      : { orderIngestAuditService: overrides.orderIngestAuditService }),
    ...(overrides.orderSyncService === undefined
      ? {}
      : { orderSyncService: overrides.orderSyncService }),
    ...(overrides.notificationService === undefined
      ? {}
      : { notificationService: overrides.notificationService }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    publicBaseUrl: "https://clever-route.cleversystem.ai",
    ...(overrides.routeOptimizationJobService === undefined
      ? {}
      : { routeOptimizationJobService: overrides.routeOptimizationJobService }),
    ...(overrides.routeOptimizationService === undefined
      ? {}
      : { routeOptimizationService: overrides.routeOptimizationService }),
    ...(overrides.routePlanService === undefined
      ? {}
      : { routePlanService: overrides.routePlanService }),
    ...(overrides.settingsService === undefined
      ? {}
      : { settingsService: overrides.settingsService }),
    ...(overrides.wooSyncService === undefined
      ? {}
      : { wooSyncService: overrides.wooSyncService }),
    secureCookies: false,
    sessionSecret: webSessionSecret,
  };
  return {
    app: await buildApp({
      adminCommerceConnectionsUi: dependencies,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
    createConnection,
    getConnection,
    listConnections,
    rotateCredentials,
    rotateWebhookSecret,
    testConnection,
    updateStatus,
  };
}

async function withRouteOpsMapEnv<T>(
  env: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const keys = [
    "ROUTE_OPS_MAP_ALLOWED_HOSTS",
    "ROUTE_OPS_MAP_ATTRIBUTION",
    "ROUTE_OPS_MAP_PROVIDER_MODE",
    "ROUTE_OPS_MAP_STYLE_URL",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withRouteOpsRouterEnv<T>(
  env: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const keys = ["OSRM_BASE_URL", "ROUTE_OPS_ROUTER_COVERAGE"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createBaseAdminCommerceDependencies() {
  const testConnection = vi.fn(() =>
    Promise.resolve({
      checkedAt: "2026-05-24T00:00:00.000Z",
      status: "VERIFIED" as const,
    }),
  );
  const adminTokenVerifier = {
    verify: vi.fn(() => ({
      allowedShopDomains: "*" as const,
      subject: "api-operator",
    })),
  };
  const dependencies: AdminCommerceConnectionsDependencies = {
    adminTokenVerifier,
    onboardingService: {
      createConnection: vi.fn(() =>
        Promise.resolve({
          connection: safeConnection(),
          webhookSetup: { oneTimeSecret: "generated-whsec" },
        }),
      ),
      getConnection: vi.fn(() => Promise.resolve(safeConnection())),
      listConnections: vi.fn(() => Promise.resolve([safeConnection()])),
      rotateCredentials: vi.fn(() => Promise.resolve(safeConnection())),
      rotateWebhookSecret: vi.fn(() =>
        Promise.resolve({
          connection: safeConnection(),
          webhookSetup: { oneTimeSecret: "new-whsec" },
        }),
      ),
      testConnection,
      updateStatus: vi.fn(() =>
        Promise.resolve(safeConnection({ status: "DISABLED" })),
      ),
    },
    publicBaseUrl: "https://clever-route.cleversystem.ai",
  };
  return { adminTokenVerifier, dependencies, testConnection };
}

async function loginAndReadCsrf(
  app: Awaited<ReturnType<typeof buildApp>>,
): Promise<{ cookie: string; csrfToken: string }> {
  const login = await app.inject({
    method: "POST",
    url: "/admin/ui/login",
    ...multipartRequest({ loginSecret: webLoginSecret }),
  });
  expect(login.statusCode).toBe(303);
  const cookie = readSetCookie(login);
  const home = await app.inject({
    headers: { cookie },
    method: "GET",
    url: "/admin/ui/commerce-connections/woocommerce",
  });
  expect(home.statusCode).toBe(200);
  const { csrfToken } = readCsrfFromHtml(home.body);
  return { cookie, csrfToken };
}

function readSetCookie(
  response: Awaited<ReturnType<Awaited<ReturnType<typeof buildApp>>["inject"]>>,
): string {
  return readSetCookies(response)[0] ?? "";
}

function readSetCookies(
  response: Awaited<ReturnType<Awaited<ReturnType<typeof buildApp>>["inject"]>>,
): string[] {
  const header = response.headers["set-cookie"];
  if (Array.isArray(header)) return header;
  return typeof header === "string" ? [header] : [];
}

function expectCookieClearPaths(cookies: string[], paths: string[]): void {
  for (const path of paths) {
    expect(
      cookies.some(
        (cookie) =>
          cookie.includes("Max-Age=0") && cookie.includes(`Path=${path}`),
      ),
    ).toBe(true);
  }
}

function readCsrfFromHtml(body: string): { csrfToken: string } {
  const match = csrfFieldPattern.exec(body);
  if (match?.[1] === undefined)
    throw new Error("Expected CSRF token in admin UI HTML");
  return { csrfToken: match[1] };
}

function countOccurrences(value: string, pattern: string): number {
  return value.split(pattern).length - 1;
}

function safeConnection(
  overrides: Partial<SafeWooCommerceConnection> = {},
): SafeWooCommerceConnection {
  return {
    credential: {
      fingerprint: "ck:abc123",
      rotatedAt: "2026-05-24T00:00:00.000Z",
      status: "stored",
    },
    id: "11111111-1111-4111-8111-111111111111",
    label: "Woo main",
    lastRestSyncAt: null,
    lastWebhookAt: null,
    shopDomain: "tenant-a.example.test",
    siteUrl: "https://woo.example.test",
    status: "ACTIVE",
    timezone: "America/Toronto",
    verification: {
      lastVerifiedAt: "2026-05-24T00:00:00.000Z",
      status: "VERIFIED",
    },
    webhook: { rotatedAt: "2026-05-24T00:00:00.000Z", status: "stored" },
    ...overrides,
  };
}

function canonicalOrder(
  overrides: Partial<
    Awaited<
      ReturnType<
        NonNullable<
          AdminCommerceConnectionsUiDependencies["orderSyncService"]
        >["listCanonicalOrders"]
      >
    >[number]
  > = {},
) {
  return {
    cancelledAt: null,
    currencyCode: "CAD",
    deliveryArea: "Toronto",
    deliveryBatchEndDate: null,
    deliveryBatchStartDate: null,
    deliveryDate: "2026-05-26",
    deliveryDateSource: "EXPLICIT_ATTRIBUTE" as const,
    deliveryDayRaw: "Tuesday",
    deliverySession: "DAY" as const,
    deliveryStopId: "stop-1",
    deliveryStopStatus: "PENDING",
    deliveryWeekday: "TUESDAY" as const,
    email: "customer@example.test",
    financialStatus: "paid",
    fulfillmentStatus: "unfulfilled",
    geocodeStatus: "RESOLVED" as const,
    hasCoordinates: true,
    latitude: 43.6532,
    longitude: -79.3832,
    name: "#1001",
    orderCreatedAt: "2026-05-25T12:00:00.000Z",
    orderDateLocal: "2026-05-25",
    orderId: "order-1",
    phone: "+14165550100",
    pickup: false,
    planningGroupKey: "2026-05-26|DELIVERY|||Toronto",
    planningStatus: "UNPLANNED" as const,
    processedAt: "2026-05-25T12:00:00.000Z",
    readiness: "READY_TO_PLAN" as const,
    recipientName: "Jane Customer",
    reviewReasons: [] as string[],
    routePlanId: null,
    routePlanName: null,
    routePlanStatus: null,
    routeScopeKey: "2026-05-26|DELIVERY||",
    serviceType: "DELIVERY" as const,
    shippingAddress: {
      address1: "100 King St W",
      address2: null,
      city: "Toronto",
      countryCode: "CA",
      postalCode: "M5H 1J9",
      province: "ON",
    },
    shopifyOrderGid: "gid://woocommerce/Order/1001",
    shopifyOrderLegacyId: "1001",
    sourceOrderId: "1001",
    sourceOrderNumber: "1001",
    sourcePlatform: "WOOCOMMERCE" as const,
    sourceSiteUrl: "https://woo.example.test",
    sourceUpdatedAt: "2026-05-25T12:00:00.000Z",
    timeWindowEnd: null,
    timeWindowStart: null,
    totalPriceAmount: "45.00",
    updatedAtShopify: "2026-05-25T12:00:00.000Z",
    ...overrides,
  };
}

function routePlanSummary() {
  return {
    createdAt: "2026-05-26T12:00:00.000Z",
    deliveryAreas: ["Toronto"],
    deliveryDate: "2026-05-26",
    deliveryDays: ["Tuesday"],
    depot: { latitude: 43.6532, longitude: -79.3832 },
    driver: null,
    driverId: null,
    id: "route-plan-id",
    missingCoordinates: 0,
    name: "Route draft",
    planDate: "2026-05-26",
    routeEndMode: "END_AT_LAST_STOP" as const,
    status: "DRAFT",
    stopsCount: 2,
    updatedAt: "2026-05-26T12:00:00.000Z",
  };
}

function routePlanDetail() {
  return {
    routeGeometry: null,
    routeMetrics: null,
    routePlan: routePlanSummary(),
    routeStopPoints: [],
    stops: [
      {
        address: canonicalOrder().shippingAddress,
        attributes: [],
        coordinates: { latitude: 43.6532, longitude: -79.3832 },
        deliveryArea: "Toronto",
        deliveryDay: "Tuesday",
        deliveryStopId: "stop-1",
        financialStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        orderId: "order-1",
        orderName: "#1001",
        paymentStatus: "paid",
        recipientName: "Jane Customer",
        sequence: 1,
        shopifyOrderGid: "gid://woocommerce/Order/1001",
        status: "PENDING",
      },
      {
        address: canonicalOrder().shippingAddress,
        attributes: [],
        coordinates: { latitude: 43.7, longitude: -79.4 },
        deliveryArea: "Toronto",
        deliveryDay: "Tuesday",
        deliveryStopId: "stop-2",
        financialStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        orderId: "order-2",
        orderName: "#1002",
        paymentStatus: "paid",
        recipientName: "John Customer",
        sequence: 2,
        shopifyOrderGid: "gid://woocommerce/Order/1002",
        status: "PENDING",
      },
    ],
  };
}

function driverRow() {
  return {
    authStatus: "INVITE_PENDING" as const,
    authSubject: null,
    createdAt: "2026-05-26T12:00:00.000Z",
    displayName: "Alex Driver",
    id: "driver-id",
    inviteCode: "DRV123",
    inviteCodeExpiresAt: "2026-05-27T12:00:00.000Z",
    lastSeenAt: null,
    phone: "+14165550123",
    recentEventsCount: 0,
    status: "PENDING" as const,
    updatedAt: "2026-05-26T12:00:00.000Z",
  };
}

function storeSettings(
  overrides: Partial<
    NonNullable<
      Awaited<
        ReturnType<
          NonNullable<
            AdminCommerceConnectionsUiDependencies["settingsService"]
          >["getSettings"]
        >
      >
    >
  > = {},
) {
  return {
    defaultDepotAddress: "123 Depot St, Toronto, ON",
    defaultDepotLatitude: 43.6532,
    defaultDepotLongitude: -79.3832,
    locale: "en-CA",
    routeOpsUiSettings: defaultRouteOpsUiSettings(),
    routeScopeConfig: defaultRouteScopeConfig(),
    shopDomain: "tenant-a.example.test",
    ...overrides,
  };
}

function credentialFormFields(input: {
  csrfToken: string;
}): Record<string, string> {
  return {
    csrfToken: input.csrfToken,
    label: "Woo main",
    shopDomain: "tenant-a.example.test",
    siteUrl: "https://woo.example.test",
    timezone: "America/Toronto",
    webhookSecret: "",
    wooConsumerKey: "ck_SHOULD_NOT_RENDER",
    wooConsumerSecret: "cs_SHOULD_NOT_RENDER",
  };
}

function multipartRequest(
  fields: Record<string, string>,
  options: { file?: { content: string; filename: string; name: string } } = {},
): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `admin-ui-boundary-${Math.random().toString(36).slice(2)}`;
  const chunks = Object.entries(fields).map(([name, value]) =>
    fieldPart(boundary, name, value),
  );
  if (options.file !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${options.file.name}"; filename="${options.file.filename}"\r\n` +
          "Content-Type: text/plain\r\n\r\n" +
          `${options.file.content}\r\n`,
        "utf8",
      ),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}

function authenticatedMultipartRequest(
  cookie: string,
  fields: Record<string, string>,
  options: { file?: { content: string; filename: string; name: string } } = {},
  headers: Record<string, string> = {},
): { headers: Record<string, string>; payload: Buffer } {
  const request = multipartRequest(fields, options);
  return {
    headers: { ...request.headers, ...headers, cookie },
    payload: request.payload,
  };
}

function authenticatedJsonRequest(
  cookie: string,
  body: unknown,
  csrfToken?: string,
): {
  headers: Record<string, string>;
  payload: string;
} {
  return {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      ...(csrfToken === undefined ? {} : { "x-csrf-token": csrfToken }),
    },
    payload: JSON.stringify(body),
  };
}

function fieldPart(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    "utf8",
  );
}
