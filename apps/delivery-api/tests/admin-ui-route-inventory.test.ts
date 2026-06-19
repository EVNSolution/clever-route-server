import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

type RouteRegistration = {
  line: number;
  method: string;
  pathExpression: string;
};

type RouteSurface = Omit<RouteRegistration, "line">;

const expectedRouteRegistrations: RouteRegistration[] = [
  { line: 444, method: "GET", pathExpression: "\"/\"" },
  { line: 446, method: "GET", pathExpression: "ADMIN_ROOT_PATH" },
  { line: 450, method: "GET", pathExpression: "DRIVER_APP_INSTALL_PATH" },
  { line: 461, method: "GET", pathExpression: "ADMIN_UI_WOOCOMMERCE_TEST_SCRIPT_PATH" },
  { line: 469, method: "GET", pathExpression: "ADMIN_UI_ROUTE_APP_SCRIPT_PATH" },
  { line: 479, method: "GET", pathExpression: "ADMIN_UI_PLUGIN_LAUNCH_PATH" },
  { line: 523, method: "GET", pathExpression: "ADMIN_UI_ROOT_PATH" },
  { line: 543, method: "GET", pathExpression: "ADMIN_UI_STORE_SESSIONS_PATH" },
  { line: 556, method: "GET", pathExpression: "ADMIN_UI_COMMERCE_CONNECTIONS_PATH" },
  { line: 576, method: "GET", pathExpression: "ADMIN_UI_APP_PATH" },
  { line: 582, method: "GET", pathExpression: "ADMIN_UI_APP_DASHBOARD_PATH" },
  { line: 588, method: "GET", pathExpression: "ADMIN_UI_APP_ORDERS_PATH" },
  { line: 594, method: "GET", pathExpression: "ADMIN_UI_APP_ROUTE_PLANS_PATH" },
  { line: 600, method: "GET", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/new`" },
  { line: 606, method: "GET", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId`" },
  { line: 615, method: "POST", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/create`" },
  { line: 624, method: "POST", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/stops`" },
  { line: 639, method: "POST", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/driver`" },
  { line: 654, method: "POST", pathExpression: "`${ADMIN_UI_APP_ROUTE_PLANS_PATH}/:routePlanId/optimize`" },
  { line: 669, method: "GET", pathExpression: "ADMIN_UI_APP_DRIVERS_PATH" },
  { line: 675, method: "POST", pathExpression: "ADMIN_UI_APP_DRIVERS_PATH" },
  { line: 681, method: "GET", pathExpression: "ADMIN_UI_APP_SETTINGS_PATH" },
  { line: 687, method: "POST", pathExpression: "ADMIN_UI_APP_SETTINGS_PATH" },
  { line: 693, method: "GET", pathExpression: "ADMIN_UI_ROUTE_PLANS_PATH" },
  { line: 703, method: "POST", pathExpression: "`${ADMIN_UI_ROUTE_PLANS_PATH}/create`" },
  { line: 709, method: "POST", pathExpression: "`${ADMIN_UI_ROUTE_PLANS_PATH}/:routePlanId/stops`" },
  { line: 724, method: "POST", pathExpression: "`${ADMIN_UI_ROUTE_PLANS_PATH}/:routePlanId/driver`" },
  { line: 739, method: "GET", pathExpression: "ADMIN_UI_ORDERS_PATH" },
  { line: 749, method: "GET", pathExpression: "ADMIN_UI_DRIVERS_PATH" },
  { line: 759, method: "POST", pathExpression: "ADMIN_UI_DRIVERS_PATH" },
  { line: 765, method: "GET", pathExpression: "ADMIN_UI_SETTINGS_PATH" },
  { line: 775, method: "POST", pathExpression: "ADMIN_UI_SETTINGS_PATH" },
  { line: 781, method: "GET", pathExpression: "LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH" },
  { line: 784, method: "POST", pathExpression: "LEGACY_ADMIN_UI_WOOCOMMERCE_LOGIN_PATH" },
  { line: 788, method: "GET", pathExpression: "ADMIN_UI_LOGIN_PATH" },
  { line: 797, method: "POST", pathExpression: "ADMIN_UI_LOGIN_PATH" },
  { line: 870, method: "GET", pathExpression: "ADMIN_UI_WOOCOMMERCE_PATH" },
  { line: 892, method: "GET", pathExpression: "ADMIN_UI_LOGOUT_PATH" },
  { line: 895, method: "POST", pathExpression: "ADMIN_UI_LOGOUT_PATH" },
  { line: 898, method: "GET", pathExpression: "LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH" },
  { line: 901, method: "POST", pathExpression: "LEGACY_ADMIN_UI_WOOCOMMERCE_LOGOUT_PATH" },
  { line: 905, method: "POST", pathExpression: "`${ADMIN_UI_WOOCOMMERCE_PATH}/test`" },
  { line: 957, method: "POST", pathExpression: "ADMIN_UI_WOOCOMMERCE_PATH" },
  { line: 998, method: "POST", pathExpression: "`${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/credentials`" },
  { line: 1063, method: "POST", pathExpression: "`${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/webhook-secret`" },
  { line: 1116, method: "POST", pathExpression: "`${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/pairing-code`" },
  { line: 1169, method: "POST", pathExpression: "`${ADMIN_UI_WOOCOMMERCE_PATH}/:connectionId/status`" },
  { line: 1219, method: "GET", pathExpression: "`${ADMIN_UI_APP_PATH}/*`" },
  { line: 1224, method: "GET", pathExpression: "`${ADMIN_UI_ROOT_PATH}/*`" },
  { line: 1234, method: "GET", pathExpression: "`${ADMIN_UI_APP_ASSETS_PATH}/*`" },
  { line: 1240, method: "GET", pathExpression: "`${ADMIN_UI_APP_VENDOR_PATH}/*`" },
  { line: 1246, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/bootstrap`" },
  { line: 1282, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/notifications`" },
  { line: 1309, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/notifications/:notificationId/read`" },
  { line: 1343, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/order-ingest-audit`" },
  { line: 1343, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders`" },
  { line: 1403, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/sync`" },
  { line: 1434, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/sync/latest`" },
  { line: 1458, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/sync/:syncRunId`" },
  { line: 1497, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/woo/:sourceOrderId/sync`" },
  { line: 1529, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode`" },
  { line: 1558, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode/:jobId`" },
  { line: 1575, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/geocode`" },
  { line: 1607, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/geocode/:jobId`" },
  { line: 1624, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/:orderId`" },
  { line: 1659, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/:orderId/customer-note-context`" },
  { line: 1699, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/delivery-customers/:profileId/admin-memo`" },
  { line: 1741, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/delivery-customers/:sourceProfileId/merge`" },
  { line: 1784, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata-diagnostics`" },
  { line: 1697, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata`" },
  { line: 1740, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/:orderId/coordinates`" },
  { line: 1781, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/orders/:orderId/geocode`" },
  { line: 1903, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/order-batches`" },
  { line: 1931, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes`" },
  { line: 1955, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes`" },
  { line: 1993, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`" },
  { line: 2019, method: "DELETE", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`" },
  { line: 2046, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId`" },
  { line: 2147, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/stops`" },
  { line: 2194, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize-jobs`" },
  { line: 2215, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize-jobs/latest`" },
  { line: 2244, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize-jobs/:jobId`" },
  { line: 2281, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize`" },
  { line: 2302, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/driver`" },
  { line: 2333, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/options`" },
  { line: 2381, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/publish`" },
  { line: 2426, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/drivers`" },
  { line: 2444, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/drivers`" },
  { line: 2476, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/drivers/:driverId/regenerate-invite-code`" },
  { line: 2519, method: "DELETE", pathExpression: "`${ADMIN_UI_APP_API_PATH}/drivers/:driverId`" },
  { line: 2562, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/settings`" },
  { line: 2583, method: "PATCH", pathExpression: "`${ADMIN_UI_APP_API_PATH}/settings`" },
  { line: 2622, method: "POST", pathExpression: "`${ADMIN_UI_APP_API_PATH}/settings/geocode`" },
  { line: 2701, method: "GET", pathExpression: "ADMIN_UI_APP_API_PATH" },
  { line: 2705, method: "GET", pathExpression: "`${ADMIN_UI_APP_API_PATH}/*`" }
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
    expect(registrations).toContain("GET `${ADMIN_UI_APP_API_PATH}/order-ingest-audit`");
    expect(registrations).toContain("POST `${ADMIN_UI_APP_API_PATH}/orders/bulk-geocode`");
    expect(registrations).toContain("POST `${ADMIN_UI_APP_API_PATH}/orders/:orderId/customer-note-context`");
    expect(registrations).toContain("PATCH `${ADMIN_UI_APP_API_PATH}/delivery-customers/:profileId/admin-memo`");
    expect(registrations).toContain("POST `${ADMIN_UI_APP_API_PATH}/delivery-customers/:sourceProfileId/merge`");
    expect(registrations).toContain("PATCH `${ADMIN_UI_APP_API_PATH}/orders/:orderId/metadata`");
    expect(registrations).toContain("POST `${ADMIN_UI_APP_API_PATH}/routes`");
    expect(registrations).toContain("PATCH `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/stops`");
    expect(registrations).toContain("POST `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize-jobs`");
    expect(registrations).toContain("GET `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize-jobs/latest`");
    expect(registrations).toContain("GET `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/optimize-jobs/:jobId`");
    expect(registrations).toContain("POST `${ADMIN_UI_APP_API_PATH}/routes/:routePlanId/publish`");
    expect(registrations).toContain("PATCH `${ADMIN_UI_APP_API_PATH}/settings`");
    expect(expectedRouteRegistrations).toHaveLength(95);
  });
});
