<?php

defined('ABSPATH') || exit;

final class Clever_Route_Options {
    private const OPTION_BASE_URL = 'clever_route_api_base_url';
    private const OPTION_TOKEN = 'clever_route_connector_token';
    private const OPTION_TOKEN_PREFIX = 'clever_route_connector_token_prefix';
    private const OPTION_CONNECTION_ID = 'clever_route_connection_id';
    private const OPTION_LAST_ERROR = 'clever_route_last_error';

    /** @return array{base_url:string,connection_id:string,token_prefix:string,connected:bool,last_error:string} */
    public function summary(): array {
        return array(
            'base_url' => $this->get_base_url(),
            'connection_id' => (string) get_option(self::OPTION_CONNECTION_ID, ''),
            'token_prefix' => (string) get_option(self::OPTION_TOKEN_PREFIX, ''),
            'connected' => $this->get_token() !== '' && $this->get_base_url() !== '',
            'last_error' => (string) get_option(self::OPTION_LAST_ERROR, ''),
        );
    }

    public function get_base_url(): string {
        return rtrim((string) get_option(self::OPTION_BASE_URL, ''), '/');
    }

    public function get_token(): string {
        return (string) get_option(self::OPTION_TOKEN, '');
    }

    public function token_prefix(): string {
        return (string) get_option(self::OPTION_TOKEN_PREFIX, '');
    }

    public function save_pairing(string $base_url, string $token, string $token_prefix, string $connection_id): void {
        $this->save_nonautoloaded_option(self::OPTION_BASE_URL, esc_url_raw(rtrim($base_url, '/')));
        $this->save_nonautoloaded_option(self::OPTION_TOKEN, $token);
        $this->save_nonautoloaded_option(self::OPTION_TOKEN_PREFIX, sanitize_text_field($token_prefix));
        $this->save_nonautoloaded_option(self::OPTION_CONNECTION_ID, sanitize_text_field($connection_id));
        delete_option(self::OPTION_LAST_ERROR);
    }

    public function save_error(string $message): void {
        $this->save_nonautoloaded_option(self::OPTION_LAST_ERROR, sanitize_text_field($message));
    }

    public function disconnect_local(): void {
        delete_option(self::OPTION_TOKEN);
        delete_option(self::OPTION_TOKEN_PREFIX);
        delete_option(self::OPTION_CONNECTION_ID);
    }

    public function delete_all(): void {
        delete_option(self::OPTION_BASE_URL);
        delete_option(self::OPTION_TOKEN);
        delete_option(self::OPTION_TOKEN_PREFIX);
        delete_option(self::OPTION_CONNECTION_ID);
        delete_option(self::OPTION_LAST_ERROR);
    }

    /** @param mixed $value */
    private function save_nonautoloaded_option(string $name, $value): void {
        delete_option($name);
        add_option($name, $value, '', 'no');
    }
}
