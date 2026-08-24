# Driver route completion invariant rollout

`DRIVER_ROUTE_COMPLETION_INVARIANT_MODE` is a fail-closed startup setting with three values. A missing value is `OBSERVE`; any other value stops application startup.

| Mode | Legacy clients | Receipt-aware contract v2 |
| --- | --- | --- |
| `OBSERVE` | Permit and record `wouldReject` | Permit and record `wouldReject` |
| `GUARDED` | Permit and record `wouldReject` | Reject incomplete completion |
| `FULL` | Reject incomplete completion | Reject incomplete completion |

An incomplete `ROUTE_COMPLETED` rejection returns HTTP 409 with code `ROUTE_COMPLETION_INCOMPLETE`, leaves the route `IN_PROGRESS`, and records only mode, contract/adoption state, and stop counts. Contract-v2 attempts converge durably to a non-retryable `REJECTED` receipt in the same evidence transaction. The rejected state-transition transaction never contains the review evidence, so rollback cannot erase the decision.

Zero-stop routes are valid. Terminal stop statuses are `CANCELLED`, `DELIVERED`, `FAILED`, and `SKIPPED`.

## Read-only rollout evidence

Run from `apps/delivery-api` with production read-only database credentials:

```bash
npm run driver:route-completion-invariant:report -- --since 2026-08-18T00:00:00Z
```

The JSON contains only counts, mode totals, receipt-aware adoption percentage, would-reject/reject totals, and operator review totals. It emits no shop, route, driver, order, customer, address, phone, or event identifiers.

Before `GUARDED`, require at least 95% receipt-aware adoption, seven consecutive reviewed days with zero confirmed false positives, an exact-main successful CI SHA, and a rehearsed environment restore. Before `FULL`, also require legacy-client retirement evidence. Unreviewed `wouldReject` rows are not zero-false-positive evidence.

## Manual change and rollback

Use the manual `Route completion invariant mode` workflow only from `main`. Supply the exact successful main SHA already deployed and the target mode. The workflow verifies exact main and exact-SHA CI, then the host verifies its current image SHA before changing the runtime env.

The host backs up `apps/delivery-api/.env`, recreates only `clever-route-api`, verifies `/healthz` and the container environment, and automatically restores the backup and recreates the service if any validation fails. Returning to `OBSERVE` uses the same workflow. This workflow does not run migrations and must not be used to deploy a new image.
