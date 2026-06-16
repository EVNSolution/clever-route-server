# Route Ops GitHub release prepare/promote

The Route Ops deployment lane is `.github/workflows/route-ops-release.yml`: a single manual prepare/promote workflow that builds the Route Ops images, performs the no-mutation SSM dry validation, emits an immutable release manifest, and later promotes only that verified manifest. The retired split publish/deploy workflows were removed after the consolidated lane completed a successful production run.

This repo is private under the EVNSolution Free org. Do not use GitHub Environments, environment secrets, required reviewers, or GitHub-native secret scanning as required controls for this phase.

## Primary release workflow

`route-ops-release.yml` runs only by `workflow_dispatch` on `main` and has two explicit modes:

- `mode=prepare` runs actor allowlist, ignore hygiene, pinned gitleaks scans, Route Ops deploy-scope guard, image build/push, deploy-control bundle creation, S3 upload, and `dryRun=true` SSM validation. It emits a `route-ops-release-manifest` artifact with the exact git SHA, image coordinates, publish evidence URL, route_engine evidence URL plus image revision label and immutable image digest, dry-run bundle URI, and `manifestSha256`. The manifest records only whether the driver APK URL handoff is present; it must not expose the raw URL.
- `mode=promote` accepts only `release_run_id` and `release_manifest_sha256`, downloads the prepare artifact, validates the digest/provenance, checks out the exact manifest commit, regenerates the deploy-control bundle with `dryRun=false`, and runs the same constrained SSM deploy path. Promotion must not rebuild images or accept mutable image coordinates.

Job permissions stay separated: image publishing jobs may use `packages: write`; SSM jobs may use `id-token: write`; no job should need both. The workflow also preserves the Route Ops safety gates in CI and `scripts/validate-route-ops-release.mjs`.

### Primary operator flow

Prepare first; this is the required no-mutation validation after changing the deploy lane:

```bash
gh workflow run route-ops-release.yml \
  --ref main \
  -f mode=prepare \
  -f deployed_base_ref=<current-production-git-sha> \
  -f route_engine_image=ghcr.io/evnsolution/route-engine-worker:<published-route-engine-sha> \
  -f route_engine_image_digest=ghcr.io/evnsolution/route-engine-worker@sha256:<published-route-engine-digest> \
  -f route_engine_publish_evidence_url=https://github.com/EVNSolution/route_engine/actions/runs/<route-engine-publish-run-id>
```

For consolidated release prepare/promote, the runner must be able to pull the private `route_engine` GHCR package before SSM dry-run and before production promote. Configure repository secret `ROUTE_ENGINE_GHCR_READ_TOKEN` with `read:packages` scope and repository variable `ROUTE_ENGINE_GHCR_READ_USERNAME` with the token owner. If absent, the workflow falls back to `GITHUB_TOKEN`, which only works when package permissions allow this repository to read the image.


After the prepare run succeeds, inspect the redacted summary and the `route-ops-release-manifest` artifact. Promote only the same digest:

```bash
gh workflow run route-ops-release.yml \
  --ref main \
  -f mode=promote \
  -f release_run_id=<successful-prepare-run-id> \
  -f release_manifest_sha256=<manifest-sha256-from-prepare>
```

If prepare or promote fails, use the run summary, the manifest, and host-local trace artifacts before retrying. Manifest artifacts are retained for 14 days; if that window expires, rerun `mode=prepare` and promote the new manifest digest.

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

## Emergency host deploy

On the production host, with the GHCR read token already configured in Docker credential storage:

```bash
cd /srv/clever-route-server
export IMAGE_TAG=<immutable-git-sha-from-reviewed-release>
export PRISMA_SCHEMA_SHA=<schema-sha-from-reviewed-release>
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

By default the standalone smoke script fails if public OpenFreeMap hosts appear in CSP. Production monitoring wraps it with the currently approved settings: `ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP=true`, `ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOSTS=tiles.openfreemap.org`, and `ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED=true`.

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
  not a secret. `ROUTE_ENGINE_GRAPH_HOST_DIR` must point to host-local parquet
  artifacts provisioned from the private S3 graph artifact pointer; do not put
  those large artifacts in the clever-route-server image layer.
- Keep Actions manual, timeout-bounded, and artifact-light. The consolidated release manifest and prepare/promote summaries are retained for 14 days so promote can verify the reviewed manifest digest, then operators must rerun prepare after expiry.
- If Actions quota is exhausted, use a local maintainer build/push or the existing emergency deploy path after separate approval. For the verified no-Actions/no-GHCR-write tar fallback, follow `docs/deployment/route-ops-manual-tar-deploy.md`.

## SSM deploy follow-up

The current primary deployment model is documented in `docs/deployment/route-ops-ssm-deploy.md` and implemented by `route-ops-release.yml`: GitHub Actions `workflow_dispatch` uses OIDC to assume an AWS deploy role, uploads a non-secret deploy-control bundle to the Route Ops S3 artifact prefix, invokes a custom constrained SSM document with the S3 URI, SHA-256 digest, and masked driver APK URL handoff, and runs the host-local deploy wrapper after host-side verification. First run the release workflow in `mode=prepare`, which keeps SSM in `dryRun=true`; production execution happens only through `mode=promote` after the release manifest digest is reviewed. Do not store production secrets in S3 deploy-control artifacts; the only GitHub/SSM command-parameter secret exception is the masked `DRIVER_APP_DOWNLOAD_URL` handoff.

## Production monitoring

Use the read-only monitor wrapper after promote or when checking production health:

```bash
AWS_REGION=ap-northeast-2 scripts/monitor-route-ops-production.sh
```

The wrapper resolves the single SSM-managed production node by `SSM_ROUTE_OPS_TARGET_TAG_KEY/VALUE` (or `ROUTE_OPS_MONITOR_INSTANCE_ID`), checks disk/Docker/container health, scans recent logs with cookie/token redaction, and runs the authenticated Route Ops smoke through the deployed `delivery-api` runtime image. This avoids ad-hoc SSM quoting failures and does not depend on Node being installed on the host. Use `--status-only` for no authenticated smoke and `--render-host-script` for local regression review without AWS.

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
deployment provisions the approved private S3 graph artifact when needed, then
fails closed if the host parquet files are absent, still Git LFS pointers, or do
not match the `org.clever-route.graph-manifest-sha` label on the pinned worker
image.
