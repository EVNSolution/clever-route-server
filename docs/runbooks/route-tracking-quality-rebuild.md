# Route tracking quality rebuild

This runbook rebuilds one route's derived `route_tracking_geometries` row from its
immutable `LOCATION_UPDATED` source events and refreshes its OSRM road-match cache.
It does not update driver events, route or stop status, Shopify data, or completion
state.

The command is a dry-run unless `--apply` is present. Apply requires the plan hash
and a mode-`0600` backup produced by a reviewed dry-run. The apply transaction takes
the same route advisory lock as live ingestion, rechecks tenant and route state, and
accepts only an unchanged reviewed source prefix plus a strictly append-only tail.
OSRM calls happen before that transaction.

## Preconditions

- Deploy an image containing `dist/scripts/rebuild-route-tracking-quality.js` and
  the reviewed tracking-quality implementation.
- Confirm the exact app ID, shop domain, and route plan ID from authoritative data.
- Confirm the production API container can reach its configured OSRM coverage.
- Create a root-owned host directory for private evidence:

```bash
sudo install -d -m 0700 /srv/clever-route-server/private/route-tracking-rebuild
```

Set shell variables without placing credentials in shell history:

```bash
tracking_container="$(docker compose -f infra/compose/docker-compose.prod.yml ps -q clever-route-api)"
tracking_app_id='<exact-app-id>'
tracking_shop_domain='<exact-shop-domain>'
tracking_route_plan_id='<exact-route-plan-uuid>'
tracking_backup_container="/tmp/route-tracking-${tracking_route_plan_id}.json"
tracking_backup_host="/srv/clever-route-server/private/route-tracking-rebuild/${tracking_route_plan_id}.json"
```

## Dry-run and host backup

Run the dry-run in the production API container. It reads source events, computes
the new derived geometry and road match, writes no database rows, and creates the
private backup with mode `0600`.

```bash
docker exec "${tracking_container}" node dist/scripts/rebuild-route-tracking-quality.js \
  --app-id "${tracking_app_id}" \
  --shop-domain "${tracking_shop_domain}" \
  --route-plan-id "${tracking_route_plan_id}" \
  --backup-file "${tracking_backup_container}"
```

Record the reported `planHash`, `backup.sha256`, before/after point counts, gap
counts, matched point counts, `inferredLineCount`, and time ranges. The output
contains aggregate data only. It does not print raw coordinates.

`inferredLineCount` counts conservative road connections generated only to make a
known tracking gap readable. These lines are not observed GPS, do not prove that
the driver used that exact road, and must never be used as delivery-completion or
return-to-depot evidence. A surprising inferred count or range is a reason to stop
and review the dry-run rather than apply it.

Copy the backup out before apply and verify both copies. The file contains private
derived GPS coordinates and must not be committed or attached to a public log.

```bash
docker cp "${tracking_container}:${tracking_backup_container}" "${tracking_backup_host}"
sudo chmod 0600 "${tracking_backup_host}"
tracking_host_sha256="$(sudo sha256sum "${tracking_backup_host}" | awk '{print $1}')"
tracking_container_sha256="$(docker exec "${tracking_container}" sha256sum "${tracking_backup_container}" | awk '{print $1}')"
test "${tracking_host_sha256}" = "${tracking_container_sha256}"
```

Do not apply when the identity is wrong, OSRM reports a retryable/incomplete result,
the summary range is unexpected, or the backup hashes differ.

## Guarded apply

Use the exact values printed by the reviewed dry-run:

```bash
tracking_plan_hash='<reviewed-plan-hash>'
tracking_backup_sha256="${tracking_host_sha256}"

docker exec "${tracking_container}" node dist/scripts/rebuild-route-tracking-quality.js \
  --app-id "${tracking_app_id}" \
  --shop-domain "${tracking_shop_domain}" \
  --route-plan-id "${tracking_route_plan_id}" \
  --backup-file "${tracking_backup_container}" \
  --backup-sha256 "${tracking_backup_sha256}" \
  --plan-hash "${tracking_plan_hash}" \
  --apply
```

New GPS events that arrived after dry-run are accepted only when they form an
append-only tail. A changed prefix, out-of-order insertion, route or stop status
change, tenant mismatch, or plan mismatch aborts without a database write. Apply
also creates a unique `*.prewrite-<timestamp>.json` snapshot inside the container
while holding the lock. Copy that reported path to the private host directory and
verify its SHA-256 immediately after apply.

## Verification and rollback

1. Confirm `mutationCount` is `1`, or `0` for an already identical derived row.
2. Confirm source point count and time range cover the intended tracking session.
3. Confirm route status and every delivery-stop status are unchanged.
4. Confirm the `LOCATION_UPDATED` source-event count and reviewed-prefix digest are
   unchanged; later append-only events are expected while live tracking continues.
5. Open the selected historical route and verify the map keeps only the planned
   route and a uniform GPS presentation. Confirm inferred and uncertain provenance
   remains distinguishable in the API/cache for diagnostics without creating extra
   map styles, and remains excluded from delivery-completion evidence.

Rollback is a scoped restore of the single backed-up derived row. It takes the same
route advisory lock, requires the exact currently deployed road-match watermark,
rechecks tenant and route/stop state, writes another private pre-restore snapshot,
and restores only whitelisted `route_tracking_geometries` fields. It does not
restore driver events or route/stop state.

Use `plannedRoadMatchedWatermark` and `appliedDerivedStateHash` from the successful
apply result. Any live geometry/source-tail change, even one that has not refreshed
the road-match watermark yet, changes the derived-state hash and makes rollback
fail closed.

```bash
tracking_expected_watermark='<watermark-from-successful-apply>'
tracking_expected_derived_hash='<derived-state-hash-from-successful-apply>'

docker exec "${tracking_container}" node dist/scripts/rebuild-route-tracking-quality.js \
  --app-id "${tracking_app_id}" \
  --shop-domain "${tracking_shop_domain}" \
  --route-plan-id "${tracking_route_plan_id}" \
  --backup-file "${tracking_backup_container}" \
  --backup-sha256 "${tracking_backup_sha256}" \
  --expected-current-derived-hash "${tracking_expected_derived_hash}" \
  --expected-current-watermark "${tracking_expected_watermark}" \
  --restore
```

Copy the reported `preRestoreBackupFile` to the private host directory and verify
its hash just as for the apply prewrite snapshot. A restore with `mutationCount: 1`
restored the prior derived row; no other table is in the CLI mutation allowlist.
