# Script tooling inventory

This repo keeps a small set of root-level scripts because deployment and Route Ops checks need to be runnable from CI, SSM, and local shells. The goal is not to add a new shell file for every app feature; ordinary feature work should avoid touching workflow/deploy scripts unless the platform behavior changes.

## Production/operator entrypoints

- `scripts/ssm-simple-route-ops-deploy.sh` — current production deploy lane: GitHub Actions publishes digest-addressable changed images, then SSM pulls, runs the same-image migration service, stages static assets only when needed, recreates only `delivery-api`, and rolls back from the previous `.deploy/current-image.env` if health fails. The local `--publish` flag is a manual fallback, not the normal CI path; missing `write:packages` in `gh auth status` is warning-only while Docker/GHCR push failures remain fatal.

- `scripts/scan-secrets.sh` — local/CI secret hygiene utility for staged, worktree, and history scans.
- `scripts/monitor-route-ops-production.sh` — read-only SSM monitor wrapper for production health, container status, redacted recent logs, and authenticated smoke through the deployed runtime image.
- `scripts/package-wordpress-plugin.sh` — explicit packaging helper for the WordPress plugin artifact.

## CI validators and deploy-safety checks

These are not production commands. They are kept separate so each failure domain remains easy to review.

- `scripts/check-ignore-hygiene.mjs` — verifies generated/private artifacts stay ignored.

## Smoke tests

- `scripts/smoke-route-ops-production.mjs` — HTTP/CSP/bootstrap smoke for the embedded Route Ops app.

## Environment preparation helpers

- `scripts/osrm-ontario.sh preflight` — read-only EC2 check for existing OSRM data/service/env plus disk and memory thresholds before deciding whether EBS expansion or preparation is needed.
- `scripts/osrm-ontario.sh prepare` — optional Ontario OSRM data preparation on the EC2 host.
- `scripts/osrm-ontario.sh smoke` — optional OSRM route-geometry smoke.
- `OSRM_DRY_RUN=1 scripts/osrm-ontario.sh preflight|prepare|smoke` — validates command construction without downloads, Docker, env reads, or live OSRM requests.

## Test harnesses

Tests should live under `tests/`, not beside operator commands.

- `tests/deploy/ssm-simple-route-ops-deploy.test.sh` — regression test for simple SSM render guards and VROOM/proof-media deploy checks.
- `tests/deploy/route-ops-prisma-db-push-guard.test.sh` — regression test for the Prisma schema SHA guard used by the same-image `delivery-api-migrate` compose service.
- `tests/deploy/monitor-route-ops-production.test.sh` — regression test for monitor wrapper host-script rendering, production expectation defaults, runtime-image smoke fallback, and redaction hooks.

## Change rule

For normal app/UI/backend features, do not edit `.github/workflows/*`, `scripts/ssm-*`, or deploy-safety validators. Touch them only when the requested change is explicitly about deployment, CI, secrets, platform preparation, or a verified path/reference update.
