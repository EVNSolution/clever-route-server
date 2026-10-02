# Driver runtime diagnostics

Server contract for CLEVER Routes app PR #293 and change control #307. The existing
`PUT /driver/sync-health` protocol and business event responses remain compatible.
This channel stores observations; it never changes route progress, deletes a
business queue, sends notifications, or infers a cause from missing signals.

## Why the server needs this channel

The previous heartbeat requires business route credentials and an active lease.
It cannot independently report a blocked authentication refresh, and its active
lease query omits expired sessions. Mobile diagnostics also require server-side
durable acceptance and event application evidence; an app-side mock cannot prove
either. Existing event idempotency is reused, with GPS attempts added to the same
evidence store.

## Authentication and HTTP protocol

- `POST /driver/sync-health/registrations`: an active driver account JWT plus
  `{schemaVersion: 1, deviceInstanceHash}` returns **top-level** `{token, expiresAt}`.
  Opaque random tokens are stored only as hashes and expire within 24 hours.
- A registration is scoped to the account and device. No arbitrary company is
  selected for an account belonging to several companies. Every non-null route
  context is checked against its assigned driver's account before its company
  and driver are derived. Completed routes may still supply replay evidence.
  Route-less records remain private to the account, outside tenant admin queries.
- `POST /driver/sync-health/diagnostics`: use the diagnostic bearer, independently
  of expired business tokens. The top-level response contains
  `acceptedDiagnosticIds`, `rejectedDiagnostics: [{diagnosticId, code}]`, and
  `serverReceivedAt`. Only committed records are acknowledged. A repeated ID with
  identical canonical payload is acknowledged again; conflicting payloads are
  permanently rejected. IDs are scoped to account and device across renewal.
- `DELETE /driver/sync-health/registrations`: an active account JWT and the same
  registration body revoke device credentials. Account status/token-version
  changes also invalidate diagnostic credentials. Invalid, expired, and revoked
  diagnostic credentials always receive **401**, which the app can recover from.
  Diagnostic tokens cannot register, revoke, read diagnostics, or call business
  APIs. Renewal requires a valid account bearer and cannot extend authentication
  indefinitely.
- Responses use `Cache-Control: no-store`. Ingestion is limited to 64 KiB and
  50 records. Per-minute IP limits are 120 for ingestion, 20 per registration or
  revocation endpoint, and 30 for admin reads; ingestion also permits at most 60
  requests per device. Limits run before contact/failure writes and IP limits
  run before credential lookup. Only versioned allowlisted fields are
  persisted. Coordinates, customer data, credentials, and arbitrary error text
  are excluded. Unknown blocker reasons are rejected, never treated as healthy.

Authenticated, rate-admitted contact is recorded before JSON parsing. Ingestion failure is
separate from acceptance. If the database itself is unavailable, the API returns
503 without an ACK; a stable log code records that failure metadata could not be
persisted. No server can guarantee durable contact metadata while its storage is
unavailable.

## Evidence and operational query

`GET /admin/drivers/runtime-diagnostics?routePlanId=<uuid>` requires the existing
admin session verifier. Company and app scope come from the verified session,
never query parameters or diagnostic payloads. The response includes scoped
device snapshots, history, server attempt evidence, and the evaluated diagnosis.
History-only routes have no synthesized live snapshot. The response exposes
truncation flags and the app-reported discarded record count so a bounded or
incomplete history cannot be mistaken for a complete audit trail.
UTC timestamps remain the wire format; display timestamps use `America/Toronto`.
The API is the server-owned operational surface. A Shopify dashboard rendering
change belongs to `clever-shopify-app`.

Contact time, client send time, snapshot observation, historical record time,
and server event receipt remain distinct. Old replay cannot replace a newer live
snapshot. Stale per-field observations, future clock skew, and a new context's
observation grace result in UNKNOWN states rather than invented failure times.
Absence means `SIGNAL_ABSENT_UNKNOWN`, not proof of app termination, network loss,
or operating-system restrictions. Classification uses versioned server constants.

Event joins require company, driver, route, and the supplied correlation IDs.
UUID-validated client `X-Request-Id` is `transportRequestId` in the event attempt table;
the server's unique `requestId` remains separate. APPLIED/DUPLICATE evidence
dominates earlier failed attempts for the same event. A client timeout alone is
not evidence of server failure, and a GPS ACK is not an ACK for a business event.

## Retention and release

Diagnostics retain bounded evidence for 30 days. The existing scheduled driver
event retention command also removes expired diagnostic records, snapshots,
credentials, and device metadata. Expired GPS attempt rows are removed regardless
of outcome; unresolved business-event retention rules remain unchanged. The additive migration keeps old binaries
compatible; the GPS attempt version constraint is widened to admit truthful
legacy version-1 evidence. Prisma explicitly maps the existing proof-media
constraint/index names found in the production backup; their definitions and
historical migrations are unchanged. This avoids unrelated naming drift during
the migration verification.

Deployment order: server migration and immutable API image; endpoint/runtime
verification; then the separately validated Routes app release. No alerting is
enabled by this server change. The app currently ignores `rejectedDiagnostics`:
before its release, it must quarantine permanent rejections so a poison record
cannot block its outbox, and invoke revocation on explicit logout. Local token
deletion alone does not revoke the server credential. Route reassignment replay
without independently verified historical ownership remains rejected rather
than trusting the payload's claimed driver.

Server tests cover authentication, tenant scope, durable/idempotent acceptance,
duplicate/conflicting replay, storage failure, stale/future observations and
server attempt classification. Database integration must use a disposable
PostgreSQL database with `DRIVER_RUNTIME_DIAGNOSTICS_DATABASE_URL` and
`DRIVER_RUNTIME_DIAGNOSTICS_DATABASE_TARGET_CLASS=safe-local-disposable`.
Source tests, real HTTP/PostgreSQL fixtures, deployed runtime, and physical-device
fault tests are separate evidence. Server deployment alone does not establish
mobile background behavior or resolve the historical South Retry incident.
