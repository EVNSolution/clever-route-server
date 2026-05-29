import { existsSync, readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AdminCommerceActor } from "../src/modules/commerce/admin-commerce-auth.js";
import { loadAdminCommerceConnectionsUiDependencies } from "../src/modules/commerce/admin-commerce-connections.dependencies.js";
import type { SafeWooCommerceConnection } from "../src/modules/commerce/commerce-connection.service.js";
import { RoutePlanBatchInvalidError } from "../src/modules/route-plans/route-plan.types.js";
import type { AdminCommerceConnectionsDependencies } from "../src/routes/admin-commerce-connections.routes.js";
import type { AdminCommerceConnectionsUiDependencies } from "../src/routes/admin-commerce-connections-ui.routes.js";
import {
  createAdminWebLaunchToken,
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
          CLEVER_ADMIN_WEB_LOGIN_SECRET: webLoginSecret,
          CLEVER_ADMIN_WEB_SESSION_SECRET: webSessionSecret,
          DELIVERY_API_PUBLIC_URL: "https://clever-route.cleversystem.ai",
        },
        nodeEnv: "production",
      }),
    ).toBeDefined();
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
    expect(
      verifyAdminWebLoginSecret({
        candidate: webLoginSecret,
        expected: webLoginSecret,
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

      const dashboardRedirect = await app.inject({
        method: "GET",
        url: "/admin/ui",
      });
      expect(dashboardRedirect.statusCode).toBe(303);
      expect(dashboardRedirect.headers.location).toBe("/admin/ui/login");

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
      expect(login.headers.location).toBe("/admin/ui");
      const setCookies = readSetCookies(login);
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
      expect(dashboard.body).toContain("WooCommerce connection setup");
      expect(dashboard.body).toContain("/admin/ui/app/orders");
      expect(dashboard.body).toContain("Orders");
      expect(dashboard.body).toContain("Routes");
      expect(dashboard.body).toContain("Drivers");
      expect(dashboard.body).toContain("Settings");
      expect(dashboard.body).toContain("-apple-system");

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
      expect(bootstrapData.routerConfig).toEqual({ status: "not_configured" });
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
    >(() => Promise.resolve(storeSettings()));
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
      expect(routes.statusCode).toBe(200);
      expect(
        readApiData<{
          routePlans: Array<{ name: string; stopsCount: number }>;
        }>(routes).routePlans[0],
      ).toEqual(
        expect.objectContaining({ name: "Route draft", stopsCount: 2 }),
      );
      expect(drivers.statusCode).toBe(200);
      expect(
        readApiData<{ drivers: Array<{ displayName: string }> }>(drivers)
          .drivers[0],
      ).toEqual(expect.objectContaining({ displayName: "Alex Driver" }));
      expect(settings.statusCode).toBe(200);
      expect(
        readApiData<{
          settings: { defaultDepotAddress: string | null; locale: string };
        }>(settings).settings,
      ).toEqual(
        expect.objectContaining({
          defaultDepotAddress: "123 Depot St, Toronto, ON",
          locale: "en-CA",
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
        cached: false,
        ok: true as const,
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
        cached: false,
        ok: true as const,
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
          noAddress: number;
          resolved: number;
          skipped: number;
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
          summary: {
            alreadyHasCoordinates: 1,
            attempted: 1,
            failed: 0,
            noAddress: 0,
            resolved: 1,
            skipped: 1,
          },
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
          latitude: 43.589045,
          longitude: -79.644119,
          orderId: "order-missing",
          provider: "mock",
          shopDomain: "tenant-a.example.test",
          source: "geocoder",
        }),
      );
    } finally {
      await app.close();
    }
  });

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
      expect(response.body).not.toContain("rawPayload");
      expect(response.body).not.toContain("customer@example.test");
      expect(response.body).not.toContain("consumer_secret");
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        shopDomain: "tenant-a.example.test",
      });
    } finally {
      await app.close();
    }
  });

  test("geocodes and remembers Route Ops settings depot coordinates", async () => {
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
          defaultDepotLatitude: 43.589045,
          locale: "ko-KR",
        }),
      );
      expect(geocode).toHaveBeenCalledWith(
        expect.objectContaining({ shopDomain: "tenant-a.example.test" }),
      );
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultDepotAddress: "300 City Centre Dr, Mississauga, ON",
          defaultDepotLatitude: 43.589045,
          defaultDepotLongitude: -79.644119,
          locale: "ko-KR",
          shopDomain: "tenant-a.example.test",
        }),
      );
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
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() => Promise.resolve(routePlanDetail()));
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
        routePlan: { id: string; name: string };
        stops: Array<{
          deliveryStopId: string;
          orderName: string;
          sourceOrderId: string;
        }>;
      }>(response);
      expect(detailData.routePlan).toEqual(
        expect.objectContaining({ id: "route-plan-id", name: "Route draft" }),
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
      expect(getRoutePlanDetail).toHaveBeenCalledWith({
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
        listCanonicalOrders: vi.fn(() => Promise.resolve([canonicalOrder()])),
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
    const getRoutePlanDetail = vi.fn<
      NonNullable<
        AdminCommerceConnectionsUiDependencies["routePlanService"]
      >["getRoutePlanDetail"]
    >(() => Promise.resolve(routePlanDetail()));
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
        getRoutePlanDetail,
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

      expect(optimized.statusCode).toBe(200);
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
    const { app } = await createUiHarness({
      getConnection,
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

      expect(credentialResponse.statusCode).toBe(403);
      expect(webhookResponse.statusCode).toBe(403);
      expect(statusResponse.statusCode).toBe(403);
      expect(rotateCredentials).not.toHaveBeenCalled();
      expect(rotateWebhookSecret).not.toHaveBeenCalled();
      expect(updateStatus).not.toHaveBeenCalled();
      expect(
        `${credentialResponse.body}${webhookResponse.body}${statusResponse.body}`,
      ).not.toContain("ck_rotated_SHOULD_NOT_RENDER");
      expect(getConnection).toHaveBeenCalledTimes(3);
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
});

async function createUiHarness(
  overrides: Partial<{
    actor: AdminCommerceActor;
    createConnection: ReturnType<typeof vi.fn>;
    driverService: AdminCommerceConnectionsUiDependencies["driverService"];
    geocodingService: AdminCommerceConnectionsUiDependencies["geocodingService"];
    getConnection: ReturnType<typeof vi.fn>;
    listConnections: ReturnType<typeof vi.fn>;
    orderSyncService: AdminCommerceConnectionsUiDependencies["orderSyncService"];
    rotateCredentials: ReturnType<typeof vi.fn>;
    rotateWebhookSecret: ReturnType<typeof vi.fn>;
    routePlanService: AdminCommerceConnectionsUiDependencies["routePlanService"];
    settingsService: AdminCommerceConnectionsUiDependencies["settingsService"];
    testConnection: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
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
    ...(overrides.geocodingService === undefined
      ? {}
      : { geocodingService: overrides.geocodingService }),
    onboardingService,
    ...(overrides.driverService === undefined
      ? {}
      : { driverService: overrides.driverService }),
    ...(overrides.orderSyncService === undefined
      ? {}
      : { orderSyncService: overrides.orderSyncService }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    publicBaseUrl: "https://clever-route.cleversystem.ai",
    ...(overrides.routePlanService === undefined
      ? {}
      : { routePlanService: overrides.routePlanService }),
    ...(overrides.settingsService === undefined
      ? {}
      : { settingsService: overrides.settingsService }),
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
    status: "DRAFT",
    stopsCount: 2,
    updatedAt: "2026-05-26T12:00:00.000Z",
  };
}

function routePlanDetail() {
  return {
    routeGeometry: null,
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
