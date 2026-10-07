# Driver destination completion result contract

`POST /driver/destinations/complete/result` confirms the result of one prior destination-completion request.

## Authentication

- The endpoint accepts a Driver account JWT.
- The account and token version must be active.
- A route JWT is not valid for this endpoint.
- The lookup does not use current route or destination access.

## Result authority

The request must repeat the original values:

- `routePlanId`
- base `clientEventId`
- `destinationId`
- ordered `deliveryStopIds`
- `occurredAt`

Each new destination-completion event stores the authenticated account ID in the nullable `DriverEvent.completionOwnerAccountId` column. This server-owned column is the actor authority. A client payload cannot set this column.

The endpoint returns `APPLIED` only when all expected `STOP_DELIVERED` events have:

- the authenticated account ID in `completionOwnerAccountId`
- the expected route, stop, event ID, event type, and occurrence time
- the exact original completion fingerprint in the stored payload

The response contains the original result fields only. It does not contain current route, destination, or stop state.

## Unknown results

The endpoint returns only `{ "status": "UNKNOWN" }` when any event is missing or conflicts.

Legacy events have a null owner column. They remain `UNKNOWN`, even if their client-controlled JSON payload contains a matching owner value. The migration does not backfill the owner column. A duplicate retry does not promote a null owner column.

A duplicate write succeeds only when the stored owner column and the complete original fingerprint match. A reused client event ID with a different owner, time, destination, stop list, base client event ID, or route returns an untagged conflict. This rule also applies after a unique-constraint race.

A partial sequential completion also remains `UNKNOWN`. The server does not claim `NOT_APPLIED` after any stop event can have committed.

## Definitive rejection

The completion write endpoint adds `completionOutcome: "NOT_APPLIED"` only for a rejection that is known to happen before any event commits. This includes handler validation and a first-stop business-validation rollback.

Errors after a prior stop commit, post-commit work, or an uncertain transaction outcome do not include this field.
