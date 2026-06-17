# Route Ops GitHub release prepare/promote

The Route Ops deployment lane is `.github/workflows/route-ops-release.yml`: a single manual prepare/promote workflow that builds the Route Ops images, performs the no-mutation SSM dry validation, emits an immutable release manifest, and later promotes only that verified manifest. The retired split publish/deploy workflows were removed after the consolidated lane completed a successful production run.

This repo is private under the EVNSolution Free org. Do not use GitHub Environments, environment secrets, required reviewers, or GitHub-native secret scanning as required controls for this phase.

## Primary release workflow

`route-ops-release.yml` runs only by `workflow_dispatch` on `main` and has two explicit modes:

- `mode=prepare` runs actor allowlist, ignore hygiene, pinned gitleaks scans, Route Ops deploy-scope guard, image build/push, deploy-control bundle creation, S3 upload, and `dryRun=true` SSM validation. It emits a `route-ops-release-manifest` artifact with the exact git SHA, image coordinates, publish evidence URL, dry-run bundle URI, and `manifestSha256`. The manifest records only whether the driver APK URL handoff is present; it must not expose the raw URL.
- `mode=promote` accepts only `release_run_id` and `release_manifest_sha256`, downloads the prepare artifact, validates the digest/provenance, checks out the exact manifest commit, regenerates the deploy-control bundle with `dryRun=false`, and runs the same constrained SSM deploy path. Promotion must not rebuild images or accept mutable image coordinates.

Job permissions stay separated: image publishing jobs may use `packages: write`; SSM jobs may use `id-token: write`; no job should need both. The workflow also preserves the Route Ops safety gates in CI and `scripts/validate-route-ops-release.mjs`.

### Primary operator flow

Prepare first; this is the required no-mutation validation after changing the deploy lane:

```bash
gh workflow run route-ops-release.yml \
  --ref main \
  -f mode=prepare \
  -f deployed_base_ref=<current-production-git-sha>
```

The release contract no longer accepts a route_engine image, digest, or publish-evidence handoff. Optimizer runtime is host-env driven: `VROOM_BASE_URL` is preferred, and legacy `ROUTE_ENGINE_BASE_URL` is rollback/compatibility only.


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
# Optional legacy route_engine rollback only: export ROUTE_ENGINE_IMAGE=ghcr.io/evnsolution/route-engine-worker:<sha>
export ROUTE_OPS_COMPOSE_PROJECT_NAME=clever-route
export ROUTE_OPS_SMOKE_BASE_URL=https://clever-route.cleversystem.ai
export ROUTE_OPS_SMOKE_SHOP_DOMAIN=dev1.tomatonofood.com
export ROUTE_OPS_SMOKE_LOGIN_SECRET=<read locally from host secret manager, never commit>
scripts/deploy-route-ops-image.sh
```

The deploy script prepares `.deploy/candidate-image.env`, prunes stale Route Ops images before pull, pulls the frontend static/runtime/migrate images plus only configured optimizer support images, stages the frontend artifact into a SHA-scoped `ROUTE_OPS_WEB_STATIC_VOLUME`, verifies labels and schema SHA, runs the guarded Prisma `db push` entrypoint from the candidate migrate image, activates/smokes OSRM and VROOM when `VROOM_BASE_URL` is configured, activates/smokes legacy route_engine only when `ROUTE_ENGINE_BASE_URL` is configured with an explicit `ROUTE_ENGINE_IMAGE`, recreates only `delivery-api`, runs authenticated Route Ops smoke, and promotes metadata only after smoke succeeds. The guard recomputes `apps/delivery-api/prisma/schema.prisma`, requires it to match `PRISMA_SCHEMA_SHA`, and never opts into `--accept-data-loss`; missing or mismatched schema metadata stops before Prisma touches the database. On failure before backend recreation, the running backend keeps its previous static volume.

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

When `VROOM_BASE_URL` is configured, the production deploy script starts OSRM first,
then VROOM, and performs a non-customer VROOM smoke from a one-off `delivery-api`
runtime container: `GET /health` and `POST /` with a fixed two-stop payload. It
expects `code=0`, no unassigned jobs, and both smoke jobs returned. Legacy
route_engine smoke remains compatibility-only and runs only when
`ROUTE_ENGINE_BASE_URL` is configured.

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
- `VROOM_IMAGE` is pinned deploy metadata, not a secret. Legacy `ROUTE_ENGINE_IMAGE`
  is optional rollback/compatibility metadata only and is required only if host env
  enables `ROUTE_ENGINE_BASE_URL`.
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

## Optimizer worker boundary

VROOM is the preferred internal optimizer Compose service. The old Python
route_engine service remains profile-gated compatibility only:

```text
route-engine:
  image: ${ROUTE_ENGINE_IMAGE}
  profile: route-engine
  expose: 8080
  graph mount: ${ROUTE_ENGINE_GRAPH_HOST_DIR}:/app/routing_engine/v7_out/parquet:ro
```

VROOM has no public port. `delivery-api` talks to it by internal Compose DNS
`http://vroom:3000` when `VROOM_BASE_URL` is set. Legacy route_engine has no
public port either and is activated only when `ROUTE_ENGINE_BASE_URL` is set with
an explicit `ROUTE_ENGINE_IMAGE`; no deploy path auto-enables it.
