# Original route GPS observations

Source contract for server issue #462 / change-control #302. This contract is a
proposed additive administrator read; source/tests and a draft PR do not prove
the endpoint has been published or deployed. Frontend work is separately owned
by `EVNSolution/shopify-clever#297` / change-control #300.

`GET /admin/route-plans/:routePlanId/tracking/original-observations`
uses the existing administrator bearer session. Optional `X-Clever-App-Id` is
checked by that verifier. Tenant/app identity comes only from the verified
session. A foreign or missing route yields the same `404 NOT_FOUND`.

Required query fields are `from` and `to`: valid UTC ISO timestamps ending in
`Z`, with zero to six fractional digits. The window is `[from,to)`, with a
maximum span of 24 hours. `limit` is an integer 1..500, default 200. `cursor`
is optional. Unknown or repeated query fields are rejected. No driver, tenant,
quality filter, descending-order, export, or whole-history option exists.

## Response

The precise machine contract is `openapi.yaml`, schemas
`OriginalObservation` and `OriginalObservationsEnvelope`.

```json
{
  "data": {
    "schemaVersion": 1,
    "routePlanId": "10000000-0000-4000-8000-000000000001",
    "source": "DRIVER_EVENT_LOCATION_UPDATED",
    "scope": "CURRENT_ASSIGNMENT",
    "window": {"from": "2026-09-01T00:00:00.000000Z", "to": "2026-09-02T00:00:00.000000Z"},
    "observations": [],
    "page": {
      "limit": 200, "returned": 0, "hasMore": false, "nextCursor": null,
      "totalReturned": 0, "pointCap": 5000, "capReached": false,
      "snapshotAt": "2026-09-03T00:00:00.123456Z"
    },
    "emptyReason": "NO_OBSERVATIONS"
  },
  "error": null
}
```

Each observation carries `eventId`, `observedAt` (persisted `occurredAt`),
`storedAt` (persisted `createdAt`), nullable `latitude`, `longitude` and
`accuracyMeters`, plus `coordinateStatus`, `accuracyStatus` and nullable
`clientEventKey`. Both timestamps retain PostgreSQL microsecond precision.
Storage time is not substituted for observation time. Persisted observation
time is client supplied at collection, not an independently verified sensor clock.

The two statuses are `VALID`, `MISSING`, `INVALID`, or `REDACTED`. Missing or
malformed accuracy is never represented as zero. A numeric zero is valid.
Only finite nonnegative JSON numbers are accepted as accuracy, with no
coercion, rounding, interpolation, filtering or inferred accuracy. Read priority
is `accuracyMeters`, then `accuracy`, then `location.accuracyMeters`, skipping
JSON nulls; a malformed present value remains invalid even if a lower-priority
field looks valid. Missing coordinates stay null; out-of-range coordinates
become null with `INVALID`. Valid coordinate decimal precision is retained.
Redacted records/tombstones return null coordinates/accuracy/client key and
`REDACTED`; payload coordinates never restore redacted table columns.

## Provenance and scope

The sole source is committed `DriverEvent` records of type `LOCATION_UPDATED`.
No simplified `recentPositions`, `recordedPath`, matched route, geometry cache,
reconstructed point, transport attempt or backfill participates. This is a
view of retained event facts, not a guarantee that every sensor fix was collected.

The current route driver and assignment generation are enforced within a
repeatable-read transaction. Prior-driver events and prior-generation events
are excluded. Legacy null generations are allowed only on generation 1;
unknown legacy generations on reassigned routes are excluded rather than
claimed to belong to the current assignment. An unassigned route returns
`NO_ASSIGNED_DRIVER`; otherwise an empty page returns `NO_OBSERVATIONS`.
No driver identity is returned. This scope can legitimately omit historical
points after reassignment and must be visible in the viewer.

`eventId` identifies the committed record. Distinct records with equal time or
coordinates remain distinct observations; no read-time deduplication occurs.
The existing writer deduplicates transport retries where identity is available;
this read cannot infer retry counts or unrecorded duplicates. `clientEventKey`
is an app/tenant/route-scoped HMAC of the client event ID. It permits comparison
without returning the raw ID, device identifiers, driver identity or arbitrary
payload fields. It is null when absent or redacted and changes after secret
rotation. No event payload, name, phone, email, address, device/session ID,
transport request ID, source file or provider metadata is returned.

## Pagination and resource bounds

Ordering is ascending `(occurredAt, createdAt, id)` using native PostgreSQL
timestamp/UUID comparisons. The next cursor seeks strictly after that tuple,
without OFFSET. Replay with exactly the same window and limit. Equivalent
UTC fractional spellings normalize to six digits. Cursors are signed with
domain-separated HMAC using the existing app credential. They bind the app,
tenant, route, current assignment, window, limit, storage cutoff, seek tuple,
and cumulative count. Expiry is 15 minutes from the first page, without renewal.
Clients must treat cursors as opaque transient state and restart on expiry,
secret rotation, or assignment change.

`snapshotAt` is a fixed server storage-time cutoff for the traversal; subsequent
late-stored observations are excluded. Each page has a consistent database
snapshot. This is not a database snapshot retained across requests: concurrent
retention/redaction or a long transaction committing a pre-cutoff `createdAt`
may change later reads. The endpoint never restores deleted or redacted facts.

One page reads at most `min(limit, 5000-totalReturned)+1` rows. The extra row
only determines continuation. At 5000 returned records, `capReached:true`
means an additional row exists; `hasMore:false` and `nextCursor:null` stop
traversal. It is not a total count and must not be shown as the full raw count.
Exactly 5000 with no extra row is complete and has `capReached:false`.

The event query includes shop, route, driver, assignment, event type, a bounded
observation window and storage cutoff. It uses the existing
`[shopId, routePlanId, occurredAt]` index; no schema migration is required.
LIMIT bounds returned rows, not necessarily all rows examined or tie-break
sort work. Each SQL statement has a three-second timeout; the transaction has
a five-second timeout and three-second pool wait. Large cohorts can return
`READ_TIMEOUT`, and clients should request a smaller window. There is no
COUNT, OFFSET, unbounded recovery loop, production query dump or external GPS
transmission. Requests remain within the already-authorized app/tenant.

## Errors and privacy

Errors use `{data:null,error:{code,message}}` without echoing query values.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | INVALID_QUERY | Invalid route UUID, time window, limit, unknown/repeated field. |
| 400 | INVALID_CURSOR | Malformed, modified, wrong-scope/window/limit, expired cursor. |
| 401 | UNAUTHORIZED | Missing/invalid existing administrator session or app mismatch. |
| 404 | NOT_FOUND | Missing route or route outside the verified tenant/app. |
| 409 | ASSIGNMENT_CHANGED | Cursor's assignment no longer current; restart. |
| 500 | INTERNAL_SERVER_ERROR / DELIVERY_SCHEMA_NOT_READY | Existing global unexpected-error/storage-schema handler. |
| 501 | NOT_IMPLEMENTED | Original-observation dependency absent in that runtime. |
| 503 | READ_TIMEOUT | Database/pool read timed out; narrow the window. |

Responses include `Cache-Control:no-store`. Request logs redact the entire
new route identifier and query, including the cursor. The access event records
only allowed/not-found outcome and returned count, with normal request
correlation. It contains no observation fields. Dedicated persisted location
access/usage audit tables are absent in this runtime; this change does not
claim that operational logs satisfy that broader compliance follow-up.

## Service-owner proposal and rollout

Owner: `clever-delivery-server`, repository `EVNSolution/clever-route-server`,
deployable `apps/delivery-api`. Keep the detailed contract in this owner
repository; add a link from `admin-route-plans.md`. Per the actual context
`doc-governance.md`, context-monorepo update is `not-needed`: this additive
runtime contract changes no global rules, shared terms, template registry or
authority pointers. No context repository or existing task worktree is edited.

This endpoint does not require batch ingest cc301 or any mobile change. After
separate merge/deploy authorization, deploy the backward-compatible server
first and verify an authenticated synthetic/non-PII empty result. Then publish
the separately owned frontend integration. Before server availability, the
viewer must retain explicit unavailable handling. No migration, backfill,
export, production dump, collection-policy change or production action is part
of this PR. Reverting this additive route/read dependency restores the previous
administrator surface; existing driver POST/auth/validation/schema and existing
tracking responses remain unchanged.

Validation: new unit/route tests and the guarded
`bash apps/delivery-api/scripts/test-original-observations-db.sh`. That script
creates its own random-port loopback PostgreSQL container, applies the existing
migrations only there, tests the actual schema using a read-only database role,
and removes only its owned container. The CI disposable stage invokes it after
the existing lane. Synthetic fixtures cover tenant/app denial, missing route,
microsecond keyset paging/replay, quality/redaction, equal fixes, current
assignment, storage cutoff and the 5000-record cap.
