# WooCommerce credential onboarding admin runbook

Status: API-contract MVP, 2026-05-22. This runbook is for internal CLEVER operators using the delivery API admin endpoints on `https://clever-route.cleversystem.ai`. The current plan does **not** create a separate CLEVER Admin Web app or `admin.cleversystem.ai`; any future operator/customer pages should stay on route-server subroutes unless a newer ADR overrides the domain strategy.

## Safety rules

- Do not put Woo Consumer Key, Consumer Secret, webhook secret, or customer PII in Slack, email, screenshots, ticket comments, logs, query strings, or repo files.
- API responses may show safe metadata only. Stored secrets are write-only: after save they are never displayed back.
- Use HTTPS Woo site URLs. Local `http://localhost` is only for local development tests.
- Start with sandbox/non-production Woo stores. Do not run production deploy or production WordPress changes from this repo.
- If evidence is needed, capture only: connection id, shop domain, site URL host, status, timestamps, audit action names, and redacted Woo screenshots with the key/secret fields covered.

## Domain and public-route scope

- Delivery API and Woo webhook host: `https://clever-route.cleversystem.ai`.
- Woo webhook delivery URLs use the same host, for example `/woocommerce/webhooks/<connectionId>/orders`.
- Internal admin API endpoints use the same host under `/admin/...`.
- Public privacy policy routes are prepared on the same host:
  - `/privacy`
  - `/privacy-policy` → redirects to `/privacy`
- Do not plan a separate `admin.cleversystem.ai` or standalone CLEVER Admin Web surface for this lane.

## Operator prerequisites

Delivery API environment:

- `CREDENTIAL_ENCRYPTION_KEY` set to the server-side encryption key.
- `CLEVER_ADMIN_API_TOKEN` set for the internal admin API bearer guard.
- `CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS` set to an explicit comma-separated allowlist for the operator token. Leave blank to fail closed; use `*` only for a deliberate, reviewed compatibility exception.
- `DELIVERY_API_PUBLIC_URL=https://clever-route.cleversystem.ai` for deployed route-server responses; otherwise local responses derive a base URL from request headers.

WooCommerce access:

- WordPress/Woo admin account with permission to create Woo REST API keys and webhooks.
- REST API key permission: **Read** is enough for the MVP order read/backfill verification path. Use **Read/Write** only if a later approved flow creates or edits Woo webhooks automatically.

## Create Woo REST API keys

1. In WordPress admin, go to **WooCommerce > Settings > Advanced > REST API**.
2. Add a key for the appropriate WordPress user.
3. Choose the minimum required permission, normally **Read** for this MVP.
4. Generate the key.
5. Copy the Consumer Key and Consumer Secret directly into the CLEVER admin API request. They are shown once in Woo; do not screenshot or store them elsewhere.

Reference: Woo's REST authentication documentation describes REST API keys, key permissions, and HTTPS Basic Auth with Consumer Key as username and Consumer Secret as password.

## Test without persisting

Use this before save. It validates Woo REST access and writes only a non-secret audit entry.

```bash
curl -sS -X POST "$DELIVERY_API_PUBLIC_URL/admin/commerce-connections/woocommerce/test" \
  -H "Authorization: Bearer <CLEVER_ADMIN_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "shopDomain": "tenant-a.example.test",
    "siteUrl": "https://woo.example.test",
    "consumerKey": "<paste once>",
    "consumerSecret": "<paste once>",
    "label": "Woo main",
    "timezone": "America/Toronto"
  }'
```

Expected result: `status: "VERIFIED"`. Failed results are sanitized and must not echo the submitted credentials.

## Save the connection

```bash
curl -sS -X POST "$DELIVERY_API_PUBLIC_URL/admin/commerce-connections/woocommerce" \
  -H "Authorization: Bearer <CLEVER_ADMIN_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "shopDomain": "tenant-a.example.test",
    "siteUrl": "https://woo.example.test",
    "consumerKey": "<paste once>",
    "consumerSecret": "<paste once>",
    "label": "Woo main",
    "timezone": "America/Toronto"
  }'
```

Record from the response:

- `connection.id`
- `webhookSetup.deliveryUrl`
- `webhookSetup.oneTimeSecret` — displayed once. Copy it immediately into Woo webhook settings, then discard local notes.

Do **not** expect list/detail endpoints to return the Consumer Key, Consumer Secret, or webhook secret later.

## Manually configure Woo webhooks

1. In WordPress admin, go to **WooCommerce > Settings > Advanced > Webhooks**.
2. Add a webhook.
3. Use a descriptive name, for example `CLEVER Route order created`.
4. Set **Status** to `Active`.
5. Set **Topic** to `Order created` for immediate new-order ingestion.
6. Set **Delivery URL** to `webhookSetup.deliveryUrl` from the create/rotate response.
7. Set **Secret** to `webhookSetup.oneTimeSecret`.
8. Save.
9. Repeat with topic `Order updated` if the customer expects post-create edits to resync route inputs.

Important: Woo's webhook docs state the Secret is used to generate a hash included in request headers, and that leaving it blank defaults to the current API user's consumer secret. For CLEVER, do **not** leave it blank; always paste the server-generated one-time webhook secret.

Woo may send a ping when an active webhook is saved. Verify with a real sandbox order event and Woo webhook logs under **WooCommerce > Status > Logs** filtered to webhook delivery logs.

## Read safe metadata

```bash
curl -sS "$DELIVERY_API_PUBLIC_URL/admin/commerce-connections/woocommerce?shopDomain=tenant-a.example.test" \
  -H "Authorization: Bearer <CLEVER_ADMIN_API_TOKEN>"

curl -sS "$DELIVERY_API_PUBLIC_URL/admin/commerce-connections/woocommerce/<connectionId>" \
  -H "Authorization: Bearer <CLEVER_ADMIN_API_TOKEN>"
```

Safe fields include status, labels, site URL, verification timestamps, last REST/webhook timestamps, and non-reversible credential fingerprint metadata. Raw secrets are not returned.

## Rotate REST credentials

Use when the Woo REST key is revoked, compromised, or intentionally replaced. Create a new Woo REST key first, then call:

```bash
curl -sS -X PATCH "$DELIVERY_API_PUBLIC_URL/admin/commerce-connections/woocommerce/<connectionId>/credentials" \
  -H "Authorization: Bearer <CLEVER_ADMIN_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "consumerKey": "<new key>",
    "consumerSecret": "<new secret>"
  }'
```

The API validates the new credentials before updating encrypted storage and returns safe metadata only.

## Rotate webhook secret

```bash
curl -sS -X PATCH "$DELIVERY_API_PUBLIC_URL/admin/commerce-connections/woocommerce/<connectionId>/webhook-secret" \
  -H "Authorization: Bearer <CLEVER_ADMIN_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Copy `webhookSetup.oneTimeSecret` into each Woo webhook using this connection URL. After rotation, old signatures should fail and new signatures should pass.

## Disable or re-enable a connection

```bash
curl -sS -X PATCH "$DELIVERY_API_PUBLIC_URL/admin/commerce-connections/woocommerce/<connectionId>/status" \
  -H "Authorization: Bearer <CLEVER_ADMIN_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"status":"DISABLED"}'
```

Disabled connections are not returned by internal decrypted credential reads, so webhook processing and REST sync paths fail closed for that connection. Re-enable with `{"status":"ACTIVE"}` only after credentials and webhook setup are verified.

## Support-safe evidence checklist

Allowed evidence:

- API status code and sanitized response with `connection.id`.
- `verification.status`, `verification.lastVerifiedAt`, `webhook.deliveryUrl`, `lastWebhookAt`, `lastRestSyncAt`.
- Audit actions and statuses: `test`, `create`, `rotate_credentials`, `rotate_webhook_secret`, `status`.
- Woo webhook delivery log status with secrets and payload PII redacted.

Forbidden evidence:

- Raw `ck_...`, `cs_...`, webhook secret, Basic Auth header, request body containing credentials, unredacted Woo order/customer payloads, browser local/session storage, or screenshots where generated keys are visible.

## References

- WooCommerce REST API authentication docs: https://developer.woocommerce.com/docs/apis/rest-api/authentication/
- WooCommerce webhook docs: https://woocommerce.com/document/webhooks/
