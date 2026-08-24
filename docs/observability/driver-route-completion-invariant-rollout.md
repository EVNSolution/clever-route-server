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

The JSON contains only counts, the current mode/SHA, active sync-session receipt-aware adoption from `driverContractVersion` and `lastObservedAt`, daily review continuity, five-minute receipt recovery backlog, would-reject/reject totals, and operator review totals. It emits no shop, route, driver, order, customer, address, phone, or event identifiers. Review decisions are written through the authenticated shop-scoped admin PATCH API as `CONFIRMED_CORRECT` or `FALSE_POSITIVE`, with server-derived actor, source, note, `reviewedAt`, and append-only history.

Before `GUARDED`, require at least 95% receipt-aware adoption, seven consecutive reviewed days with zero confirmed false positives, an exact-main successful CI SHA, and a rehearsed environment restore. Before `FULL`, also require legacy-client retirement evidence. Unreviewed `wouldReject` rows are not zero-false-positive evidence.

## Manual change and rollback

First run the manual `Route completion invariant evidence` workflow against the exact deployed main SHA. It executes only the read-only report in the production container and uploads the named JSON artifact. Then run `Route completion invariant mode` with that artifact ID. The workflow verifies the artifact run succeeded at the exact SHA, validates its embedded SHA/current mode and freshness, and rejects direct `OBSERVE` to `FULL` transitions. `GUARDED` requires at least 95% active-session v2 adoption, seven consecutive clean reviewed days, zero false positives, zero unreviewed would-rejects, and no receipt pending after five minutes. `FULL` additionally requires current `GUARDED` and zero active legacy sessions.

For `GUARDED` or `FULL`, the configured CloudWatch alarm must have actions enabled, include the approved SNS topic, and that topic must have at least one confirmed subscription. The host acquires the same `.deploy/route-ops-simple-deploy.lock.d` used by normal deploys, verifies exact current mode and image SHA, backs up `apps/delivery-api/.env`, recreates only `clever-route-api`, retries `/healthz`, and automatically restores the backup with the same health retry if validation fails. Returning to `OBSERVE` uses the same workflow. This workflow does not run migrations and must not be used to deploy a new image.
