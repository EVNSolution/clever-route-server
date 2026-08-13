# Route Ops multi-coverage OSRM/VROOM routing

Purpose: extend Route Ops from the current Ontario-only engine to multiple internal routing coverages, starting with South Korea, while keeping browsers and mobile clients on the Clever API only.

## Current implemented contract

The delivery API now supports two configuration modes.

### Legacy single-coverage mode

```env
OSRM_BASE_URL=http://osrm-ontario:5000
VROOM_BASE_URL=http://vroom:3000
ROUTE_OPS_ROUTER_COVERAGE=ontario
```

This remains supported for rollback and existing Ontario deployments.

### Multi-coverage mode

```env
OSRM_ONTARIO_BASE_URL=http://osrm-ontario:5000
OSRM_KOREA_BASE_URL=http://osrm-korea:5000
OSRM_DEFAULT_COVERAGE=korea
OSRM_TIMEOUT_MS=10000

VROOM_ONTARIO_BASE_URL=http://vroom:3000
VROOM_KOREA_BASE_URL=http://vroom-korea:3000
VROOM_TIMEOUT_MS=180000
ROUTE_OPTIMIZATION_JOB_TIMEOUT_BUDGET_MS=180000
```

When any per-coverage URL is present, the API selects a coverage from route coordinates before calling OSRM/VROOM. Mixed routes, such as Seoul + Toronto in the same route plan, fail closed instead of silently sending points to the wrong engine.

Supported built-in coverages:

- `ontario`
- `korea`

## API-only boundary

Frontend and driver clients must never receive or call these internal URLs:

- `osrm-ontario:5000`
- `osrm-korea:5000`
- `vroom:3000`
- `vroom-korea:3000`

The delivery API accepts only these exact internal origins. Development may additionally use
`https://router.project-osrm.org`. Route engine configuration with another scheme, hostname,
port, credentials, path, query, or fragment is rejected before a request is made. OSRM and
VROOM HTTP clients also reject redirects so an approved origin cannot redirect the API to an
internal or metadata endpoint. Additions require a reviewed deployment-topology change; do not
replace this origin check with client-IP pinning or a private-address blacklist.

The bootstrap router state may expose coverage names only, for example:

```json
{
  "routerConfig": {
    "status": "configured",
    "provider": "osrm",
    "coverage": "korea",
    "coverages": ["ontario", "korea"]
  }
}
```

## Korea server rollout sequence

Do not run these steps unless production mutation has been explicitly approved.

### 1. Copy preprocessed Korea OSRM data

Target path:

```text
/srv/clever-route-server/data/osrm/korea
```

Required MLD artifacts include at least:

```text
south-korea-latest.osrm.fileIndex
south-korea-latest.osrm.cells
south-korea-latest.osrm.partition
south-korea-latest.osrm.mldgr
```

Local feasibility artifact source from the spike:

```text
/Users/jiin/.cache/clever-route/osrm-korea-feasibility-20260706T060400Z/data
```

### 2. Start Korea OSRM only

```bash
cd /srv/clever-route-server

docker compose -p clever-route \
  --env-file .deploy/current-image.env \
  -f infra/compose/docker-compose.prod.yml \
  --profile korea \
  up -d osrm-korea
```

Korea OSRM is internal to compose and, for host-only smoke, bound to loopback:

```text
127.0.0.1:5001 -> osrm-korea:5000
```

Smoke:

```bash
curl -fsS 'http://127.0.0.1:5001/route/v1/driving/126.9780,37.5665;127.0276,37.4979?overview=false&steps=false' \
  | python3 -c 'import json,sys; p=json.load(sys.stdin); assert p["code"]=="Ok", p; print(p["routes"][0]["distance"], p["routes"][0]["duration"])'
```

### 3. Start Korea VROOM

```bash
docker compose -p clever-route \
  --env-file .deploy/current-image.env \
  -f infra/compose/docker-compose.prod.yml \
  --profile korea \
  up -d vroom-korea
```

Smoke from the host through a one-off container on the compose network, or from inside `delivery-api` once env is staged. The expected VROOM endpoint is internal only:

```text
http://vroom-korea:3000/
```

Example payload:

```json
{
  "jobs": [
    { "id": 1, "location": [126.978, 37.5665] },
    { "id": 2, "location": [127.0276, 37.4979] }
  ],
  "vehicles": [
    { "id": 1, "profile": "car", "start": [126.9769, 37.5759] }
  ]
}
```

Expected result:

```text
code=0
routes length > 0
unassigned length = 0
```

### 4. Stage API env

Only after OSRM and VROOM Korea smoke pass, stage the multi-coverage env:

```env
OSRM_BASE_URL=http://osrm-ontario:5000
VROOM_BASE_URL=http://vroom:3000
ROUTE_OPS_ROUTER_COVERAGE=ontario

OSRM_ONTARIO_BASE_URL=http://osrm-ontario:5000
OSRM_KOREA_BASE_URL=http://osrm-korea:5000
OSRM_DEFAULT_COVERAGE=korea

VROOM_ONTARIO_BASE_URL=http://vroom:3000
VROOM_KOREA_BASE_URL=http://vroom-korea:3000
```

Keep the legacy Ontario keys during the first rollout. They are harmless fallback context and make rollback simpler.

### 5. Deploy/restart delivery-api

Use the reviewed simple SSM deploy path or a host-only app restart approved for the incident/change window. Do not expose OSRM or VROOM through Caddy or security groups.

### 6. Verify no URL leak

Check admin bootstrap contains coverage names but no internal URLs:

```bash
curl -fsS https://clever-route-api.cleversystem.ai/healthz
# then authenticated admin bootstrap smoke through the existing production smoke tooling
```

No response body should contain:

- `osrm-korea`
- `osrm-ontario`
- `vroom-korea`
- `:5000`
- `:3000`
- `OSRM_KOREA_BASE_URL`
- `VROOM_KOREA_BASE_URL`

## Capacity note

Preprocessed Korea runtime was measured locally at about 1.3 GiB for `osrm-routed` after smoke and about 115 MiB for VROOM. The current production host is `t3a.medium` with 4 GiB RAM and already runs Ontario OSRM + VROOM + API + DB + Caddy + Shopify app containers.

Recommendation:

- Korea MVP / low traffic: acceptable on the current host after smoke.
- Stable multi-country production: move to at least 8 GiB RAM or split OSRM/VROOM to a routing host.

## Rollback

For env rollback, remove or blank the per-coverage keys and restart `delivery-api`:

```env
OSRM_ONTARIO_BASE_URL=
OSRM_KOREA_BASE_URL=
OSRM_DEFAULT_COVERAGE=
VROOM_ONTARIO_BASE_URL=
VROOM_KOREA_BASE_URL=
```

Legacy Ontario mode remains:

```env
OSRM_BASE_URL=http://osrm-ontario:5000
VROOM_BASE_URL=http://vroom:3000
ROUTE_OPS_ROUTER_COVERAGE=ontario
```

Then stop Korea-only services if no longer needed:

```bash
docker compose -p clever-route -f infra/compose/docker-compose.prod.yml stop vroom-korea osrm-korea
```
