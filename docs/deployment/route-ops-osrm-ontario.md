# Route Ops OSRM Ontario runbook

Purpose: enable road-following route geometry for Route Ops without changing stop order optimization. OSRM Route service is used only to draw geometry for the sequence CLEVER already has.

## Safety boundaries

- Existing EC2 only, Ontario extract only.
- OSRM is internal-only: compose binds port 5000 to host loopback only
  (`127.0.0.1:5000`); do not expose it through Caddy or security groups.
- Do not set `OSRM_BASE_URL` for `delivery-api` until OSRM smoke passes.
- Rollback is env-only: unset `OSRM_BASE_URL`, restart `delivery-api`, and Route Ops falls back to sequence preview.

## Prepare data on EC2

From `/srv/clever-route-server`:

```sh
bash scripts/prepare-osrm-ontario.sh
```

The script:

1. checks disk and Linux memory+swap before download/preprocessing;
2. downloads Geofabrik Ontario `ontario-latest.osm.pbf` if missing;
3. runs `osrm-extract`, `osrm-partition`, and `osrm-customize` with `ghcr.io/project-osrm/osrm-backend`.

Override knobs if needed:

```sh
OSRM_MIN_FREE_MB=30000 \
OSRM_MIN_MEMORY_MB=4096 \
OSRM_DATA_DIR=/srv/clever-route-server/data/osrm/ontario \
OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend:latest \
bash scripts/prepare-osrm-ontario.sh
```

## Start and smoke OSRM

```sh
DELIVERY_API_IMAGE="$CURRENT_DELIVERY_API_IMAGE" \
DELIVERY_API_MIGRATE_IMAGE="$CURRENT_DELIVERY_API_MIGRATE_IMAGE" \
docker compose -f infra/compose/docker-compose.prod.yml --profile osrm up -d osrm-ontario

OSRM_BASE_URL=http://127.0.0.1:5000 bash scripts/smoke-osrm-ontario.sh
```

If running smoke from a container in the compose network, use:

```sh
OSRM_BASE_URL=http://osrm-ontario:5000 bash scripts/smoke-osrm-ontario.sh
```

## Activate delivery-api

Edit the host env file only after the OSRM smoke succeeds:

```sh
OSRM_BASE_URL=http://osrm-ontario:5000
OSRM_TIMEOUT_MS=10000
ROUTE_OPS_ROUTER_COVERAGE=ontario
```

Then restart only the app:

```sh
DELIVERY_API_IMAGE="$CURRENT_DELIVERY_API_IMAGE" \
DELIVERY_API_MIGRATE_IMAGE="$CURRENT_DELIVERY_API_MIGRATE_IMAGE" \
docker compose -f infra/compose/docker-compose.prod.yml --profile osrm up -d delivery-api
```

Smoke:

- `/healthz` returns 200;
- `/admin/ui/app/api/bootstrap` has `routerConfig.status=configured`, `provider=osrm`, `coverage=ontario`;
- an Ontario route detail has non-null `routeGeometry`;
- Routes page label shows `Road geometry`, not only sequence preview.

## Rollback

```sh
# remove/blank OSRM_BASE_URL in infra/env/delivery-api.env
DELIVERY_API_IMAGE="$CURRENT_DELIVERY_API_IMAGE" \
DELIVERY_API_MIGRATE_IMAGE="$CURRENT_DELIVERY_API_MIGRATE_IMAGE" \
docker compose -f infra/compose/docker-compose.prod.yml up -d delivery-api
docker compose -f infra/compose/docker-compose.prod.yml --profile osrm stop osrm-ontario
```

Expected rollback behavior:

- bootstrap returns `routerConfig.status=not_configured`;
- route UI falls back to `Sequence preview — router not configured`;
- health remains 200.

## Known limits

- Ontario coverage only. Out-of-province stops may fall back.
- This does not optimize order/stop sequence and must not use OSRM Trip/Table.
