# AGENTS.md — clever-route-server

## Repository role

`EVNSolution/clever-route-server` is the main CLEVER route/delivery server repository.
It is the future WordPress/WooCommerce-facing server home and must not become a
Shopify embedded app repository.

Current imported server code lives under `apps/delivery-api`. Some identifiers and
legacy modules still say Shopify because this repo was bootstrapped from
`EVNSolution/shopify-clever/apps/delivery-api`; keep those compatibility seams
additive until the WordPress/Woo tenant/order migration is proven.

## Hard constraints

- Do not modify AWS, EC2, EIP, Route53, Caddy production hosts, or DNS records
  unless the user explicitly asks for that operation in the current turn.
- Do not commit secrets, `.env`, `infra/env/*.env`, DB dumps, proof media, or
  private evidence.
- Keep production deploys manual and evidence-backed; do not introduce an
  automatic production deploy workflow without an approved change-control issue.
- Do not remove legacy Shopify-compatible fields/routes until rollback and
  driver-app compatibility have been verified.
- Work on branches and PRs; do not push directly to `main` for implementation
  work.

## Expected verification

For server changes, run the smallest fresh verification that proves the claim:

```bash
npm --prefix apps/delivery-api run prisma:generate
npm --prefix apps/delivery-api run lint
npm --prefix apps/delivery-api run typecheck
npm --prefix apps/delivery-api run test
npm --prefix apps/delivery-api run build
```

For runtime config changes, also run:

```bash
cp infra/env/delivery-api.env.example infra/env/delivery-api.env
docker compose -f infra/compose/docker-compose.prod.yml config --quiet
rm -f infra/env/delivery-api.env
```

Report any command that could not run and why.
## Deployable boundaries

`clever-route-server` stays a monorepo, but its deployables must remain distinct:

- `apps/delivery-api` owns backend API/server behavior, authenticated `/admin/ui/app/*` shell/session checks, Prisma, and server-side integration contracts.
- `apps/route-ops-web` owns the Route Ops React/Vite SPA, frontend tests, styles, MapLibre/PMTiles assets, and the static web artifact.
- The production backend runtime image must not absorb `route-ops-web` as a baked frontend payload by default. Route Ops web is shipped as a separately identifiable static artifact/image and supplied to `delivery-api` read-only at runtime.
- `apps/wordpress-connector-plugin` is setup/status/sync/launch glue only; do not turn it into a second admin app.
- `worktrees/` is a local Git branch checkout area, not product architecture.
- The relocated Shopify repo lives at `../05_CLEVER_Shopify/shopify-clever` as reference/backup only. Do not treat it as an active Route Ops implementation target unless the user explicitly scopes reference lookup.
