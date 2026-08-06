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
ROUTES_APP_DOWNLOAD_URL=https://downloads.example.com/clever-routes.apk
ROUTES_APP_DISTRIBUTION_CHANNEL=direct
ROUTES_APP_ANDROID_LATEST_VERSION_CODE=2
ROUTES_APP_ANDROID_LATEST_VERSION_NAME=1.0.1
ROUTES_APP_ANDROID_MIN_SUPPORTED_VERSION_CODE=1
```

During the identity cutover, the runtime accepts the legacy `DRIVER_APP_*`
values as a fallback so a server image deploy cannot silently remove update
discovery. Prefer `ROUTES_APP_*` and remove the legacy namespace after deployed
hosts have been migrated. `GET /routes-app` returns the standard install page,
while `GET /routes-app/download` redirects to the configured package. Legacy
`/driver-app` returns the explicit name/package migration guide, and
`/driver-app/release/android` remains a compatibility alias.
The manifest is unavailable when release values are absent or inconsistent.
Advance the latest version only after the stable APK has been replaced and
verified. The JSON response returns the stable server URL and never exposes
`ROUTES_APP_DOWNLOAD_URL`.

After the release registry migration is deployed, the database current pointer
is authoritative when seeded and these env values remain a bootstrap fallback
for an empty registry. Publish a new Android release without rebuilding or
restarting the server:

```bash
npm --prefix apps/delivery-api run routes-app:release:publish -- \
  --version-code 2 \
  --version-name 1.0.1 \
  --minimum-version-code 1 \
  --download-url https://downloads.example.com/clever-routes.apk \
  --apk-sha256 <64-hex-sha256>
```

The publish command only accepts a monotonic `latest-version-code`. Repeating the
same version is allowed only when every release field is identical.

Before deploying the matching mobile build, verify the public cutover:

```bash
curl -sS https://clever-route-api.cleversystem.ai/routes-app
curl -sS https://clever-route-api.cleversystem.ai/routes-app/release/android
curl -sS https://clever-route-api.cleversystem.ai/driver-app/release/android
```

The install page and both release endpoints must be `200`. The manifest must
use the stable `/routes-app` install URL, identify
`com.evnsolution.clever.routes` as the target package, list
`com.evns.cleverdriverapp` as the replaced package, and report the intended
Android version values.

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

### UVIS server-only runtime secret

UVIS vehicle GPS and temperature collection is disabled unless `UVIS_ENABLED=true` is supplied through an encrypted SSM parameter. Never place the vendor company key, access key, endpoint URLs, or vendor specification in Git, GitHub Actions secrets, image build arguments, compose inline environment, or frontend variables.

1. Store dotenv lines for the allowlisted `UVIS_*` keys in one encrypted SSM Parameter Store value.
2. Register only that parameter name as the repository variable `ROUTE_OPS_UVIS_ENV_PARAM`.
3. Keep `UVIS_ENABLED=false` until the migration is applied, the two registered vehicle mappings are confirmed, and change approval is complete.
4. Use `UVIS_SHOP_DOMAIN` and `UVIS_APP_ID` to scope polling to one tenant. Do not infer a tenant from the first database row.
5. Keep the location and temperature poll intervals explicit. Current defaults are 60 seconds and 300 seconds. Dormant location heartbeat defaults to 300 seconds after all mapped vehicles report stopped readings continuously for the configured grace period, default 10 minutes. The existing shop `loadingStartTime` setting is authoritative: Asia/Seoul location polling is forced to the active 60-second cadence from one hour before loading through the latest final ETA of the service day's mapped-vehicle routes. At that ETA, stopped accumulation starts fresh from actual provider signals; ETA alone never proves that a vehicle stopped. When no final ETA exists, forced activity ends at the loading time and the same signal-based grace applies.
6. Verify dry-run and secret scanning before a real deploy. Deployment evidence may contain key names and the SSM parameter name, but never decrypted values.

The delivery API shares one EC2 network interface with other integrations. Do not
claim UVIS isolation by attaching an additional restrictive security group while
another attached group still permits broad egress; security-group permissions are
combined. The UVIS client instead validates each exact HTTPS endpoint, rejects
private/reserved DNS results and redirects, and pins the validated IPv4 result into
the TLS connection so the connection cannot perform a second DNS lookup. A future
network-level domain allowlist requires an isolated worker/network interface or an
egress firewall with the complete set of required application domains.

The host deploy script only accepts these server keys: `UVIS_ENABLED`, `UVIS_APP_ID`, `UVIS_SHOP_DOMAIN`, `UVIS_ACCESS_KEY_URL`, `UVIS_TELEMETRY_URL`, `UVIS_ALLOWED_OUTBOUND_URLS`, `UVIS_COMPANY_SERIAL_KEY`, `UVIS_LOCATION_GUBUN`, `UVIS_TEMPERATURE_GUBUN`, `UVIS_TIMEOUT_MS`, `UVIS_LOCATION_POLL_INTERVAL_MS`, `UVIS_LOCATION_DORMANT_GRACE_PERIOD_MS`, `UVIS_LOCATION_DORMANT_HEARTBEAT_INTERVAL_MS`, and `UVIS_TEMPERATURE_POLL_INTERVAL_MS`.

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
