import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

type RouteRegistration = {
  line: number;
  method: string;
  pathExpression: string;
};

type RouteSurface = Omit<RouteRegistration, "line">;

const expectedRouteRegistrations: RouteRegistration[] = [
  { line: 413, method: "GET", pathExpression: "\"/\"" },
  { line: 415, method: "GET", pathExpression: "ADMIN_ROOT_PATH" },
  { line: 419, method: "GET", pathExpression: "ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT_PATH" },
  { line: 427, method: "GET", pathExpression: "ADMIN_UI_ROUTE_APP_SCRIPT_PATH" },
  { line: 437, method: "GET", pathExpression: "ADMIN_UI_PLUGIN_LAUNCH_PATH" },
  { line: 481, method: "GET", pathExpression: "ADMIN_UI_ROOT_PATH" },
  { line: 501, method: "GET", pathExpression: "ADMIN_UI_STORE_SESSIONS_PATH" },
  { line: 514, method: "GET", pathExpression: "ADMIN_UI_COMMERCE_CONNECTIONS_PATH" },
  { line: 534, method: "GET", pathExpression: "ADMIN_UI_APP_PATH" },
  { line: 540, method: "GET", pathExpression: "ADMIN_UI_APP_DASHBOARD_PATH" },
  { line: 546, method: "GET", pathExpression: "ADMIN_UI_APP_ORDERS_PATH" },
  { line: 552, method: "GET", pathExpression: "ADMIN_UI_APP_ROUTE_PLANS_PATH" },
  { line: 558, method: "GET", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/new`" },
  { line: 564, method: "GET", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId`" },
  { line: 573, method: "POST", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/create`" },
  { line: 582, method: "POST", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/stops`" },
  { line: 597, method: "POST", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/driver`" },
  { line: 612, method: "POST", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/optimize`" },
  { line: 627, method: "GET", pathExpression: "ADMIN_UI_APP_DRIVERS_PATH" },
  { line: 633, method: "POST", pathExpression: "ADMIN_UI_APP_DRIVERS_PATH" },
  { line: 639, method: "GET", pathExpression: "ADMIN_UI_APP_SETTINGS_PATH" },
  { line: 645, method: "POST", pathExpression: "ADMIN_UI_APP_SETTINGS_PATH" },
  { line: 651, method: "GET", pathExpression: "ADMIN_UI_ROUTE_PLANS_PATH" },
  { line: 661, method: "POST", pathExpression: "`${ADMIN_UI_ROUTE_PLANS_PATH}/create`" },
  { line: 667, method: "POST", pathExpression: "`${ADMIN_UI_ROUTE_PLANS_PATH}/:routePlanId/stops`" },
  { line: 682, method: "POST", pathExpression: "`${ADMIN_UI_ROUTE_PLANS_PATH}/:routePlanId/driver`" },
  { line: 697, method: "GET", pathExpression: "ADMIN_UI_ORDERS_PATH" },
  { line: 707, method: "GET", pathExpression: "ADMIN_UI_DRIVERS_PATH" },
  { line: 717, method: "POST", pathExpression: "ADMIN_UI_DRIVERS_PATH" },
  { line: 723, method: "GET", pathExpression: "ADMIN_UI_SETTINGS_PATH" },
  { line: 733, method: "POST", pathExpression: "ADMIN_UI_SETTINGS_PATH" },
  { line: 739, method: "GET", pathExpression: "LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH" },
  { line: 742, method: "POST", pathExpression: "LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH" },
  { line: 746, method: "GET", pathExpression: "ADMIN_UI_LOGIN_PATH" },
  { line: 755, method: "POST", pathExpression: "ADMIN_UI_LOGIN_PATH" },
  { line: 828, method: "GET", pathExpression: "ADMIN_UI_WOOCOMMERCE_PATH" },
  { line: 850, method: "GET", pathExpression: "ADMIN_UI_LOGOUT_PATH" },
  { line: 853, method: "POST", pathExpression: "ADMIN_UI_LOGOUT_PATH" },
  { line: 856, method: "GET", pathExpression: "LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH" },
  { line: 859, method: "POST", pathExpression: "LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH" },
  { line: 863, method: "POST", pathExpression: "`${ADMIN_UI_WOOCOMMERCE_PATH}/test`" },
  { line: 915, method: "POST", pathExpression: "ADMIN_UI_WOOCOMMERCE_PATH" },
  { line: 956, method: "POST", pathExpression: "`${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/credentials`" },
  { line: 1021, method: "POST", pathExpression: "`${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/webhook-secret`" },
  { line: 1074, method: "POST", pathExpression: "`${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/pairing-code`" },
  { line: 1127, method: "POST", pathExpression: "`${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/status`" },
  { line: 1177, method: "GET", pathExpression: "`${ADMIN_UI_APP_PATH}/*`" },
  { line: 1182, method: "GET", pathExpression: "`${ADMIN_UI_ROOT_PATH}/*`" },
  { line: 1192, method: "GET", pathExpression: "`${ADMIN_UI_APP_ASSETS_PATH}/*`" },
  { line: 1198, method: "GET", pathExpression: "`${ADMIN_UI_APP_VENDOR_PATH}/*`" },
  { line: 1204, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/bootstrap`" },
  { line: 1229, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/notifications`" },
  { line: 1251, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/notifications/:notificationId/read`" },
  { line: 1280, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders`" },
  { line: 1333, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/sync`" },
  { line: 1358, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/sync/latest`" },
  { line: 1375, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/sync/:syncRunId`" },
  { line: 1409, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/woo/:sourceOrderId/sync`" },
  { line: 1436, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode`" },
  { line: 1459, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode/:jobId`" },
  { line: 1471, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/geocode`" },
  { line: 1497, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/geocode/:jobId`" },
  { line: 1509, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/:orderId`" },
  { line: 1538, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata-diagnostics`" },
  { line: 1570, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata`" },
  { line: 1604, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/:orderId/coordinates`" },
  { line: 1640, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/:orderId/geocode`" },
  { line: 1754, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/order-batches`" },
  { line: 1776, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes`" },
  { line: 1795, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes`" },
  { line: 1828, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`" },
  { line: 1849, method: "DELETE", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`" },
  { line: 1871, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`" },
  { line: 1964, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/stops`" },
  { line: 1999, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize`" },
  { line: 2038, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/driver`" },
  { line: 2062, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/options`" },
  { line: 2104, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/publish`" },
  { line: 2144, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/drivers`" },
  { line: 2157, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/drivers`" },
  { line: 2184, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/drivers/:driverId/regenerate-invite-code`" },
  { line: 2222, method: "DELETE", pathExpression: "`${ADMIN_UI_APP_API_PATH}/drivers/:driverId`" },
  { line: 2260, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/settings`" },
  { line: 2276, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/settings`" },
  { line: 2308, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/settings/geocode`" },
  { line: 2381, method: "GET", pathExpression: "ADMIN_UI_APP_API_PATH" },
  { line: 2385, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/*`" }
];

function extractRouteRegistrations(source: string): RouteRegistration[] {
  const lines = source.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  const registrations: RouteRegistration[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trimStart();
    const method = ["get", "post", "patch", "delete"].find((candidate) =>
      trimmed.startsWith(`app.${candidate}`),
    );
    if (method === undefined) return;

    const lineStart = offsets[index] ?? 0;
    const callStart = source.indexOf("(", lineStart + line.indexOf("app."));
    const comma = findFirstArgumentComma(source, callStart);
    const rawExpression = source.slice(callStart + 1, comma);
    registrations.push({
      line: index + 1,
      method: method.toUpperCase(),
      pathExpression: rawExpression.trim().replace(/\s+/gu, " "),
    });
  });

  return registrations;
}

function findFirstArgumentComma(source: string, callStart: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = callStart + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) break;

    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      if (depth === 0) break;
      depth -= 1;
      continue;
    }
    if (character === "," && depth === 0) return index;
  }

  throw new Error("Could not parse Fastify route registration first argument");
}

function toRouteSurface(registration: RouteRegistration): RouteSurface {
  return {
    method: registration.method,
    pathExpression: registration.pathExpression,
  };
}

describe("admin UI route inventory", () => {
  test("keeps the route registration surface explicit before facade extraction", () => {
    const source = readFileSync(
      new URL("../src/routes/admin-commerce-connections-ui.routes.ts", import.meta.url),
      "utf8",
    );

    expect(extractRouteRegistrations(source).map(toRouteSurface)).toEqual(
      expectedRouteRegistrations.map(toRouteSurface),
    );
  });

  test("keeps the high-risk mutation and security boundaries represented", () => {
    const registrations = expectedRouteRegistrations.map(
      (registration) => `${registration.method} ${registration.pathExpression}`,
    );

    expect(registrations).toContain("POST ADMIN_UI_LOGIN_PATH");
    expect(registrations).toContain("POST ADMIN_UI_LOGOUT_PATH");
    expect(registrations).toContain("POST `${ADMIN_UI_WOOCOMMERCE_PATH}/test`");
    expect(registrations).toContain("POST `${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/credentials`");
    expect(registrations).toContain("POST `${ADMIN_UI_APP_API_PATH}/orders/sync`");
    expect(registrations).toContain("POST `${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode`");
    expect(registrations).toContain("PATCH `${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata`");
    expect(registrations).toContain("POST `${ADMIN_UI_APP_API_PATH}/routes`");
    expect(registrations).toContain("PATCH `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/stops`");
    expect(registrations).toContain("POST `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/publish`");
    expect(registrations).toContain("PATCH `${ADMIN_UI_APP_API_PATH}/settings`");
    expect(expectedRouteRegistrations).toHaveLength(87);
  });
});
