# Shopify and Admin API Contracts

Purpose: document the server endpoints used by the Shopify embedded/admin app
and Shopify HTTPS webhooks. Driver mobile endpoints are documented separately in
`driver-*.md`; all endpoints are indexed in `openapi.yaml`.

## Authentication boundaries

### Shopify embedded/admin app calls

Admin-facing routes require a Shopify App Bridge session token:

```http
Authorization: Bearer <shopify-session-token>
```

The server verifies the token and derives `shopDomain` from the verified token.
Clients must not choose a tenant by sending `shopDomain` in admin payloads except
where `/shopify/auth/token-exchange` accepts an optional expected-shop guard.

### Shopify webhook ingress

Shopify webhook delivery calls `POST /shopify/webhooks` with raw JSON body and
Shopify headers. The server verifies `X-Shopify-Hmac-Sha256` against the raw body
with the Shopify app secret before persisting receipt metadata.

Relevant Shopify references:

- Webhook header fields and duplicate event guidance:
  <https://shopify.dev/docs/apps/webhooks>
- HTTPS webhook HMAC validation:
  <https://shopify.dev/docs/apps/build/webhooks/subscribe/https>
- Session-token exchange:
  <https://shopify.dev/docs/apps/auth/get-access-tokens/token-exchange/>

## POST `/shopify/auth/token-exchange`

Exchanges a Shopify App Bridge session token for an Admin API token and stores
only encrypted token material plus metadata.

Request:

```http
POST /shopify/auth/token-exchange
Authorization: Bearer <shopify-session-token>
Content-Type: application/json
```

```json
{
  "shopDomain": "example.myshopify.com"
}
```

`shopDomain` is optional. When provided, it is an expected-shop guard for the
session-token verifier, not the source of tenant truth.

Success `200`:

```json
{
  "data": {
    "shopDomain": "example.myshopify.com",
    "tokenScopes": ["read_orders", "write_orders"],
    "tokenStored": true
  },
  "error": null
}
```

Common errors:

- `400 BAD_REQUEST`: invalid `shopDomain` field.
- `401 UNAUTHORIZED`: missing or invalid Shopify session token.
- `502 SHOPIFY_TOKEN_EXCHANGE_FAILED`: Shopify token exchange failed or token
  storage failed.

## POST `/shopify/webhooks`

Records an idempotent Shopify webhook receipt. Payload processing is separate
from this ingress contract.

Request:

```http
POST /shopify/webhooks
X-Shopify-Hmac-Sha256: <base64 HMAC>
X-Shopify-Topic: orders/create
X-Shopify-Shop-Domain: example.myshopify.com
X-Shopify-Webhook-Id: 11111111-1111-4111-8111-111111111111
X-Shopify-Event-Id: 22222222-2222-4222-8222-222222222222
X-Shopify-API-Version: 2026-04
X-Shopify-Triggered-At: 2026-05-14T00:00:00.000Z
Content-Type: application/json
```

```json
{ "id": 1234567890, "admin_graphql_api_id": "gid://shopify/Order/1234567890" }
```

Success `202` for a new receipt, `200` for a duplicate receipt:

```json
{
  "data": {
    "duplicate": false,
    "webhookId": "11111111-1111-4111-8111-111111111111"
  },
  "error": null
}
```

Required headers are `X-Shopify-Hmac-Sha256`, `X-Shopify-Topic`,
`X-Shopify-Shop-Domain`, and `X-Shopify-Webhook-Id`. `X-Shopify-Event-Id`,
`X-Shopify-API-Version`, and `X-Shopify-Triggered-At` are stored when present.
Header names are treated case-insensitively by the runtime.

Common errors:

- `400 BAD_REQUEST`: missing raw body, missing required headers, invalid shop
  domain, or invalid triggered-at timestamp.
- `401 UNAUTHORIZED`: invalid HMAC.

## PATCH `/admin/orders/sync`

Accepts a Shopify order snapshot collected by the embedded/admin app, maps it to
canonical delivery orders/stops, and returns the canonical rows plus sync counts.

Request:

```http
PATCH /admin/orders/sync
Authorization: Bearer <shopify-session-token>
Content-Type: application/json
```

```json
{
  "source": "clever-app-orders",
  "reason": "orders_page_open",
  "orders": [
    {
      "id": "gid://shopify/Order/123",
      "legacyResourceId": "123",
      "name": "#1001",
      "updatedAt": "2026-05-14T00:00:00.000Z",
      "shippingAddress": {
        "address1": "100 King St W",
        "city": "Toronto",
        "countryCodeV2": "CA",
        "latitude": 43.6487,
        "longitude": -79.3817,
        "name": "Recipient One",
        "province": "ON",
        "zip": "M5X 1A9"
      },
      "customAttributes": [
        { "key": "Delivery Area", "value": "Toronto" },
        { "key": "Delivery Day", "value": "Thursday" }
      ]
    }
  ]
}
```

Allowed `reason` values are `orders_page_open`, `manual_refresh`, and
`route_create_preflight`.

Success `200`:

```json
{
  "data": {
    "orders": [
      {
        "orderId": "33333333-3333-4333-8333-333333333333",
        "shopifyOrderGid": "gid://shopify/Order/123",
        "name": "#1001",
        "readiness": "READY_TO_PLAN",
        "planningStatus": "UNPLANNED",
        "shippingAddress": {
          "address1": "100 King St W",
          "address2": null,
          "city": "Toronto",
          "countryCode": "CA",
          "postalCode": "M5X 1A9",
          "province": "ON"
        }
      }
    ],
    "sync": {
      "created": 1,
      "updated": 0,
      "unchanged": 0,
      "skipped": 0,
      "received": 1,
      "readyToPlan": 1,
      "needsReview": 0
    }
  },
  "error": null
}
```

Invalid snapshots return `400 INVALID_ORDER_SYNC_PAYLOAD`. Timestamp parse
failures for Shopify timestamp fields reject the payload; optional non-critical
field issues can be returned as warnings when rows are skipped.

## GET `/admin/orders`

Lists canonical orders for the authenticated shop. Supported query filters:

- `readiness`: `READY_TO_PLAN`, `NEEDS_REVIEW`, `SKIPPED`
- `planned`: `true`, `false`
- `deliveryWeekday`: `THURSDAY`, `FRIDAY`, `SATURDAY`
- `serviceType`: `DELIVERY`, `EVENING_DELIVERY`, `PICKUP`
- `geocodeStatus`: `PENDING`, `RESOLVED`, `FAILED`, `NOT_REQUIRED`
- `deliveryDate`, `deliveryBatchStartDate`, `deliveryBatchEndDate`: `YYYY-MM-DD`
- `deliverySession`: `DAY`, `EVENING`, `PICKUP`
- `routeScopeKey`, `planningGroupKey`, `search`: strings

Success `200` returns:

```json
{ "data": { "orders": [] }, "error": null }
```

## POST `/admin/drivers`

Creates a pending driver record under the authenticated shop.

Request:

```json
{
  "source": "clever-app-driver-invite",
  "phone": "+14165550123",
  "displayName": "Driver One",
  "inviteLink": "https://example.com/invite/driver-one"
}
```

`phone` must be E.164. `displayName` and `inviteLink` may be `null` or omitted;
when `inviteLink` is present it must be a valid URL.

Success `201`:

```json
{ "data": { "driver": { "id": "driver-id" } }, "error": null }
```

## GET `/admin/drivers`

Lists drivers for the authenticated shop:

```json
{ "data": { "drivers": [] }, "error": null }
```

## Route-plan admin endpoints

Route planning endpoints are documented in `admin-route-plans.md` and indexed in
`openapi.yaml`:

- `POST /admin/route-plans`
- `GET /admin/route-plans`
- `GET /admin/route-plans/:routePlanId`
- `PATCH /admin/route-plans/:routePlanId/stops`
- `DELETE /admin/route-plans/:routePlanId`

## Data minimization and public-doc rules

- Never document real Admin API access tokens, refresh tokens, JWTs, HMAC
  secrets, shop-specific private evidence, proof images, or customer data.
- Use synthetic domains, UUIDs, phone numbers, and order IDs in docs and public
  PR evidence.
- Keep `shopDomain` tenant ownership server-derived from verified Shopify
  session/webhook data wherever possible.
- Driver mobile clients must call server `/driver/*` APIs, not Shopify Admin APIs.
