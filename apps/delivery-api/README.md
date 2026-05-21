# delivery-api

Fastify/Prisma API for CLEVER route planning, driver access, delivery events,
and proof-media workflows.

This package is preserved from the prior Shopify-centered monorepo as the server
foundation for the new CLEVER route runtime. Shopify-specific modules remain as
legacy compatibility seams while WordPress/WooCommerce ingestion is introduced
additively.

## Development

```bash
npm ci
cp .env.example .env
npm run dev
```

## Verification

```bash
npm run prisma:generate
npm run lint
npm run typecheck
npm run test
npm run build
```
