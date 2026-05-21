# Source inventory — delivery API bootstrap

Date: 2026-05-21

## Imported source

- Source repo: `EVNSolution/shopify-clever`
- Source path: `apps/delivery-api`
- Source baseline branch: `main`
- Source baseline commit: `0bab133 Keep route planning filters from deleting user intent`
- Preserved local Shopify pre-split work:
  - branch: `migration/pre-wordpress-split-20260521`
  - tag: `pre-wordpress-split-20260521`
  - commit: `684276107ee3e05b2bdda719b39209c17667e27e`

## Imported into this repo

- `apps/delivery-api/src`
- `apps/delivery-api/tests`
- `apps/delivery-api/prisma`
- `apps/delivery-api/docs/api`
- delivery API build/test config and Dockerfile

## Intentionally not imported

- Shopify embedded admin app (`apps/shopify-app`)
- Shopify CLI app configuration (`shopify.app*.toml`)
- Existing mixed Shopify compose/Caddy runtime files
- Built outputs (`dist`), dependencies (`node_modules`), `.DS_Store`, real env files,
  DB dumps, proof media, and private evidence

## Compatibility note

The imported server still contains Shopify-named schemas/modules/routes. Those are
legacy compatibility seams and must remain additive until WordPress/WooCommerce
order ingestion and driver-app compatibility have fresh test/smoke evidence.
