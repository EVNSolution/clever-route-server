# CLEVER Route Connector

Private WordPress/WooCommerce admin plugin for CLEVER Route connection, sync status, diagnostics, and CLEVER workspace launch.

## MVP boundary

This plugin is a **WP Admin connector console**, not a route operations app:

- WooCommerce webhook remains the primary real-time order ingestion path into CLEVER.
- WooCommerce REST remains the server-side reconciliation/backfill path.
- The plugin can request a server-side REST backfill through `POST /wordpress/plugin/sync/request`; CLEVER returns a durable sync-run id immediately, then stores final counts and geocoding results server-side for the admin UI to show after refresh.
- The plugin shows connection, REST sync, webhook, latest durable manual sync-run, and support-safe diagnostic status only.
- The Orders & Sync page can request either an all-history backfill or a modified-after backfill, with guarded Woo status presets and a custom status slug fallback.
- Connected sites show **Open CLEVER Route** launch buttons for Order list, Create route, Driver management, and Settings. The plugin asks CLEVER for a short-lived server launch URL so WooCommerce admins can enter the workspace without re-entering the CLEVER admin login secret.
- Route planning, order operation, mapping review/editing, driver assignment, and stop operations live in the CLEVER web workspace, not inside WordPress.

## ZIP install/update notes

This private plugin is not wired to a WordPress auto-update channel. For customer installs, create and upload a fresh ZIP after every plugin change.

Recommended first-run flow:

1. Upload and activate the ZIP in WordPress Admin.
2. Open **WooCommerce → CLEVER Route → Setup** and pair with the CLEVER API base URL plus one-time pairing code.
3. Open **Orders & Sync** and run **Import all historical orders** once to pull existing WooCommerce orders into CLEVER.
4. Keep WooCommerce webhooks active for real-time new/updated orders after the backfill.
5. Use **Open CLEVER Route** to enter the CLEVER server workspace without re-entering the CLEVER admin login secret.
6. Use **Diagnostics** for support-safe plugin/server/WooCommerce status. Route and mapping operations are handled in the CLEVER web workspace.

## Explicit non-goals for MVP

- No `POST /wordpress/plugin/orders/batch` plugin-push ingestion.
- No public shortcode/block storefront frontend.
- No WordPress REST callback endpoint for server-pushed route result cache.
- No Woo order note/meta write-back.
- No route create/optimize/driver assign/stop reorder controls in WordPress.
- No WordPress-side Route Plans, Route Plan Detail, or Mapping tabs.
- No route/order operations table in WordPress beyond connector-level REST/webhook status and recorded ingestion counts when the server exposes them.

## Token lifecycle note

The local Disconnect action removes the connector token from WordPress options only. Server-side token revoke/rotate is represented in the CLEVER schema and should be added before production rollout if customer operations require self-service revocation.

## Tenant isolation note

The WordPress plugin UI is intentionally limited to connection-scoped status/sync/diagnostics. If future route-result or mapping APIs are exposed again in WordPress, add an ADR before narrowing or expanding result visibility by `commerceConnectionId`/`siteUrl`.
