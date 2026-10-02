# K-food incomplete route finalization

## Purpose

The API runtime finalizes a K-food route as `INCOMPLETE` when its route-tracking
event window has ended while the route is still `IN_PROGRESS`. This removes a
stale route from active driver and operational-session queries while retaining
the route, stop states, driver events, raw GPS positions, and derived tracking
geometry for historical inspection.

`INCOMPLETE` does not mean delivered or cancelled. The worker does not modify
any stop or order status and does not append a synthetic driver event.

## Scope and guards

Routes with a valid current delivery-completion marker follow the
[two-hour return-navigation policy](kfood-delivery-navigation-grace.md): their
administrative status is already `COMPLETED`, and this worker finalizes their
raw status as `COMPLETED` after the navigation deadline. The tracking-window
`INCOMPLETE` guards below apply when no valid completion marker exists.

The runtime is deliberately fixed to this tenant identity:

- app ID: `clever-route-kfood`
- shop domain: `7hrud1-xq.myshopify.com`

When activated, every scan reads at most 25 `IN_PROGRESS` candidates and runs
every 15 minutes. A stable `(planDate, id)` cursor advances between scans and
wraps after the final page, so an unresolvable early page cannot permanently
starve later due routes.
Before updating a candidate it acquires the same `route_plans` row lock used by
driver event ingestion, then re-reads the route inside that transaction and
requires all of the following:

1. The app ID and shop domain still match the K-food tenant.
2. The route status is still `IN_PROGRESS`.
3. No `ROUTE_COMPLETED` event exists.
4. A valid IANA route timezone resolves the existing two-local-day tracking
   event window.
5. The event-window end is at or before the current server time.
6. The route ID, shop ID, assignment generation, status, and `updatedAt` value
   still match when the update is applied.

A failed guard leaves the route unchanged. DSV tenants cannot match the worker
scope, and the DSV API contract does not expose the new status.

## Two-stage deployment

The schema change is the additive migration
`20260929120000_add_incomplete_route_plan_status`. Production deployment must
use the reviewed Route Ops workflow with `run_migrations=true`. The migration
only executes:

```sql
ALTER TYPE "RoutePlanStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE';
```

The worker is guarded by `KFOOD_STALE_ROUTE_FINALIZATION_ENABLED` and defaults
to `false`. Deployment has two distinct stages:

1. Deploy the migration and compatible API image with the flag absent or set to
   `false`. Verify migration evidence, runtime health, authenticated reads, and
   the exact compatible current image digest. No route status mutation occurs
   in this stage. The workflow rollback manifest still points to the
   pre-compatible prior image at this point and is not yet safe for activation.
2. In the effective production Compose environment file, change only
   `KFOOD_STALE_ROUTE_FINALIZATION_ENABLED=false` to
   `KFOOD_STALE_ROUTE_FINALIZATION_ENABLED=true`. Run a second official deploy
   from the same main SHA with `publish_images=false` and
   `run_migrations=false`. This force-recreates the API with the same reviewed
   image digest. Before force-recreate, the deploy copies the compatible current
   image into the workflow-managed rollback manifest. Confirm the workflow and
   effective container environment before the 15-minute grace period ends. The
   worker waits for its first interval before scanning and does not mutate data
   during process startup. Activation is rollback-safe only after this second
   workflow succeeds and its compatible rollback-manifest evidence is captured.

Run stage 1 through the official workflow:

```bash
gh workflow run "Route Ops operations" --repo EVNSolution/clever-route-server \
  --ref main \
  -f operation=deploy \
  -f channel_tag=prod \
  -f source_ref=main \
  -f publish_images=true \
  -f dry_run=false \
  -f run_migrations=true \
  -f approve_dsv_migration=true \
  -f restore_rehearsal_sha256=<reviewed-restore-rehearsal-sha256>
```

`restore_rehearsal_sha256` must be the actual 64-character lowercase SHA-256
from a recent reviewed restore rehearsal and backup record. Never invent or
reuse an unrelated hash to satisfy the workflow gate. The workflow derives the
G007 baseline-manifest and production-baseline-manifest hashes from the exact
source checkout and passes those approval fields to the guarded migration
runtime; retain their workflow evidence with the rehearsal hash.

Do not activate the worker while rollback could select an image that predates
`INCOMPLETE` read compatibility. For rollback after activation, first set the
flag to `false` and restart a compatible image to stop further writes. Then
roll back only to an image already proven to read `INCOMPLETE`; never select a
pre-compatibility image. Existing `INCOMPLETE` rows remain readable and
preserved.

### Production activation procedure

The production host path is `/srv/clever-route-server`. It is a deploy tree,
not a Git checkout: do not run `git pull`, build Node artifacts, or execute
repository-local source scripts there. Compose reads the API runtime environment
from the exact host file
`/srv/clever-route-server/apps/delivery-api/.env`.

After stage 1 health and authenticated read verification, record the compatible
main SHA and digest without exposing environment values:

```bash
cd /srv/clever-route-server
test -f .deploy/current-image.env
awk -F= '$1 == "COMMIT_SHA" || $1 == "DELIVERY_API_IMAGE" { print $1 "=" $2 }' \
  .deploy/current-image.env
docker compose -p clever-route --env-file .deploy/current-image.env \
  -f infra/compose/docker-compose.prod.yml ps clever-route-api
```

The recorded `DELIVERY_API_IMAGE` must be digest-addressable and the running API
must be healthy. Save this output with the stage 1 workflow run as compatible
current-image evidence. Do not describe it as the active rollback baseline yet;
stage 2 establishes that baseline immediately before writes can begin.

Use SSM on the production host to make a private backup and edit only the
activation key. This command does not print the environment file or any secret:

```bash
set -eu
runtime_env=/srv/clever-route-server/apps/delivery-api/.env
backup_dir=/srv/clever-route-server/private/kfood-incomplete-route-finalization
stamp=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
mkdir -p "$backup_dir"
chmod 0700 "$backup_dir"
cp -p "$runtime_env" "$backup_dir/delivery-api.env.before-$stamp"
chmod 0600 "$backup_dir/delivery-api.env.before-$stamp"
match_count=$(grep -c '^KFOOD_STALE_ROUTE_FINALIZATION_ENABLED=' "$runtime_env" || true)
test "$match_count" -le 1
if [ "$match_count" -eq 0 ]; then
  printf '\nKFOOD_STALE_ROUTE_FINALIZATION_ENABLED=true\n' >> "$runtime_env"
else
  sed -i 's/^KFOOD_STALE_ROUTE_FINALIZATION_ENABLED=.*/KFOOD_STALE_ROUTE_FINALIZATION_ENABLED=true/' "$runtime_env"
fi
chmod 0600 "$runtime_env"
grep -q '^KFOOD_STALE_ROUTE_FINALIZATION_ENABLED=true$' "$runtime_env"
```

Editing the file does not change the existing container. Trigger stage 2 through
the official workflow, using the exact compatible SHA recorded above:

```bash
gh workflow run "Route Ops operations" --repo EVNSolution/clever-route-server \
  --ref main \
  -f operation=deploy \
  -f channel_tag=prod \
  -f source_ref=<compatible-main-sha> \
  -f publish_images=false \
  -f dry_run=false \
  -f run_migrations=false
```

The deploy script copies the compatible `.deploy/current-image.env` into its
rollback manifest before force-recreating `clever-route-api`. The 15-minute
startup delay is the verification window; it is not a substitute for the
compatible rollback manifest. After the workflow succeeds, verify on the host
that the digest stayed unchanged and the effective container received the flag
without printing other environment values:

```bash
cd /srv/clever-route-server
expected_image=$(awk -F= '$1 == "DELIVERY_API_IMAGE" { print substr($0, index($0, "=") + 1) }' .deploy/current-image.env)
container_id=$(docker compose -p clever-route --env-file .deploy/current-image.env \
  -f infra/compose/docker-compose.prod.yml ps -q clever-route-api)
test -n "$container_id"
test "$(docker inspect --format '{{.Config.Image}}' "$container_id")" = "$expected_image"
docker compose -p clever-route --env-file .deploy/current-image.env \
  -f infra/compose/docker-compose.prod.yml exec -T clever-route-api \
  sh -eu -c 'test "${KFOOD_STALE_ROUTE_FINALIZATION_ENABLED:-}" = true'
printf '%s\n' 'K-food stale route finalization flag verified: true'
```

Retain the private environment backup until post-activation audit is complete.
Do not copy it into Git, CI artifacts, command output, or deployment evidence.

### Activation rollback

Before any rollback, use the same guarded edit procedure to set
`KFOOD_STALE_ROUTE_FINALIZATION_ENABLED=false`, then run the official deploy
against the compatible SHA with `publish_images=false` and
`run_migrations=false`. Verify the effective container flag is false. Roll back
only to the recorded compatible digest; the pre-compatibility image is not a
valid rollback target after any `INCOMPLETE` row has been written.

Run the flag edit through SSM on the production host:

```bash
set -eu
runtime_env=/srv/clever-route-server/apps/delivery-api/.env
match_count=$(grep -c '^KFOOD_STALE_ROUTE_FINALIZATION_ENABLED=' "$runtime_env" || true)
test "$match_count" -eq 1
sed -i 's/^KFOOD_STALE_ROUTE_FINALIZATION_ENABLED=.*/KFOOD_STALE_ROUTE_FINALIZATION_ENABLED=false/' "$runtime_env"
chmod 0600 "$runtime_env"
grep -q '^KFOOD_STALE_ROUTE_FINALIZATION_ENABLED=false$' "$runtime_env"
```

Then trigger the official workflow from an authenticated operator environment,
not from the production host:

```bash
gh workflow run "Route Ops operations" --repo EVNSolution/clever-route-server \
  --ref main \
  -f operation=deploy \
  -f channel_tag=prod \
  -f source_ref=<compatible-main-sha> \
  -f publish_images=false \
  -f dry_run=false \
  -f run_migrations=false
```

## Evidence

Capture these as separate deployment records:

1. CI evidence for Prisma generation, lint, typecheck, tests, and build.
2. Migration workflow evidence showing the migration applied successfully.
3. Runtime image digest and healthy compatible rollback revision while the flag
   is still disabled.
4. Activation evidence showing the exact same reviewed image with the flag set
   to `true`.
5. A server log entry with event `kfood_stale_route_finalization_scan`.
6. A read-only postcheck for the target tenant showing no stale
   `IN_PROGRESS` route whose event window has ended.

For the known September 17 route, verify after the worker scan that:

- the route status is `INCOMPLETE`;
- all 14 stop statuses are unchanged;
- raw GPS position count is unchanged;
- route tracking geometry and road-match cache rows remain present;
- no `ROUTE_COMPLETED` event was created;
- the route remains retrievable in route-group history, driver history,
  feedback, and proof-media reads while remaining absent from active
  driver/session queries.

If a route cannot resolve its tracking timezone, it remains `IN_PROGRESS` and
the scan reports it under `skippedUnresolvableWindow`. Correct the source
timezone evidence before retrying; do not infer a timezone during finalization.
