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

The JSON contains only counts, the current mode/SHA, the latest unexpired sync session for each active in-progress driver/route pair, daily review continuity, the percentage of receipt-aware completion attempts resolved within five minutes, would-reject/reject totals, and operator review totals. It emits no shop, route, driver, order, customer, address, phone, or event identifiers. Unreviewed cases are available through the authenticated shop-scoped GET endpoint and decisions are written through its PATCH endpoint as `CONFIRMED_CORRECT` or `FALSE_POSITIVE`, with server-derived actor, source, note, `reviewedAt`, and append-only history. A later assessment never hides an earlier false-positive assessment from the rollout gate.

Before `GUARDED`, require at least 95% receipt-aware adoption, seven fully closed UTC days with at least one eligible sample per day, zero historical false positives, zero unreviewed would-rejects, at least one receipt recovery cohort with 99.5% resolved within five minutes, an exact-main successful CI SHA, and a rehearsed environment restore. Before `FULL`, also require legacy-client retirement evidence. Empty or partial days are never clean evidence.

Review evidence is retained for at least 365 days (`DRIVER_ROUTE_COMPLETION_REVIEW_RETENTION_DAYS`). The normal retention job deletes only reviewed rows after `retainedUntil`; unreviewed rows remain until audit closure, and their append-only history is deleted only with the reviewed parent after retention expires. Route-plan deletion cannot cascade these review rows because the route identifier is retained as audit data rather than a route foreign key.

## Manual change and rollback

First run the manual `Route completion invariant evidence` workflow against the exact deployed main SHA. It acquires the shared deploy lock, verifies the running container image reference, local image ID, OCI revision label, and `/healthz` before executing only the read-only report and uploading the named JSON artifact. Then run `Route completion invariant mode` with that artifact ID. The workflow verifies the artifact run succeeded at the exact SHA, validates its embedded SHA/current mode and freshness, and rejects direct `OBSERVE` to `FULL` transitions. `FULL` additionally requires current `GUARDED` and zero active legacy sessions.

For `GUARDED` or `FULL`, both the all-mode would-reject alarm and the actual rejection alarm must have actions enabled, include the approved SNS topic, and that topic must have at least one confirmed subscription. The host acquires the same `.deploy/route-ops-simple-deploy.lock.d` used by normal deploys, verifies exact current mode and image SHA, backs up `apps/delivery-api/.env`, recreates only `clever-route-api`, retries `/healthz`, and automatically restores the backup with the same health retry if validation fails. Returning to `OBSERVE` uses the same workflow. This workflow does not run migrations and must not be used to deploy a new image.
