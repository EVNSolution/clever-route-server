# Route Ops simple SSM deploy lane

This is the reduced production deploy lane for Route Ops after the VROOM/OSRM cutover.
It intentionally avoids the old S3 deploy-control bundle, EC2 image builds, separate migrate images, and `prod-prev` retag/push backups.

## Current production constraints verified on 2026-06-17

- SSM target: one online instance tagged `Service=clever-delivery-server`.
- Host app path: `/srv/clever-route-server`.
- The host is **not** a git checkout and cannot fetch the private GitHub repo directly.
- The host has `docker`, `aws`, and `python3`; it does not need host `node` or `npm`.
- Optimizer lane is multi-coverage: `delivery-api -> vroom -> osrm-ontario` and `delivery-api -> vroom-korea -> osrm-korea` once Korea data is installed.
- Local proof media storage must be bootstrapped before compose restart:
  `/srv/clever-route-server/data/driver-proof-media`, owner `100:101`, mode `750`.

Because of those constraints, do not replace this lane with “git pull on the server” until
server-side GitHub credentials and a real checkout are deliberately provisioned.

## Files

- Script: `scripts/ssm-simple-route-ops-deploy.sh`
- GitHub workflow: `.github/workflows/route-ops-simple-deploy.yml`
- Compose: `infra/compose/docker-compose.prod.yml`
- Edge/Caddy: owned by `docs/deployment/edge-caddy-deploy.md`, not this lane
- Runtime env: `apps/delivery-api/.env`
- VROOM configs: `infra/vroom/config.yml`, `infra/vroom/config.korea.yml`

For the temporary direct Android distribution channel, the runtime env also
owns the public routes release manifest:

```dotenv
ROUTES_APP_DISTRIBUTION_CHANNEL=direct
ROUTES_APP_ANDROID_LATEST_VERSION_CODE=2
ROUTES_APP_ANDROID_LATEST_VERSION_NAME=1.0.1
ROUTES_APP_ANDROID_MIN_SUPPORTED_VERSION_CODE=1
```

`GET /routes-app/release/android` is unavailable when these values are absent or
inconsistent. Update the latest version values only after the stable APK target
behind `/routes-app` has been replaced and verified. The API returns the stable
server URL and never exposes `ROUTES_APP_DOWNLOAD_URL`.

## Expected fast path

1. GitHub Actions reads `.deploy/current-image.env` from EC2 through SSM.
2. It diffs the deployed `COMMIT_SHA` against the selected source ref.
3. It builds only changed images:
   - `apps/route-ops-web/**` or `.dockerignore` -> `route-ops-web-static`
   - `apps/delivery-api/**` or `.dockerignore` -> `delivery-api`
   - compose/script/docs-only changes -> no image build
4. `docker/build-push-action@v7` publishes changed images to GHCR with both
   `${{ github.sha }}` and `${channel}` tags, using GHCR registry cache.
5. The workflow resolves the deploy image refs to `repo@sha256:<digest>` and uploads
   `route-ops-simple-image-selection` as a 7-day artifact.
6. The SSM command receives digest refs through `ROUTE_OPS_RUNTIME_IMAGE` and
   `ROUTE_OPS_WEB_STATIC_IMAGE`.

## SSM host work

The EC2 host does not build. A real deploy does this in order:

1. Takes `.deploy/route-ops-simple-deploy.lock.d`.
2. Writes the reviewed `infra/compose/docker-compose.prod.yml` and VROOM config files from the workflow checkout onto the host, so compose/VROOM config/script-only changes can deploy through SSM without image builds. It does **not** write or reload Caddy.
3. Writes `.deploy/simple-candidate-image.env` with digest-addressable image refs.
4. Copies existing `.deploy/current-image.env` to `.deploy/simple-rollback-image.env`.
5. Validates compose config with `--profile osrm --profile vroom --profile korea`.
6. Rewrites optimizer env to legacy Ontario URLs plus explicit Ontario/Korea OSRM/VROOM URLs and `OSRM_DEFAULT_COVERAGE=korea`.
7. Bootstraps proof-media directory owner/mode.
8. Logs into GHCR using SSM parameters only on the host.
9. Runs `docker compose --profile osrm --profile vroom --profile korea pull delivery-api vroom vroom-korea`; pulls `route-ops-web-static` only when static staging is required.
10. Runs `docker compose run --rm delivery-api-migrate` before touching the live static volume. The migration service must use the G007 migrate-deploy entrypoint and its target guard.
11. Compares candidate and current `ROUTE_OPS_WEB_STATIC_IMAGE` digest refs.
12. Stages the static volume via `route-ops-web-static` when the static digest changed, the current ref is missing, either ref is a mutable tag/non-digest ref, or `ROUTE_OPS_FORCE_STATIC_RESTAGE=1` is set.
13. Recreates `delivery-api` only with `up -d --no-build --no-deps --force-recreate`.
14. Verifies public `/healthz`.
15. Backs up `.deploy/current-image.env`, promotes the candidate env, and appends deploy history including `staticStage`.

## Commands

Local preflight only:

```bash
bash -n scripts/ssm-simple-route-ops-deploy.sh
scripts/ssm-simple-route-ops-deploy.sh --dry-run --no-send
```

Manual fallback publish:

```bash
scripts/ssm-simple-route-ops-deploy.sh --publish --dry-run --no-send
```

The local `--publish` path treats a missing `write:packages` line in `gh auth status`
as a warning only, because Docker/GHCR push is the authoritative publish check. A real
`docker push` or login failure remains fatal. `ROUTE_OPS_SKIP_GHCR_WRITE_SCOPE_CHECK=1`
only skips the GitHub CLI scope warning; it does not bypass Docker push failures.
The same path requires the Docker buildx CLI plugin and publishes linux/amd64 images
with `docker buildx build --push`, `--provenance=false`, and the same GHCR registry
cache refs used by GitHub Actions. Do not fall back to legacy `docker build --platform`
on Apple Silicon; that path can fail inside amd64/esbuild emulation before anything is
published. The web static Dockerfile therefore runs its Node/Vite build stage on
`$BUILDPLATFORM` and only emits the final static image on `$TARGETPLATFORM`.

Safe host dry-run:

```bash
scripts/ssm-simple-route-ops-deploy.sh --dry-run
```

GitHub Actions production deploy:

```bash
gh workflow run "Route Ops simple deploy" --repo EVNSolution/clever-route-server --ref main \
  -f channel_tag=prod -f source_ref=main -f publish_images=true -f dry_run=false
```

If images were already published but SSM dispatch failed, preserve the previous rollback env
and rerun only the SSM phase against the already-published channel digest refs:

```bash
gh workflow run "Route Ops simple deploy" --repo EVNSolution/clever-route-server --ref main \
  -f channel_tag=prod -f source_ref=<published-sha> -f publish_images=false -f dry_run=false
```

## Rollback

The workflow no longer pushes `${channel}-prev`. Rollback state is file-based:

- `.deploy/simple-rollback-image.env` is copied from the previously promoted
  `.deploy/current-image.env` before any container restart.
- `.deploy/current-image.env.before-simple-*` is kept before promotion.
- GitHub Actions also uploads `route-ops-simple-image-selection`, which records previous
  and candidate image refs for the run.

If the new `delivery-api` fails public `/healthz`, the script uses
`.deploy/simple-rollback-image.env`, stages the previous static image, recreates only
`delivery-api`, leaves `caddy` running, and exits failed so the attempted deploy is not
promoted.

Manual rollback is the same operation: restore or point compose at the previous env file,
stage `route-ops-web-static`, then recreate `delivery-api` with `--no-deps`. Rollback
always stages the previous static image, even if normal forward deploy would skip unchanged
static, because recovery integrity is more important than speed. Do not touch `caddy` unless
the rollback is specifically an ingress change.

## DB/schema risk boundary

Image rollback is not database rollback. A deploy is `db-risk: true` when it
changes Prisma schema/migrations, the DB guard script, the production migration
service/command, deploy workflow/script migration behavior, or image schema
metadata such as `PRISMA_SCHEMA_SHA`. For those deploys, record schema guard/diff
evidence and state whether the previous runtime image is backward-compatible. If
not trivially reversible, prepare a backup/restore or forward-fix plan before
production mutation.

## Migrate image model

`delivery-api-migrate` remains a compose service, but it uses the same
`DELIVERY_API_IMAGE` as the runtime service and overrides only `command` with
the guarded G007 migrate-deploy entrypoint:

```yaml
delivery-api-migrate:
  image: ${DELIVERY_API_IMAGE}
  command: ["sh", "scripts/dsv-g007-migrate-deploy.sh"]
```

The runtime image includes the migration script and Prisma schema, so this removes the
second `delivery-api-migrate` image build/push from the deploy path. Production mode must
provide `DSV_MIGRATION_APPROVED=1`, `DSV_MIGRATION_MANIFEST_SHA256`, and
`DSV_RESTORE_REHEARSAL_SHA256`; rehearsals must use disposable `clever_g007_*` targets.

Database recovery for G007 is rehearsed through `apps/delivery-api/scripts/dsv-g007-restore.sh`.
It restores only to `clever_g007_stale_clone_*`, `clever_g007_restore_*`, or
`clever_g007_recovery_*` databases and rejects protected targets before any restore command
can run.

## Availability expectation

Build/push happens in GitHub Actions and does not stop production. The SSM phase only pulls,
runs migration, stages static assets, and recreates `delivery-api`. Caddy is neither
rewritten nor reloaded by this lane. The edge lane must already have the
`lb_try_duration 30s` / `lb_try_interval 500ms` retry policy in place so brief connection
failures during the single-container `delivery-api` swap are retried instead of returned
immediately as transient 502 responses.

## Static staging skip

Backend-only deploys can avoid restaging unchanged web assets. The script compares the
candidate `ROUTE_OPS_WEB_STATIC_IMAGE` ref with the previous value from
`.deploy/current-image.env` / `.deploy/simple-rollback-image.env`. It skips only when both values are digest-addressable `repo@sha256:...` refs and equal:

- same digest -> skip `route-ops-web-static` staging and record `staticStage=unchanged`;
- changed digest, missing current ref, or mutable tag/non-digest ref -> pull/stage `route-ops-web-static`;
- `ROUTE_OPS_FORCE_STATIC_RESTAGE=1` -> stage static even when the digest matches.

Use the force flag when debugging volume state, repairing a suspected stale static volume,
or deliberately rehydrating the static artifact without changing the image digest. Local manual `--publish` fallbacks may still render mutable channel tags; those refs are intentionally staged conservatively instead of using the unchanged skip.
