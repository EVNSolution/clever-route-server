# Local WooCommerce sandbox checklist

Date: 2026-05-21
Purpose: define a safe local WordPress/WooCommerce environment for discovering order data shape before implementing CLEVER order ingestion.

## Non-goals and safety boundaries

- Do not use production WordPress credentials in the local sandbox.
- Do not clone production WordPress DB until a PII-safe export process is approved.
- Do not install a connector plugin on production WordPress as part of sandbox setup.
- Do not create production WooCommerce webhooks until the CLEVER HTTPS endpoint and signature verification exist.
- Do not change AWS, EC2, EIP, Route53, DNS, or Caddy production hosts for this checklist.

## Inputs needed from WordPress admin discovery

Record these from the customer WordPress admin before building fixtures:

- WordPress version.
- WooCommerce active/inactive and WooCommerce version.
- Whether WooCommerce High-Performance Order Storage (HPOS) is enabled, if visible.
- Whether WooCommerce REST API keys can be created.
- Whether WooCommerce webhooks can be created and logs are visible.
- Whether plugin installation/upload is allowed.
- For 3-5 representative orders:
  - order number,
  - Woo status,
  - recipient name,
  - phone,
  - shipping address,
  - delivery date/time field label,
  - delivery date/time storage location if visible,
  - delivery notes / customer notes,
  - any route/area/shipping method metadata.

Do not paste secrets, customer PII, or full raw order dumps into git. Use redacted examples or synthetic fixtures.

## Recommended local sandbox shape

Use a disposable local WordPress + WooCommerce stack separate from `clever-route-server` runtime:

```text
local-woocommerce-sandbox/
  compose.yml
  README.md
  seed-orders/
    sample-orders.redacted.json
```

Recommended services:

- `wordpress` — current stable WordPress image.
- `mysql` or `mariadb` — local-only DB volume.
- optional `wp-cli` — to install/activate WooCommerce and seed orders.

A repo-local disposable Compose scaffold now lives at `tools/local-woocommerce/`. It is for synthetic local development only and must not receive production credentials or customer exports.

Keep this sandbox outside production deploy paths. If it is later committed, use fake data only.

## Setup checklist

1. Create local-only directory or branch-scoped prototype.
2. Start WordPress + DB locally.
3. Install and activate WooCommerce.
4. Configure pretty permalinks; WooCommerce REST API requires non-plain permalinks for standard `wc/v3` routes.
5. Create local admin user.
6. Create local WooCommerce REST API key with read-only orders permission first.
7. Verify local REST discovery:

   ```bash
   curl -sS http://localhost:<port>/wp-json/ | jq '.namespaces'
   ```

8. Verify local Woo orders endpoint:

   ```bash
   curl -sS -u "$WC_CONSUMER_KEY:$WC_CONSUMER_SECRET" \
     'http://localhost:<port>/wp-json/wc/v3/orders?per_page=1'
   ```

9. Seed synthetic orders matching the customer-discovered field shape.
10. Capture one redacted fixture per order shape in `apps/delivery-api/tests/fixtures/woocommerce/` when implementation begins.

## Synthetic order fixture requirements

Create fixtures that cover:

- normal order with shipping name/address/phone and delivery date metadata,
- order where billing phone is the only available phone,
- order with missing delivery date that should become explicit `Date pending`,
- order with delivery date stored in order `meta_data`,
- order with delivery date stored in line item `meta_data`, if the customer site uses that shape,
- cancelled/refunded order that should be excluded or de-planned according to the later business rule,
- duplicate numeric order id across platforms to prove `sourcePlatform = woocommerce` prevents collision with Shopify-era ids.

## REST proof checklist

Before writing importer code, prove these against local sandbox and, later, the customer site using read-only credentials:

- `GET /wp-json/` returns JSON.
- Woo namespace/routes are available.
- `GET /wp-json/wc/v3/orders?per_page=1` returns a JSON array.
- Pagination works with `page` and `per_page`; record `X-WP-Total` and `X-WP-TotalPages` behavior.
- Authentication failure returns a controlled 401/403 response.
- If HTTPS Basic Auth fails because the host strips `Authorization`, classify it as hosting/server config before using query-string auth.

## Webhook sandbox checklist

Only after REST mapping is proven:

- Create a local or tunnel URL that can receive WooCommerce webhooks.
- Create local webhook topics:
  - `order.created`,
  - `order.updated`,
  - `order.deleted` only if delete/cancel handling is required.
- Set a local-only webhook secret.
- Verify the webhook delivery log in WooCommerce admin.
- Verify the receiver rejects invalid signatures.
- Verify duplicate delivery does not duplicate CLEVER orders.

Do not create production webhooks until `clever-route-server` has a public HTTPS endpoint, secret storage, signature verification, and idempotency.

## Mapping target for CLEVER

The later importer should map Woo orders into a platform-neutral input:

```text
sourcePlatform: woocommerce
sourceSiteUrl: <customer WordPress site URL>
sourceOrderId: order.id
sourceOrderNumber: order.number
sourceUpdatedAt: order.date_modified_gmt || order.date_modified
recipientName: shipping first, billing fallback
phone: best known phone, usually billing.phone
address: shipping address fields
status: Woo status mapped to CLEVER eligibility
deliveryDate: customer-specific metadata key, or explicit Date pending diagnostic
```

## Exit criteria

The sandbox is ready for implementation when:

- local Woo REST orders endpoint works,
- at least 5 synthetic orders cover the discovered customer data shapes,
- delivery date metadata has a named mapping candidate or an explicit unknown classification,
- read-only importer tests can be written without production secrets,
- no production WordPress settings, AWS, or DNS were changed.

## References

- WooCommerce REST API: https://developer.woocommerce.com/docs/apis/rest-api/
- WooCommerce REST API authentication: https://developer.woocommerce.com/docs/apis/rest-api/authentication/
- WooCommerce webhooks: https://woocommerce.com/document/webhooks/
- WordPress REST API authentication: https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/
- WordPress custom REST endpoints: https://developer.wordpress.org/rest-api/extending-the-rest-api/adding-custom-endpoints/
