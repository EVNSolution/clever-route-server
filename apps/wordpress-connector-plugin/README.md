# CLEVER Route Connector

Private WordPress/WooCommerce admin plugin for CLEVER Route result access.

## MVP boundary

This plugin is a **WP Admin access layer**, not an ingestion source of truth:

- WooCommerce webhook remains the primary real-time order ingestion path into CLEVER.
- WooCommerce REST remains the server-side reconciliation/backfill path.
- The plugin can request a server-side REST backfill through `POST /wordpress/plugin/sync/request`.
- The plugin reads route result DTOs from CLEVER and renders them under WooCommerce Admin.
- The Orders & Sync page can request either an all-history backfill or a modified-after backfill, with guarded Woo status presets and a custom status slug fallback.
- Connected sites show an **Open CLEVER Route** link to the server-owned admin workspace, prefilled with the WordPress site domain.

## ZIP install/update notes

This private plugin is not wired to a WordPress auto-update channel. For customer installs, create and upload a fresh ZIP after every plugin change.

Recommended first-run flow:

1. Upload and activate the ZIP in WordPress Admin.
2. Open **WooCommerce → CLEVER Route → Setup** and pair with the CLEVER API base URL plus one-time pairing code.
3. Open **Orders & Sync** and run **Import all historical orders** once to pull existing WooCommerce orders into CLEVER.
4. Keep WooCommerce webhooks active for real-time new/updated orders after the backfill.
5. Use **Open CLEVER Route** for route creation/date work on the CLEVER server workspace.
6. Use **Route Plans**, **Mapping**, and **Diagnostics** as read-only WordPress-side operational views.

## Explicit non-goals for MVP

- No `POST /wordpress/plugin/orders/batch` plugin-push ingestion.
- No public shortcode/block storefront frontend.
- No WordPress REST callback endpoint for server-pushed route result cache.
- No Woo order note/meta write-back.
- No route create/optimize/driver assign/stop reorder controls in WordPress.

## Token lifecycle note

The local Disconnect action removes the connector token from WordPress options only. Server-side token revoke/rotate is represented in the CLEVER schema and should be added before production rollout if customer operations require self-service revocation.

## Tenant isolation note

Route result APIs currently scope route plans by CLEVER `shopId`, which matches current server route-plan ownership. If a future tenant uses multiple Woo sites under one CLEVER shop, add an ADR before narrowing or expanding result visibility by `commerceConnectionId`/`siteUrl`.
