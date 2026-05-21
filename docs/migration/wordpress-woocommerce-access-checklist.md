# WordPress / WooCommerce access checklist

Date: 2026-05-21
Purpose: classify the customer WordPress commerce environment before implementing the connector.

## Known now

- WordPress admin account exists.
- Hosting/SFTP/SSH/DB access: unknown.
- WooCommerce REST API key authority: unknown.
- Webhook setup authority: unknown.
- Plugin install/custom plugin authority: unknown.


## Related local sandbox

After completing the admin discovery checks, use `docs/migration/local-woocommerce-sandbox-checklist.md` to create a non-production WooCommerce sandbox with synthetic orders that match the discovered metadata shape.

## Access checks to perform in WordPress admin

### Commerce platform
- [ ] Is WooCommerce installed and active?
- [ ] WooCommerce version:
- [ ] HPOS/order storage setting visible?
- [ ] Order list contains the relevant customer orders?
- [ ] Delivery date/time appears in order detail? Where?
  - [ ] core order field
  - [ ] order meta/custom field
  - [ ] line item meta
  - [ ] shipping method/date plugin
  - [ ] not present

### REST API
- [ ] Can create WooCommerce REST API key?
- [ ] Minimum required scope available:
  - [ ] read-only orders
  - [ ] read/write only if route/tracking write-back is contractually required
- [ ] Test endpoint reachable:
  - `GET /wp-json/`
  - `GET /wp-json/wc/v3/orders?per_page=1`
- [ ] API auth method confirmed:
  - [ ] Woo consumer key/secret
  - [ ] WP application password
  - [ ] other/security plugin constraint

### Webhooks
- [ ] Can create WooCommerce webhook?
- [ ] Topics available:
  - [ ] order.created
  - [ ] order.updated
  - [ ] order.deleted
- [ ] Webhook delivery URL can be set to HTTPS external URL.
- [ ] Secret can be set/rotated.
- [ ] Delivery logs are visible.

### Hosting / plugin fallback
- [ ] Plugin install allowed?
- [ ] Custom plugin upload allowed?
- [ ] SFTP/SSH available?
- [ ] DB/adminer/phpMyAdmin access available?
- [ ] Backup/restore owner identified?
- [ ] Security/WAF/cache plugins identified?

## Classification result

Choose one after checks:

1. `Woo core usable`: Woo REST + metadata + webhook enough. No plugin required.
2. `Woo plus metadata mapping`: Woo REST works but delivery fields require custom meta mapping.
3. `Woo plus connector plugin`: REST/webhook insufficient or delivery fields hidden; minimal plugin required.
4. `Non-Woo/custom commerce`: connector must be custom; Woo plan is not enough.
5. `Insufficient access`: stop and request hosting/API/plugin permissions.

## Connector implementation guard

Start read-only. Do not request write scope unless we need to push route/tracking state back into WordPress.
