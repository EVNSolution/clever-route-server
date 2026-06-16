# Script tooling inventory

This repo keeps a small set of root-level scripts because deployment and Route Ops checks need to be runnable from CI, SSM, and local shells. The goal is not to add a new shell file for every app feature; ordinary feature work should avoid touching workflow/deploy scripts unless the platform behavior changes.

## Production/operator entrypoints

These are intentionally separate because they have different blast radius and rollback semantics.

- `scripts/ssm-route-ops-deploy.sh` — host-side SSM wrapper. Validates manifest-derived deploy inputs, reads the host-local admin smoke secret, and calls the activation script. Do not place production SSH keys or runtime env in GitHub.
- `scripts/route-ops-deploy-control-bundle.sh` — deploy-control bundle helper used by GitHub Actions and the custom SSM document to enforce the reviewed file allowlist, SHA-256 verification, manifest validation, and host source sync.
- `scripts/deploy-route-ops-image.sh` — activates a published Route Ops image, checks schema labels, runs migration/compose/smoke, and promotes or restores current image metadata.
- `scripts/rollback-route-ops-image.sh` — explicit rollback path to a previous image tag.
- `scripts/scan-secrets.sh` — local/CI secret hygiene utility for staged, worktree, and history scans.
- `scripts/monitor-route-ops-production.sh` — read-only SSM monitor wrapper for production health, container status, redacted recent logs, and authenticated smoke through the deployed runtime image.
- `scripts/package-wordpress-plugin.sh` — explicit packaging helper for the WordPress plugin artifact.

## CI validators and deploy-safety checks

These are not production commands. They are kept separate so each failure domain remains easy to review.

- `scripts/check-ignore-hygiene.mjs` — verifies generated/private artifacts stay ignored.
- `scripts/guard-route-ops-deploy-scope.mjs` — fails closed when a Route Ops deploy lane includes unrelated Woo, Prisma, Caddy, infra, or output artifacts.
- `scripts/validate-route-ops-release.mjs` — statically validates the GitHub Actions → OIDC → SSM deployment topology and secret boundaries.

## Smoke tests

- `scripts/smoke-route-ops-production.mjs` — HTTP/CSP/bootstrap smoke for the embedded Route Ops app.

## Environment preparation helpers

- `scripts/osrm-ontario.sh preflight` — read-only EC2 check for existing OSRM data/service/env plus disk and memory thresholds before deciding whether EBS expansion or preparation is needed.
- `scripts/osrm-ontario.sh prepare` — optional Ontario OSRM data preparation on the EC2 host.
- `scripts/osrm-ontario.sh smoke` — optional OSRM route-geometry smoke.
- `OSRM_DRY_RUN=1 scripts/osrm-ontario.sh preflight|prepare|smoke` — validates command construction without downloads, Docker, env reads, or live OSRM requests.

## Test harnesses

Tests should live under `tests/`, not beside operator commands.

- `tests/deploy/ssm-route-ops-deploy.test.sh` — regression test for the SSM deploy wrapper lock, tag validation, evidence, and secret-redaction behavior.
- `tests/deploy/route-ops-deploy-control-bundle.test.sh` — regression test for deploy-control bundle tar manifest validation, SHA-256 mismatch failure, manifest allowlist failure, and dry-run manifest env generation.
- `tests/deploy/monitor-route-ops-production.test.sh` — regression test for monitor wrapper host-script rendering, production expectation defaults, runtime-image smoke fallback, and redaction hooks.

## Change rule

For normal app/UI/backend features, do not edit `.github/workflows/*`, `scripts/deploy-*`, `scripts/rollback-*`, `scripts/ssm-*`, or deploy-safety validators. Touch them only when the requested change is explicitly about deployment, CI, secrets, platform preparation, or a verified path/reference update.
