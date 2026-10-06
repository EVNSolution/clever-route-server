# Shopify offline token authority

The Delivery API owns the current offline access/refresh pair for each Shopify
app and shop. Staff browser sessions still use short-lived, freshly obtained
Shopify ID tokens. Increasing an access-token lifetime is not required for
multiple staff members to use the app concurrently.

## Acquisition and renewal

All server token readers, the public `/shopify/auth/token-exchange` compatibility
endpoint, and the signed app-server broker use `ShopTokenService`. The service
holds the existing PostgreSQL shop privacy advisory transaction lock while it
rechecks stored credentials, calls Shopify when needed, and stores the result.
This serializes OAuth calls across API replicas and background workers, not just
within one Node process. Different app/shop identities remain independent.

The app-server broker reuses access tokens with more than 330 seconds remaining,
beyond the Shopify SDK's five-minute renewal threshold. Otherwise it refreshes
the encrypted canonical credential. Only a verified, current Shopify ID token
can bootstrap or recover an installation when refresh is no longer possible.
Transient upstream failures do not trigger a replacement token exchange.

Uninstall and privacy redaction share the same lock. The signed ID token's `nbf`
timestamp is the conservative installation-intent time, so a delayed request
from before uninstall/redaction cannot reactivate the installation. A background
refresh cannot reactivate it either.

## App-server broker

`POST /shopify/auth/offline-token` accepts only these JSON fields, in canonical
serialization order:

```json
{"clientId":"configured-client-id","shopDomain":"store.myshopify.com","operation":"exchange","sessionToken":"fresh-shopify-id-token"}
```

For `operation: "refresh"`, omit `sessionToken`. Never send a Shopify refresh
token or client secret. The app's legacy refresh-token cache is ignored.

Headers:

- `x-clever-token-timestamp`: Unix time in seconds, within 60 seconds.
- `x-clever-token-signature`: hexadecimal HMAC-SHA256 using that app's configured
  Shopify client secret and this newline-joined input:
  `clever-shopify-token-authority-v1`, `POST`, `/shopify/auth/offline-token`,
  timestamp, and hexadecimal SHA256 of canonical JSON.

The client ID selects the configured app credential. The signature binds shop,
operation and subject token; exchange also verifies the subject token against
that exact app/shop. Requests inside the short replay window are idempotent
while the canonical credential remains healthy; there is no durable nonce store.
Possession of the app's Shopify client secret authorizes broker refresh reads
for every active installation of that app, matching the app server's existing
offline-token trust boundary. This is not a staff-user credential. Broker traffic
is limited to 300 requests per minute per source IP per API process; that bound
does not replace secret protection. Production app traffic uses the existing
private container network. The endpoint additionally requires the signature even
when reachable through the public API hostname.

The response uses Shopify's OAuth field names with the remaining lifetimes and
`Cache-Control: no-store`. Its `refresh_token` is the opaque routing marker
`clever-route-managed-v1`, never the real Shopify refresh token. Only the app
server receives the access token. The browser-accessible compatibility endpoint
continues returning status and scopes only.

## Coordinated rollout and verification

1. Deploy this server change, retaining the existing public compatibility route.
2. Deploy the Shopify app's OAuth transport adapter immediately afterwards. It
   routes the SDK's offline exchange/refresh calls to this broker and fails closed
   when the broker is unavailable. It leaves Admin GraphQL/REST transport intact.
3. Verify authenticated Orders/settings from multiple staff sessions, absence of
   new token-refresh failures, exact deployed revisions, and background reads.

Until step 2, older app replicas can still issue tokens independently. Deploy
every replica of each app being cut over. Other app identities can migrate
independently because credentials and locks are app-scoped. The app session
storage adapter marks legacy offline caches expired in memory on their first
load, so even non-expiring caches converge through the SDK's normal renewal.
No production token/session deletion, database migration or new secret is required.

For rollback, revert the app adapter before reverting the server broker. A
server-first rollback would leave the new app calling a missing endpoint.
Returning to the old app also returns its independent-issuer risk; refresh
recovery may require a current merchant ID token.

Validation includes real PostgreSQL cross-client concurrency/privacy checks,
signed broker rejection and secret-leakage tests, SDK transport contract tests
in the app repository, and the standard source/CI checks. Local tests are not
evidence of production staff-session behavior.

Reference: [Shopify access-token lifecycle](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens).
