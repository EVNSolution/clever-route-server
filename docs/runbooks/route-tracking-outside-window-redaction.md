# Route tracking outside-window redaction

Use this procedure only for an exact reviewed route whose `LOCATION_UPDATED`
coordinates fall outside its route-local tracking window. The window begins at
00:00 on the local calendar date of the first `ROUTE_STARTED` event and ends at
00:00 two calendar days later in the resolved route timezone. If no start event
exists, `planDate` is the fallback anchor. Eligibility is based on `occurredAt`,
so a delayed upload received later remains eligible when its actual occurrence
time is inside the window.

The command never deletes event rows. Apply mode clears only `latitude`,
`longitude`, and `payload` on the reviewed out-of-window `LOCATION_UPDATED`
rows. It retains event IDs, `clientEventId`, timestamps, tenant/route links, and
event type. Other driver event types are never candidates.

## Dry-run

Create the backup directory outside the repository and restrict it before use.
The backup contains original coordinates and payloads and must be treated as
private production data.

On the production host, run the exact deployed API image as a resource-bounded
one-off container. Do not run the scan inside the serving API container.

```bash
sudo install -d -m 0700 /srv/clever-route-server/private/route-tracking-redaction
tracking_container=clever-route-clever-route-api-1
tracking_image="$(docker inspect --format '{{.Image}}' "$tracking_container")"
tracking_backup_dir=/srv/clever-route-server/private/route-tracking-redaction
docker run --rm --network clever-route_default --cpus=1 --memory=3g \
  --pids-limit=64 --read-only --tmpfs /tmp --user 0:0 \
  --env-file <(docker inspect --format '{{json .Config.Env}}' "$tracking_container" | jq -r '.[]') \
  --mount "type=bind,source=$tracking_backup_dir,target=/private" \
  --entrypoint node "$tracking_image" /app/dist/scripts/redact-route-tracking-outside-window.js \
  --app-id clever-route-kfood \
  --shop-domain 7hrud1-xq.myshopify.com \
  --route-plan-id ROUTE_UUID \
  --backup-file /private/ROUTE_UUID.json
```

Dry-run uses exclusive file creation with mode `0600`; it fails if the path
already exists. Review the reported route, window, candidate count, candidate
digest, backup path, and backup SHA-256. Do not print or copy backup contents to
logs.

## Apply

Use the exact backup SHA-256 and candidate digest emitted by the reviewed
dry-run:

```bash
docker run --rm --network clever-route_default --cpus=1 --memory=3g \
  --pids-limit=64 --read-only --tmpfs /tmp --user 0:0 \
  --env-file <(docker inspect --format '{{json .Config.Env}}' "$tracking_container" | jq -r '.[]') \
  --mount "type=bind,source=$tracking_backup_dir,target=/private" \
  --entrypoint node "$tracking_image" /app/dist/scripts/redact-route-tracking-outside-window.js \
  --app-id clever-route-kfood \
  --shop-domain 7hrud1-xq.myshopify.com \
  --route-plan-id ROUTE_UUID \
  --backup-file /private/ROUTE_UUID.json \
  --backup-sha256 REVIEWED_BACKUP_SHA256 \
  --candidate-digest REVIEWED_CANDIDATE_DIGEST \
  --apply
```

Apply locks and revalidates the route identity, route state, timezone window,
and exact candidate set. It then rebuilds eligible geometry, clears stale road
matching, and queues one bounded road-match job. OSRM is not called inside the
transaction. If no eligible coordinates remain, the derived tracking row and
job are removed. Repeating the same reviewed apply after a successful
redaction repairs derived state if necessary without rewriting the tombstones.
The database transaction has a five-minute ceiling to accommodate large
reviewed routes; its route row and advisory locks remain held for that bounded
period, so run it only as a single historical maintenance operation.

Keep the backup until post-apply geometry and map verification are complete.

## Reviewed restore

Restore uses the same reviewed source backup, SHA-256, identity, event-window
anchor, and candidate digest. It requires a new exclusive private backup path
for the current tombstones and derived state:

```bash
docker run --rm --network clever-route_default --cpus=1 --memory=3g \
  --pids-limit=64 --read-only --tmpfs /tmp --user 0:0 \
  --env-file <(docker inspect --format '{{json .Config.Env}}' "$tracking_container" | jq -r '.[]') \
  --mount "type=bind,source=$tracking_backup_dir,target=/private" \
  --entrypoint node "$tracking_image" /app/dist/scripts/redact-route-tracking-outside-window.js \
  --app-id clever-route-kfood \
  --shop-domain 7hrud1-xq.myshopify.com \
  --route-plan-id ROUTE_UUID \
  --backup-file /private/ROUTE_UUID.json \
  --backup-sha256 REVIEWED_BACKUP_SHA256 \
  --candidate-digest REVIEWED_CANDIDATE_DIGEST \
  --pre-restore-backup-file /private/ROUTE_UUID.pre-restore.json \
  --restore
```

Restore refuses rows whose retained metadata changed or whose coordinate and
payload tombstones are no longer intact. It restores only the reviewed
`LOCATION_UPDATED` fields, then rebuilds derived geometry under the current
date-window rule, clears stale road matching, and queues one bounded job. It
does not reapply the old out-of-window derived geometry from the source backup.
