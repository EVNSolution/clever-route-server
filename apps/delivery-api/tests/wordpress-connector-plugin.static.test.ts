import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const pluginRoot = new URL('../../wordpress-connector-plugin/', import.meta.url);

describe('WordPress connector plugin static contract', () => {
  test('main plugin file declares a private CLEVER Route WooCommerce connector', async () => {
    const source = await readFile(new URL('clever-route-connector.php', pluginRoot), 'utf8');

    expect(source).toContain('Plugin Name: CLEVER Route Connector');
    expect(source).toContain('WooCommerce Admin connector');
    expect(source).toContain('register_uninstall_hook');
    expect(source).toContain('before_woocommerce_init');
    expect(source).toContain("declare_compatibility('custom_order_tables'");
  });

  test('admin UI lives under WooCommerce and includes required read-only pages', async () => {
    const source = await readFile(new URL('includes/class-clever-route-admin.php', pluginRoot), 'utf8');

    expect(source).toContain("add_submenu_page(\n            'woocommerce'");
    for (const label of ['Dashboard', 'Setup', 'Route Plans', 'Orders & Sync', 'Mapping', 'Diagnostics']) {
      expect(source).toContain(label);
    }
    expect(source).toContain('Route Plan Detail');
    expect(source).toContain('Read-only MVP');
    expect(source).not.toContain('add_shortcode');
    expect(source).not.toContain('register_rest_route');
  });

  test('forms check capability/nonce and token storage is non-autoloaded', async () => {
    const adminSource = await readFile(new URL('includes/class-clever-route-admin.php', pluginRoot), 'utf8');
    const optionsSource = await readFile(new URL('includes/class-clever-route-options.php', pluginRoot), 'utf8');

    expect(adminSource).toContain('current_user_can');
    expect(adminSource).toContain('wp_nonce_field');
    expect(adminSource).toContain('check_admin_referer');
    expect(adminSource).toContain('woo_order_edit_url');
    expect(adminSource).toContain('get_edit_order_url');
    expect(adminSource).toContain('post.php?post=');
    expect(adminSource).toContain('normalize_api_base_url');
    expect(adminSource).toContain('wp_http_validate_url');
    expect(adminSource).toContain("$scheme !== 'https'");
    expect(adminSource).toContain('read_modified_after_iso');
    expect(adminSource).toContain('date->format($format) === $value');
    expect(adminSource).not.toContain('strtotime(');
    expect(adminSource).toContain('esc_html');
    expect(adminSource).toContain('esc_attr');
    expect(adminSource).toContain('esc_url');
    expect(optionsSource).toContain("add_option($name, $value, '', 'no')");
    expect(optionsSource).toContain('delete_all');
  });

  test('admin pages surface API errors instead of silently rendering empty data', async () => {
    const source = await readFile(new URL('includes/class-clever-route-admin.php', pluginRoot), 'utf8');

    expect(source).toContain('render_api_error');
    expect(source).toContain('notice-error inline');
  });

  test('orders sync UI makes historical backfill explicit and typo-resistant', async () => {
    const source = await readFile(new URL('includes/class-clever-route-admin.php', pluginRoot), 'utf8');

    expect(source).toContain('Import all historical orders');
    expect(source).toContain('Only import orders modified after');
    expect(source).toContain('Run server-side Woo REST backfill');
    expect(source).toContain('woo_status_preset');
    expect(source).toContain('woo_status_custom');
    expect(source).toContain('custom Woo status slug');
    expect(source).toContain('summarize_sync_result');
    expect(source).toContain('warnings');
    expect(source).not.toContain('type="text" name="woo_status"');
  });

  test('connected WordPress admin exposes a server-owned Open CLEVER Route link', async () => {
    const adminSource = await readFile(new URL('includes/class-clever-route-admin.php', pluginRoot), 'utf8');
    const readme = await readFile(new URL('README.md', pluginRoot), 'utf8');

    expect(adminSource).toContain('render_open_clever_route_card');
    expect(adminSource).toContain('open_clever_route');
    expect(adminSource).toContain('/wordpress/plugin/admin-launch');
    expect(adminSource).toContain('Open CLEVER Route workspace');
    expect(adminSource).toContain('wp_redirect');
    expect(adminSource).toContain("parse_url(home_url('/'), PHP_URL_HOST)");
    expect(readme).toContain('Open CLEVER Route');
    expect(readme).toContain('without re-entering the CLEVER admin login secret');
  });

  test('api client uses safe no-redirect HTTP requests', async () => {
    const source = await readFile(new URL('includes/class-clever-route-api-client.php', pluginRoot), 'utf8');

    expect(source).toContain('wp_safe_remote_request');
    expect(source).toContain("'redirection' => 0");
    expect(source).toContain("'reject_unsafe_urls' => true");
  });

  test('connector token is never localized into JavaScript or diagnostics', async () => {
    const sources = await readPluginSources();
    const joined = sources.join('\n');

    expect(joined).not.toContain('wp_localize_script');
    expect(joined).not.toContain('localize_script');
    expect(joined).toContain('Token prefix');
    expect(joined).toContain('get_token()');
  });
});

async function readPluginSources(): Promise<string[]> {
  const files = ['clever-route-connector.php'];
  const includeDir = new URL('includes/', pluginRoot);
  for (const file of await readdir(includeDir)) {
    if (file.endsWith('.php')) {
      files.push(join('includes', file));
    }
  }
  return Promise.all(files.map((file) => readFile(new URL(file, pluginRoot), 'utf8')));
}
