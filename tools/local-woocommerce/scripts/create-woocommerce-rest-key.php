<?php
/**
 * Create a local WooCommerce REST API key and print shell-compatible env vars.
 * This script is intended for the Docker-only local sandbox.
 */

if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) {
    fwrite( STDERR, "This script must run through WP-CLI.\n" );
    exit( 1 );
}

if ( ! class_exists( 'WooCommerce' ) ) {
    fwrite( STDERR, "WooCommerce is not active.\n" );
    exit( 2 );
}

if ( ! function_exists( 'wc_rand_hash' ) || ! function_exists( 'wc_api_hash' ) ) {
    fwrite( STDERR, "WooCommerce REST key helpers are unavailable.\n" );
    exit( 2 );
}

$description = getenv( 'CLEVER_WC_KEY_DESCRIPTION' ) ?: 'CLEVER local sandbox key';
$user_login  = getenv( 'CLEVER_WC_KEY_USER' ) ?: 'admin';
$permissions = getenv( 'CLEVER_WC_KEY_PERMISSIONS' ) ?: 'read_write';
$base_url    = getenv( 'CLEVER_WC_BASE_URL' ) ?: get_site_url();

if ( ! in_array( $permissions, array( 'read', 'write', 'read_write' ), true ) ) {
    fwrite( STDERR, "CLEVER_WC_KEY_PERMISSIONS must be read, write, or read_write.\n" );
    exit( 2 );
}

$user = get_user_by( 'login', $user_login );
if ( ! $user ) {
    fwrite( STDERR, "WordPress user not found: {$user_login}\n" );
    exit( 2 );
}

global $wpdb;
$table = $wpdb->prefix . 'woocommerce_api_keys';

// Keep this local helper idempotent and avoid piling up duplicate sandbox keys.
$wpdb->delete( $table, array( 'description' => $description ), array( '%s' ) );

$consumer_key    = 'ck_' . wc_rand_hash();
$consumer_secret = 'cs_' . wc_rand_hash();

$inserted = $wpdb->insert(
    $table,
    array(
        'user_id'         => $user->ID,
        'description'     => $description,
        'permissions'     => $permissions,
        'consumer_key'    => wc_api_hash( $consumer_key ),
        'consumer_secret' => $consumer_secret,
        'truncated_key'   => substr( $consumer_key, -7 ),
    ),
    array( '%d', '%s', '%s', '%s', '%s', '%s' )
);

if ( false === $inserted ) {
    fwrite( STDERR, "Failed to create WooCommerce REST API key.\n" );
    exit( 1 );
}

printf( "WC_BASE_URL=%s\n", escapeshellarg( rtrim( $base_url, '/' ) ) );
printf( "WC_CONSUMER_KEY=%s\n", escapeshellarg( $consumer_key ) );
printf( "WC_CONSUMER_SECRET=%s\n", escapeshellarg( $consumer_secret ) );
