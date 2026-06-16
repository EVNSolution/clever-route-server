---
name: route-ops-manual-deploy
description: Manual Route Ops production deploy fallback when GitHub Actions or GHCR push cannot be used.
---

# Route Ops manual deploy skill

Use `docs/deployment/route-ops-manual-tar-deploy.md` as the source of truth.
This skill is for the emergency/manual tar fallback only; prefer the normal
`route-ops-release.yml` prepare/promote lane when the user allows Actions.

Hard rules:

1. If the user says not to run CI/Actions, do not run GitHub Actions.
2. Build and verify local artifacts from a clean checkout before touching production.
3. Upload only under `s3://route-ops-artifacts-902837199612-ap-northeast-2/artifacts/route-ops/prod/deploy-control/*`.
4. Generate SSM parameter JSON with Python and wrap remote commands with
   `bash -lc`; `AWS-RunShellScript` may use `/bin/sh`, where `pipefail` is
   invalid.
5. Preserve the current `ROUTE_ENGINE_IMAGE` unless the user explicitly changes it.
   Read only the current route-engine variables from `.deploy/current-image.env`;
   do not source it wholesale because it can clobber the candidate `IMAGE_TAG`.
6. Pass `ROUTE_OPS_DRIVER_APP_DOWNLOAD_URL` and `ROUTE_OPS_SMOKE_LOGIN_SECRET` from host env or explicit values; do not rely on the missing default SSM parameter.
7. Use `ROUTE_OPS_SKIP_CANDIDATE_IMAGE_PULL=1` only after `docker load` has loaded the exact candidate image tags on the host.
8. Resolve exactly one Online SSM target; never use the first item from an ambiguous target list.
9. Always run the post-deploy checks from the runbook and report evidence.

Minimum success evidence:

- SSM deploy command status `Success`.
- `.deploy/current-image.env` references the intended git SHA.
- `delivery-api` is healthy.
- proof-media host dir is `100:101` mode `750` and container path is writable.
- `/healthz` succeeds.
- unauthenticated `/driver/proof-media` returns 401, and a real mobile upload returns 201 when available.
