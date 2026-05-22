# clever-route.cleversystem.ai subroute and privacy migration note

Date: 2026-05-22
Status: planning note for the WordPress/WooCommerce migration lane

## Decision

This lane uses only the existing route-server host:

```text
https://clever-route.cleversystem.ai
```

Do **not** introduce a separate CLEVER Admin Web app or `admin.cleversystem.ai`
for this lane. Public pages, protected operator surfaces, API contracts, and Woo
webhook delivery all stay under the route-server host unless a newer ADR changes
that strategy.

## Route allocation

| Surface | Route-server path | Notes |
| --- | --- | --- |
| Public privacy policy | `/privacy` | Migrated from the legacy Shopify app public privacy route. |
| Legacy privacy link | `/privacy-policy` | Redirects to `/privacy`. |
| API docs | `/docs`, `/docs/openapi.yaml` | Existing same-host docs surface; public only while `docs/security/public-docs-sanitized-review.md` remains valid, otherwise protect by default. |
| Internal/operator APIs | `/admin/...` | Protected by explicit admin/API auth; no public credential collection. |
| Woo webhook ingress | `/woocommerce/webhooks/<connectionId>/orders` | WooCommerce posts order webhooks here. |
| Future operator pages | Protected `/admin/...` pages on the same host | Only after identity/session and UI ownership are approved. |

## Privacy migration prep

Current implementation prep:

- `apps/delivery-api/src/routes/privacy.routes.ts` serves `/privacy` from the
  route server.
- `/privacy-policy` redirects to `/privacy` so legacy policy links have a stable
  migration target.
- The policy text has been generalized from Shopify-only language to
  WordPress/WooCommerce + route planning + driver/proof-of-delivery operations.
- The page avoids a separate admin-host dependency and points to
  `https://clever-route.cleversystem.ai/privacy`.

Remaining owner/legal work before final publication:

1. Confirm the legal operator name, support/privacy email, retention wording,
   and data storage region. Configure the finalized contact through
   `PRIVACY_CONTACT_EMAIL`; do not hardcode personal email addresses in source.
2. Confirm whether driver-app store privacy disclosures and this public privacy
   policy should share the same published URL or use separate mobile-store copy.
3. Confirm any production processors for hosting, maps, geocoding, routing,
   proof-media storage, and scanning.
4. Replace any legacy Shopify App Store listing privacy URL with
   `https://clever-route.cleversystem.ai/privacy` only after deployment evidence
   confirms the route is live.
5. Keep Woo Consumer Key, Consumer Secret, webhook secret, customer PII, proof
   media, and private evidence out of docs, logs, screenshots, and tickets.
