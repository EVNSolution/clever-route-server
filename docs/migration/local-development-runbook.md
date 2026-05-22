# Local development runbook

Parent workspace:

```text
04_CLEVER_Route/
  clever-route-server/   # main route server repo
  shopify-clever/        # legacy Shopify monorepo/source baseline
  clever-driver-app/     # mobile app repo; preserve existing WIP
  worktrees/             # disposable local worktrees, ignored
```

## Ports

| Service | Default local port | Notes |
| --- | ---: | --- |
| delivery-api | 3000 | `npm run dev:api` |
| Postgres | 5432 | local/dev DB, optional unless running integration storage manually |
| Caddy | 80/443 | compose/runtime only |

## Compose project names

Use explicit project names if running main and legacy stacks on the same machine:

```bash
docker compose -p clever-route-server -f infra/compose/docker-compose.prod.yml config
```

Keep legacy Shopify compose project names separate, for example `shopify-clever-legacy`.

## Env templates

- Server package local env: `apps/delivery-api/.env.example`
- Delivery-only compose env: `infra/env/delivery-api.env.example`
- Real env files are ignored and must not be committed.

## Mobile base URL

Future mobile/server contract should use `https://clever-route.cleversystem.ai`.
Do not hardcode raw EIP or `sslip.io` as the normal app contract except in
emergency diagnostics notes.

## Public route-server subroutes

The current WordPress/WooCommerce migration lane is constrained to the existing
route-server host. Do not plan a separate `admin.cleversystem.ai` or standalone
CLEVER Admin Web for this lane.

Expected public/protected subroutes on `https://clever-route.cleversystem.ai`:

- `/privacy` — public privacy policy page migrated from the legacy Shopify app surface.
- `/privacy-policy` — legacy privacy URL redirect to `/privacy`.
- `/docs` and `/docs/openapi.yaml` — API documentation.
- `/admin/...` — protected internal/operator APIs and any future same-host operator pages.
- `/woocommerce/webhooks/...` — WooCommerce webhook delivery endpoints.

## Safe cleanup

```bash
git status --short --branch
rm -f infra/env/delivery-api.env
rm -rf apps/delivery-api/dist apps/delivery-api/coverage apps/delivery-api/.vitest
```

Do not delete or reset `shopify-clever` or `clever-driver-app` from this repo's
workflow.
