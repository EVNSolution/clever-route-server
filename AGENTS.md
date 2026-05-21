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
