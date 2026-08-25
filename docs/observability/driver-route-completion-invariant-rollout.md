# Driver route completion invariant rollout

`DRIVER_ROUTE_COMPLETION_INVARIANT_MODE` is a fail-closed startup setting with three values. A missing value is `OBSERVE`; any other value stops application startup.

| Mode | Legacy clients | Receipt-aware contract v2 |
| --- | --- | --- |
| `OBSERVE` | Permit and record `wouldReject` | Permit and record `wouldReject` |
| `GUARDED` | Permit and record `wouldReject` | Reject incomplete completion |
| `FULL` | Reject incomplete completion | Reject incomplete completion |

An incomplete `ROUTE_COMPLETED` rejection returns HTTP 409 with code `ROUTE_COMPLETION_INCOMPLETE`, leaves the route `IN_PROGRESS`, and records only mode, contract/adoption state, and stop counts. The invariant reads membership from the immutable current route-version snapshot, not mutable `route_plan_stops`. Contract-v2 attempts converge to non-retryable `REJECTED` in the same transaction that appends the review; the repository returns the committed decision and throws 409 only after commit. A database fault rolls back both changes and leaves a recoverable failed attempt, never a rejected receipt without matching review evidence.

Zero-stop routes are valid. Terminal stop statuses are `CANCELLED`, `DELIVERED`, `FAILED`, and `SKIPPED`.

## Read-only rollout evidence

Run from `apps/delivery-api` with production read-only database credentials:

```bash
npm run driver:route-completion-invariant:report -- --source-sha <exact-deployed-main-sha> --since 2026-08-18T00:00:00Z
```

The JSON contains only counts, the current mode/SHA, the latest unexpired sync session for each active in-progress driver/route pair, daily review continuity, the raw percentage of receipt-aware completion attempts resolved within five minutes, would-reject/reject totals, and operator review totals. A missing contract version is legacy. It emits no shop, route, driver, order, customer, address, phone, or event identifiers. Unreviewed cases are available through the authenticated shop-scoped GET endpoint and decisions are written through its PATCH endpoint as `CONFIRMED_CORRECT` or `FALSE_POSITIVE`, with server-derived actor, source, note, `reviewedAt`, and append-only history. A later assessment never hides an earlier false-positive assessment from the rollout gate.

Before `GUARDED`, require at least 95% receipt-aware adoption, seven fully closed UTC days with at least one eligible sample per day, zero historical false positives, zero unreviewed would-rejects, at least one receipt recovery cohort with 99.5% resolved within five minutes, an exact-main successful CI SHA, and a rehearsed environment restore. Before `FULL`, also require legacy-client retirement evidence. Empty or partial days are never clean evidence.

Review evidence is retained for at least 365 days (`DRIVER_ROUTE_COMPLETION_REVIEW_RETENTION_DAYS`). The normal retention job deletes only reviewed rows after `retainedUntil`; unreviewed rows remain until audit closure. Every assessment also appends its outcome/source/time to a PII-free global gate ledger with no shop, route, or review foreign key, so tenant erasure or parent cleanup cannot hide a false positive during the retention window. Route-plan deletion cannot cascade review rows because the route identifier is retained as audit data rather than a route foreign key.

## Manual change and rollback

First run the manual `Route completion invariant evidence` workflow against the exact deployed main SHA. It acquires the shared deploy lock, records the live repository digest and image ID, verifies the OCI revision and capability-v1 labels plus `/healthz`, then executes only the read-only report. Run `Route completion alarm canary` at the same SHA; it changes both alarm states with unique correlation tokens and accepts only subscriber-side delivery receipts. Then run `Route completion invariant mode` with both artifact IDs. The workflow verifies both artifact runs succeeded at the exact SHA, validates freshness, and rechecks the live digest/image ID immediately before changing mode, preventing reuse after a same-SHA rebuild. Direct `OBSERVE` to `FULL` transitions are rejected. `FULL` additionally requires current `GUARDED` and zero active legacy sessions.

For `GUARDED` or `FULL`, both alarms must exactly match the approved namespace, metric, Sum statistic, threshold, period, evaluation count, missing-data policy, and the single approved SNS action; additional alarm actions fail the gate. A confirmed subscription alone is insufficient: the fresh exact-SHA canary artifact must contain successful subscriber receipts for both alarm paths. The host acquires the same `.deploy/route-ops-simple-deploy.lock.d` used by normal deploys, verifies exact current mode, image digest/ID/SHA/capability, backs up `apps/delivery-api/.env`, recreates only `clever-route-api`, retries `/healthz`, and automatically restores the backup with the same health retry if validation fails. Standard deploys while mode is elevated also reject candidate or rollback images without capability v1. An emergency return from `GUARDED` or `FULL` to `OBSERVE` deliberately does not depend on a current-main CI run or rollout-evidence artifact: it requires the separate emergency actor allowlist and verifies the supplied deployed revision plus the live container image ID, repository digest, capability, and elevated current mode under the shared lock. This workflow does not run migrations and must not be used to deploy a new image.

While a child route is `IN_PROGRESS`, public route-plan stop replacement, route/group hard deletion, current-child archival/regeneration/rollback, and active-removal acknowledgement all fail closed before membership changes. Membership changes must instead use the immutable archive-and-successor transaction so completion decisions cannot observe a stale CURRENT snapshot.
