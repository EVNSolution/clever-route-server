# Deployable boundaries

CLEVER Route keeps one source repo but separates deployable identity.

## Deployables

| Deployable | Source | Artifact identity | Responsibility |
| --- | --- | --- | --- |
| Backend runtime | `apps/delivery-api` | `ghcr.io/evnsolution/clever-route-server-delivery-api:<git-sha>` | API, admin/session shell, static asset proxy from mounted web artifact |
| DB migration runner | `apps/delivery-api` | same `ghcr.io/evnsolution/clever-route-server-delivery-api:<digest>` as runtime | Compose service overriding command to run the Prisma schema SHA guard |
| Route Ops web static | `apps/route-ops-web` | `ghcr.io/evnsolution/clever-route-server-route-ops-web-static:<git-sha>` | Built SPA `dist/`, Vite manifest, assets, and `public/vendor` files |

## First-pass serving contract

`delivery-api` remains the authenticated shell owner for `/admin/ui/app/*`. The frontend SPA files are supplied separately and mounted read-only into the backend container:

```text
route-ops-web-static image -> channel-scoped ROUTE_OPS_WEB_STATIC_VOLUME -> /app/external/route-ops-web:ro in delivery-api
```

Production `delivery-api` images default to:

```text
ROUTE_OPS_WEB_DIST_PATH=/app/external/route-ops-web/dist
ROUTE_OPS_WEB_PUBLIC_PATH=/app/external/route-ops-web/public
```

The backend uses these paths only to read the externally supplied Vite manifest, hashed assets, and vendor map files. It must not bake `apps/route-ops-web/dist` into its runtime image as the production payload. Deploy and rollback stage candidate frontend assets into a channel-scoped Docker volume first, then recreate `delivery-api` to switch mounts. The promoted `.deploy/current-image.env` records digest-addressable runtime and static image refs; rollback restores the previous env file and recreates only `delivery-api`.

## Same-origin route ownership

Caddy continues to proxy the public host to `delivery-api` in this first pass. Route ordering remains simple:

1. `/admin/ui/app/api/*` -> backend API/session checks.
2. `/admin/ui/app/*` shell -> backend session + `shopDomain` gate.
3. `/admin/ui/app/assets/*` and `/admin/ui/app/vendor/*` -> backend static handlers reading the mounted web artifact.

If a later lane serves assets directly from Caddy or another static service, API and shell auth gates must remain backend-owned or be replaced by equivalent tested gates.

## Local fallback

For local development and tests, `delivery-api` may fall back to checked-out `apps/route-ops-web/dist` and `apps/route-ops-web/public` if explicit env vars and external artifact paths are absent. That fallback is compatibility-only and not the production deployable model.

## Rejected states

- Backend runtime image copies `apps/route-ops-web/dist` as its production payload.
- Publish evidence lists backend images but not the frontend static artifact identity.
- Static shell bypasses `delivery-api` auth/session and `shopDomain` checks.
- Shopify reference code is treated as active Route Ops source.
