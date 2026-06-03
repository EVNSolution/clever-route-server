import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const pluginRoot = new URL(
  "../../wordpress-connector-plugin/",
  import.meta.url,
);

describe("WordPress connector plugin static contract", () => {
  test("main plugin file declares a private CLEVER Route WooCommerce connector", async () => {
    const source = await readFile(
      new URL("clever-route-connector.php", pluginRoot),
      "utf8",
    );

    expect(source).toContain("Plugin Name: CLEVER Route Connector");
    expect(source).toContain("WooCommerce Admin connector");
    expect(source).toContain("register_uninstall_hook");
    expect(source).toContain("before_woocommerce_init");
    expect(source).toContain("declare_compatibility('custom_order_tables'");
  });

  test("admin UI lives under WooCommerce and stays connector-only", async () => {
    const source = await readFile(
      new URL("includes/class-clever-route-admin.php", pluginRoot),
      "utf8",
    );
    const readme = await readFile(new URL("README.md", pluginRoot), "utf8");

    expect(source).toContain("add_submenu_page(\n            'woocommerce'");
    for (const label of [
      "Dashboard",
      "Setup",
      "Orders & Sync",
      "Diagnostics",
    ]) {
      expect(source).toContain(label);
    }
    for (const removedWordPressPage of [
      "Route Plans",
      "Route Plan Detail",
      "Mapping",
      "Read-only MVP",
    ]) {
      expect(source).not.toContain(removedWordPressPage);
    }
    expect(source).not.toContain("add_shortcode");
    expect(source).not.toContain("register_rest_route");
    expect(readme).toContain("WP Admin connector console");
    expect(readme).toContain(
      "No WordPress-side Route Plans, Route Plan Detail, or Mapping tabs.",
    );
  });

  test("forms check capability/nonce and token storage is non-autoloaded", async () => {
    const adminSource = await readFile(
      new URL("includes/class-clever-route-admin.php", pluginRoot),
      "utf8",
    );
    const optionsSource = await readFile(
      new URL("includes/class-clever-route-options.php", pluginRoot),
      "utf8",
    );

    expect(adminSource).toContain("current_user_can");
    expect(adminSource).toContain("wp_nonce_field");
    expect(adminSource).toContain("check_admin_referer");
    expect(adminSource).toContain("normalize_api_base_url");
    expect(adminSource).toContain("wp_http_validate_url");
    expect(adminSource).toContain("$scheme !== 'https'");
    expect(adminSource).toContain("read_modified_after_iso");
    expect(adminSource).toContain("date->format($format) === $value");
    expect(adminSource).not.toContain("strtotime(");
    expect(adminSource).toContain("esc_html");
    expect(adminSource).toContain("esc_attr");
    expect(adminSource).toContain("esc_url");
    expect(optionsSource).toContain("add_option($name, $value, '', 'no')");
    expect(optionsSource).toContain("delete_all");
  });

  test("admin pages surface API errors instead of silently rendering empty data", async () => {
    const source = await readFile(
      new URL("includes/class-clever-route-admin.php", pluginRoot),
      "utf8",
    );

    expect(source).toContain("render_api_error");
    expect(source).toContain("notice-error inline");
  });

  test("orders sync UI makes raw sync default and keeps REST backfill as recovery", async () => {
    const source = await readFile(
      new URL("includes/class-clever-route-admin.php", pluginRoot),
      "utf8",
    );

    expect(source).toContain("Import all historical orders");
    expect(source).toContain("Only import orders modified after");
    expect(source).toContain("Start raw sync");
    expect(source).toContain("sync/raw/request");
    expect(source).toContain("clever_route_raw_sync_chunk");
    expect(source).toContain("as_enqueue_async_action");
    expect(source).toContain("wp_schedule_single_event");
    expect(source).toContain("Run server-side Woo REST backfill");
    expect(source).toContain('value="sync_rest_backfill"');
    expect(source).toContain("woo_status_preset");
    expect(source).toContain("woo_status_custom");
    expect(source).toContain("custom Woo status slug");
    expect(source).toContain("summarize_sync_request_result");
    expect(source).toContain("render_latest_sync_run_status");
    expect(source).toContain("Final counts and geocoding results");
    expect(source).toContain("format_raw_sync_failures");
    expect(source).toContain("warnings");
    expect(source).not.toContain("plugin raw push is unavailable");
    expect(source).not.toContain('type="text" name="woo_status"');
  });

  test("manual sync state is durable and does not show placeholder result counts", async () => {
    const adminSource = await readFile(
      new URL("includes/class-clever-route-admin.php", pluginRoot),
      "utf8",
    );
    const optionsSource = await readFile(
      new URL("includes/class-clever-route-options.php", pluginRoot),
      "utf8",
    );

    expect(adminSource).toContain("latestSyncRun");
    expect(adminSource).toContain("save_latest_sync_run_id");
    expect(adminSource).toContain("Latest manual sync");
    expect(adminSource).toContain("No duplicate background job was started.");
    expect(adminSource).not.toContain("zero counts in this acknowledgement are placeholders");
    expect(optionsSource).toContain("clever_route_latest_sync_run_id");
    expect(optionsSource).toContain("latest_sync_run_id");
  });

  test("connected WordPress admin exposes server-owned launch buttons for each Route Ops section", async () => {
    const adminSource = await readFile(
      new URL("includes/class-clever-route-admin.php", pluginRoot),
      "utf8",
    );
    const readme = await readFile(new URL("README.md", pluginRoot), "utf8");

    expect(adminSource).toContain("render_open_clever_route_card");
    expect(adminSource).toContain("open_clever_route");
    expect(adminSource).toContain("/wordpress/plugin/admin-launch");
    for (const section of ["orders", "route-plans", "drivers", "settings"]) {
      expect(adminSource).toContain(section);
    }
    expect(adminSource).toContain("Open CLEVER Route workspace");
    expect(adminSource).toContain("wp_redirect");
    expect(adminSource).toContain("is_allowed_clever_launch_url");
    expect(adminSource).toContain("$launch_path === '/admin/ui/plugin-launch'");
    expect(adminSource).toContain("$launch_scheme === 'https'");
    expect(readme).toContain("Open CLEVER Route");
    expect(readme).toContain(
      "without re-entering the CLEVER admin login secret",
    );
  });

  test("WordPress actions call only the approved connector endpoint matrix", async () => {
    const adminSource = await readFile(
      new URL("includes/class-clever-route-admin.php", pluginRoot),
      "utf8",
    );
    const clientSource = await readFile(
      new URL("includes/class-clever-route-api-client.php", pluginRoot),
      "utf8",
    );

    const actionMatrix = [
      {
        action: 'value="pair"',
        endpoint: "/wordpress/plugin/pair",
        method: "post",
      },
      {
        action: 'value="open_clever_route"',
        endpoint: "/wordpress/plugin/admin-launch",
        method: "post",
      },
      {
        action: 'value="sync"',
        endpoint: "/wordpress/plugin/sync/raw/request",
        method: "post",
      },
      {
        action: 'value="sync_rest_backfill"',
        endpoint: "/wordpress/plugin/sync/request",
        method: "post",
      },
      {
        action: "handle_raw_sync_chunk_job",
        endpoint: "/wordpress/plugin/sync/raw/chunk",
        method: "post",
      },
      {
        action: "handle_raw_sync_chunk_job",
        endpoint: "/wordpress/plugin/sync/raw/finalize",
        method: "post",
      },
      {
        action: "get('/wordpress/plugin/health')",
        endpoint: "/wordpress/plugin/health",
        method: "get",
      },
    ];

    for (const { action, endpoint, method } of actionMatrix) {
      expect(adminSource).toContain(action);
      expect(`${adminSource}\n${clientSource}`).toContain(endpoint);
      if (endpoint === "/wordpress/plugin/pair") {
        const pairEndpointIndex = clientSource.indexOf(endpoint);
        expect(clientSource.indexOf("'POST'", pairEndpointIndex)).toBeGreaterThan(pairEndpointIndex);
      } else if (method === "post") {
        expect(`${adminSource}\n${clientSource}`).toContain(`post('${endpoint}'`);
      } else {
        expect(adminSource).toContain(`get('${endpoint}'`);
      }
    }

    expect(adminSource).not.toContain("/admin/ui/app/orders");
    expect(adminSource).not.toContain("/admin/ui/app/routes");
    expect(adminSource).not.toContain("/wordpress/plugin/orders/push");
    expect(adminSource).not.toContain("/wordpress/plugin/orders/batch");
  });

  test("accepted raw manual sync stores the syncRunId before scheduling chunks or falling back to latest status", async () => {
    const adminSource = await readFile(
      new URL("includes/class-clever-route-admin.php", pluginRoot),
      "utf8",
    );

    const syncRequestIndex = adminSource.indexOf("/wordpress/plugin/sync/raw/request");
    const acceptedRunIndex = adminSource.indexOf("isset($data['syncRun'])", syncRequestIndex);
    const saveRunIndex = adminSource.indexOf("save_latest_sync_run_id($sync_run_id)", acceptedRunIndex);
    const enqueueIndex = adminSource.indexOf("enqueue_raw_sync_chunk($job)", saveRunIndex);
    const fallbackIndex = adminSource.indexOf("/wordpress/plugin/sync/latest", syncRequestIndex);

    expect(syncRequestIndex).toBeGreaterThan(-1);
    expect(acceptedRunIndex).toBeGreaterThan(syncRequestIndex);
    expect(saveRunIndex).toBeGreaterThan(acceptedRunIndex);
    expect(enqueueIndex).toBeGreaterThan(saveRunIndex);
    expect(fallbackIndex).toBeGreaterThan(enqueueIndex);
    expect(adminSource.slice(acceptedRunIndex, fallbackIndex)).toContain("summarize_sync_request_result($data)");
    expect(adminSource.slice(acceptedRunIndex, fallbackIndex)).not.toContain("/wordpress/plugin/sync/latest");
  });

  test("raw sync status display is redacted and never renders raw payload fields", async () => {
    const adminSource = await readFile(
      new URL("includes/class-clever-route-admin.php", pluginRoot),
      "utf8",
    );

    expect(adminSource).toContain("format_raw_sync_summary");
    expect(adminSource).toContain("format_raw_sync_failures");
    expect(adminSource).toContain("sourceOrderNumber");
    expect(adminSource).toContain("failureCode");
    expect(adminSource).toContain("message");
    expect(adminSource).not.toContain("rawPayload");
  });

  test("api client uses safe bounded no-redirect HTTP requests", async () => {
    const source = await readFile(
      new URL("includes/class-clever-route-api-client.php", pluginRoot),
      "utf8",
    );

    expect(source).toContain("wp_safe_remote_request");
    expect(source).toContain("'redirection' => 0");
    expect(source).toContain("'reject_unsafe_urls' => true");
    expect(source).toContain("'timeout' => 10");
  });

  test("connector token is never localized into JavaScript or diagnostics", async () => {
    const sources = await readPluginSources();
    const joined = sources.join("\n");

    expect(joined).not.toContain("wp_localize_script");
    expect(joined).not.toContain("localize_script");
    expect(joined).toContain("Token prefix");
    expect(joined).toContain("get_token()");
  });
});

async function readPluginSources(): Promise<string[]> {
  const files = ["clever-route-connector.php"];
  const includeDir = new URL("includes/", pluginRoot);
  for (const file of await readdir(includeDir)) {
    if (file.endsWith(".php")) {
      files.push(join("includes", file));
    }
  }
  return Promise.all(
    files.map((file) => readFile(new URL(file, pluginRoot), "utf8")),
  );
}
