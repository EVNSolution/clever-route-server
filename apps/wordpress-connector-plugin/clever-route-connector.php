<?php
/**
 * Plugin Name: CLEVER Route Connector
 * Description: Private WooCommerce Admin connector for read-only CLEVER Route results.
 * Version: 0.3.0
 * Author: EVNSolution
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Text Domain: clever-route-connector
 */

defined('ABSPATH') || exit;

define('CLEVER_ROUTE_CONNECTOR_VERSION', '0.3.0');
define('CLEVER_ROUTE_CONNECTOR_FILE', __FILE__);
define('CLEVER_ROUTE_CONNECTOR_DIR', plugin_dir_path(__FILE__));
define('CLEVER_ROUTE_CONNECTOR_URL', plugin_dir_url(__FILE__));

require_once CLEVER_ROUTE_CONNECTOR_DIR . 'includes/class-clever-route-options.php';
require_once CLEVER_ROUTE_CONNECTOR_DIR . 'includes/class-clever-route-api-client.php';
require_once CLEVER_ROUTE_CONNECTOR_DIR . 'includes/class-clever-route-admin.php';

add_action('before_woocommerce_init', 'clever_route_connector_declare_hpos_compatibility');

function clever_route_connector_declare_hpos_compatibility(): void {
    if (!class_exists('Automattic\\WooCommerce\\Utilities\\FeaturesUtil')) {
        return;
    }
    Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
}

function clever_route_connector_boot(): void {
    $options = new Clever_Route_Options();
    $admin = new Clever_Route_Admin($options, new Clever_Route_Api_Client($options));
    $admin->register();
}
add_action('plugins_loaded', 'clever_route_connector_boot');

register_uninstall_hook(__FILE__, 'clever_route_connector_uninstall');

function clever_route_connector_uninstall(): void {
    $options = new Clever_Route_Options();
    $options->delete_all();
}
