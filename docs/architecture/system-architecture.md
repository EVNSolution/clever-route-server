# CLEVER Route system architecture

`EVNSolution/clever-route-server` is the active CLEVER Route monorepo. It is not a Shopify embedded-app repo and it is not being split into multiple GitHub repos by default. The first-pass architecture is **monorepo source with separated deployables**.

```text
04_CLEVER_Route/
  clever-route-server/                 active Route Ops monorepo
    apps/delivery-api/                 backend API/server, auth shell, Prisma
    apps/route-ops-web/                frontend Route Ops SPA static artifact
    apps/wordpress-connector-plugin/   Woo/WordPress setup, sync, launch glue
    infra/                             Caddy, compose, env examples, deploy controls
    docs/                              architecture, migration, deployment runbooks
  clever-driver-app/                   sibling mobile driver app repo
  worktrees/                           local Git branch workspaces only

05_CLEVER_Shopify/
  shopify-clever/                      relocated Shopify reference/backup repo
```

## Backend: `apps/delivery-api`

Role: Route server API, admin/session gateway, WordPress/WooCommerce integration backend, driver/mobile API, Prisma data access, route/geocoding/OSRM coordination, and authenticated `/admin/ui/app/*` shell owner.

Technology rationale:
- **Node 22** keeps the runtime aligned with current LTS server JavaScript and GitHub Actions images.
- **Fastify** provides explicit route ownership, low overhead, and testable request injection for admin/API/session gates.
- **Prisma** gives typed PostgreSQL access while preserving migration/schema auditability.
- **PostgreSQL** is the durable source for shops, canonical orders, route plans, drivers, auth state, and operational settings.

Compatibility note: some modules still use Shopify names because the backend was bootstrapped from the Shopify codebase. Treat those as additive compatibility seams until Woo and driver-app compatibility have fresh evidence.

## Frontend: `apps/route-ops-web`

Role: Route Ops operator SPA for Orders, Routes, Drivers, and Settings. It owns UI state, React components, frontend tests, styles, MapLibre rendering, and static map/vendor assets.

Technology rationale:
- **React + TypeScript** keeps UI state and DTO usage explicit.
- **Vite** provides a small build surface and manifest-driven static assets.
- **MapLibre** is the browser map renderer used for OpenFreeMap/PMTiles style assets.
- **PMTiles/OpenFreeMap static vendor files** keep the no-paid-key-first map lane viable while allowing stricter provider allowlisting.

## WordPress connector: `apps/wordpress-connector-plugin`

Role: WordPress/WooCommerce setup, status, sync trigger, webhook delivery, and admin launch only. It should not become a duplicate Route Ops admin UI. Store operations continue in `/admin/ui/app/*` after the backend creates/validates a launch session.

## Infrastructure: `infra/`

Role: local/production compose, Caddy, environment examples, and manual deployment controls. Production deploys are manual/evidence-backed unless a separate change-control plan approves more automation.

## Worktrees

`worktrees/` is only a local Git checkout area for branch work. It is not a product component, deployable, or architectural boundary.

## Shopify reference repo

The Shopify app/source baseline is preserved outside the active Route workspace at:

```text
../05_CLEVER_Shopify/shopify-clever
```

Use it as reference/backup when explicitly useful. Do not modify it as part of Route Ops implementation unless the user explicitly scopes that repo.

## First-pass non-goals

- No GitHub repo split by default.
- No Shopify source deletion or remote change.
- No production AWS, DNS, or deploy action from architecture cleanup alone.
- No DB/API/WordPress plugin/driver app contract change.
- No unauthenticated static shell that bypasses `delivery-api` session and `shopDomain` gates.
