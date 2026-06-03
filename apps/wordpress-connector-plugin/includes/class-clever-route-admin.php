<?php

defined('ABSPATH') || exit;

final class Clever_Route_Admin {
    private const RAW_SYNC_CHUNK_ACTION = 'clever_route_raw_sync_chunk';
    private const RAW_SYNC_CHUNK_SIZE = 100;
    private const RAW_SYNC_MAX_META_ITEMS = 120;

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
        add_action(self::RAW_SYNC_CHUNK_ACTION, array($this, 'handle_raw_sync_chunk_job'), 10, 1);
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
            case 'orders-sync':
                $this->render_orders_sync();
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
            'orders-sync' => __('Orders & Sync', 'clever-route-connector'),
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
            $this->render_ingestion_status(is_array($health['data'] ?? null) ? $health['data'] : array());
            $this->render_open_clever_route_card($summary);
        } else {
            echo '<p class="description">' . esc_html__('Connect this plugin before REST sync, webhook status, or CLEVER workspace launch actions are available.', 'clever-route-connector') . '</p>';
        }
        echo '<p><a class="button button-primary" href="' . esc_url($this->tab_url('orders-sync')) . '">' . esc_html__('Run Manual Sync', 'clever-route-connector') . '</a> ';
        echo '<a class="button" href="' . esc_url($this->tab_url('setup')) . '">' . esc_html__('Go to Setup', 'clever-route-connector') . '</a></p>';
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
        $this->render_ingestion_status(is_array($health['data'] ?? null) ? $health['data'] : array());
        echo '<h3>' . esc_html__('Raw order sync', 'clever-route-connector') . '</h3>';
        echo '<p>' . esc_html__('Use this after initial setup to send WooCommerce order snapshots to CLEVER in bounded background chunks. CLEVER accepts the raw rows quickly, then normalizes and geocodes them on the server without blocking this WordPress request.', 'clever-route-connector') . '</p>';
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
        submit_button(__('Start raw sync', 'clever-route-connector'));
        echo '</form>';
        echo '<p class="description">' . esc_html__('Manual sync calls POST /wordpress/plugin/sync/raw/request, then uploads bounded chunks through WordPress background scheduling. Final counts and failures appear in Ingestion status after CLEVER finishes processing.', 'clever-route-connector') . '</p>';

        echo '<hr />';
        echo '<h3>' . esc_html__('Advanced recovery', 'clever-route-connector') . '</h3>';
        echo '<p class="description">' . esc_html__('Use REST backfill only for recovery or reconciliation. It asks the CLEVER server to pull from WooCommerce REST credentials and remains available as a fallback.', 'clever-route-connector') . '</p>';
        echo '<form method="post">';
        wp_nonce_field('clever_route_action', 'clever_route_nonce');
        echo '<input type="hidden" name="clever_route_action" value="sync_rest_backfill" />';
        submit_button(__('Run server-side Woo REST backfill', 'clever-route-connector'), 'secondary');
        echo '</form>';
    }

    /** @param array{base_url:string,connection_id:string,token_prefix:string,connected:bool,last_error:string} $summary */
    private function render_open_clever_route_card(array $summary): void {
        if (!$summary['connected'] || $this->normalize_api_base_url($summary['base_url']) === null) {
            return;
        }

        echo '<div class="clever-route-open-card">';
        echo '<h3>' . esc_html__('Open CLEVER Route workspace', 'clever-route-connector') . '</h3>';
        echo '<p>' . esc_html__('Launch the CLEVER server workspace from this WordPress admin session without re-entering the CLEVER admin login secret. WordPress only requests a short-lived launch URL; the connector token is never placed in the browser URL.', 'clever-route-connector') . '</p>';
        echo '<div class="clever-route-launch-actions">';
        $this->render_admin_launch_button('orders', __('Open orders in CLEVER', 'clever-route-connector'), true);
        $this->render_admin_launch_button('route-plans', __('Create route in CLEVER', 'clever-route-connector'), false);
        $this->render_admin_launch_button('drivers', __('Manage drivers in CLEVER', 'clever-route-connector'), false);
        $this->render_admin_launch_button('settings', __('Open CLEVER settings', 'clever-route-connector'), false);
        echo '</div>';
        echo '<p class="description">' . esc_html__('The server verifies this paired plugin token and opens the matching customer store using this WordPress site domain.', 'clever-route-connector') . '</p>';
        echo '</div>';
    }

    private function render_admin_launch_button(string $section, string $label, bool $primary): void {
        echo '<form method="post" class="clever-route-inline-form">';
        wp_nonce_field('clever_route_action', 'clever_route_nonce');
        echo '<input type="hidden" name="clever_route_action" value="open_clever_route" />';
        echo '<input type="hidden" name="clever_route_section" value="' . esc_attr($section) . '" />';
        submit_button($label, $primary ? 'primary' : 'secondary', 'submit', false);
        echo '</form>';
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
        $this->render_ingestion_status(is_array($health['data'] ?? null) ? $health['data'] : array());
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
        if ($action === 'open_clever_route') {
            $section = sanitize_key((string) ($_POST['clever_route_section'] ?? 'orders'));
            if (!in_array($section, array('orders', 'route-plans', 'drivers', 'settings'), true)) {
                $section = 'orders';
            }
            $result = $this->client->post('/wordpress/plugin/admin-launch', array('section' => $section));
            $launch_url = $this->text($result['data']['launchUrl'] ?? '');
            if ($launch_url !== '' && $this->is_allowed_clever_launch_url($launch_url)) {
                wp_redirect(esc_url_raw($launch_url));
                exit;
            }
            $message = $this->text($result['error']['message'] ?? __('Could not open CLEVER Route workspace.', 'clever-route-connector'));
            $this->options->save_error($message);
            return $message;
        }
        if ($action === 'sync' || $action === 'sync_rest_backfill') {
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

            if ($action === 'sync_rest_backfill') {
                $result = $this->client->post('/wordpress/plugin/sync/request', $payload);
                return $this->handle_sync_request_response($result, __('REST backfill failed.', 'clever-route-connector'));
            }

            $result = $this->client->post('/wordpress/plugin/sync/raw/request', $payload);
            $data = is_array($result['data'] ?? null) ? $result['data'] : array();
            if (isset($data['syncRun']) && is_array($data['syncRun'])) {
                $sync_run_id = $this->text($data['syncRun']['syncRunId'] ?? '');
                if ($sync_run_id !== '') {
                    $this->options->save_latest_sync_run_id($sync_run_id);
                    $job = array(
                        'chunk_count' => 0,
                        'expected_order_count' => 0,
                        'modified_after' => $this->text($payload['modifiedAfter'] ?? ''),
                        'page' => 1,
                        'page_size' => self::RAW_SYNC_CHUNK_SIZE,
                        'status' => $this->text($payload['status'] ?? ''),
                        'sync_run_id' => $sync_run_id,
                    );
                    if (!$this->enqueue_raw_sync_chunk($job)) {
                        return __('Raw sync was accepted by CLEVER, but WordPress could not schedule the chunk upload job. Use Advanced recovery REST backfill or retry after WP-Cron is enabled.', 'clever-route-connector') . ' ' . $this->summarize_sync_request_result($data);
                    }
                }
                return $this->summarize_sync_request_result($data) . ' ' . __('WordPress scheduled bounded raw-order chunk uploads in the background.', 'clever-route-connector');
            }
            if (isset($data['sync']) && is_array($data['sync'])) {
                return $this->summarize_legacy_sync_result($data);
            }
            if ($this->sync_request_was_accepted_without_run_id($result, $data)) {
                $latest = $this->client->get('/wordpress/plugin/sync/latest');
                $latest_data = is_array($latest['data'] ?? null) ? $latest['data'] : array();
                $latest_sync_run = is_array($latest_data['syncRun'] ?? null) ? $latest_data['syncRun'] : array();
                if (!empty($latest_sync_run)) {
                    $sync_run_id = $this->text($latest_sync_run['syncRunId'] ?? '');
                    if ($sync_run_id !== '') {
                        $this->options->save_latest_sync_run_id($sync_run_id);
                    }
                    return __('Manual sync request reached CLEVER. Loaded the latest server sync status.', 'clever-route-connector') . ' ' . $this->summarize_sync_request_result(array(
                        'message' => $this->text($data['message'] ?? ''),
                        'syncRun' => $latest_sync_run,
                    ));
                }
                $message = $this->text($data['message'] ?? '');
                if ($message === '') {
                    $message = __('Manual sync request reached CLEVER, but this plugin could not read a sync run id. Refresh Ingestion status to verify completion.', 'clever-route-connector');
                }
                return $message;
            }
            $message = $this->text($result['error']['message'] ?? __('Manual sync failed.', 'clever-route-connector'));
            $this->options->save_error($message);
            return $message;
        }
        return '';
    }

    /** @param array<string,mixed> $result */
    private function handle_sync_request_response(array $result, string $fallback_error): string {
        $data = is_array($result['data'] ?? null) ? $result['data'] : array();
        if (isset($data['syncRun']) && is_array($data['syncRun'])) {
            $sync_run_id = $this->text($data['syncRun']['syncRunId'] ?? '');
            if ($sync_run_id !== '') {
                $this->options->save_latest_sync_run_id($sync_run_id);
            }
            return $this->summarize_sync_request_result($data);
        }
        if (isset($data['sync']) && is_array($data['sync'])) {
            return $this->summarize_legacy_sync_result($data);
        }
        if ($this->sync_request_was_accepted_without_run_id($result, $data)) {
            $latest = $this->client->get('/wordpress/plugin/sync/latest');
            $latest_data = is_array($latest['data'] ?? null) ? $latest['data'] : array();
            $latest_sync_run = is_array($latest_data['syncRun'] ?? null) ? $latest_data['syncRun'] : array();
            if (!empty($latest_sync_run)) {
                $sync_run_id = $this->text($latest_sync_run['syncRunId'] ?? '');
                if ($sync_run_id !== '') {
                    $this->options->save_latest_sync_run_id($sync_run_id);
                }
                return __('Manual sync request reached CLEVER. Loaded the latest server sync status.', 'clever-route-connector') . ' ' . $this->summarize_sync_request_result(array(
                    'message' => $this->text($data['message'] ?? ''),
                    'syncRun' => $latest_sync_run,
                ));
            }
            $message = $this->text($data['message'] ?? '');
            if ($message === '') {
                $message = __('Manual sync request reached CLEVER, but this plugin could not read a sync run id. Refresh Ingestion status to verify completion.', 'clever-route-connector');
            }
            return $message;
        }
        $message = $this->text($result['error']['message'] ?? $fallback_error);
        $this->options->save_error($message);
        return $message;
    }

    /** @param array<string,mixed> $job */
    private function enqueue_raw_sync_chunk(array $job): bool {
        if (function_exists('as_enqueue_async_action')) {
            $action_id = as_enqueue_async_action(self::RAW_SYNC_CHUNK_ACTION, array($job), 'clever-route');
            return is_numeric($action_id) && (int) $action_id > 0;
        }

        return wp_schedule_single_event(time() + 1, self::RAW_SYNC_CHUNK_ACTION, array($job));
    }

    /** @param mixed $job */
    public function handle_raw_sync_chunk_job($job): void {
        if (!is_array($job)) {
            return;
        }
        $sync_run_id = $this->text($job['sync_run_id'] ?? '');
        if ($sync_run_id === '') {
            return;
        }

        $page = max(1, (int) ($job['page'] ?? 1));
        $page_size = (int) ($job['page_size'] ?? self::RAW_SYNC_CHUNK_SIZE);
        if ($page_size < 1 || $page_size > self::RAW_SYNC_CHUNK_SIZE) {
            $page_size = self::RAW_SYNC_CHUNK_SIZE;
        }
        $status = $this->text($job['status'] ?? '');
        $modified_after = $this->text($job['modified_after'] ?? '');
        $chunk_count = max(0, (int) ($job['chunk_count'] ?? 0));
        $expected_order_count = max(0, (int) ($job['expected_order_count'] ?? 0));

        $page_result = $this->read_woo_orders_page(array(
            'modified_after' => $modified_after,
            'page' => $page,
            'page_size' => $page_size,
            'status' => $status,
        ));
        $orders = $page_result['orders'];
        $chunk_id = $sync_run_id . '-page-' . (string) $page;

        $chunk_result = $this->client->post('/wordpress/plugin/sync/raw/chunk', array(
            'chunkCount' => $page_result['total_pages'] > 0 ? $page_result['total_pages'] : null,
            'chunkId' => $chunk_id,
            'chunkIndex' => $page - 1,
            'orders' => $orders,
            'syncRunId' => $sync_run_id,
        ));
        if (!is_array($chunk_result['data'] ?? null) && is_array($chunk_result['error'] ?? null)) {
            $this->options->save_error($this->text($chunk_result['error']['message'] ?? __('Raw sync chunk upload failed.', 'clever-route-connector')));
            return;
        }

        $chunk_count += 1;
        $expected_order_count += count($orders);
        if ($page_result['has_more']) {
            $this->enqueue_raw_sync_chunk(array(
                'chunk_count' => $chunk_count,
                'expected_order_count' => $expected_order_count,
                'modified_after' => $modified_after,
                'page' => $page + 1,
                'page_size' => $page_size,
                'status' => $status,
                'sync_run_id' => $sync_run_id,
            ));
            return;
        }

        $finalize = $this->client->post('/wordpress/plugin/sync/raw/finalize', array(
            'expectedChunkCount' => $chunk_count,
            'expectedOrderCount' => $expected_order_count,
            'syncRunId' => $sync_run_id,
        ));
        if (!is_array($finalize['data'] ?? null) && is_array($finalize['error'] ?? null)) {
            $this->options->save_error($this->text($finalize['error']['message'] ?? __('Raw sync finalize failed.', 'clever-route-connector')));
        }
    }

    /**
     * @param array{modified_after:string,page:int,page_size:int,status:string} $input
     * @return array{orders:array<int,array<string,mixed>>,has_more:bool,total_pages:int}
     */
    private function read_woo_orders_page(array $input): array {
        if (!function_exists('wc_get_orders')) {
            return array('orders' => array(), 'has_more' => false, 'total_pages' => 0);
        }

        $query = array(
            'limit' => $input['page_size'],
            'orderby' => 'modified',
            'order' => 'ASC',
            'page' => $input['page'],
            'paginate' => true,
            'return' => 'objects',
        );
        if ($input['status'] !== '') {
            $query['status'] = $input['status'];
        }
        if ($input['modified_after'] !== '') {
            $modified_after = $this->parse_utc_datetime($input['modified_after']);
            if ($modified_after !== null) {
                $query['date_modified'] = '>=' . $modified_after->setTimezone(wp_timezone())->format('Y-m-d H:i:s');
            }
        }

        $result = wc_get_orders($query);
        $orders = array();
        $total_pages = 0;
        if (is_object($result) && isset($result->orders) && is_array($result->orders)) {
            $total_pages = isset($result->max_num_pages) ? (int) $result->max_num_pages : 0;
            foreach ($result->orders as $order) {
                $serialized = $this->serialize_woo_order($order);
                if (!empty($serialized)) {
                    $orders[] = $serialized;
                }
            }
        } elseif (is_array($result)) {
            foreach ($result as $order) {
                $serialized = $this->serialize_woo_order($order);
                if (!empty($serialized)) {
                    $orders[] = $serialized;
                }
            }
        }

        $has_more = $total_pages > 0 ? $input['page'] < $total_pages : count($orders) === $input['page_size'];
        return array('orders' => $orders, 'has_more' => $has_more, 'total_pages' => $total_pages);
    }

    /** @param mixed $order @return array<string,mixed> */
    private function serialize_woo_order($order): array {
        if (!is_object($order) || !method_exists($order, 'get_id')) {
            return array();
        }

        return array(
            'billing' => $this->serialize_woo_order_address($order, 'billing'),
            'currency' => method_exists($order, 'get_currency') ? $this->text($order->get_currency()) : null,
            'customer_note' => method_exists($order, 'get_customer_note') ? $this->text($order->get_customer_note()) : null,
            'date_created_gmt' => $this->format_wc_datetime_utc(method_exists($order, 'get_date_created') ? $order->get_date_created() : null),
            'date_modified_gmt' => $this->format_wc_datetime_utc(method_exists($order, 'get_date_modified') ? $order->get_date_modified() : null),
            'id' => (int) $order->get_id(),
            'line_items' => $this->serialize_woo_order_items($order, 'line_item'),
            'meta_data' => $this->serialize_woo_meta_data(method_exists($order, 'get_meta_data') ? $order->get_meta_data() : array()),
            'number' => method_exists($order, 'get_order_number') ? $this->text($order->get_order_number()) : (string) $order->get_id(),
            'payment_method' => method_exists($order, 'get_payment_method') ? $this->text($order->get_payment_method()) : null,
            'payment_method_title' => method_exists($order, 'get_payment_method_title') ? $this->text($order->get_payment_method_title()) : null,
            'shipping' => $this->serialize_woo_order_address($order, 'shipping'),
            'shipping_lines' => $this->serialize_woo_order_items($order, 'shipping'),
            'status' => method_exists($order, 'get_status') ? $this->text($order->get_status()) : null,
            'total' => method_exists($order, 'get_total') ? $this->text($order->get_total()) : null,
        );
    }

    /** @param object $order @return array<string,string|null> */
    private function serialize_woo_order_address(object $order, string $kind): array {
        $prefix = $kind === 'shipping' ? 'get_shipping_' : 'get_billing_';
        return array(
            'address_1' => $this->call_text($order, $prefix . 'address_1'),
            'address_2' => $this->call_text($order, $prefix . 'address_2'),
            'city' => $this->call_text($order, $prefix . 'city'),
            'company' => $this->call_text($order, $prefix . 'company'),
            'country' => $this->call_text($order, $prefix . 'country'),
            'email' => $kind === 'billing' ? $this->call_text($order, 'get_billing_email') : null,
            'first_name' => $this->call_text($order, $prefix . 'first_name'),
            'last_name' => $this->call_text($order, $prefix . 'last_name'),
            'phone' => $kind === 'billing' ? $this->call_text($order, 'get_billing_phone') : $this->call_text($order, 'get_shipping_phone'),
            'postcode' => $this->call_text($order, $prefix . 'postcode'),
            'state' => $this->call_text($order, $prefix . 'state'),
        );
    }

    /** @param object $order @return array<int,array<string,mixed>> */
    private function serialize_woo_order_items(object $order, string $type): array {
        if (!method_exists($order, 'get_items')) {
            return array();
        }
        $items = array();
        foreach ($order->get_items($type) as $item) {
            if (!is_object($item)) {
                continue;
            }
            if ($type === 'shipping') {
                $items[] = array(
                    'id' => method_exists($item, 'get_id') ? (int) $item->get_id() : null,
                    'meta_data' => $this->serialize_woo_meta_data(method_exists($item, 'get_meta_data') ? $item->get_meta_data() : array()),
                    'method_id' => method_exists($item, 'get_method_id') ? $this->text($item->get_method_id()) : null,
                    'method_title' => method_exists($item, 'get_method_title') ? $this->text($item->get_method_title()) : null,
                );
                continue;
            }
            $items[] = array(
                'id' => method_exists($item, 'get_id') ? (int) $item->get_id() : null,
                'meta_data' => $this->serialize_woo_meta_data(method_exists($item, 'get_meta_data') ? $item->get_meta_data() : array()),
                'name' => method_exists($item, 'get_name') ? $this->text($item->get_name()) : null,
                'quantity' => method_exists($item, 'get_quantity') ? (int) $item->get_quantity() : null,
                'sku' => method_exists($item, 'get_product') && is_object($item->get_product()) && method_exists($item->get_product(), 'get_sku') ? $this->text($item->get_product()->get_sku()) : null,
            );
        }
        return $items;
    }

    /** @param array<int,mixed> $meta_data @return array<int,array{key:string,value:mixed}> */
    private function serialize_woo_meta_data(array $meta_data): array {
        $items = array();
        foreach ($meta_data as $meta) {
            if (count($items) >= self::RAW_SYNC_MAX_META_ITEMS) {
                break;
            }
            $key = '';
            $value = null;
            if (is_object($meta) && method_exists($meta, 'get_data')) {
                $data = $meta->get_data();
                if (is_array($data)) {
                    $key = $this->text($data['key'] ?? '');
                    $value = $data['value'] ?? null;
                }
            } elseif (is_array($meta)) {
                $key = $this->text($meta['key'] ?? '');
                $value = $meta['value'] ?? null;
            }
            if ($key === '' || !$this->is_safe_order_meta_key($key)) {
                continue;
            }
            $items[] = array('key' => $key, 'value' => $this->normalize_raw_sync_value($value));
        }
        return $items;
    }

    /** @param mixed $value @return mixed */
    private function normalize_raw_sync_value($value) {
        if (is_null($value) || is_bool($value) || is_int($value) || is_float($value)) {
            return $value;
        }
        if (is_scalar($value)) {
            return substr((string) $value, 0, 4000);
        }
        if (is_array($value)) {
            $normalized = array();
            $count = 0;
            foreach ($value as $key => $item) {
                if ($count >= 40) {
                    break;
                }
                $normalized[$key] = $this->normalize_raw_sync_value($item);
                $count += 1;
            }
            return $normalized;
        }
        if (is_object($value) && method_exists($value, '__toString')) {
            return substr((string) $value, 0, 4000);
        }
        return null;
    }

    private function is_safe_order_meta_key(string $key): bool {
        return preg_match('/(?:password|token|secret|cookie|session|auth)/i', $key) !== 1;
    }

    /** @param mixed $date */
    private function format_wc_datetime_utc($date): ?string {
        if (!is_object($date) || !method_exists($date, 'setTimezone')) {
            return null;
        }
        $copy = clone $date;
        $copy->setTimezone(new DateTimeZone('UTC'));
        return $copy->format('Y-m-d\TH:i:s');
    }

    private function parse_utc_datetime(string $value): ?DateTimeImmutable {
        try {
            return new DateTimeImmutable($value, new DateTimeZone('UTC'));
        } catch (Exception $error) {
            return null;
        }
    }

    private function call_text(object $object, string $method): ?string {
        if (!method_exists($object, $method)) {
            return null;
        }
        $value = $object->{$method}();
        $text = $this->text($value);
        return $text === '' ? null : $text;
    }

    /** @param array<string,mixed> $result */
    private function render_api_error(array $result): void {
        $message = $this->text($result['error']['message'] ?? '');
        if ($message === '') {
            return;
        }
        echo '<div class="notice notice-error inline"><p>' . esc_html($message) . '</p></div>';
    }

    /** @param array<string,mixed> $health */
    private function render_ingestion_status(array $health): void {
        $freshness = is_array($health['freshness'] ?? null) ? $health['freshness'] : array();
        $stats = is_array($health['ingestionStats'] ?? null) ? $health['ingestionStats'] : array();
        echo '<h3>' . esc_html__('Ingestion status', 'clever-route-connector') . '</h3>';
        echo '<div class="clever-route-status-grid">';
        $this->render_status_card(
            __('REST sync', 'clever-route-connector'),
            $this->format_count_stat($stats, 'rest'),
            array(
                __('Last REST sync', 'clever-route-connector') => $this->format_optional_datetime($freshness['lastRestSyncAt'] ?? null, __('No REST sync recorded yet', 'clever-route-connector')),
            )
        );
        $this->render_status_card(
            __('Webhook', 'clever-route-connector'),
            $this->format_count_stat($stats, 'webhook'),
            array(
                __('Last webhook', 'clever-route-connector') => $this->format_optional_datetime($freshness['lastWebhookAt'] ?? null, __('No webhook received yet', 'clever-route-connector')),
            )
        );
        echo '</div>';
        $server_time = $this->text($freshness['serverTime'] ?? '');
        if ($server_time !== '') {
            echo '<p class="description">' . esc_html(sprintf(__('CLEVER server time: %s', 'clever-route-connector'), $server_time)) . '</p>';
        }
        $latest_sync_run = is_array($health['latestSyncRun'] ?? null) ? $health['latestSyncRun'] : array();
        if (!empty($latest_sync_run)) {
            $this->render_latest_sync_run_status($latest_sync_run);
        } elseif ($this->options->latest_sync_run_id() !== '') {
            echo '<p class="description">' . esc_html(sprintf(__('Latest manual sync request id: %s. Refresh this page to load server-side completion details.', 'clever-route-connector'), $this->options->latest_sync_run_id())) . '</p>';
        }
    }

    /** @param array<string,mixed> $stats */
    private function format_count_stat(array $stats, string $channel): string {
        $channel_stats = is_array($stats[$channel] ?? null) ? $stats[$channel] : array();
        if (array_key_exists('recordedOrdersReceived', $channel_stats)) {
            return sprintf(
                /* translators: 1: count of orders received since stats tracking was enabled */
                __('%1$s recorded orders received since stats tracking was enabled', 'clever-route-connector'),
                $this->text($channel_stats['recordedOrdersReceived'])
            );
        }
        return __('Recorded order count is not available from this CLEVER server yet', 'clever-route-connector');
    }

    /** @param array<string,string> $details */
    private function render_status_card(string $title, string $summary, array $details): void {
        echo '<section class="clever-route-status-card">';
        echo '<h4>' . esc_html($title) . '</h4>';
        echo '<p class="clever-route-status-summary">' . esc_html($summary) . '</p>';
        echo '<dl>';
        foreach ($details as $label => $value) {
            echo '<dt>' . esc_html($label) . '</dt><dd>' . esc_html($value) . '</dd>';
        }
        echo '</dl>';
        echo '</section>';
    }

    /** @param mixed $value */
    private function format_optional_datetime($value, string $empty_text): string {
        $text = $this->text($value);
        return $text === '' ? $empty_text : $text;
    }

    /** @param array<string,string|int|bool|null> $values */
    private function render_key_values(array $values): void {
        echo '<table class="form-table clever-route-key-values"><tbody>';
        foreach ($values as $key => $value) {
            $text = $this->text($value);
            $display = $text === '' ? __('Not configured', 'clever-route-connector') : $text;
            $class = $text === '' ? ' class="clever-route-empty-value"' : '';
            echo '<tr><th scope="row">' . esc_html((string) $key) . '</th><td><span' . $class . '>' . esc_html($display) . '</span></td></tr>';
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
        $allowed = array('dashboard', 'setup', 'orders-sync', 'diagnostics');
        return in_array($tab, $allowed, true) ? $tab : 'dashboard';
    }

    private function tab_url(string $tab): string {
        return add_query_arg(array('page' => 'clever-route', 'tab' => $tab), admin_url('admin.php'));
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

    private function is_allowed_clever_launch_url(string $launch_url): bool {
        $base_url = $this->normalize_api_base_url($this->options->get_base_url());
        $launch_url = esc_url_raw(trim($launch_url));
        if ($base_url === null || $launch_url === '' || wp_http_validate_url($launch_url) === false) {
            return false;
        }

        $base_host = parse_url($base_url, PHP_URL_HOST);
        $launch_host = parse_url($launch_url, PHP_URL_HOST);
        $launch_scheme = parse_url($launch_url, PHP_URL_SCHEME);
        $launch_path = parse_url($launch_url, PHP_URL_PATH);

        return is_string($base_host)
            && is_string($launch_host)
            && strtolower($base_host) === strtolower($launch_host)
            && $launch_scheme === 'https'
            && $launch_path === '/admin/ui/plugin-launch';
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

    /** @param array<string,mixed> $sync_run */
    private function render_latest_sync_run_status(array $sync_run): void {
        $result = is_array($sync_run['result'] ?? null) ? $sync_run['result'] : array();
        $details = array(
            __('Run id', 'clever-route-connector') => $this->text($sync_run['syncRunId'] ?? ''),
            __('Request', 'clever-route-connector') => $this->format_sync_request($sync_run),
            __('Accepted', 'clever-route-connector') => $this->format_optional_datetime($sync_run['acceptedAt'] ?? null, __('Not recorded', 'clever-route-connector')),
            __('Started', 'clever-route-connector') => $this->format_optional_datetime($sync_run['startedAt'] ?? null, __('Not started yet', 'clever-route-connector')),
            __('Completed', 'clever-route-connector') => $this->format_optional_datetime($sync_run['completedAt'] ?? null, __('Not completed yet', 'clever-route-connector')),
        );

        if (!empty($result)) {
            $details[__('Orders', 'clever-route-connector')] = $this->format_sync_counts($result);
            $details[__('Geocoding', 'clever-route-connector')] = $this->format_geocode_summary($result);
        }
        $raw = is_array($sync_run['raw'] ?? null) ? $sync_run['raw'] : array();
        if (!empty($raw)) {
            $details[__('Raw sync', 'clever-route-connector')] = $this->format_raw_sync_summary($raw);
            $failure_summary = $this->format_raw_sync_failures($raw);
            if ($failure_summary !== '') {
                $details[__('Raw failures', 'clever-route-connector')] = $failure_summary;
            }
        }

        $error_message = $this->text($sync_run['errorMessage'] ?? '');
        if ($error_message !== '') {
            $details[__('Error', 'clever-route-connector')] = $error_message;
        }

        $warnings = $this->sync_result_warnings($result);
        if (count($warnings) > 0) {
            $details[__('Warnings', 'clever-route-connector')] = implode(' | ', $warnings);
        }

        $this->render_status_card(
            __('Latest manual sync', 'clever-route-connector'),
            $this->format_sync_run_status_summary($sync_run),
            $details
        );
    }

    /** @param array<string,mixed> $data */
    private function summarize_sync_request_result(array $data): string {
        $message = $this->text($data['message'] ?? '');
        if ($message === '') {
            $message = __('Manual sync request accepted.', 'clever-route-connector');
        }

        $sync_run = is_array($data['syncRun'] ?? null) ? $data['syncRun'] : array();
        $status = $this->text($sync_run['status'] ?? '');
        $sync_run_id = $this->text($sync_run['syncRunId'] ?? '');
        $summary = $message;
        if ($sync_run_id !== '') {
            $summary .= ' ' . sprintf(__('Sync run: %1$s (%2$s).', 'clever-route-connector'), $sync_run_id, $status === '' ? __('status unknown', 'clever-route-connector') : $status);
        }

        if (!empty($data['alreadyRunning'])) {
            $summary .= ' ' . __('No duplicate background job was started.', 'clever-route-connector');
        }

        $result = is_array($sync_run['result'] ?? null) ? $sync_run['result'] : array();
        if (!empty($result)) {
            $summary .= ' ' . $this->format_sync_counts($result) . ' ' . $this->format_geocode_summary($result);
        } else {
            $summary .= ' ' . __('Final counts and geocoding results will appear in Ingestion status after the server finishes.', 'clever-route-connector');
        }

        return $summary;
    }

    /** @param array<string,mixed> $data */
    private function summarize_legacy_sync_result(array $data): string {
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

        $warnings = $this->sync_result_warnings($data);
        if (count($warnings) > 0) {
            $summary .= ' ' . __('Warnings:', 'clever-route-connector') . ' ' . implode(' | ', $warnings);
        }
        return $summary;
    }

    /** @param array<string,mixed> $result @param array<string,mixed> $data */
    private function sync_request_was_accepted_without_run_id(array $result, array $data): bool {
        $meta = is_array($result['_meta'] ?? null) ? $result['_meta'] : array();
        $status_code = (int) ($meta['statusCode'] ?? 0);
        if ($status_code === 202) {
            return true;
        }
        if ($status_code >= 200 && $status_code < 300 && $this->text($data['message'] ?? '') !== '') {
            return true;
        }
        return false;
    }

    /** @param array<string,mixed> $sync_run */
    private function format_sync_run_status_summary(array $sync_run): string {
        $status = strtoupper($this->text($sync_run['status'] ?? ''));
        if ($status === 'SUCCEEDED') {
            return __('Succeeded. Final server-side order and geocoding counts are stored in CLEVER.', 'clever-route-connector');
        }
        if ($status === 'FAILED') {
            return __('Failed. The redacted server error is shown below.', 'clever-route-connector');
        }
        if ($status === 'RUNNING') {
            return __('Running in the CLEVER server background worker.', 'clever-route-connector');
        }
        if ($status === 'QUEUED') {
            return __('Queued on the CLEVER server.', 'clever-route-connector');
        }
        return __('Status is not available yet.', 'clever-route-connector');
    }

    /** @param array<string,mixed> $sync_run */
    private function format_sync_request(array $sync_run): string {
        $request = is_array($sync_run['request'] ?? null) ? $sync_run['request'] : array();
        $modified_after = $this->text($request['modifiedAfter'] ?? '');
        $status = $this->text($request['status'] ?? '');
        return sprintf(
            __('page size %1$s; modified after %2$s; status %3$s', 'clever-route-connector'),
            $this->text($request['pageSize'] ?? '100'),
            $modified_after === '' ? __('all history', 'clever-route-connector') : $modified_after,
            $status === '' ? __('any supported status', 'clever-route-connector') : $status
        );
    }

    /** @param array<string,mixed> $result */
    private function format_sync_counts(array $result): string {
        $sync = is_array($result['sync'] ?? null) ? $result['sync'] : array();
        return sprintf(
            /* translators: 1: pages read, 2: received count, 3: created count, 4: updated count, 5: unchanged count, 6: skipped count, 7: ready-to-plan count, 8: needs-review count */
            __('pages %1$s; received %2$s; created %3$s; updated %4$s; unchanged %5$s; skipped %6$s; ready to plan %7$s; needs review %8$s', 'clever-route-connector'),
            $this->text($result['pagesRead'] ?? '0'),
            $this->text($sync['received'] ?? '0'),
            $this->text($sync['created'] ?? '0'),
            $this->text($sync['updated'] ?? '0'),
            $this->text($sync['unchanged'] ?? '0'),
            $this->text($sync['skipped'] ?? '0'),
            $this->text($sync['readyToPlan'] ?? '0'),
            $this->text($sync['needsReview'] ?? '0')
        );
    }

    /** @param array<string,mixed> $result */
    private function format_geocode_summary(array $result): string {
        $geocode = is_array($result['geocode'] ?? null) ? $result['geocode'] : array();
        return sprintf(
            __('resolved %1$s; pending %2$s; failed %3$s; not required %4$s', 'clever-route-connector'),
            $this->text($geocode['resolved'] ?? '0'),
            $this->text($geocode['pending'] ?? '0'),
            $this->text($geocode['failed'] ?? '0'),
            $this->text($geocode['notRequired'] ?? '0')
        );
    }

    /** @param array<string,mixed> $raw */
    private function format_raw_sync_summary(array $raw): string {
        return sprintf(
            __('accepted %1$s; processed %2$s; skipped %3$s; failed %4$s; chunks %5$s/%6$s', 'clever-route-connector'),
            $this->text($raw['accepted'] ?? '0'),
            $this->text($raw['processed'] ?? '0'),
            $this->text($raw['skipped'] ?? '0'),
            $this->text($raw['failed'] ?? '0'),
            $this->text($raw['chunksReceived'] ?? '0'),
            $this->text($raw['expectedChunkCount'] ?? __('unknown', 'clever-route-connector'))
        );
    }

    /** @param array<string,mixed> $raw */
    private function format_raw_sync_failures(array $raw): string {
        if (!is_array($raw['failures'] ?? null)) {
            return '';
        }
        $items = array();
        foreach ($raw['failures'] as $failure) {
            if (!is_array($failure)) {
                continue;
            }
            $source = $this->text($failure['sourceOrderNumber'] ?? $failure['sourceOrderId'] ?? '');
            $code = $this->text($failure['failureCode'] ?? 'RAW_ORDER_PROCESSING_FAILED');
            $message = $this->text($failure['message'] ?? __('Order could not be processed.', 'clever-route-connector'));
            $items[] = trim(sprintf('#%1$s %2$s: %3$s', $source, $code, $message));
            if (count($items) >= 10) {
                break;
            }
        }
        return implode(' | ', $items);
    }

    /** @param array<string,mixed> $result @return string[] */
    private function sync_result_warnings(array $result): array {
        $warnings = array();
        if (is_array($result['warnings'] ?? null)) {
            foreach ($result['warnings'] as $warning) {
                $warning_text = $this->text($warning);
                if ($warning_text !== '') {
                    $warnings[] = $warning_text;
                }
            }
        }
        return $warnings;
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
