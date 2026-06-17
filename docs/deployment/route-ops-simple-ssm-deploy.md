# Route Ops simple SSM deploy lane

This is the reduced production deploy lane for Route Ops after the VROOM/OSRM cutover.
It intentionally avoids the old S3 deploy-control bundle and the route-engine image/data
handoff. The operator builds and pushes stable GHCR channel images locally, then SSM tells
the managed instance to pull those images and restart Docker Compose.

## Current production constraints verified on 2026-06-17

- SSM target: one online instance tagged `Service=clever-delivery-server`.
- Host app path: `/srv/clever-route-server`.
- The host is **not** a git checkout and cannot fetch the private GitHub repo directly.
- The host has `docker`, `aws`, `python3`, and `rsync`; it does not need host `node` or `npm`.
- Optimizer lane is `delivery-api -> vroom -> osrm-ontario`; `route-engine` remains stopped.
- Local proof media storage must be bootstrapped before compose restart:
  `/srv/clever-route-server/data/driver-proof-media`, owner `100:101`, mode `750`.

Because of those constraints, do not replace this lane with “git pull on the server” until
server-side GitHub credentials and a real checkout are deliberately provisioned.

## Files

- Script: `scripts/ssm-simple-route-ops-deploy.sh`
- Compose: `infra/compose/docker-compose.prod.yml`
- Runtime env: `infra/env/delivery-api.env`

## Safety model

`--dry-run` sends an SSM command that validates the target, compose file, env-file shape,
and candidate image env. It exits before image pulls, migrations, env rewrites, or container
restarts. It may write `.deploy/simple-candidate-image.env` on the host as preflight evidence.

A real deploy does the following in order:

1. Before publishing, retags the current GHCR channel images as `${channel}-prev`.
2. Takes a deploy lock under `.deploy/route-ops-simple-deploy.lock.d`.
3. Writes `.deploy/simple-candidate-image.env` and `.deploy/simple-rollback-image.env`.
4. Validates compose config with `--profile osrm --profile vroom`.
5. Rewrites optimizer env to VROOM/OSRM and blanks `ROUTE_ENGINE_BASE_URL`.
6. Bootstraps proof-media directory owner/mode.
7. Logs into GHCR using SSM parameters only on the host.
8. Pulls previous images, candidate images, and pinned VROOM image.
9. Stages the static volume, runs Prisma migration, ensures OSRM/VROOM are up.
10. Runs a VROOM solve smoke from inside the delivery-api container.
11. Recreates `delivery-api` only; `caddy` stays up unless its config changed in a separate infra lane.
12. Verifies public `/healthz`; if this fails, recreates `delivery-api` from `${channel}-prev` and exits failed.
13. Backs up `.deploy/current-image.env`, promotes the candidate env, and appends deploy history.

## Commands

Local preflight only:

```bash
bash -n scripts/ssm-simple-route-ops-deploy.sh
scripts/ssm-simple-route-ops-deploy.sh --dry-run --no-send
```

Safe host dry-run:

```bash
scripts/ssm-simple-route-ops-deploy.sh --dry-run
```

Publish and deploy the production channel:

```bash
scripts/ssm-simple-route-ops-deploy.sh --publish
```

Optional channel override for a non-production rehearsal:

```bash
ROUTE_OPS_SIMPLE_CHANNEL_TAG=prod-candidate scripts/ssm-simple-route-ops-deploy.sh --dry-run
```

## Availability expectation

The build/push/pull/migrate/smoke phases do not stop the current domain path. Only the final
`delivery-api` container recreate can cause a short API blip. `caddy` is not recreated by this
lane.


## GitHub Actions deploy

Use the manual `Route Ops simple deploy` workflow when the deploy should run from GitHub
Actions instead of a local shell. It is `workflow_dispatch` only; pushes to `main` run CI but
do not deploy automatically. The workflow checks the actor allowlist, logs into GHCR with
`GITHUB_TOKEN`, assumes `AWS_ROUTE_OPS_DEPLOY_ROLE_ARN` through OIDC, then runs:

```bash
scripts/ssm-simple-route-ops-deploy.sh --publish
```

Run from CLI after `main` is up to date:

```bash
gh workflow run "Route Ops simple deploy" --repo EVNSolution/clever-route-server --ref main \
  -f channel_tag=prod -f source_ref=main -f publish_images=true -f dry_run=false
```


If images were already published but SSM dispatch failed, keep `${channel}-prev` intact and
rerun only the SSM phase against the already-published source ref:

```bash
gh workflow run "Route Ops simple deploy" --repo EVNSolution/clever-route-server --ref main \
  -f channel_tag=prod -f source_ref=<published-sha> -f publish_images=false -f dry_run=false
```

## Rollback

The script backs up the previous `.deploy/current-image.env` before promoting the simple
candidate and also keeps `${channel}-prev` GHCR image tags. If the new `delivery-api`
recreate fails public `/healthz`, the script stages the previous static image, recreates
`delivery-api` from `${channel}-prev`, leaves `caddy` running, and exits failed so the
operator sees that the attempted deploy did not promote.

For manual rollback, restore the latest `.deploy/current-image.env.before-simple-*`, or use
`.deploy/simple-rollback-image.env`, then recreate `route-ops-web-static` plus `delivery-api`;
leave `caddy` running unless the rollback is specifically an ingress change.

## Storage cleanup evidence

On 2026-06-17 the old route-engine artifacts were removed from production:

- stopped route-engine container
- route-engine image
- `clever-route_route-engine-cache` Docker volume
- `/srv/clever-route-server/data/route-engine`
- stale `/tmp/route-ops-manual-*` and `/tmp/clever-route-manual-*`
- stopped containers and dangling images

Root disk usage improved from about `20G used / 35%` to `14G used / 24%`.
The simple SSM lane has completed a production deploy. Remaining old GHCR SHA images
can be pruned after a separate image-retention pass confirms no container references them.

## Instance rebuild plan after this lane is proven

Rebuild only after a successful simple SSM production deploy and at least one monitoring pass.
Minimum cutover checklist:

1. Snapshot/backup Postgres, proof-media, `.deploy`, `infra/env`, Caddy config, and OSRM data.
2. Launch a smaller clean SSM-managed instance with Docker Compose and GHCR pull access.
3. Restore env/data and run compose with VROOM/OSRM profiles only; do not provision route-engine.
4. Run `/healthz`, admin smoke, VROOM solve smoke, proof-media write check, and route optimize smoke.
5. Move DNS/Caddy traffic or elastic IP.
6. Keep the old instance stopped-but-restorable for 24-48 hours, then terminate.

## Troubleshooting

### `docker push` fails with GHCR `403 Forbidden`

The publish phase needs package write permission. On 2026-06-17 the local active
GitHub CLI token only had `repo`/`workflow` scopes and the deploy bot token only had
`read:packages`, so image build succeeded but push stopped before any SSM deploy or
production restart. Fix by refreshing/logging into GHCR with a token that has
`write:packages`, then rerun `scripts/ssm-simple-route-ops-deploy.sh --publish`.

The script now checks GitHub CLI scopes before building. If a separate Docker credential
already has GHCR write access, bypass the CLI-scope guard explicitly:

```bash
ROUTE_OPS_SKIP_GHCR_WRITE_SCOPE_CHECK=1 scripts/ssm-simple-route-ops-deploy.sh --publish
```
