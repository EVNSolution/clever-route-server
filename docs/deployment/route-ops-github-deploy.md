# Route Ops GitHub image publish and manual EC2 deploy

Phase 1 is intentionally **publish-only** from GitHub Actions because this repo is private under the EVNSolution Free org. Do not use GitHub Environments, environment secrets, required reviewers, or GitHub-native secret scanning as required controls for this phase.

## What GitHub Actions does

`.github/workflows/route-ops-publish.yml` runs only by `workflow_dispatch` on `main`. The operator must provide `deployed_base_ref`, the immutable git SHA/ref currently represented by production's `.deploy/current-image.env`; the deploy-scope guard compares `deployed_base_ref...HEAD` so unrelated Woo/Prisma/infra changes already on `main` cannot be silently included in a Route Ops image publish.

It:
- runs ignore hygiene, a pinned gitleaks full-history scan plus worktree scan, and Route Ops deploy-scope guard;
- builds the `route-ops-web-static` target from `apps/route-ops-web/Dockerfile` as a separately identifiable frontend static artifact;
- builds `runtime` and `migrate` targets from `apps/delivery-api/Dockerfile`;
- pushes immutable git SHA tags to GHCR;
- labels backend images with `org.opencontainers.image.revision`, `org.clever-route.prisma-schema-sha`, and `org.clever-route.image-role`;
- labels the frontend static image with `org.opencontainers.image.revision`, `org.clever-route.route-ops-web-static-sha`, and `org.clever-route.image-role=route-ops-web-static`;
- prints a redacted EC2 command block.

It does **not** SSH to production and does not receive production SSH/admin smoke secrets.

### First merge caveat

GitHub cannot dispatch `route-ops-publish.yml` until this workflow file exists on the repository default branch. The first PR must therefore be a clean CI/runbook/workflow bootstrap PR only: validate it with CI, `actionlint`, local Docker/compose checks, and secret hygiene, then merge it to `main` without running publish. After it is on `main`, run the manual publish workflow with `deployed_base_ref=<current production git SHA>`.

Do not test this by pushing the mixed Woo/Prisma/delivery-facts worktree: the deploy-scope guard is designed to fail that lane.

## One-time host bootstrap

Copy deploy metadata only; do not rsync app source:

```bash
rsync -azR --itemize-changes \
  infra/compose/docker-compose.prod.yml \
  scripts/deploy-route-ops-image.sh \
  scripts/rollback-route-ops-image.sh \
  scripts/smoke-route-ops-production.mjs \
  docs/deployment/route-ops-github-deploy.md \
  ubuntu@HOST:/srv/clever-route-server/

ssh ubuntu@HOST 'cd /srv/clever-route-server && mkdir -p .deploy
export ROUTE_OPS_COMPOSE_PROJECT_NAME=clever-route
PRISMA_SCHEMA_SHA=$(sha256sum apps/delivery-api/prisma/schema.prisma | awk "{print \$1}")
cat > .deploy/current-image.env <<EOF_IMAGE
IMAGE_TAG=bootstrap-local
DELIVERY_API_IMAGE=clever-route-server-delivery-api:local
DELIVERY_API_MIGRATE_IMAGE=clever-route-server-delivery-api-migrate:local
ROUTE_OPS_WEB_STATIC_IMAGE=clever-route-server-route-ops-web-static:local
ROUTE_OPS_WEB_STATIC_VOLUME=clever-route-route-ops-web-static-bootstrap-local
PRISMA_SCHEMA_SHA=${PRISMA_SCHEMA_SHA}
EOF_IMAGE
set -a; source .deploy/current-image.env; set +a
docker compose -p "$ROUTE_OPS_COMPOSE_PROJECT_NAME" --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml config --quiet'
```

If the host cannot compute the real schema fingerprint, stop and use the DB/infra lane.

## Manual deploy after publish

On the production host, with the GHCR read token already configured in Docker credential storage:

```bash
cd /srv/clever-route-server
export IMAGE_TAG=<immutable-git-sha-from-publish>
export PRISMA_SCHEMA_SHA=<schema-sha-from-publish>
export DELIVERY_API_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api:${IMAGE_TAG}
export DELIVERY_API_MIGRATE_IMAGE=ghcr.io/evnsolution/clever-route-server-delivery-api-migrate:${IMAGE_TAG}
export ROUTE_OPS_WEB_STATIC_IMAGE=ghcr.io/evnsolution/clever-route-server-route-ops-web-static:${IMAGE_TAG}
export ROUTE_OPS_WEB_STATIC_VOLUME=clever-route-route-ops-web-static-${IMAGE_TAG}
export ROUTE_ENGINE_IMAGE=ghcr.io/evnsolution/route-engine-worker:19baa45ee4fde9d2c21cfd3985c00d3bed07b8a4
export ROUTE_ENGINE_GRAPH_HOST_DIR=/srv/clever-route-server/data/route-engine/parquet
export ROUTE_OPS_COMPOSE_PROJECT_NAME=clever-route
export ROUTE_OPS_SMOKE_BASE_URL=https://clever-route.cleversystem.ai
export ROUTE_OPS_SMOKE_SHOP_DOMAIN=dev1.tomatonofood.com
export ROUTE_OPS_SMOKE_LOGIN_SECRET=<read locally from host secret manager, never commit>
scripts/deploy-route-ops-image.sh
```

The deploy script prepares `.deploy/candidate-image.env`, prunes stale Route Ops images before pull, pulls the frontend static, runtime, migrate, and pinned `route_engine` worker images, stages the frontend artifact into a SHA-scoped `ROUTE_OPS_WEB_STATIC_VOLUME`, verifies labels and schema SHA, verifies the host-mounted `route_engine` graph parquet manifest, runs the guarded Prisma `db push` entrypoint from the candidate migrate image, smokes `route_engine` from the `delivery-api` runtime network, recreates only `delivery-api` to switch to the candidate volume and internal `ROUTE_ENGINE_BASE_URL`, runs authenticated Route Ops smoke, and promotes metadata only after smoke succeeds. The guard recomputes `apps/delivery-api/prisma/schema.prisma`, requires it to match `PRISMA_SCHEMA_SHA`, and never opts into `--accept-data-loss`; missing or mismatched schema metadata stops before Prisma touches the database. The `route-engine-cache` Docker volume is mounted at `/cache/route_engine` so completed V8 cache builds survive service recreation. On failure before backend recreation, the running backend keeps its previous static volume and the pre-deploy `delivery-api.env` is restored.

## Smoke coverage

`scripts/smoke-route-ops-production.mjs` checks:
- `/healthz`;
- `/admin/ui/login` session creation without printing the secret or cookie;
- `/admin/ui/app` built shell;
- built vendor assets referenced by the shell;
- `/admin/ui/app/api/bootstrap` mapConfig and CSP;
- `/admin/ui/app/orders` shell;
- `/admin/ui/app/api/orders?status=unplanned`;
- `/admin/ui/app/vendor/maplibre-gl.css` and `/admin/ui/app/vendor/openfreemap-clever-lite.json`.

By default it fails if public OpenFreeMap hosts appear in CSP. Set `ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP=true` only when explicitly allowlisted.

The production deploy script also performs a non-customer `route_engine` smoke
before `delivery-api` activation: `/readyz`, authenticated `POST
/internal/warmup`, then `POST /v1/solve` against `http://route-engine:8080` from
a one-off `delivery-api` runtime container. The warmup call forces the road graph
V8 router cache to be built before the solve smoke, avoiding production deploys
that pass readiness but hang on the first cold solve. The smoke expects
`engine.name=route_engine`, `external_calls=false`, two smoke stops, and positive
distance/duration.

## Rollback

```bash
cd /srv/clever-route-server
export ROUTE_OPS_SMOKE_LOGIN_SECRET=<read locally, never commit>
scripts/rollback-route-ops-image.sh
```

Rollback uses `.deploy/previous-image.env`, verifies the schema fingerprint matches the current lane, stages the previous frontend static artifact into its own SHA-scoped volume, activates the previous image, runs the same smoke, and restores the pre-rollback current image if rollback smoke fails. During the first static-artifact cutover, legacy image metadata that lacks `ROUTE_OPS_WEB_STATIC_IMAGE` or `ROUTE_OPS_WEB_STATIC_VOLUME` is normalized from the immutable `IMAGE_TAG` before backend service mutation; if the tag is not a 40-hex git SHA, rollback fails closed before touching services.

## Secrets and billing constraints

- No production SSH key, admin smoke secret, cookie, or runtime `.env` is stored in GitHub.
- Use a host-local GHCR read token in Docker credential storage.
- `ROUTE_OPS_WEB_STATIC_IMAGE` and `ROUTE_OPS_WEB_STATIC_VOLUME` are deploy metadata, not runtime secrets; both must use the same immutable git SHA tag as the backend images.
- `ROUTE_ENGINE_IMAGE` is a separately published pinned optimizer worker image,
  not a secret. `ROUTE_ENGINE_GRAPH_HOST_DIR` must point to host-local Git LFS
  parquet artifacts; do not put those large artifacts in the
  clever-route-server image layer.
- Keep Actions manual, timeout-bounded, and artifact-light; redacted summaries only with one-day retention.
- If Actions quota is exhausted, use a local maintainer build/push or the existing emergency deploy path after separate approval.

## SSM deploy follow-up

The next approved deployment model is documented in `docs/deployment/route-ops-ssm-deploy.md`: GitHub Actions `workflow_dispatch` uses OIDC to assume an AWS deploy role, uploads a non-secret deploy-control bundle to the Route Ops S3 artifact prefix, invokes a custom constrained SSM document with only the S3 URI and SHA-256 digest, and runs the host-local deploy wrapper after host-side verification. First run `dry_run=true`; production execution with `dry_run=false` remains separately gated. Do not store production secrets in GitHub, S3 deploy-control artifacts, or SSM command parameters.

## Frontend static artifact boundary

Route Ops web is no longer primarily baked into the `delivery-api` runtime image. The frontend build is published as `ghcr.io/evnsolution/clever-route-server-route-ops-web-static:<git-sha>`. Compose runs the `route-ops-web-static` one-shot service to copy `/opt/route-ops-web/dist` and `/opt/route-ops-web/public` into the `route-ops-web-static` named volume. `delivery-api` mounts that volume read-only at `/app/external/route-ops-web` and serves the authenticated shell/assets from `ROUTE_OPS_WEB_DIST_PATH` and `ROUTE_OPS_WEB_PUBLIC_PATH`.

## Route Engine worker boundary

The Python optimizer worker remains a separate internal Compose service:

```text
route-engine:
  image: ${ROUTE_ENGINE_IMAGE}
  profile: route-engine
  expose: 8080
  graph mount: ${ROUTE_ENGINE_GRAPH_HOST_DIR}:/app/routing_engine/v7_out/parquet:ro
```

It has no public port. `delivery-api` talks to it by the internal Compose DNS
name `http://route-engine:8080` and a shared host-local
`ROUTE_ENGINE_INTERNAL_TOKEN`. The deploy script generates that token only if it
is missing and never prints it. The graph mount is mandatory for production:
deployment fails closed if the host parquet files are absent, still Git LFS
pointers, or do not match the `org.clever-route.graph-manifest-sha` label on the
pinned worker image.
