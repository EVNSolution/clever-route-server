# DSV operational server v1

Server P1–P3 technical contract. This record does not approve operating policy, production migration, deployment, actual GPS shadow, or live sending.

Target: [server #482](https://github.com/EVNSolution/clever-route-server/issues/482). Change-control: [#310](https://github.com/EVNSolution/clever-change-control/issues/310).
Base: `9c517aa2f483bdfdccf730889df61da346d1d22d`.
Evidence: [verification report](dsv-operational-server-verification-20261006.md).

## Identity and explicit commands

| Field | Meaning | Change rule |
|---|---|---|
| executionContextId | UUID for one logical execution | Retain for SAME_EXECUTION. Allocate for NEW_EXECUTION. Never reopen a closed context. |
| routeVersion | Positive integer content revision | Increment for membership, sequence, quantity, address, destination identity, coordinates, or depot coordinates. Internal metadata and delivery status do not increment it. |
| assignmentEpoch | Positive bigint attribution fence; decimal string in HTTP | Increment for driver, linked account, or assigned vehicle changes. Retain for content-only changes. |

Legacy assignmentGeneration and current child UUID remain separate event fences. Neither substitutes for a new identity field. Driver commands supply both fence sets.

INITIAL_EXECUTION is an internal first-valid-publication operation. Upload outcome alone does not trigger N01. A fresh NO_OP command that first publishes a valid child can trigger N01. Successful receipt replay cannot create another context or intent. Receipt keys include tenant, command name, and command ID. Different semantic input with the same key rejects. Internal publication hints are excluded from the semantic hash.

An already-published unmapped route, or a vehicle with same-date execution history, requires explicit mapping. Physical legacy publication can remain valid while logical monitoring waits. Afternoon trips require NEW_EXECUTION. SAME_EXECUTION requires a named ACTIVE context, matching tenant/date, and monotonic effective time. Mapping intervals use [validFrom, validUntil). Zero-length closed history is allowed and cannot accept samples.

Replacement routes keep identity only through explicit mapping or a proven grouping successor. Mapping history and observation time prevent old samples from moving to a new route. Default vehicle-driver registry links alone do not change route attribution.

Several ACTIVE executions may share a vehicle. A sole eligible context can accept its observation. Several eligible contexts require a selector valid at observation time. PostgreSQL exclusion constraints prevent overlapping tenant/vehicle selector intervals. Closing or replacing vehicle attribution clips its selector history. No latest-route heuristic is used.

Content edits resolve prior N01/N02/N06 links, create N02, and preserve the missing-start incident, T, ordinal, and due time. Attribution changes end old driver warnings and timers. The former recipient receives limited N03; the new recipient receives N01. Vehicle-only replacement creates N02 without same-recipient N03. New attribution requires fresh departure evidence. Approved start remains approved through edits. N07 is an operations report and remains OPEN until operations resolves it.

Generic route save/assignment preserves the existing grouped driver API. Under the route row lock, it increments legacy generation and uses the shared immutable-child replacement writer. The successor preserves publication, grouping version, and membership; it records the new driver and generation. Order projections, epoch, and intents commit together. The previous child remains archived evidence. No grouping parent lock is added. Route row locks serialize mapping and route mutation; an additional per-route advisory lock would invert that order. Import, publication, grouping, stop override, depot, account-link, cancellation, and event writers invoke hooks inside their transaction. Generated production Prisma clients cannot silently bypass missing tables. Narrow legacy unit-test ports can omit the new delegate; actual PostgreSQL tests verify the production path.

The immutable-child replacement helper does not synchronize execution by itself. Each caller synchronizes at its completed business boundary in the same transaction. Multi-child draft writers finish stop changes, projection claims, assignment recomputation, and grouping READY before synchronizing affected routes in a stable order. An unpublished draft without a context creates neither a context nor N01. First valid publication performs that operation. Invalid published snapshots still reject and roll back the business transaction.

## Atomic business commands

START_EXECUTION commits ROUTE_STARTED, PICKUP_COMPLETED, the durable result, startedAt, and N04/N05 resolution together. A failure rolls all new writes back. Existing arbitrary legacy event IDs and partial successes remain evidence. The command fills only missing events. Legacy endpoints remain supported.

REPORT_DELIVERY_EXCEPTION commits a separate report, N07 operations intent, and result. It creates no STOP_FAILED, FAILED, or automatic completion. New reports reject terminal targets. Same-command retry replays its result. Operations acknowledge and resolve lock the report row. A late acknowledge cannot reopen a resolved report. Existing terminal stop commands resolve pending N06 in the same transaction.

## Persisted geofence evidence

UVIS saves original samples and eligible jobs atomically. The processor uses persisted sample IDs and observed coordinates. Road-matched points, tunnel interpolation, and fabricated accuracy are excluded. Raw observations remain stored when no job is eligible. OFF contexts do not enqueue monitoring jobs.

State is keyed by context, epoch, and target. Immutable transition evidence records sample ID, content version, epoch, policy version, first boundary observation, confirming observation, and server confirmation time. Operations DTOs do not copy raw coordinates. The scalar sample reference can remain after raw retention removes a sample.

Invalid coordinates, implausible jumps, stale/future observations, duplicates, and reverse time cannot advance state. GPS gaps reset unfinished dwell evidence. Inner entry and larger outer exit radii provide hysteresis. The neutral band preserves confirmed state and cancels pending entry/exit candidates. Dwell duration and distinct sample count are both required. Repeated visits use a visit ordinal. Overlapping pending destinations do not choose an arbitrary target.

After locking the context, the processor revalidates mapping, effective time, version, epoch, selector, monitor window, and attribution. Old samples cannot attach after concurrent route replacement. Job claims use leases. Ambiguous or unavailable attribution retries within a bounded technical budget, then ends with an ignored reason. Restart preserves committed evidence.

Warehouse arrival creates N04 at most once per logical execution. GPS writes no business start, pickup, delivery result, or completion event.

T is the observation that completes departure confirmation. First N05 is due at T+300 seconds. Later logical reminders are due at least 300 seconds after the previous actual creation. Recovery creates at most one current reminder and does not replay missed slots. Provider and job retries cannot increase reminderOrdinal. Re-entry pauses the timer. Re-departure resumes from its new T and preserves ordinal. Date rollover alone cannot end an execution. Start, cancellation, completion, reassignment, expiry, and injected cap suppress obsolete warnings.

SHADOW records decisions without N04/N05/N06 intents. LIVE requires liveEligibleAt. GPS warnings require evidence at or after activation. A previous departure becomes STALE_ACTIVATION; activation alone cannot replay it. Fresh confirmed departure is required. This is technical behavior, not an approved fleet policy.

## Durable intents and sending

| Kind | Trigger | Audience/resolver |
|---|---|---|
| N01 | First valid publication or new recipient | Current driver execution |
| N02 | Content revision or vehicle-only replacement | Current driver execution |
| N03 | Previous recipient release/cancellation | Release fact only |
| N04 | Warehouse arrival, once per execution | Current execution; no automatic start |
| N05 | Missing start at T+5 minutes and subsequent due | Current execution; no automatic start |
| N06 | Confirmed pending-destination visit | Current target; no automatic delivery result |
| N07 | Separate delivery exception | Authorized operations report; no driver FCM |

Business mutation and intent commit together. Logical keys prevent duplicates. Per-token/per-capability attempts prevent repeated materialization and starvation. Business states are OPEN, RESOLVED, CANCELLED, EXPIRED. READ/OPENED acknowledgements do not resolve warnings.

Immediately before provider send, the worker checks fresh policy, lease owner/expiry, latest intent, tenant, active driver/account/vehicle, current published assignment, epoch, content compatibility, target, and capability. N03 reveals only release. N04/N05 retain timing through content revisions and resolve current authorized details. N06 requires its exact pending target. N07 is operations-only.

Capabilities bind schema v1, kinds, installation ID, app ID, token hash, and token update time. Token renewal invalidates the old capability. Clients without a new capability retain existing contracts. Legacy/new routing suppresses duplicates only when the new channel satisfies complete policy and capability checks.

Push payloads contain notification identity and minimal copy, without order/customer details. TTL is bounded by expiry and provider limits. N04/N05/N06 expiry also precedes the next interval and monitor end. N06 collapse tags include target and visit ordinal. Delivered messages cannot be recalled. Lease CAS prevents late worker result commits or token revocation. A crash after provider acceptance can cause a provider retry; network delivery is at-least-once.

businessReminderCap and maxProviderAttempts are separate. Attempt count is a bounded claim/retry budget that includes abandoned leases, not an exact network counter. Operations uses the term workerAttemptCount.

## Additive API

All routes use private, no-store caching and exact parsers. Existing strict web DTOs and app endpoints remain unchanged. UUIDs are actual UUIDs. P0 symbolic IDs are fixture notation. assignmentEpoch and assignmentGeneration are decimal strings; routeVersion is an integer. Instants are UTC ISO strings.

| Method/path | Contract |
|---|---|
| GET /api/dsv/driver/executions | Current authorized contexts and both fence sets; optional serviceDate |
| POST /api/dsv/driver/executions/:id/start | commandId, occurredAt, routeVersion, assignmentEpoch, assignmentGeneration, expectedRouteVersionId |
| POST /api/dsv/driver/executions/:id/delivery-exceptions | Same fences plus targetStopId, reasonCode, optional explanation |
| GET /api/dsv/driver/operational-notifications | Bounded inbox with cursor/limit |
| GET /api/dsv/driver/operational-notifications/:id/resolve | Authenticated current destination |
| POST /api/dsv/driver/operational-notifications/:id/acks | READ or OPENED |
| POST /api/dsv/driver/operational-notifications/capability | installationId, tokenId, schemaVersion, kinds |
| GET /api/dsv/v1/operations/executions[/:id] | Context and bounded evidence/status summaries |
| POST /api/dsv/v1/operations/executions/map | commandId, effectiveAt, routePlanId, mapping; context ID only for SAME_EXECUTION |
| POST /api/dsv/v1/operations/executions/select | commandId, context ID, vehicle ID, validFrom, validUntil |
| GET /api/dsv/v1/operations/notifications[/:id/resolve] | Operations N07 inbox/resolver |
| POST /api/dsv/v1/operations/notifications/:id/acks | Operations acknowledgement |
| GET /api/dsv/v1/operations/delivery-exceptions[/:id] | Authorized report list/detail |
| POST /api/dsv/v1/operations/delivery-exceptions/:id/acknowledge or /resolve | Report handling only |

Driver authentication resolves one active DSV driver from current account/token version. Operations GETs require control-read scope and an admin session. Mutations require dispatch-write scope and CSRF. GETs/resolvers cannot write DriverEvents or change business state. Expired, reassigned, account-changed, or unauthorized links cannot expose old delivery detail. N03 returns ASSIGNMENT_RELEASED only. Operations summaries expose truncation and separate business from attempt status.

## Default OFF and unresolved decisions

No operational environment or deployment settings change. New contexts default OFF. Geofence runtime requires DSV_GEOFENCE_ENABLED=true and valid DSV_GEOFENCE_POLICY_JSON. Otherwise it is a no-op. Required GPS values include entry/exit radii, dwell/counts, gap, delay, speed, future tolerance, TTL, and version. Synthetic values are not fleet settings.

New sending requires DSV_OPERATIONAL_SEND_ENABLED=true and complete DSV_OPERATIONAL_SEND_POLICY_JSON. Missing or invalid configuration disables it. Required values include authorization ID, approved geofence version, tenant/account/kind allowlists, business cap, provider retry budget, monitor window, and retention. Context mode, activation, monitor bounds, and matching authorization/version must also exist. Policy is re-read before send. This PR provides no production activation/bootstrap operation.

DSV_GEOFENCE_JOB_RETRY_DELAY_MS, DSV_GEOFENCE_JOB_RETRY_MAX_AGE_MS, and DSV_GEOFENCE_JOB_RETRY_MAX_ATTEMPTS are technical queue bounds. Defaults are 30 seconds, 10 minutes, and 5 claims. These are not reminder policy.

| Decision | Remaining evidence/decision | Blocked stage |
|---|---|---|
| D01 | Cap, incident/context budget, expiry. Six remains unapproved. | Live policy/P6 sending |
| D02 | Monitor start/end, night behavior, operating timezone | Operational monitoring/P6 |
| D03 | Technical identity/mapping/version/epoch recorded here and #482/#310 | Server P1 implemented; operations workflow review remains |
| D04 | Fleet labels, GPS parameters, false-positive/negative and latency acceptance | Actual GPS shadow evaluation/LIVE acceptance |
| D05 | Reason catalog, explanation rules, roles, final handling workflow | P5 client workflow acceptance |
| D06 | Business trail visibility and exceptional boundaries | P7; excluded here |
| D07 | Evidence/intent/ack/attempt/command retention, deletion, read audit | Actual-data shadow/P6 |

No retention purge or new read-audit policy is approved here. OFF synthetic storage uses finite expiry. Fleet acceptance, device proof, runtime proof, migration/deploy rehearsal, and activation remain separate work.

Driver dev: 4009a9f522372a9cf23272ba723bfbbb76d96253.
Driver Draft PR61: a7959e5a84393d7dc57e2caa654ea2f8edad202c.
Driver Issue62 blocks app integration/release only. Other repositories were read only.
Web baseline: 4f261b67cfb22669cb26a093eb1f3f59ab9c7606.
