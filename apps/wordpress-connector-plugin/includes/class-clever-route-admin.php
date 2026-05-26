<?php

defined('ABSPATH') || exit;

final class Clever_Route_Admin {
    private Clever_Route_Options $options;
    private Clever_Route_Api_Client $client;
    private string $hook_suffix = '';

    public function __construct(Clever_Route_Options $options, Clever_Route_Api_Client $client) {
        $this->options = $options;
        $this->client = $client;
    }

    public function register(): void {
        add_action('admin_menu', array($this, 'register_menu'));
        add_action('admin_enqueue_scripts', array($this, 'enqueue_assets'));
    }

    public function register_menu(): void {
        $this->hook_suffix = add_submenu_page(
            'woocommerce',
            __('CLEVER Route', 'clever-route-connector'),
            __('CLEVER Route', 'clever-route-connector'),
            $this->capability(),
            'clever-route',
            array($this, 'render')
        ) ?: '';
    }

    public function enqueue_assets(string $hook): void {
        if ($hook !== $this->hook_suffix) {
            return;
        }
        wp_enqueue_style(
            'clever-route-admin',
            CLEVER_ROUTE_CONNECTOR_URL . 'assets/css/admin.css',
            array(),
            CLEVER_ROUTE_CONNECTOR_VERSION
        );
    }

    public function render(): void {
        if (!$this->can_manage()) {
            wp_die(esc_html__('You do not have permission to manage CLEVER Route.', 'clever-route-connector'));
        }

        $notice = $this->handle_post();
        $tab = $this->current_tab();
        echo '<div class="wrap clever-route-admin">';
        echo '<h1>' . esc_html__('CLEVER Route', 'clever-route-connector') . '</h1>';
        $this->render_woocommerce_guard();
        if ($notice !== '') {
            echo '<div class="notice notice-info"><p>' . esc_html($notice) . '</p></div>';
        }
        $this->render_tabs($tab);
        echo '<div class="clever-route-panel">';
        switch ($tab) {
            case 'setup':
                $this->render_setup();
                break;
            case 'route-plans':
                $this->render_route_plans();
                break;
            case 'route-plan-detail':
                $this->render_route_plan_detail();
                break;
            case 'orders-sync':
                $this->render_orders_sync();
                break;
            case 'mapping':
                $this->render_mapping();
                break;
            case 'diagnostics':
                $this->render_diagnostics();
                break;
            case 'dashboard':
            default:
                $this->render_dashboard();
                break;
        }
        echo '</div></div>';
    }

    private function render_woocommerce_guard(): void {
        if (class_exists('WooCommerce')) {
            return;
        }
        echo '<div class="notice notice-warning"><p>' . esc_html__('WooCommerce is required for this connector. The admin pages are shown for setup only until WooCommerce is active.', 'clever-route-connector') . '</p></div>';
    }

    private function render_tabs(string $active): void {
        $tabs = array(
            'dashboard' => __('Dashboard', 'clever-route-connector'),
            'setup' => __('Setup', 'clever-route-connector'),
            'route-plans' => __('Route Plans', 'clever-route-connector'),
            'orders-sync' => __('Orders & Sync', 'clever-route-connector'),
            'mapping' => __('Mapping', 'clever-route-connector'),
            'diagnostics' => __('Diagnostics', 'clever-route-connector'),
        );
        echo '<nav class="nav-tab-wrapper">';
        foreach ($tabs as $tab => $label) {
            $url = add_query_arg(array('page' => 'clever-route', 'tab' => $tab), admin_url('admin.php'));
            $class = $active === $tab ? ' nav-tab-active' : '';
            echo '<a class="nav-tab' . esc_attr($class) . '" href="' . esc_url($url) . '">' . esc_html($label) . '</a>';
        }
        echo '</nav>';
    }

    private function render_dashboard(): void {
        $summary = $this->options->summary();
        echo '<h2>' . esc_html__('Connection Status', 'clever-route-connector') . '</h2>';
        $this->render_key_values(array(
            __('State', 'clever-route-connector') => $summary['connected'] ? __('Connected', 'clever-route-connector') : __('Disconnected', 'clever-route-connector'),
            __('CLEVER server URL', 'clever-route-connector') => $summary['base_url'],
            __('Connection ID', 'clever-route-connector') => $summary['connection_id'],
            __('Token prefix', 'clever-route-connector') => $summary['token_prefix'],
            __('Last redacted error', 'clever-route-connector') => $summary['last_error'],
        ));
        if ($summary['connected']) {
            $health = $this->client->get('/wordpress/plugin/health');
            $this->render_api_error($health);
            $this->render_freshness($health['data']['freshness'] ?? array());
            $this->render_open_clever_route_card($summary);
        }
        echo '<p><a class="button button-primary" href="' . esc_url($this->tab_url('route-plans')) . '">' . esc_html__('Open Route Plans', 'clever-route-connector') . '</a> ';
        echo '<a class="button" href="' . esc_url($this->tab_url('orders-sync')) . '">' . esc_html__('Run Manual Sync', 'clever-route-connector') . '</a> ';
        echo '<a class="button" href="' . esc_url($this->tab_url('setup')) . '">' . esc_html__('Go to Settings', 'clever-route-connector') . '</a></p>';
    }

    private function render_setup(): void {
        $summary = $this->options->summary();
        echo '<h2>' . esc_html__('Setup / Pairing', 'clever-route-connector') . '</h2>';
        $this->render_key_values(array(
            __('Plugin version', 'clever-route-connector') => CLEVER_ROUTE_CONNECTOR_VERSION,
            __('WordPress version', 'clever-route-connector') => get_bloginfo('version'),
            __('WooCommerce version', 'clever-route-connector') => defined('WC_VERSION') ? (string) WC_VERSION : __('Not active', 'clever-route-connector'),
            __('HPOS enabled', 'clever-route-connector') => $this->hpos_enabled() ? __('Yes', 'clever-route-connector') : __('No', 'clever-route-connector'),
            __('Connected connection ID', 'clever-route-connector') => $summary['connection_id'],
            __('Token prefix only', 'clever-route-connector') => $summary['token_prefix'],
        ));
        echo '<form method="post">';
        wp_nonce_field('clever_route_action', 'clever_route_nonce');
        echo '<input type="hidden" name="clever_route_action" value="pair" />';
        echo '<p><label>' . esc_html__('CLEVER API base URL', 'clever-route-connector') . '<br />';
        echo '<input class="regular-text" type="url" name="clever_route_base_url" value="' . esc_attr($summary['base_url']) . '" required /></label></p>';
        echo '<p><label>' . esc_html__('One-time pairing code', 'clever-route-connector') . '<br />';
        echo '<input class="regular-text" type="password" name="clever_route_pairing_code" autocomplete="off" required /></label></p>';
        submit_button(__('Connect', 'clever-route-connector'));
        echo '</form>';

        if ($summary['connected']) {
            echo '<form method="post">';
            wp_nonce_field('clever_route_action', 'clever_route_nonce');
            echo '<input type="hidden" name="clever_route_action" value="disconnect" />';
            submit_button(__('Disconnect local plugin token', 'clever-route-connector'), 'delete');
            echo '</form>';
        }
    }

    private function render_orders_sync(): void {
        echo '<h2>' . esc_html__('Orders & Sync', 'clever-route-connector') . '</h2>';
        $health = $this->client->get('/wordpress/plugin/health');
        $this->render_api_error($health);
        $this->render_freshness($health['data']['freshness'] ?? array());
        echo '<h3>' . esc_html__('Historical order import', 'clever-route-connector') . '</h3>';
        echo '<p>' . esc_html__('Use this after initial setup to bring existing WooCommerce orders into CLEVER. The plugin never pushes order payloads from WordPress; it asks the CLEVER server to pull orders through the stored WooCommerce REST credentials.', 'clever-route-connector') . '</p>';
        echo '<form method="post">';
        wp_nonce_field('clever_route_action', 'clever_route_nonce');
        echo '<input type="hidden" name="clever_route_action" value="sync" />';
        echo '<fieldset class="clever-route-fieldset"><legend>' . esc_html__('Sync range', 'clever-route-connector') . '</legend>';
        echo '<p><label><input type="radio" name="sync_scope" value="all" checked /> ' . esc_html__('Import all historical orders', 'clever-route-connector') . '</label><br />';
        echo '<span class="description">' . esc_html__('Recommended for the first backfill. CLEVER omits modified_after so WooCommerce can return older orders page by page.', 'clever-route-connector') . '</span></p>';
        echo '<p><label><input type="radio" name="sync_scope" value="modified" /> ' . esc_html__('Only import orders modified after', 'clever-route-connector') . '</label><br />';
        echo '<input type="datetime-local" name="modified_after" /> <span class="description">' . esc_html__('Uses the WordPress site timezone and sends UTC to CLEVER.', 'clever-route-connector') . '</span></p>';
        echo '</fieldset>';
        echo '<p><label>' . esc_html__('Order status filter', 'clever-route-connector') . '<br /><select name="woo_status_preset">';
        foreach ($this->woo_status_options() as $value => $label) {
            echo '<option value="' . esc_attr($value) . '">' . esc_html($label) . '</option>';
        }
        echo '</select></label></p>';
        echo '<p><label>' . esc_html__('Advanced custom Woo status slug', 'clever-route-connector') . '<br />';
        echo '<input class="regular-text" type="text" name="woo_status_custom" placeholder="wc-ready-for-delivery" /></label><br />';
        echo '<span class="description">' . esc_html__('Only used when the status filter is Custom. Leave blank for normal WooCommerce statuses.', 'clever-route-connector') . '</span></p>';
        submit_button(__('Run server-side Woo REST backfill', 'clever-route-connector'));
        echo '</form>';
        echo '<p class="description">' . esc_html__('Manual sync calls POST /wordpress/plugin/sync/request. Plugin push orders/batch is intentionally not available in MVP.', 'clever-route-connector') . '</p>';
    }

    private function render_route_plans(): void {
        $summary = $this->options->summary();
        echo '<h2>' . esc_html__('Route Plans', 'clever-route-connector') . '</h2>';
        $this->render_open_clever_route_card($summary);
        $result = $this->client->get('/wordpress/plugin/route-plans');
        $this->render_api_error($result);
        $this->render_freshness($result['data']['freshness'] ?? array());
        $plans = $result['data']['routePlans'] ?? array();
        if (!is_array($plans) || count($plans) === 0) {
            echo '<p>' . esc_html__('No route plans returned by CLEVER.', 'clever-route-connector') . '</p>';
            return;
        }
        echo '<table class="widefat striped"><thead><tr>';
        foreach (array(__('Date', 'clever-route-connector'), __('Route', 'clever-route-connector'), __('Status', 'clever-route-connector'), __('Driver', 'clever-route-connector'), __('Stops', 'clever-route-connector'), __('Updated', 'clever-route-connector')) as $heading) {
            echo '<th>' . esc_html($heading) . '</th>';
        }
        echo '</tr></thead><tbody>';
        foreach ($plans as $plan) {
            if (!is_array($plan)) {
                continue;
            }
            $detail_url = add_query_arg(array('page' => 'clever-route', 'tab' => 'route-plan-detail', 'route_plan_id' => $this->text($plan['id'] ?? '')), admin_url('admin.php'));
            $driver = is_array($plan['driver'] ?? null) ? $this->text($plan['driver']['displayName'] ?? '') : '';
            echo '<tr>';
            echo '<td>' . esc_html($this->text($plan['deliveryDate'] ?? $plan['planDate'] ?? '')) . '</td>';
            echo '<td><a href="' . esc_url($detail_url) . '">' . esc_html($this->text($plan['name'] ?? '')) . '</a></td>';
            echo '<td>' . esc_html($this->text($plan['status'] ?? '')) . '</td>';
            echo '<td>' . esc_html($driver) . '</td>';
            echo '<td>' . esc_html($this->text($plan['stopCount'] ?? '0')) . '</td>';
            echo '<td>' . esc_html($this->text($plan['updatedAt'] ?? '')) . '</td>';
            echo '</tr>';
        }
        echo '</tbody></table>';
        echo '<p class="description">' . esc_html__('Read-only MVP: no create, optimize, assign, reorder, or write-back actions are rendered here.', 'clever-route-connector') . '</p>';
    }

    /** @param array{base_url:string,connection_id:string,token_prefix:string,connected:bool,last_error:string} $summary */
    private function render_open_clever_route_card(array $summary): void {
        $workspace_url = $this->clever_route_workspace_url($summary['base_url']);
        if ($workspace_url === '') {
            return;
        }

        echo '<div class="clever-route-open-card">';
        echo '<h3>' . esc_html__('Open CLEVER Route workspace', 'clever-route-connector') . '</h3>';
        echo '<p>' . esc_html__('Use this server workspace to create route plans by delivery date and adjust stop order. WordPress stays as the connector/status page.', 'clever-route-connector') . '</p>';
        echo '<p><a class="button button-primary" href="' . esc_url($workspace_url) . '">' . esc_html__('Open CLEVER Route', 'clever-route-connector') . '</a></p>';
        echo '<p class="description">' . esc_html__('The link includes this WordPress site domain so the CLEVER admin page opens on the matching customer store.', 'clever-route-connector') . '</p>';
        echo '</div>';
    }

    private function render_route_plan_detail(): void {
        $route_plan_id = sanitize_text_field((string) ($_GET['route_plan_id'] ?? ''));
        echo '<h2>' . esc_html__('Route Plan Detail', 'clever-route-connector') . '</h2>';
        if ($route_plan_id === '') {
            echo '<p>' . esc_html__('Choose a route plan from the list.', 'clever-route-connector') . '</p>';
            return;
        }
        $result = $this->client->get('/wordpress/plugin/route-plans/' . rawurlencode($route_plan_id));
        $this->render_api_error($result);
        $this->render_freshness($result['data']['freshness'] ?? array());
        $detail = $result['data']['detail'] ?? array();
        $stops = is_array($detail) ? ($detail['stops'] ?? array()) : array();
        echo '<table class="widefat striped"><thead><tr>';
        foreach (array('#', __('Woo order', 'clever-route-connector'), __('Recipient', 'clever-route-connector'), __('ETA', 'clever-route-connector'), __('Window', 'clever-route-connector'), __('Status', 'clever-route-connector')) as $heading) {
            echo '<th>' . esc_html($heading) . '</th>';
        }
        echo '</tr></thead><tbody>';
        foreach (is_array($stops) ? $stops : array() as $stop) {
            if (!is_array($stop)) {
                continue;
            }
            $order = is_array($stop['order'] ?? null) ? $stop['order'] : array();
            $source_order_id = $this->text($order['sourceOrderId'] ?? '');
            $order_link = $this->woo_order_edit_url($source_order_id);
            echo '<tr>';
            echo '<td>' . esc_html($this->text($stop['sequence'] ?? '')) . '</td>';
            echo '<td>' . ($order_link === '' ? esc_html($this->text($order['name'] ?? '')) : '<a href="' . esc_url($order_link) . '">' . esc_html($this->text($order['name'] ?? '')) . '</a>') . '</td>';
            echo '<td>' . esc_html($this->text($stop['recipientName'] ?? '')) . '</td>';
            echo '<td>' . esc_html($this->text($stop['estimatedArrivalAt'] ?? '')) . '</td>';
            echo '<td>' . esc_html($this->text($stop['timeWindowStart'] ?? '')) . ' - ' . esc_html($this->text($stop['timeWindowEnd'] ?? '')) . '</td>';
            echo '<td>' . esc_html($this->text($stop['status'] ?? '')) . '</td>';
            echo '</tr>';
        }
        echo '</tbody></table>';
        echo '<p class="description">' . esc_html__('Read-only MVP: stop reorder, driver assignment, delivery status changes, callback cache, and Woo write-back are not implemented.', 'clever-route-connector') . '</p>';
    }

    private function render_mapping(): void {
        echo '<h2>' . esc_html__('Mapping', 'clever-route-connector') . '</h2>';
        $result = $this->client->get('/wordpress/plugin/mapping');
        $this->render_api_error($result);
        $mapping = is_array($result['data']['mapping'] ?? null) ? $result['data']['mapping'] : array();
        $this->render_key_values(array(
            __('Delivery date meta key', 'clever-route-connector') => $this->text($mapping['deliveryDateMetaKey'] ?? ''),
            __('Delivery time/window meta key', 'clever-route-connector') => $this->text($mapping['deliveryTimeMetaKey'] ?? ''),
            __('Delivery area/zone meta key', 'clever-route-connector') => $this->text($mapping['deliveryAreaMetaKey'] ?? ''),
            __('Notes/instructions field', 'clever-route-connector') => $this->text($mapping['notesField'] ?? ''),
            __('Phone preference', 'clever-route-connector') => $this->text($mapping['phonePreference'] ?? ''),
            __('Address preference', 'clever-route-connector') => $this->text($mapping['addressPreference'] ?? ''),
            __('Preview', 'clever-route-connector') => __('Redacted sample only', 'clever-route-connector'),
        ));
        echo '<p class="description">' . esc_html__('Mapping is server-owned in MVP; this page is display-only unless a later approved edit flow is enabled.', 'clever-route-connector') . '</p>';
    }

    private function render_diagnostics(): void {
        $summary = $this->options->summary();
        $health = $summary['connected'] ? $this->client->get('/wordpress/plugin/health') : array('data' => null);
        echo '<h2>' . esc_html__('Diagnostics', 'clever-route-connector') . '</h2>';
        $this->render_api_error($health);
        $this->render_key_values(array(
            __('Plugin version', 'clever-route-connector') => CLEVER_ROUTE_CONNECTOR_VERSION,
            __('WordPress version', 'clever-route-connector') => get_bloginfo('version'),
            __('WooCommerce version', 'clever-route-connector') => defined('WC_VERSION') ? (string) WC_VERSION : __('Not active', 'clever-route-connector'),
            __('HPOS status', 'clever-route-connector') => $this->hpos_enabled() ? __('Enabled', 'clever-route-connector') : __('Disabled or unavailable', 'clever-route-connector'),
            __('Server URL', 'clever-route-connector') => $summary['base_url'],
            __('Connection ID', 'clever-route-connector') => $summary['connection_id'],
            __('Token prefix', 'clever-route-connector') => $summary['token_prefix'],
            __('Last API error', 'clever-route-connector') => $summary['last_error'],
        ));
        $this->render_freshness($health['data']['freshness'] ?? array());
        echo '<p class="description">' . esc_html__('Support bundle is token/PII-safe: it shows token prefix only and omits raw order payload, phone, full addresses, and connector token.', 'clever-route-connector') . '</p>';
    }

    private function handle_post(): string {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            return '';
        }
        if (!$this->can_manage()) {
            return __('Permission denied.', 'clever-route-connector');
        }
        check_admin_referer('clever_route_action', 'clever_route_nonce');
        $action = sanitize_text_field((string) ($_POST['clever_route_action'] ?? ''));
        if ($action === 'pair') {
            $base_url = $this->normalize_api_base_url((string) ($_POST['clever_route_base_url'] ?? ''));
            $pairing_code = sanitize_text_field((string) ($_POST['clever_route_pairing_code'] ?? ''));
            if ($base_url === null) {
                $message = __('CLEVER API base URL must be a valid HTTPS URL.', 'clever-route-connector');
                $this->options->save_error($message);
                return $message;
            }
            $result = $this->client->pair($base_url, $pairing_code);
            if (isset($result['data']['token'], $result['data']['tokenPrefix'], $result['data']['connectionId'])) {
                $this->options->save_pairing($base_url, (string) $result['data']['token'], (string) $result['data']['tokenPrefix'], (string) $result['data']['connectionId']);
                return __('Connected to CLEVER Route. The full connector token was stored locally and will not be displayed.', 'clever-route-connector');
            }
            $message = $this->text($result['error']['message'] ?? __('Pairing failed.', 'clever-route-connector'));
            $this->options->save_error($message);
            return $message;
        }
        if ($action === 'disconnect') {
            $this->options->disconnect_local();
            return __('Local connector token removed. CLEVER server data was not deleted.', 'clever-route-connector');
        }
        if ($action === 'sync') {
            $scope = sanitize_key((string) ($_POST['sync_scope'] ?? 'all'));
            $status_preset = sanitize_key((string) ($_POST['woo_status_preset'] ?? ''));
            $status_custom = sanitize_text_field((string) ($_POST['woo_status_custom'] ?? ''));
            $modified_after = sanitize_text_field((string) ($_POST['modified_after'] ?? ''));
            $payload = array('pageSize' => 100);
            if (!in_array($scope, array('all', 'modified'), true)) {
                return __('Invalid sync range. Manual sync was not requested.', 'clever-route-connector');
            }
            $status_filter = $this->read_woo_status_filter($status_preset, $status_custom);
            if ($status_filter['error'] !== '') {
                return $status_filter['error'];
            }
            if ($status_filter['status'] !== null) {
                $payload['status'] = $status_filter['status'];
            }
            if ($scope === 'modified') {
                if ($modified_after === '') {
                    return __('Choose a modified-after date or switch the range to all historical orders.', 'clever-route-connector');
                }
                $modified_after_iso = $this->read_modified_after_iso($modified_after);
                if ($modified_after_iso === null) {
                    return __('Invalid modified-after date. Manual sync was not requested.', 'clever-route-connector');
                }
                $payload['modifiedAfter'] = $modified_after_iso;
            }
            $result = $this->client->post('/wordpress/plugin/sync/request', $payload);
            if (isset($result['data']['sync']) && is_array($result['data']['sync'])) {
                return $this->summarize_sync_result($result['data']);
            }
            $message = $this->text($result['error']['message'] ?? __('Manual sync failed.', 'clever-route-connector'));
            $this->options->save_error($message);
            return $message;
        }
        return '';
    }

    /** @param array<string,mixed> $result */
    private function render_api_error(array $result): void {
        $message = $this->text($result['error']['message'] ?? '');
        if ($message === '') {
            return;
        }
        echo '<div class="notice notice-error inline"><p>' . esc_html($message) . '</p></div>';
    }

    /** @param array<mixed> $freshness */
    private function render_freshness(array $freshness): void {
        echo '<h3>' . esc_html__('Freshness', 'clever-route-connector') . '</h3>';
        $this->render_key_values(array(
            'lastWebhookAt' => $this->text($freshness['lastWebhookAt'] ?? ''),
            'lastRestSyncAt' => $this->text($freshness['lastRestSyncAt'] ?? ''),
            'lastRouteUpdatedAt' => $this->text($freshness['lastRouteUpdatedAt'] ?? ''),
            'serverTime' => $this->text($freshness['serverTime'] ?? ''),
        ));
    }

    /** @param array<string,string|int|bool|null> $values */
    private function render_key_values(array $values): void {
        echo '<table class="form-table"><tbody>';
        foreach ($values as $key => $value) {
            echo '<tr><th scope="row">' . esc_html((string) $key) . '</th><td><code>' . esc_html($this->text($value)) . '</code></td></tr>';
        }
        echo '</tbody></table>';
    }

    /** @param mixed $value */
    private function text($value): string {
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_scalar($value)) {
            return (string) $value;
        }
        return '';
    }

    private function current_tab(): string {
        $tab = sanitize_key((string) ($_GET['tab'] ?? 'dashboard'));
        $allowed = array('dashboard', 'setup', 'route-plans', 'route-plan-detail', 'orders-sync', 'mapping', 'diagnostics');
        return in_array($tab, $allowed, true) ? $tab : 'dashboard';
    }

    private function tab_url(string $tab): string {
        return add_query_arg(array('page' => 'clever-route', 'tab' => $tab), admin_url('admin.php'));
    }

    private function clever_route_workspace_url(string $base_url): string {
        $base_url = $this->normalize_api_base_url($base_url);
        if ($base_url === null) {
            return '';
        }

        return add_query_arg(
            array('shopDomain' => $this->site_domain()),
            $base_url . '/admin/ui/route-plans'
        );
    }

    private function site_domain(): string {
        $host = parse_url(home_url('/'), PHP_URL_HOST);
        return is_string($host) ? strtolower($host) : '';
    }

    private function woo_order_edit_url(string $source_order_id): string {
        if ($source_order_id === '') {
            return '';
        }
        if (function_exists('wc_get_order')) {
            $woo_order = wc_get_order($source_order_id);
            if (is_object($woo_order) && method_exists($woo_order, 'get_edit_order_url')) {
                $url = $woo_order->get_edit_order_url();
                if (is_string($url) && $url !== '') {
                    return $url;
                }
            }
        }
        if ($this->hpos_enabled()) {
            return admin_url('admin.php?page=wc-orders&action=edit&id=' . rawurlencode($source_order_id));
        }
        return admin_url('post.php?post=' . rawurlencode($source_order_id) . '&action=edit');
    }

    private function normalize_api_base_url(string $value): ?string {
        $url = esc_url_raw(trim($value));
        if ($url === '' || wp_http_validate_url($url) === false) {
            return null;
        }
        $scheme = parse_url($url, PHP_URL_SCHEME);
        if ($scheme !== 'https') {
            return null;
        }
        return rtrim($url, '/');
    }

    private function read_modified_after_iso(string $value): ?string {
        $value = trim($value);
        if ($value === '') {
            return null;
        }

        foreach (array('Y-m-d\\TH:i', 'Y-m-d\\TH:i:s') as $format) {
            $date = DateTimeImmutable::createFromFormat($format, $value, wp_timezone());
            $errors = DateTimeImmutable::getLastErrors();
            $has_errors = is_array($errors) && ((int) $errors['warning_count'] > 0 || (int) $errors['error_count'] > 0);
            if ($date instanceof DateTimeImmutable && !$has_errors && $date->format($format) === $value) {
                return $date->setTimezone(new DateTimeZone('UTC'))->format(DATE_ATOM);
            }
        }

        return null;
    }

    /** @return array<string,string> */
    private function woo_status_options(): array {
        return array(
            '' => __('Any supported order status', 'clever-route-connector'),
            'processing' => __('Processing', 'clever-route-connector'),
            'completed' => __('Completed', 'clever-route-connector'),
            'on-hold' => __('On hold', 'clever-route-connector'),
            'pending' => __('Pending payment', 'clever-route-connector'),
            'cancelled' => __('Cancelled', 'clever-route-connector'),
            'refunded' => __('Refunded', 'clever-route-connector'),
            'failed' => __('Failed', 'clever-route-connector'),
            'trash' => __('Trash', 'clever-route-connector'),
            'custom' => __('Custom status slug', 'clever-route-connector'),
        );
    }

    /** @return array{status:?string,error:string} */
    private function read_woo_status_filter(string $preset, string $custom): array {
        if (!array_key_exists($preset, $this->woo_status_options())) {
            return array('status' => null, 'error' => __('Invalid Woo order status filter. Manual sync was not requested.', 'clever-route-connector'));
        }
        if ($preset !== 'custom') {
            return array('status' => $preset === '' ? null : $preset, 'error' => '');
        }

        $raw_custom = strtolower(trim($custom));
        $slug = sanitize_key($raw_custom);
        if ($slug === '' || $slug !== $raw_custom) {
            return array('status' => null, 'error' => __('Custom Woo status slug can only contain lowercase letters, numbers, underscores, and hyphens.', 'clever-route-connector'));
        }
        return array('status' => $slug, 'error' => '');
    }

    /** @param array<string,mixed> $data */
    private function summarize_sync_result(array $data): string {
        $sync = is_array($data['sync'] ?? null) ? $data['sync'] : array();
        $summary = sprintf(
            /* translators: 1: pages read, 2: received count, 3: created count, 4: updated count, 5: unchanged count, 6: skipped count, 7: ready-to-plan count, 8: needs-review count */
            __('Manual sync accepted: pages %1$s; received %2$s; created %3$s; updated %4$s; unchanged %5$s; skipped %6$s; ready to plan %7$s; needs review %8$s.', 'clever-route-connector'),
            $this->text($data['pagesRead'] ?? '0'),
            $this->text($sync['received'] ?? '0'),
            $this->text($sync['created'] ?? '0'),
            $this->text($sync['updated'] ?? '0'),
            $this->text($sync['unchanged'] ?? '0'),
            $this->text($sync['skipped'] ?? '0'),
            $this->text($sync['readyToPlan'] ?? '0'),
            $this->text($sync['needsReview'] ?? '0')
        );

        $warnings = array();
        if (is_array($data['warnings'] ?? null)) {
            foreach ($data['warnings'] as $warning) {
                $warning_text = $this->text($warning);
                if ($warning_text !== '') {
                    $warnings[] = $warning_text;
                }
            }
        }
        if (count($warnings) > 0) {
            $summary .= ' ' . __('Warnings:', 'clever-route-connector') . ' ' . implode(' | ', $warnings);
        }
        return $summary;
    }

    private function capability(): string {
        return current_user_can('manage_woocommerce') ? 'manage_woocommerce' : 'manage_options';
    }

    private function can_manage(): bool {
        return current_user_can('manage_woocommerce') || current_user_can('manage_options');
    }

    private function hpos_enabled(): bool {
        if (!class_exists('Automattic\\WooCommerce\\Utilities\\OrderUtil')) {
            return false;
        }
        return Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();
    }
}
