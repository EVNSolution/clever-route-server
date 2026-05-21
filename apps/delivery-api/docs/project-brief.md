# Project brief — CLEVER route server delivery API

This package is the server foundation for CLEVER route planning, delivery-driver
access, delivery events, route plans, and proof-media workflows.

## Current product direction

The project is moving away from Shopify as the primary customer integration.
The future commerce source is WordPress/WooCommerce or another WordPress shop
source. The existing server and mobile app contracts should be preserved while
Shopify-specific ingestion/admin seams are retired only after a tested
WordPress/Woo replacement exists.

## Current package role

- Fastify HTTP API
- Prisma/PostgreSQL persistence
- Admin order/driver/route-plan APIs consumed by current admin clients
- Native driver app APIs for invite/login, assigned routes, events, and proof media
- Legacy Shopify token/webhook/order-sync compatibility modules

## Non-goals for this bootstrap

- No Shopify embedded app runtime in this repository
- No AWS/EC2/EIP/Route53 mutation
- No destructive Prisma/table/field rename
- No WordPress production site mutation without access/permission proof

## Near-term target

1. Keep the delivery API running as `clever-route-server`.
2. Add WordPress/WooCommerce order ingestion additively.
3. Preserve driver mobile API contracts while server base URL migrates toward
   `https://clever-route.cleversystem.ai`.
4. Keep Shopify compatibility as a legacy rollback path until migration evidence
   proves it can be retired.

## Verification baseline

```bash
npm run prisma:generate
npm run lint
npm run typecheck
npm run test
npm run build
```
