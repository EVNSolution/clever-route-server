# Ordered driver-event contract v2

Contract v2 is additive. Requests without `driverContractVersion`, including Driver 1.1.6, retain the legacy behavior. New ordered workflow events (`ROUTE_STARTED`, `ROUTE_PAUSED`, `ROUTE_COMPLETED`, pickup/stop and acknowledgement events) send:

```json
{
  "driverContractVersion": 2,
  "clientEventId": "stable-client-generated-id",
  "expectedRouteVersionId": "uuid-from-route-access",
  "assignmentGeneration": "7",
  "appVersion": "1.2.0",
  "versionCode": 120
}
```

`assignmentGeneration` is a canonical base-10 string in `1..9223372036854775807`; clients must not convert it to a JavaScript number. Route-access lookup projects it with `expectedRouteVersionId` and `driverContractVersion: 2`. The server locks `route_plans` with `FOR UPDATE`, then compares both fields before applying an ordered transition.

Stable failures are:

- `409 ROUTE_VERSION_MISMATCH` — refresh the assigned route and reconcile pending evidence.
- `409 ROUTE_ASSIGNMENT_CHANGED` — do not replay automatically; the account must refresh assignment.
- `503 DRIVER_EVENT_ADMISSION_UNAVAILABLE` — no business transition was applied; retry with bounded backoff.

Every authenticated v2 ordered attempt is admitted to `driver_event_attempts` before wire or business validation. Malformed fields are stored as null rather than copied as raw input, then rejected with a stable stage/code. The row contains only identifiers, versions, timestamps, stable codes, and retry state. It never contains bearer tokens, addresses, customers, notes, proof media, request payloads, or free-form errors. `attemptNumber` starts at 1 for each `(driverId, clientEventId)` lineage; the unique database contract plus request-id idempotency makes concurrent retries safe.

Lifecycle states are `ACCEPTED`, `APPLIED`, `DUPLICATE`, `REJECTED`, and `FAILED`. Default retention is 90 days (`DRIVER_EVENT_ATTEMPT_RETENTION_DAYS`). `npm run driver:event-attempts:cleanup` deletes only expired resolved evidence (`APPLIED`, `DUPLICATE`, `REJECTED`); unresolved `ACCEPTED` and reconciliation-needed `FAILED` rows are preserved.

## Completion recovery

Use an active account token, not the short-lived route token:

```text
GET /driver/event-receipts/:routePlanId/:clientEventId
Authorization: Bearer <driver-account-token>
```

The response is `APPLIED`, `REJECTED`, or `UNKNOWN`. Resolution always checks committed `DriverEvent` first. Therefore a process crash after business commit but before the attempt-row update still returns `APPLIED`. Only a durable non-retryable attempt returns `REJECTED`; failed or accepted-only evidence returns `UNKNOWN`.

Canonical cross-repository fixtures live in `tests/contract-fixtures/route-operations/v1`. Consumers must verify `sha256-manifest.json` with `npm run driver:event-contract:verify` (or the same script pointed at a copied contract root) before running their own adapter tests.

## External logs

Contract failures emit `driver_event_contract_failure`; lifecycle counters emit `driver_event_contract_metric` with `accepted`, `applied`, `duplicate`, `rejected`, or `failed` and a stable failure stage. Payloads and exception text are deliberately excluded. Production Compose ships stdout through the `awslogs` driver to a stable log group; `scripts/configure-driver-event-cloudwatch.sh` owns 90-day retention, metric filters, and the failed-event alarm. Production application remains the G009 rollout responsibility; see `docs/observability/driver-event-contract-cloudwatch.md`.
