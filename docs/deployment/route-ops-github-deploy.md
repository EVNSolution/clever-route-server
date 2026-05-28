# Route Ops GitHub image publish and manual EC2 deploy

Phase 1 is intentionally **publish-only** from GitHub Actions because this repo is private under the EVNSolution Free org. Do not use GitHub Environments, environment secrets, required reviewers, or GitHub-native secret scanning as required controls for this phase.

## What GitHub Actions does

`.github/workflows/route-ops-publish.yml` runs only by `workflow_dispatch` on `main`. The operator must provide `deployed_base_ref`, the immutable git SHA/ref currently represented by production's `.deploy/current-image.env`; the deploy-scope guard compares `deployed_base_ref...HEAD` so unrelated Woo/Prisma/infra changes already on `main` cannot be silently included in a Route Ops image publish.

It:
- runs ignore hygiene, a pinned gitleaks full-history scan plus worktree scan, and Route Ops deploy-scope guard;
- builds `runtime` and `migrate` targets from `apps/delivery-api/Dockerfile`;
- pushes immutable git SHA tags to GHCR;
- labels both images with `org.opencontainers.image.revision`, `org.clever-route.prisma-schema-sha`, and `org.clever-route.image-role`;
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
PRISMA_SCHEMA_SHA=$(sha256sum apps/delivery-api/prisma/schema.prisma | awk "{print \$1}")
cat > .deploy/current-image.env <<EOF_IMAGE
IMAGE_TAG=bootstrap-local
DELIVERY_API_IMAGE=clever-route-server-delivery-api:local
DELIVERY_API_MIGRATE_IMAGE=clever-route-server-delivery-api-migrate:local
PRISMA_SCHEMA_SHA=${PRISMA_SCHEMA_SHA}
EOF_IMAGE
set -a; source .deploy/current-image.env; set +a
docker compose --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml config --quiet'
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
export ROUTE_OPS_SMOKE_BASE_URL=https://clever-route.cleversystem.ai
export ROUTE_OPS_SMOKE_SHOP_DOMAIN=dev1.tomatonofood.com
export ROUTE_OPS_SMOKE_LOGIN_SECRET=<read locally from host secret manager, never commit>
scripts/deploy-route-ops-image.sh
```

The deploy script prepares `.deploy/candidate-image.env`, pulls both images, verifies labels and schema SHA, runs the existing migration command as a schema-gated no-op for this Route Ops lane, recreates only `delivery-api`, runs authenticated smoke, and promotes metadata only after smoke succeeds. On failure it restores `.deploy/current-image.env`.

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

## Rollback

```bash
cd /srv/clever-route-server
export ROUTE_OPS_SMOKE_LOGIN_SECRET=<read locally, never commit>
scripts/rollback-route-ops-image.sh
```

Rollback uses `.deploy/previous-image.env`, verifies the schema fingerprint matches the current lane, activates the previous image, runs the same smoke, and restores the pre-rollback current image if rollback smoke fails.

## Secrets and billing constraints

- No production SSH key, admin smoke secret, cookie, or runtime `.env` is stored in GitHub.
- Use a host-local GHCR read token in Docker credential storage.
- Keep Actions manual, timeout-bounded, and artifact-light; redacted summaries only with one-day retention.
- If Actions quota is exhausted, use a local maintainer build/push or the existing emergency deploy path after separate approval.
