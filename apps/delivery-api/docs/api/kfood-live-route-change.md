# KFood future delivery changes

This is an opt-in server contract for an already started KFood route. Shopify and
the Routes app must adopt this contract in separate releases. PR293 is independent.
The existing admin edit APIs retain their existing behavior. Do not mix those
APIs with a pending live-change draft. This contract detects external content or
assignment changes and rejects the draft instead of overwriting them.

## Boundaries

1. **Save** stores a CLEVER draft. It does not modify the published route, Shopify
   order, delivery status, arrival event, completion event, or assignment.
2. **Dispatch** validates the draft again under the route lock. It atomically
   changes future operational addresses/order and records an immutable publication
   plus a durable logical notification. Provider delivery happens after commit.
3. **Apply** is a driver action. The app fetches a publication, applies that exact
   snapshot locally, and acknowledges that publication. Reading or receiving push
   does not acknowledge the publication.

The current stop and the completed prefix remain fixed. Only future PENDING or
ASSIGNED stops can be changed. This restriction applies to the new API. It does
not introduce a policy for current-stop changes, deletion, or reassignment in the
existing admin APIs. Those policies remain a separate decision (D06).

## Identity

| Field | Meaning |
| --- | --- |
| `assignmentGeneration` | Existing canonical decimal string. Changes when the driver assignment changes. |
| `revision` / `expectedRevision` | Optimistic revision of the saved draft. Starts at 0. |
| `commandId` | Client-generated UUID retained unchanged on command retry. |
| `expectedAssignmentGeneration` | Assignment from the admin draft GET. Required for Save and Dispatch. |
| `publicationVersionId` | UUID of one immutable Dispatch publication. |
| Driver `routeVersionId` / `expectedRouteVersionId` | Latest public UUID returned through existing assigned-route/access APIs after changed Dispatch. |
| Admin `expectedRouteVersionId` | Underlying child UUID returned by draft GET. It stays fixed across these publications. |
| Applied publication | Exact publication the current driver acknowledged. |

Content identity includes stop and order IDs, operational address, coordinates,
instructions, service duration, time windows, and order. It excludes execution
status, real event timestamps, recalculated ETA, and DB update timestamps.
An address-only change produces a new publication. Unchanged repeated Dispatch
returns the existing publication and does not create another logical notification.

## Admin requests

Use the existing admin bearer authentication and `x-clever-app-id`. Tenant scope
comes from authentication. A client cannot select another tenant in the body.

- `GET /admin/route-plans/:routePlanId/live-change`: read the draft and revision.
- `PATCH /admin/route-plans/:routePlanId/live-change`: save the draft.
- `POST /admin/route-plans/:routePlanId/live-change/dispatch`: publish the draft.

Save example (IDs must be the route's actual UUIDs):

```json
{
  "commandId": "80000000-0000-4000-8000-000000000001",
  "expectedAssignmentGeneration": "2",
  "expectedRouteVersionId": "60000000-0000-4000-8000-000000000001",
  "expectedRevision": 0,
  "stopOverrides": [{
    "deliveryStopId": "70000000-0000-4000-8000-000000000007",
    "address1": "700 Example Avenue",
    "latitude": 43.7,
    "longitude": -79.4
  }]
}
```

Optional `futureStopOrder` contains each eligible future stop ID exactly once.
It cannot remove a stop, add a stop, move the current stop, or move a completed
stop. Send `expectedRevision` from the last successful draft response.

The draft response contains `routePlanId`, `revision`, `assignmentGeneration`,
`expectedRouteVersionId`, `publishedVersionId`, `hasUnpublishedChanges`,
`editableFutureStopIds`, and `draft`. Use the returned eligible IDs for edits.
The snapshot includes operational address/contact fields, instructions, service
minutes, time windows, and coordinates. PATCH edits only address fields,
coordinates, and future order. Contact, instruction, service, and time-window
changes are outside this new API. Coordinates are decimal strings or null.
Save accepts paired numeric coordinates or paired nulls. An address change
without coordinates clears coordinates. It can be saved but cannot be dispatched
until the office supplies a verified routeable location.

Dispatch body:

```json
{
  "commandId": "80000000-0000-4000-8000-000000000002",
  "expectedAssignmentGeneration": "2",
  "expectedRouteVersionId": "60000000-0000-4000-8000-000000000001",
  "expectedRevision": 1
}
```

Save and Dispatch persist a command receipt in the same transaction. A response
lost after commit can be retried with the same body and `commandId`. The original
result is returned, including its revision and publication identity. A reused
command ID with different content returns `IDEMPOTENCY_CONFLICT`.
Use a new command ID for a new edit or Dispatch. Unchanged content still reuses
the publication even when the Dispatch command ID differs.
The receipt preserves the original publication and applied-state result.
After a delayed retry, GET the current driver publication to discover newer
changes. The Dispatch response also returns `revision`, `changed`, `geometry`,
and `notification`. Geometry and notification results reflect that retry attempt.
A revision conflict requires a fresh GET and
an explicit rebase of the office edit. Do not blindly substitute a newer revision.
The assignment and underlying version must also match the GET result. A GET
before reassignment cannot authorize a first Save for the new assignment.

## Driver requests

Use the existing route bearer token. The path must match the token's route.

- `GET /driver/routes/:routePlanId/live-change`: latest publication and applied
  state. The immutable publication contains stop content; execution remains live.
- `POST /driver/routes/:routePlanId/live-change/applied`: acknowledge the exact
  applied publication using `publicationVersionId` and `assignmentGeneration`.

Apply body:

```json
{
  "publicationVersionId": "90000000-0000-4000-8000-000000000001",
  "assignmentGeneration": "2"
}
```

The server checks the current tenant, driver, active account, assignment, and
route state again in the transaction. Cancellation and reassignment do not permit
the previous driver to write or acknowledge changes.

Driver response fields are `routePlanId`, `publicationVersionId`,
`assignmentGeneration`, `sequence`, `publishedAt`, `appliedVersionId`, `pending`,
and `snapshot`. `snapshot.schemaVersion` is 1. `snapshot.stops` contains the
ordered operational stop content. A route without enrollment returns `data: null`.
The baseline publication has sequence 0 and no pending change. Saving a first
draft does not change the existing assigned-route/access event version.

| HTTP / error | Client action |
| --- | --- |
| 400 `BAD_REQUEST` / `INVALID_INPUT` | Correct malformed fields. Do not repeat the same invalid command. |
| 401 existing authentication errors | Refresh authentication. Preserve pending edits and events. |
| 403 `FORBIDDEN` / `ACCESS_REVOKED` | Stop writes. Recheck account and route access. |
| 404 `NOT_FOUND` / `PUBLICATION_NOT_FOUND` | Recheck route scope. Never substitute another tenant or route. |
| 409 `REVISION_CONFLICT` | GET the draft and rebase the edit with a new command ID. |
| 409 `IDEMPOTENCY_CONFLICT` | Keep the original command immutable. Use a new ID for a different command. |
| 409 `ASSIGNMENT_CHANGED` / `VERSION_CONFLICT` | Refresh assignment. Preserve offline event identity for reconciliation. |
| 409 `STOP_NOT_FUTURE` / `ROUTE_NOT_IN_PROGRESS` | Stop the edit. The target is outside this new workflow. |
| 409 `DRAFT_NOT_FOUND` | Save a valid draft before Dispatch. |
| 409 `STOP_LOCATION_NOT_ROUTEABLE` | Supply verified coordinates before Dispatch. |
| 409 `ROUTE_VERSION_MISMATCH` / `ROUTE_ASSIGNMENT_CHANGED` on events | Reconcile the original event. Do not relabel it with a newer version. |

The envelope remains `{ "data": ..., "error": null }` on success and the
existing error envelope on failure. Provider or geometry failure does not undo
the committed publication. Retry the same Dispatch command to retry its delivery.

If the app applies N while N+1 is published, acknowledging N leaves N+1 pending.
A repeated or out-of-order acknowledgement cannot move the applied cursor back.
The app must retain the banner when the response still reports a pending change.
GET and acknowledgement remain available during the existing return-navigation
grace. They do not permit new execution writes after delivery work completes.

## Offline events and compatibility

The ordered v2 event request format is preserved. Keep the original
`clientEventId`, `assignmentGeneration`, and `expectedRouteVersionId` on retry.
Do not replace a queued event's identity with the latest access identity.

For an enrolled route, a previous version can admit only a stop event whose target
content remained unchanged through every publication and still matches the live
stop. This allows stop 2's valid offline completion after stop 7 changes. It does
not allow an old event for a reordered target, the changed stop 7, an unrelated UUID, another tenant,
or another assignment. Route-level events require the latest publication.
The original pre-enrollment child UUID is recognized as the baseline identity.
Existing child-version foreign keys remain the execution lineage; the new public
identity is stored in the submitted `expectedRouteVersionId` field.

The current Routes app compares queued version equality before sending events.
App work must distinguish publication changes from assignment changes. Otherwise
the app may quarantine an unchanged-stop event before the server can validate it.
The old app can read the published route and send its existing ordered v2 format.
The persistent banner and explicit apply button require the follow-up app release.

## Notifications and geometry

Push carries `driver_route_changed` and the publication UUID. Push is a hint.
GET is authoritative after restart, offline recovery, duplicate or missing push.
The server creates one logical notification per publication. A lease prevents
simultaneous Dispatch retries from both claiming it. Failed delivery and an
expired claim can be retried with the same Dispatch request. A provider timeout
can still cause a physical duplicate; clients compare publication identity.

Dispatch invalidates planned geometry and future ETA when content changes.
Current/completed ETA and actual arrival/completion timestamps are preserved.
An address-only draft clears stale coordinates. Dispatch requires verified,
routeable coordinates for changed locations. The app must handle absent/stale
planned geometry when the route provider is unavailable or rebuilding fails.
Historical tracking geometry and KFood return-navigation grace are preserved.

The server rebuilds planned geometry outside the publication transaction. Before
cache commit, it checks the current assignment, public UUID, and route shape
under the route lock. A superseded rebuild cannot replace the newer cache.
Future leg metrics and ETA use the preserved current-stop ETA and service duration
as the anchor. Missing anchor data leaves future ETA unavailable with an explicit
failure code. Completed and current stop records are not rewritten.
`geometry.status` is `fresh`, `failed`, `unavailable`, or `superseded`.
`notification` reports `status`, `attemptCount`, and `errorCode`.
Notification delivery uses active KFood app tokens only. Delivery completion,
reassignment, cancellation, or a newer publication suppresses a late attempt.
There is no background retry worker in this release. Dispatch retries claim the
same durable notification row. Driver GET remains available without push.

Published location corrections use the existing CLEVER `routeOpsCorrections`
metadata. The entire address/coordinate tuple stays protected during source sync.
Shopify shipping address and raw order payload continue to store source data.
Source sync takes the route lock before reading effective stop and correction
data. A concurrent publication forces a bounded transaction retry. It cannot
overwrite the public correction with a stale source snapshot.

The new owner can start at revision 0 after an existing valid reassignment has
updated both route and child ownership. Previous publications and receipts remain
immutable and cannot authorize the previous driver. External edits in the same
assignment return `VERSION_CONFLICT`; do not mix legacy editing with this workflow.

## Release order and remaining checks

1. Review this server PR and rehearse the additive migration. Apply the migration
   before starting this server binary. It reads the new tables even before enrollment.
2. Update Shopify to use draft GET/PATCH and live-change Dispatch.
3. Update the Routes app for persistent pending state, exact apply acknowledgement,
   input preservation, and safe queued-event replay.
4. Verify the combined flow on a test device with synthetic routes.
5. Authorize production migration and manual deployment separately.

Do not enable this workflow with only an office UI change. The app must preserve
camera/completion drafts and the selected current stop by ID during apply.
Current-stop policy, payment, proof requirements, toll routing, and update-error
diagnosis are outside this contract. No production Dispatch or real driver push
is part of this server validation.

For a binary rollback, stop new live-change commands first and retain the additive
tables. Published stop changes remain operational data. Removing publication
history or rewriting queued event identities requires a separate reconciliation.

## Reproducible server verification

Run the standard Prisma generation, lint, typecheck, test, and build commands.
The full test profile checks route authority and OpenAPI coverage. Database tests
use PostgreSQL transactions rather than mocked Prisma delegates.

```bash
CLEVER_RUN_DISPOSABLE_DB_TESTS=1 bash apps/delivery-api/scripts/test-live-route-change-db.sh
```

The runner creates and removes its own loopback PostgreSQL container. It ignores
`DATABASE_URL`. For an already created synthetic local database, both
`LIVE_ROUTE_CHANGE_DATABASE_TARGET_CLASS=safe-local-disposable` and
`LIVE_ROUTE_CHANGE_DATABASE_URL` are required. The URL must use loopback, an
explicit port, database `kfood_live_change`, and schema `public`.

The integration suite covers actual SQL lock waits, completion versus publication,
draft revision conflicts, immutable receipts, notification leases, publication
versus acknowledgement, superseded geometry, tenant/account isolation, and
original offline event replay. Rehearse both empty migration and a populated
upgrade from the preceding migration before release. Live provider and device
acceptance require the separate combined test release.
