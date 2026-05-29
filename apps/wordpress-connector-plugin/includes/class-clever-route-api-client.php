<?php

defined('ABSPATH') || exit;

final class Clever_Route_Api_Client {
    private Clever_Route_Options $options;

    public function __construct(Clever_Route_Options $options) {
        $this->options = $options;
    }

    /** @return array<string,mixed> */
    public function pair(string $base_url, string $pairing_code): array {
        return $this->request(
            $base_url,
            '/wordpress/plugin/pair',
            'POST',
            array(
                'hposEnabled' => $this->hpos_enabled(),
                'pairingCode' => $pairing_code,
                'pluginVersion' => CLEVER_ROUTE_CONNECTOR_VERSION,
                'siteUrl' => home_url(),
                'wooVersion' => $this->woo_version(),
                'wpVersion' => get_bloginfo('version'),
            ),
            ''
        );
    }

    /** @return array<string,mixed> */
    public function get(string $path): array {
        return $this->request($this->options->get_base_url(), $path, 'GET', null, $this->options->get_token());
    }

    /** @return array<string,mixed> */
    public function post(string $path, array $payload): array {
        return $this->request($this->options->get_base_url(), $path, 'POST', $payload, $this->options->get_token());
    }

    /** @param array<string,mixed>|null $payload @return array<string,mixed> */
    private function request(string $base_url, string $path, string $method, ?array $payload, string $token): array {
        $base_url = $this->normalize_base_url($base_url);
        if ($base_url === null) {
            return array('data' => null, 'error' => array('message' => __('CLEVER API base URL must be a valid HTTPS URL.', 'clever-route-connector')));
        }

        $headers = array('Accept' => 'application/json');
        if ($token !== '') {
            $headers['Authorization'] = 'Bearer ' . $token;
        }
        if ($payload !== null) {
            $headers['Content-Type'] = 'application/json';
        }

        $response = wp_safe_remote_request(
            $base_url . $path,
            array(
                'method' => $method,
                'redirection' => 0,
                'reject_unsafe_urls' => true,
                'timeout' => 10,
                'headers' => $headers,
                'body' => $payload === null ? null : wp_json_encode($payload),
            )
        );

        if (is_wp_error($response)) {
            return array('data' => null, 'error' => array('message' => $response->get_error_message()));
        }

        $status_code = (int) wp_remote_retrieve_response_code($response);
        $body = json_decode((string) wp_remote_retrieve_body($response), true);
        if (!is_array($body)) {
            return array('data' => null, 'error' => array('message' => __('CLEVER API returned a non-JSON response.', 'clever-route-connector')));
        }

        $body['_meta'] = array('statusCode' => $status_code);
        if ($status_code >= 400 && !is_array($body['error'] ?? null)) {
            return array(
                'data' => null,
                'error' => array('message' => sprintf(__('CLEVER API returned HTTP %s.', 'clever-route-connector'), (string) $status_code)),
                '_meta' => array('statusCode' => $status_code),
            );
        }

        return $body;
    }

    private function normalize_base_url(string $base_url): ?string {
        $url = esc_url_raw(rtrim(trim($base_url), '/'));
        if ($url === '' || wp_http_validate_url($url) === false) {
            return null;
        }
        $scheme = parse_url($url, PHP_URL_SCHEME);
        if ($scheme !== 'https') {
            return null;
        }
        return $url;
    }

    private function woo_version(): ?string {
        if (defined('WC_VERSION')) {
            return (string) WC_VERSION;
        }
        return null;
    }

    private function hpos_enabled(): bool {
        if (!class_exists('Automattic\\WooCommerce\\Utilities\\OrderUtil')) {
            return false;
        }
        return Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();
    }
}
