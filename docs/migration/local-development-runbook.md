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

## Safe cleanup

```bash
git status --short --branch
rm -f infra/env/delivery-api.env
rm -rf apps/delivery-api/dist apps/delivery-api/coverage apps/delivery-api/.vitest
```

Do not delete or reset `shopify-clever` or `clever-driver-app` from this repo's
workflow.
