# Route Ops VROOM runbook

Purpose: replace the custom `route_engine` optimization lane with a standard
self-hosted VROOM service while keeping OSRM as the internal road-network
routing/matrix provider.

## Safety boundaries

- VROOM is internal-only. Do not expose it through Caddy, public DNS, or security
  groups.
- OSRM remains the routing provider. VROOM is the VRP solver.
- Normal server deploys must not require VROOM unless `VROOM_BASE_URL` is set.
- Do not remove the legacy `route_engine` fallback until VROOM has passed local
  PoC, deploy smoke, and an approved production cutover.
- Do not run GitHub Actions or mutate production unless explicitly requested.

## Selected runtime contract

Initial target image:

```text
ghcr.io/vroom-project/vroom-docker:v1.15.0
ghcr.io/vroom-project/vroom-docker@sha256:247d5683d6745c755d718a156d16b16aac80baccc276a003a68b986c13883b08
```

Runtime shape:

- HTTP service: `vroom-express@0.12.0`
- Container port: `3000/tcp`
- Solve endpoint: `POST /`
- Health endpoint: `GET /health` returns HTTP 200 with an empty body
- VROOM CLI units: seconds for timings, meters for distances
- VROOM coordinate order: `[lon, lat]`
- VROOM can use OSRM as routing backend or accept request-supplied matrices

Important image behavior:

- The image entrypoint copies `/conf/config.yml` into
  `/vroom-express/config.yml` when a host config is mounted.
- The image's default config sets OSRM hosts to `0.0.0.0`; production must mount
  an explicit config that points the `car` profile at `osrm-ontario:5000`.
- `VROOM_LOG` is interpreted as a log directory by `vroom-express`; do not set it
  to `/conf/access.log`.

## Proposed production service contract

Target compose topology:

```text
delivery-api -> vroom:3000 -> osrm-ontario:5000
```

Recommended env names for `delivery-api`:

```sh
# Blank keeps VROOM disabled.
VROOM_BASE_URL=
VROOM_TIMEOUT_MS=180000
```

The production config is committed at `infra/vroom/config.yml` and mounted read-only at `/conf/config.yml`. It points the `car` profile to `osrm-ontario:5000`.

The compose `vroom` service uses `expose: ["3000"]` only. Do not add a Caddy route
or host port. Deploy/rollback scripts start VROOM only when `VROOM_BASE_URL` is
set and require OSRM to be configured first.

## Production cutover runbook

Use this only after a reviewed release has passed local verification. Do not run
GitHub Actions or mutate production from this runbook unless the operator has
explicitly approved that step.

### 1. Preflight

On the production host, capture the current optimizer env before changing it:

```bash
cd /srv/clever-route-server
ts="$(date -u +%Y%m%dT%H%M%SZ)"
cp infra/env/delivery-api.env ".deploy/delivery-api.env.before-vroom-${ts}"
grep -E '^(VROOM_BASE_URL|VROOM_TIMEOUT_MS|ROUTE_ENGINE_BASE_URL|ROUTE_ENGINE_TIMEOUT_MS|ROUTE_OPTIMIZATION_JOB_TIMEOUT_BUDGET_MS|OSRM_BASE_URL|OSRM_TIMEOUT_MS)=' infra/env/delivery-api.env || true
```

Required preflight state:

- `VROOM_BASE_URL` and `ROUTE_ENGINE_BASE_URL` must not both be set.
- VROOM requires `OSRM_BASE_URL=http://osrm-ontario:5000`.
- If `ROUTE_ENGINE_BASE_URL` is still set, stop and decide whether this is a
  deliberate legacy rollback lane. The VROOM cutover must clear it.
- `docker compose -p clever-route --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml --profile osrm --profile vroom config --quiet`
  must pass before deploy.
- Production VROOM must remain internal-only: no Caddy route, no host port, no
  security-group/public DNS exposure.

### 2. Enable VROOM host env

Update only these optimizer keys in `infra/env/delivery-api.env`:

```env
VROOM_BASE_URL=http://vroom:3000
VROOM_TIMEOUT_MS=180000
ROUTE_OPTIMIZATION_JOB_TIMEOUT_BUDGET_MS=180000
ROUTE_ENGINE_BASE_URL=
OSRM_BASE_URL=http://osrm-ontario:5000
OSRM_TIMEOUT_MS=10000
```

Keep `ROUTE_ENGINE_IMAGE` out of the normal deploy environment. It is required
only if the host env deliberately re-enables `ROUTE_ENGINE_BASE_URL`.

### 3. Deploy with the simple SSM lane

Run the current reviewed deploy path:

```bash
scripts/ssm-simple-route-ops-deploy.sh --publish
```

When `--publish` is used as a manual fallback, it builds/pushes the channel images,
then the SSM phase pulls them on the EC2 host, runs the Prisma guard, stages static
assets conservatively for mutable tag refs, recreates `delivery-api` only, reloads Caddy
in place, and keeps legacy route_engine stopped. The normal GitHub Actions lane passes
digest-addressable refs; only equal digest refs are eligible for static staging skip.

### 4. Post-cutover verification

After deploy:

```bash
AWS_REGION=ap-northeast-2 scripts/monitor-route-ops-production.sh
```

Then verify one real Route Ops optimization from the admin UI:

- route optimization reaches `Completed`, not timeout or `HTTP 422`;
- the route receives ordered stops;
- deploy trace contains VROOM smoke success and no route_engine smoke unless
  `ROUTE_ENGINE_BASE_URL` was intentionally set.

### 5. Rollback

Current rollback is file/digest based. Restore or point compose at the previous
`.deploy/current-image.env` / `.deploy/simple-rollback-image.env`, stage the previous
static image, and recreate `delivery-api` with `--no-deps` as described in
`docs/deployment/route-ops-simple-ssm-deploy.md`. Do not retag `:prod` as rollback state.

Legacy route_engine rollback is compatibility-only:

```env
VROOM_BASE_URL=
ROUTE_ENGINE_BASE_URL=http://route-engine:8080
```

and requires an explicit reviewed
`ROUTE_ENGINE_IMAGE=ghcr.io/evnsolution/route-engine-worker:<40-hex-sha>` export.
The deploy path no longer supplies a default route_engine image or auto-enables
route_engine.

## Local PoC evidence

Date: 2026-06-17
Host: local Docker only, no production mutation, no GitHub Actions.

Commands used:

```sh
docker pull ghcr.io/vroom-project/vroom-docker:v1.15.0
docker image inspect ghcr.io/vroom-project/vroom-docker:v1.15.0 \
  --format 'Id={{.Id}} RepoDigests={{json .RepoDigests}} Entrypoint={{json .Config.Entrypoint}} Cmd={{json .Config.Cmd}} Exposed={{json .Config.ExposedPorts}}'

docker run -d --name clever-vroom-poc \
  -p 127.0.0.1:13000:3000 \
  -e VROOM_ROUTER=osrm \
  ghcr.io/vroom-project/vroom-docker:v1.15.0

curl -fsS http://127.0.0.1:13000/health
curl -fsS -H 'Content-Type: application/json' \
  --data @/tmp/vroom-matrix-request.json \
  http://127.0.0.1:13000/

docker rm -f clever-vroom-poc
```

Result:

```json
{
  "code": 0,
  "summary": {
    "routes": 1,
    "unassigned": 0,
    "service": 120,
    "duration": 5461,
    "distance": 5461
  },
  "jobs": [101, 102]
}
```

The local solve used request-supplied matrices, not a live OSRM call. This proves
VROOM HTTP process, request/response shape, `start_index`/`end_index`, job step
parsing, and unassigned handling. A later deploy-phase smoke must prove the
VROOM-to-OSRM network path with `osrm-ontario:5000` before enabling
`VROOM_BASE_URL` in `delivery-api`.

## Implementation notes for the next story

- Implement a minimal `VroomRouteOptimizationClient` behind the existing
  `RouteOptimizationService` boundary.
- Convert internal coordinates to VROOM `[lng, lat]` arrays; never `[lat, lng]`.
- For return-to-store, set the vehicle `end` to the depot; otherwise omit or set
  the intended non-return end according to the route plan option.
- Treat `unassigned.length > 0` as an explicit optimization failure unless a
  future product decision allows partial optimization.
- Before deploy work, update job-runner/UI notice code so `source: 'vroom'` is
  accepted as an external optimizer success.
