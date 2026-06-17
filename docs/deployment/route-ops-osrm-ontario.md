# Route Ops OSRM Ontario runbook

Purpose: enable road-following route geometry for Route Ops without changing stop order optimization. OSRM Route service is used only to draw geometry for the sequence CLEVER already has.

## Safety boundaries

- Existing EC2 only, Ontario extract only.
- OSRM is internal-only: compose binds port 5000 to host loopback only
  (`127.0.0.1:5000`); do not expose it through Caddy or security groups.
- Do not set `OSRM_BASE_URL` for `delivery-api` until OSRM smoke passes.
- `infra/env/delivery-api.env` is the authoritative runtime source for OSRM enablement; deploy history records `osrmEnabled` at promotion/rollback time for auditability.
- When `OSRM_BASE_URL` is configured, the reviewed image deploy and rollback scripts must start `osrm-ontario` through the `clever-route` compose project and smoke it before `delivery-api` restarts. Do not leave OSRM as a manually attached sidecar/container.
- Rollback is env-only for disabling road geometry: unset `OSRM_BASE_URL`, restart `delivery-api`, and Route Ops removes road geometry instead of drawing fake straight lines. When disabled, deploy/rollback automatically stops `osrm-ontario` after the app restarts with the disabled env.
- Run preflight before any storage expansion or data preparation. This server may
  already contain OSRM data/service from the previous Shopify/delivery-api lane;
  expand EBS only when preflight proves the prepared Ontario data is absent or
  incomplete and the current filesystem is below the prepare threshold.

## Preflight existing OSRM state

From `/srv/clever-route-server`, run the read-only preflight first:

```sh
OSRM_MIN_FREE_MB=30000 \
OSRM_MIN_MEMORY_MB=4096 \
bash scripts/osrm-ontario.sh preflight
```

Preflight checks, without printing env values:

1. existing Ontario OSRM MLD data files under `data/osrm/ontario`
   (`.fileIndex`, `.cells`, `.partition`, `.mldgr`);
2. whether `OSRM_BASE_URL`, `OSRM_TIMEOUT_MS`, and
   `ROUTE_OPS_ROUTER_COVERAGE` are present in the host env file;
3. Docker containers/images whose names include OSRM;
4. compose service wiring still binds only to `127.0.0.1:5000`;
5. disk and memory+swap thresholds for a safe prepare run.

If preflight reports `Prepared data decision: likely_complete_for_mld`, start
and smoke OSRM before preparing again. If it reports missing/incomplete data and
`Storage decision: expansion_required_before_prepare`, expand/attach EBS first
and mount it at the OSRM data path before running `prepare`.

When the root filesystem is too small but an existing data EBS volume is
available, prefer mounting a dedicated directory from that EBS volume at
`/srv/clever-route-server/data/osrm` instead of storing OSRM artifacts on root.
If `Memory decision: below_prepare_threshold`, add temporary or persistent
swap on the data EBS volume before running `prepare`; OSRM extraction is memory
intensive even though the runtime service is internal-only.

## Prepare data on EC2

From `/srv/clever-route-server`:

```sh
bash scripts/osrm-ontario.sh prepare
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
bash scripts/osrm-ontario.sh prepare
```


## Validate helper without side effects

For CI or local command-shape validation, use dry-run mode. It does not create directories, download the PBF, run Docker, or call a live OSRM service:

```sh
OSRM_DRY_RUN=1 bash scripts/osrm-ontario.sh preflight
OSRM_DRY_RUN=1 bash scripts/osrm-ontario.sh prepare
OSRM_DRY_RUN=1 bash scripts/osrm-ontario.sh smoke
bash scripts/osrm-ontario.sh --help
```

## Start and smoke OSRM

The simple SSM deploy lane keeps `osrm-ontario` live through the compose `osrm` profile. If `OSRM_BASE_URL` is blank, the API can run without OSRM, but production route optimization currently expects OSRM behind VROOM.

Manual start is for preflight/diagnostics only, not the steady-state deployment model:

```sh
export ROUTE_OPS_COMPOSE_PROJECT_NAME=clever-route
DELIVERY_API_IMAGE="$CURRENT_DELIVERY_API_IMAGE" \
docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" -f infra/compose/docker-compose.prod.yml --profile osrm up -d osrm-ontario

OSRM_BASE_URL=http://127.0.0.1:5000 bash scripts/osrm-ontario.sh smoke
```

The smoke helper validates the OSRM JSON response with `node` when available
and falls back to `python3` on production hosts where only Python is installed.

If running smoke from a container in the compose network, use:

```sh
OSRM_BASE_URL=http://osrm-ontario:5000 bash scripts/osrm-ontario.sh smoke
```

## Activate delivery-api

Edit the host env file only after the OSRM smoke succeeds:

```sh
OSRM_BASE_URL=http://osrm-ontario:5000
OSRM_TIMEOUT_MS=10000
ROUTE_OPS_ROUTER_COVERAGE=ontario
```

Then run the normal reviewed image deploy/rollback path. It will keep OSRM in the same `clever-route` compose project. For emergency host-only activation, restart only the app after manually starting/smoking OSRM:

```sh
export ROUTE_OPS_COMPOSE_PROJECT_NAME=clever-route
DELIVERY_API_IMAGE="$CURRENT_DELIVERY_API_IMAGE" \
docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" -f infra/compose/docker-compose.prod.yml --profile osrm up -d delivery-api
```

Smoke:

- `/healthz` returns 200;
- `/admin/ui/app/api/bootstrap` has `routerConfig.status=configured`, `provider=osrm`, `coverage=ontario`;
- an Ontario route detail has non-null `routeGeometry`;
- Routes page label shows `Road geometry`.

## Rollback

```sh
# remove/blank OSRM_BASE_URL in infra/env/delivery-api.env
export ROUTE_OPS_COMPOSE_PROJECT_NAME=clever-route
DELIVERY_API_IMAGE="$CURRENT_DELIVERY_API_IMAGE" \
docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" -f infra/compose/docker-compose.prod.yml up -d delivery-api
docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" -f infra/compose/docker-compose.prod.yml --profile osrm stop osrm-ontario
```

The reviewed deploy/rollback scripts perform the app restart and OSRM stop automatically when `OSRM_BASE_URL` is blank. The manual commands above are emergency host-only equivalents.

Expected rollback behavior:

- bootstrap returns `routerConfig.status=not_configured`;
- route UI falls back to `Router not configured` / `Road geometry unavailable` with marker-only coordinates, not a fake route line;
- health remains 200.

## Known limits

- Ontario coverage only. Out-of-province stops may fall back.
- This does not optimize order/stop sequence and must not use OSRM Trip/Table.
