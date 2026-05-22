# CLEVER Route Server

Main server repository for CLEVER route planning, driver access, delivery events,
and proof-media workflows.

This repo was bootstrapped from the delivery API inside
`EVNSolution/shopify-clever` so the existing mobile/server contracts can be
preserved while the commerce source moves from Shopify to WordPress/WooCommerce.
The Shopify embedded admin app is intentionally **not** part of this repository.

## Current state

- Runtime app: `apps/delivery-api` (Fastify + Prisma + PostgreSQL)
- Preserved flows: health/readiness, admin route/order/driver APIs, driver auth,
  assigned route, driver events, proof media, route planning data model
- Legacy compatibility still present: Shopify token/webhook/order-sync modules
  remain available until the WordPress/WooCommerce connector and tenant/order
  identity migration are complete
- Intended public endpoint: `https://clever-route.cleversystem.ai`
- Public and operator-facing surfaces for this lane stay on this same host:
  `/privacy`, `/privacy-policy`, `/docs`, `/admin/...`, and
  `/woocommerce/webhooks/...`. `/docs` is public only under the sanitized docs
  review in `docs/security/public-docs-sanitized-review.md`; otherwise protect
  it by default. Do not introduce a separate CLEVER Admin Web
  domain for the current WordPress/WooCommerce migration lane.
- Infrastructure changes are staged only; this bootstrap does not mutate AWS,
  EC2, EIP, or Route53

## Local development

```bash
npm run setup
cp apps/delivery-api/.env.example apps/delivery-api/.env
npm run dev:api
```

Health checks:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

Validation:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Compose preview

The delivery-only compose stack is under `infra/compose/docker-compose.prod.yml`.
Use the example env file for config validation only; do not commit real env files.

```bash
cp infra/env/delivery-api.env.example infra/env/delivery-api.env
docker compose -f infra/compose/docker-compose.prod.yml config --quiet
rm -f infra/env/delivery-api.env
```

## Migration references

- `docs/migration/source-inventory.md`
- `docs/migration/wordpress-woocommerce-access-checklist.md`
- `docs/adr/tenant-order-identity.md`
