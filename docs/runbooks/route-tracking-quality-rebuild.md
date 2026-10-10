# Route tracking quality rebuild

This runbook rebuilds one route's derived `route_tracking_geometries` row from its
immutable `LOCATION_UPDATED` source events and refreshes its OSRM road-match cache.
It does not update driver events, route or stop status, Shopify data, or completion
state.

The command is a dry-run unless `--apply` is present. Apply requires the plan hash
and a mode-`0600` backup produced by a reviewed dry-run. The apply transaction takes
the same route advisory lock as live ingestion, rechecks tenant and route state, and
requires the reviewed GPS source to remain unchanged. An appended GPS tail requires
a new dry-run.
OSRM calls happen before that transaction.

## Continuous policy (route tracking, since 2026-10-11)

The office decided that a route's tracking path must be continuous and that a
plain connector is better than a gap ("경로가 끊기면 안 된다", change control
#344). The `bounded-per-leg` provider therefore works like this; the
`legacy-whole-match` provider used by UVIS vehicle trails is unchanged.

- The OSRM match request is sent with `tidy=false` and a per-sample search
  radius of at least 25 m (still capped at 200 m). With the phone accuracy
  (3-4 m) as radius OSRM returned null tracepoints for 25-60 % of the points.
- OSRM's whole-trace `confidence` is recorded but does not gate a leg. It is a
  length ratio over the whole trace and falls on long delivery traces with
  stops; a leg is accepted on its own distance, speed and snap checks.
- Consecutive non-null tracepoints of one matching are paired even across null
  tracepoints. Every skipped fix must lie inside a corridor around the leg
  (60 m plus its accuracy, at most 160 m); such a leg is level 1 with reason
  `NO_MATCH`, or `LOW_ACCURACY` when a skipped fix is above 100 m.
- A fix above 200 m, or a single implausible spike (> 55 m/s), is left out so
  its neighbours can still be joined; real gaps (> 180 s, another driver,
  outside coverage) still split the trace. Missing accuracy is treated as 25 m
  and can only reach level 1.
- The road-distance cap per leg is 2,500 m.
- After the existing supplements, every span still left between two accepted
  lines of the same driver gets one bounded OSRM route bridge: at most 20
  minutes and 10 km straight, road distance at most 2.2 x straight + 200 m
  (15 km), average speed at most 45 m/s, the fastest road even when a similar
  alternative exists. Level 1 with reason `GPS_GAP`, `LOW_ACCURACY` or
  `NO_MATCH`.
- What even the bridge cannot join is drawn by the office map as a plain
  connector through the recorded fixes (shopify-clever#374). Inferred and
  connector geometry is still never completion evidence.

Existing caches are not refreshed by the deploy; re-queue the routes you want
recomputed (`enqueueRouteTrackingRoadMatch` per route; no schema change).

## Interpolation levels

Quality policy v4 with cache schema v5 preserves the recorded GPS order and
classifies derived road legs internally. It never runs VROOM visit-order
optimization on the GPS trace. The cache schema changed so existing v4 results
are recomputed by the durable worker; the API remains `gps_quality.v4` for the
deployed client contract. The rows below describe the conservative rules that
still apply to the raw-evidence rebuild passes and to the legacy provider; the
continuous policy above overrides the confidence gates for route tracking.

| Level | Meaning | Map behavior |
| --- | --- | --- |
| 0 | Accepted road matching, GPS accuracy up to 100 m, confidence at least 0.5, and no soft uncertainty | Show road geometry |
| 1 | Accepted matching up to 200 m accuracy, constrained soft uncertainty with confidence at least 0.8, or a bounded road supplement | Show road geometry in the same GPS color |
| 2 | Rejected, ambiguous, missing, or implausible evidence | Leave the path disconnected |

The 200 m limit is an initial inference ceiling, not a statement that every point
below it is reliable. Actual acquisition gaps, driver changes, invalid/reversed
time, implausible speed, and unsupported road transitions remain disqualifiers.
Short supplements additionally require reliable anchors (at most 50 m accuracy),
at most 120 seconds and 750 m between endpoints, and the road distance, duration,
and ambiguity checks. Interior observations must constrain the road geometry;
do not replace an observed trace with an unconstrained endpoint route.

Each accepted leg requires explicit OSRM tracepoint-to-leg mapping, continuous
step geometry, valid time order, and bounded road distance and displacement.
OSRM radiuses express GPS standard deviation; point-local alternatives and nominal
road duration are not independent proof that a matching is wrong. Local alternatives,
displacement beyond the reported accuracy, and nominal travel-time disagreement
may qualify only for Level 1 with matching confidence at least 0.8. The hard
displacement and observed-speed checks account for a bounded three-sigma endpoint
error envelope; they never excuse missing source/matching metadata or an actual gap.
These cutoffs are initial product policy, not guarantees supplied by OSRM.
Ordinary rejected legs cannot be promoted by a later supplement pass. The one
exception is a short interval rejected solely because OSRM returned null
tracepoints: both adjacent Level 0 road anchors must remain unchanged, every
intervening source edge must be explicitly classified as null-tracepoint-only,
and every raw GPS source index must be examined. This exception is enabled only
for a guarded historical rebuild that supplies the original event sequence;
the normal background worker does not run this observed-null rescue pass.
The rebuild can examine points removed by geometry simplification. The same driver,
reliable timestamps and accuracy, a unique bounded OSRM road
candidate, and monotonic support from every observation are also required.
Matching-index boundaries, malformed tracepoint metadata, filtered-out raw
fixes, or any competing rejection cause leave the path disconnected. This
adds Level 1 inferred road geometry; it never rewrites an accepted match or
the recorded GPS events. Repeated arrival coordinates are valid zero-length
steps; genuine closed turns must be preserved rather than treated as malformed
paths.

Cache v5 adds a separate contextual supplement for spans that the normal matcher
cannot ingest because interior accuracy is above 200 m. It requires confident
anchors on both sides, at least two chronological interior observations, one
driver, no acquisition gap, known accuracy at most 400 m, at most 10 minutes and
3 km between anchors, a unique OSRM route candidate, and monotonic projection of
every observation inside its bounded accuracy corridor. Per-sample projected
speed still has the hard 55 m/s ceiling. A competing route of similar cost, an
off-corridor observation, reversed progress, or any existing rejected OSRM leg
keeps the span disconnected. This is additional evidence validation, not a wider
acceptance threshold for normal v4 matching.

Historical routes with no recorded GPS accuracy remain disconnected by default.
For an exact, reviewed route only, `--allow-unmeasured-accuracy-inference` can
promote individual OSRM legs to Level 1 when both endpoints lack accuracy,
matching confidence is at least 0.95, neither endpoint has an alternative,
each road snap is within 12 m, and the leg is at most 250 m and 30 seconds with
road speed at most 25 m/s. The existing time-order, driver, detour, and road
duration checks still apply. This opt-in does not invent a GPS accuracy value,
does not create Level 0 observed geometry, and is not enabled in the normal
background worker. OSRM confidence alone is not proof of the driven road.
The opt-in pilot applies only when the current road cache has no accepted or
inferred lines and the proposed rebuild adds at least one inferred line. Both
dry-run and the locked apply transaction enforce this rule, so the pilot cannot
replace an already recovered road path or publish a zero-gain candidate.

For routes with an existing road cache, `--preserve-existing-road-cache` is the
explicit historical rebuild mode. It retains each existing Level 0 and Level 1
line in full, and adds only new accepted or inferred lines whose source edges do
not overlap an existing trusted line. Sharing an endpoint is allowed. It does
not cut an existing line to fit a new OSRM result. Invalid source ranges, a
coverage or source-version mismatch, or a changed derived cache aborts the
operation. A route with no safe new line may correctly remain unchanged. This
mode must not be combined with the unmeasured-accuracy pilot.

Source semantics: [OSRM v26.5 Match API](https://github.com/Project-OSRM/osrm-backend/blob/v26.5.0/docs/http.md#match-service).

V4 clients display only accepted `matchedGeometry` and `inferredGeometry`.
`uncertainGeometry` and unmatched ranges remain diagnostic evidence; clients must
not reconnect them with raw GPS lines or a live-tail fallback. An entirely rejected
trace must keep a v4 result with zero accepted geometry so it cannot accidentally
fall back to an unqualified raw path. Current-position markers remain independent.
Deploy the compatible client before publishing v4 caches.

Background tracking matching has a separate bounded 30-second request budget.
Planned-route requests and existing vehicle-telemetry consumers keep their own
policies and timeouts. For a manual historical rebuild, pass
`docker exec -e OSRM_TIMEOUT_MS=30000 ...` to the command process; do not change the
shared production routing environment. South replay included valid requests over
10 seconds, so a routing-oriented 10-second budget can prevent a complete cache
refresh even when its geometry is valid.

## Durable background refresh

Every accepted route-tracking geometry write transaction also upserts one durable
road-match job for the latest source point count and timestamp. API snapshot reads
serve the last verified cache and never wait for OSRM. The worker claims jobs with
a database lease, limits batch size and concurrency, retries transient provider
failures with bounded exponential backoff, and recovers expired work after a
process restart. A new GPS input supersedes the claimed input version. Publication
locks the route and compares the job lease, source point count, and last input
timestamp before replacing cache fields, so an older or partial result cannot
overwrite a newer geometry. The previous verified cache remains readable while a
job is queued, processing, retrying, or rejected.

The migration queues existing geometry rows whose cache schema is older than v5
without clearing their current cache. Do not manually delete the queue or cache
rows to force a refresh. Diagnose job status and provider reachability first.
An algorithm-only release under the same cache schema does not refresh existing
v5 rows. Historical recomputation must use the guarded per-route dry-run,
backup, and apply procedure below, one route at a time with resource checks.
The preservation flag is also per-route; deploying a new image does not
automatically update existing completed or in-progress routes. Live worker
refreshes after new GPS events are separate publications, so re-audit an
in-progress route if tracking continues after a manual rebuild.

Inspect the selected service day's level counts and the actual road shapes during
replay. A larger feature count or zero acquisition gaps does not prove better
tracking. Preserve genuine turns and visits and confirm rejected intervals remain
visibly disconnected. Inferred geometry is never completion evidence.

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

For an unmeasured-accuracy pilot, add `--allow-unmeasured-accuracy-inference`
to both the dry-run and guarded apply commands. The flag requires a private
backup file, is recorded in the backup and plan hash, and cannot be used for
restore. Compare the candidate with a same-source default replay before apply;
publish only actual additional inferred lines without losing existing accepted
geometry. Keep the flag absent for other routes and all ordinary maintenance.

For an existing road cache, add `--preserve-existing-road-cache` to **both**
dry-run and apply. The reviewed backup and plan hash bind the mode and the
current derived-state hash. Check the proposed source-edge additions, not just
aggregate point or line counts. If OSRM is incomplete, a line overlaps existing
trusted source edges, or the current cache changes before apply, keep the route
unchanged and repeat the review when appropriate.

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

New GPS events that arrive after dry-run, a changed prefix, out-of-order insertion,
route or stop status change, tenant mismatch, or plan mismatch abort without a
database write. Apply
also creates a unique `*.prewrite-<timestamp>.json` snapshot inside the container
while holding the lock. Copy that reported path to the private host directory and
verify its SHA-256 immediately after apply.
With `--preserve-existing-road-cache`, the apply transaction also compares the
current derived-state hash with the reviewed backup under the same lock. A live
worker refresh or any other derived change therefore requires a new dry-run.

## Server-host batch preservation worker

Use `scripts/route-tracking-preservation-worker.sh` when every eligible K-food
historical route must be processed without moving GPS or OSRM work to an operator
machine. Run it on the production server through AWS SSM. The API container reads
the database and calls OSRM; the host script only serializes routes, verifies
hashes, and maintains private evidence. Concurrency is fixed at one.

The worker is deliberately tenant-locked to app `clever-route-kfood` and shop
`7hrud1-xq.myshopify.com`. It selects `COMPLETED` routes and `IN_PROGRESS` routes
whose route-tracking event window has already ended. A stale in-progress route is
eligible for derived GPS repair, but the worker does not synthesize completion or
change route/stop status. Status finalization requires its own audited policy.

The deployed API image must already contain the reviewed preservation flag. The
production host is not a Git checkout. Send the exact reviewed script content to
`/tmp/route-tracking-preservation-worker.sh` with the same AWS SSM Run Command
used to invoke it, set its mode to `0700`, and start or resume it on the host:

```bash
sudo env \
  TRACKING_EXECUTE=1 \
  TRACKING_APP_ID=clever-route-kfood \
  TRACKING_SHOP_DOMAIN=7hrud1-xq.myshopify.com \
  bash /tmp/route-tracking-preservation-worker.sh
```

The script discovers the running API container by its Compose service label, then
by the exact production container name. Set `TRACKING_CONTAINER=<name-or-id>` only
when that discovery is unavailable. An explicit absolute
`TRACKING_COMPOSE_FILE` is the last fallback; the worker never depends on a
relative repository path. `TRACKING_PRIVATE_DIR` may be changed only to another
directory below `/srv/clever-route-server/private/`. Do not copy this directory
to a workstation.

The worker takes a tenant-wide `flock`, creates mode-`0600` logs and per-route
files, performs a preservation dry-run, copies the reviewed backup from the
container, and verifies both SHA-256 values before apply. The preservation CLI
itself proves that at least one new non-overlapping trusted line exists. No-gain
routes receive a `.done` checkpoint only after a separate read-only state audit.
Every `.done` records the exact route/stop, event-window, source, derived-cache,
and durable-job fingerprint. A later live publish, rollback, GPS change, route
transition, or job change invalidates that checkpoint and causes a new dry-run.
Retryable or incomplete OSRM
results and known source/cache changes between review and apply are recorded as
retryable or stale and skipped for that run, so a later invocation can re-plan
them. Unexpected identity, cache-shape, backup, or apply failures stop the run.

After each apply, the worker copies and verifies the locked prewrite snapshot and
checks the raw source count, v5 cache input count and timestamp, reviewed
watermark, durable job target, lease settlement, and unchanged route/stop state.
Only then does it atomically create the route's `.done` checkpoint. A restart
skips those checkpoints and continues the remaining routes. Review progress and
results only in the root-owned private directory:

```bash
sudo find /srv/clever-route-server/private/route-tracking-preservation-worker/state \
  -maxdepth 1 -type f -name '*.done' -print
sudo sh -c \
  'tail -n 100 /srv/clever-route-server/private/route-tracking-preservation-worker/logs/*.log'
```

The logs and JSON summaries contain route IDs and aggregate counts only. Raw or
derived GPS coordinates remain inside the mode-`0600` backup files and must never
be printed, committed, or attached to a ticket.

### Interrupted apply recovery

Immediately before each apply, the worker creates a route-specific
`*.apply-pending` marker containing the reviewed plan, backup SHA-256, and
pre-apply state fingerprint. It removes this marker only after the apply output,
prewrite backup, post-audit, and fingerprinted `.done` checkpoint are durable.
On restart, a pending marker prevents both no-gain completion and another apply.
The only automatic recovery is the narrow case where a completed checkpoint
already exists and its fingerprint still matches the live server state; this is
the crash window after checkpoint creation and before marker removal.

For any other pending marker, leave it in place and inspect that route's private
reviewed backup, apply output/error, prewrite snapshot, and post-audit files. Do
not infer success from an empty output file or from a no-gain replay. If the apply
result and all post-apply invariants can be proven, record the audited live
fingerprint in the existing checkpoint before removing the pending marker. If
the outcome is ambiguous, use the reviewed backup and a complete apply result's
`plannedRoadMatchedWatermark` plus `appliedDerivedStateHash` for the guarded
restore procedure below. Remove the pending marker only after the restore and
source/cache/job audit succeed. If no mutation occurred, independently reproduce
the worker's read-only state fingerprint and require an exact match with
`preApplyStateFingerprint` before removing the marker and restarting the worker.

## Verification and rollback

1. Confirm `mutationCount` is `1`, or `0` for an already identical derived row.
2. Confirm source point count and time range cover the intended tracking session.
3. Confirm route status and every delivery-stop status are unchanged.
4. Confirm the `LOCATION_UPDATED` source-event count and reviewed-prefix digest are
   unchanged. A later GPS event requires a new dry-run before apply.
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
