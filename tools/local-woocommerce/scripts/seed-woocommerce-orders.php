<?php
/**
 * Seed synthetic WooCommerce orders for the local CLEVER sandbox.
 */

if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) {
    fwrite( STDERR, "This script must run through WP-CLI.\n" );
    exit( 1 );
}

if ( ! class_exists( 'WooCommerce' ) ) {
    fwrite( STDERR, "WooCommerce is not active.\n" );
    exit( 2 );
}

$seed_file = getenv( 'CLEVER_WC_SEED_FILE' ) ?: '/tmp/seed-orders.example.json';
if ( ! file_exists( $seed_file ) ) {
    fwrite( STDERR, "Seed file not found: {$seed_file}\n" );
    exit( 2 );
}

$orders = json_decode( file_get_contents( $seed_file ), true );
if ( ! is_array( $orders ) ) {
    fwrite( STDERR, "Seed file must contain a JSON array.\n" );
    exit( 2 );
}

$product_id = clever_get_or_create_sandbox_product();
$created    = 0;
$updated    = 0;

foreach ( $orders as $order_data ) {
    if ( ! is_array( $order_data ) ) {
        continue;
    }

    $seed_number = isset( $order_data['number'] ) ? (string) $order_data['number'] : '';
    if ( '' === $seed_number ) {
        WP_CLI::warning( 'Skipping seed order without number.' );
        continue;
    }

    $existing = wc_get_orders(
        array(
            'limit'      => 1,
            'meta_key'   => '_clever_sandbox_number',
            'meta_value' => $seed_number,
            'return'     => 'objects',
        )
    );

    if ( ! empty( $existing ) ) {
        $order = $existing[0];
        $updated++;
    } else {
        $order = wc_create_order( array( 'created_via' => 'clever-local-sandbox' ) );
        $order->add_product( wc_get_product( $product_id ), 1 );
        $order->update_meta_data( '_clever_sandbox_number', $seed_number );
        $created++;
    }

    clever_apply_seed_order_data( $order, $order_data );
    $order->save();
}

WP_CLI::success( sprintf( 'Seeded WooCommerce orders. created=%d updated=%d received=%d', $created, $updated, count( $orders ) ) );

function clever_get_or_create_sandbox_product(): int {
    $sku        = 'CLEVER-SANDBOX-MEAL';
    $product_id = wc_get_product_id_by_sku( $sku );

    if ( $product_id ) {
        return (int) $product_id;
    }

    $product = new WC_Product_Simple();
    $product->set_name( 'CLEVER synthetic meal box' );
    $product->set_sku( $sku );
    $product->set_regular_price( '10.00' );
    $product->set_catalog_visibility( 'hidden' );
    $product->save();

    return (int) $product->get_id();
}

function clever_apply_seed_order_data( WC_Order $order, array $order_data ): void {
    $status = isset( $order_data['status'] ) ? sanitize_key( (string) $order_data['status'] ) : 'processing';
    $order->set_status( $status );

    $shipping = isset( $order_data['shipping'] ) && is_array( $order_data['shipping'] ) ? $order_data['shipping'] : array();
    $billing  = isset( $order_data['billing'] ) && is_array( $order_data['billing'] ) ? $order_data['billing'] : $shipping;

    $order->set_address( clever_sanitize_address( $billing ), 'billing' );
    $order->set_address( clever_sanitize_address( $shipping ), 'shipping' );

    if ( array_key_exists( 'delivery_date', $order_data ) ) {
        $value = $order_data['delivery_date'];
        if ( null === $value || '' === $value ) {
            $order->delete_meta_data( 'delivery_date' );
        } else {
            $order->update_meta_data( 'delivery_date', sanitize_text_field( (string) $value ) );
        }
    }

    foreach ( array( 'delivery_area', 'delivery_window', 'delivery_day' ) as $meta_key ) {
        if ( isset( $order_data[ $meta_key ] ) ) {
            $order->update_meta_data( $meta_key, sanitize_text_field( (string) $order_data[ $meta_key ] ) );
        }
    }

    $order->calculate_totals();
}

function clever_sanitize_address( array $address ): array {
    $fields = array(
        'first_name',
        'last_name',
        'company',
        'address_1',
        'address_2',
        'city',
        'state',
        'postcode',
        'country',
        'email',
        'phone',
    );

    $result = array();
    foreach ( $fields as $field ) {
        if ( isset( $address[ $field ] ) ) {
            $result[ $field ] = sanitize_text_field( (string) $address[ $field ] );
        }
    }

    return $result;
}
