# DSV operational server v1

Server P1–P3 technical contract, updated for the confirmed 2026-10-08 operating policy. See [policy and app follow-up contract](dsv-operations-policy-20261008.md). This record does not authorize production migration, deployment, or live sending.

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

serviceDate is the immutable date of the logical execution. Existing-context synchronization and SAME_EXECUTION replacement reject a different route plan date with EXECUTION_SERVICE_DATE_MISMATCH. A different business day requires a new execution. Date comparisons use the stored date-only UTC calendar key, without converting publication or send time.

Replacement routes keep identity only through explicit mapping or a proven grouping successor. Mapping history and observation time prevent old samples from moving to a new route. Default vehicle-driver registry links alone do not change route attribution.

Several ACTIVE executions may share a vehicle. A sole eligible context can accept its observation. Several eligible contexts require a selector valid at observation time. PostgreSQL exclusion constraints prevent overlapping tenant/vehicle selector intervals. Closing or replacing vehicle attribution clips its selector history. No latest-route heuristic is used.

Content edits resolve prior N01/N02/N06 links, create N02, and preserve the missing-start incident, T, ordinal, and due time. Attribution changes end old driver warnings and timers. The former recipient receives limited N03; the new recipient receives N01. Vehicle-only replacement creates N02 without same-recipient N03. New attribution requires fresh departure evidence. Approved start remains approved through edits. N07 remains a separate report. Existing operations acknowledge/resolve endpoints remain compatible, but neither is required by the report/email policy.

Generic route save/assignment preserves the existing grouped driver API. Under the route row lock, it increments legacy generation and uses the shared immutable-child replacement writer. The successor preserves publication, grouping version, and membership; it records the new driver and generation. Order projections, epoch, and intents commit together. The previous child remains archived evidence. No grouping parent lock is added. Route row locks serialize mapping and route mutation; an additional per-route advisory lock would invert that order. Import, publication, grouping, stop override, depot, account-link, cancellation, and event writers invoke hooks inside their transaction. Generated production Prisma clients cannot silently bypass missing tables. Narrow legacy unit-test ports can omit the new delegate; actual PostgreSQL tests verify the production path.

The immutable-child replacement helper does not synchronize execution by itself. Each caller synchronizes at its completed business boundary in the same transaction. Multi-child draft writers finish stop changes, projection claims, assignment recomputation, and grouping READY before synchronizing affected routes in a stable order. An unpublished draft without a context creates neither a context nor N01. First valid publication performs that operation. Invalid published snapshots still reject and roll back the business transaction.

DSV driver deletion, common admin driver deletion, and DSV vehicle deletion use one transactional guard. A nonterminal route with a CURRENT, non-superseded published child, any ACTIVE execution reference, or an existing import-row reference rejects deletion with RESOURCE_IN_USE (HTTP 409). Rejection changes no resource, route, context, warning, timer, or intent. It creates no N03. Unreferenced resources retain normal deletion behavior. Closed execution scalar references and stored content remain historical evidence.

The guard locks known directly assigned and ACTIVE-context routes in sorted order, then locks the resource FOR UPDATE, then rechecks current references. It never locks newly discovered routes after the resource lock. Execution publication and synchronization lock the route first, then the driver and vehicle FOR KEY SHARE, and revalidate resource existence and scope. Foreign-key assignment locks and these explicit locks prevent concurrent assignment or publication from bypassing deletion checks. A snapshot that still names a missing resource rejects and rolls back rather than publishing a stale scalar reference.

Admin account approval, DSV registration, DSV login/refresh auto-linking, common invite registration, and common admin registration of an existing driver share a transaction-level attribution protocol. Existing accounts use account advisory locks in UUID order, followed by account row FOR UPDATE locks in UUID order. The common admin existing-driver branch locks the current and target account union, then rechecks both references after driver locking. A newly discovered account also requires whole-transaction topology retry. Newly created accounts already own their inserted row. Before any driver mutation, the writer collects all candidate drivers' directly assigned routes and ACTIVE-context routes across shops. It locks the complete route union in UUID order, then all candidate drivers in UUID order. Per-driver route locking is insufficient when driver order differs from route order.

After driver locks, the writer rereads the route union and revalidates candidate eligibility. Every affected route must belong to the actually locked set. A newly discovered route causes full rollback before any additional route wait. Only this topology change can restart the complete transaction, for at most three attempts. Exhaustion returns ATTRIBUTION_CHANGED (HTTP 409). SQL deadlocks and arbitrary storage errors are not retried by this protocol. The attribution hook checks the prelocked route proof before synchronization. Account, driver/profile changes, audit where applicable, epoch, recipient, intents, and session creation commit together. Common invite session creation is inside this boundary.

The deletion guard retains route-before-resource locks and its fresh reference check. A link holding a driver cannot subsequently wait for an unowned route. A publication or assignment that obtains its resource lock first is reflected in the fresh route union; a writer arriving later waits until linking commits and reads the new account. Rejected deletion leaves the completed link and its coherent execution state unchanged. No historical execution is removed to avoid a lock conflict.

If deletion wins before first publication, the route driver FK becomes null. The existing grouped publication boundary may retain physical publishedAt and a durable SKIPPED_NON_DSV command result, then return FAILED/NOTIFICATION_PROCESSING_FAILED from its legacy notification wrapper. It creates no execution, mapping, or N01. This preserves existing partial-publication evidence and skipped-command retry semantics. Publication winning first instead makes deletion reject with RESOURCE_IN_USE.

## Atomic business commands

START_EXECUTION commits ROUTE_STARTED, PICKUP_COMPLETED, the durable result, startedAt, and N04/N05 resolution together. A failure rolls all new writes back. Existing arbitrary legacy event IDs and partial successes remain evidence. The command fills only missing events. Legacy endpoints remain supported.

REPORT_DELIVERY_EXCEPTION commits a free-text report, its prepared email snapshot, N07 operations intent, and result. The report row is its single email job. Saving a report does not mean an email was sent. It creates no STOP_FAILED, FAILED, or automatic completion. New reports reject terminal targets. Same-command retry replays its result. Operations acknowledge and resolve lock the report row. A late acknowledge cannot reopen a resolved report. Existing terminal stop commands resolve pending N06 in the same transaction.

## Persisted geofence evidence

UVIS saves original samples and eligible jobs atomically. The processor uses persisted sample IDs and observed coordinates. Road-matched points, tunnel interpolation, and fabricated accuracy are excluded. Raw observations remain stored when no job is eligible. OFF contexts do not enqueue monitoring jobs.

State is keyed by context, epoch, and target. Immutable transition evidence records sample ID, content version, epoch, policy version, first boundary observation, confirming observation, and server confirmation time. Operations DTOs do not copy raw coordinates. The scalar sample reference can remain after raw retention removes a sample.

Invalid coordinates, implausible jumps, stale/future observations, duplicates, and reverse time cannot advance state. GPS gaps reset unfinished dwell evidence. Inner entry and larger outer exit radii provide hysteresis. The neutral band preserves confirmed state and cancels pending entry/exit candidates. Dwell duration and distinct sample count are both required. Repeated visits use a visit ordinal. Overlapping pending destinations do not choose an arbitrary target.

When exitMinSamples=1 and exitDwellSeconds=0, the first valid observation outside the outer exit radius confirms DEPARTED. The same confirmation rule applies on the first and subsequent outside observations. Higher sample counts, positive dwell, neutral-band cancellation, GPS-gap reset, and re-entry retain their existing behavior.

After locking the context, the processor revalidates mapping, effective time, version, epoch, selector, monitor window, and attribution. Old samples cannot attach after concurrent route replacement. Job claims use leases. Ambiguous or unavailable attribution retries within a bounded technical budget, then ends with an ignored reason. Restart preserves committed evidence.

Warehouse arrival creates N04 at most once per logical execution during its business day, without a fixed morning start time. Publication while already inside uses recent valid vehicle-GPS dwell evidence. Assignment, GPS quality, and ambiguity checks still apply. GPS writes no business start, pickup, delivery result, or completion event.

T is the observation that completes departure confirmation. First N05 is due at T+300 seconds. Later reminders are due 300 seconds after the previous actual creation. There is no business reminder count limit. Recovery creates at most one current reminder and does not replay missed slots. Provider and job retries cannot increase reminderOrdinal. Re-entry pauses the timer. Re-departure resumes from its new T and preserves ordinal. At the execution serviceDate noon in Asia/Seoul, N05 creation, send, and retry stop. Start, cancellation, completion, or reassignment can stop them earlier. The next day cannot revive the incident. Noon does not close the execution or suppress other notification kinds.

SHADOW records decisions without N04/N05/N06 intents. LIVE requires liveEligibleAt. Departure and destination warnings require evidence at or after activation. N04 can use recent valid warehouse dwell from before first publication. A previous departure becomes STALE_ACTIVATION; activation alone cannot replay it. Fresh confirmed departure is required. GPS thresholds still need field validation after the app release.

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

N01/N02 begin sending after successful publication/material change at any hour, including night. Business mutation and intent commit together. Logical keys prevent duplicates. Per-token/per-capability attempts prevent repeated materialization and starvation. Business states are OPEN, RESOLVED, CANCELLED, EXPIRED. READ/OPENED acknowledgements do not resolve warnings.

N01 push title and inbox title are “n월 n일 배차가 등록되었습니다.”, using the referenced execution's serviceDate. The stored UTC date-only month and day are used for future executions and retries across a calendar boundary. Intent creation time and provider send time do not select the displayed date. The existing body and schema-v1 payload keys remain compatible. Missing execution date fails closed. Date loading precedes the final fresh policy, authority, and lease checks; no extra asynchronous lookup occurs between the final lease check and provider invocation.

Immediately before provider send, the worker checks fresh policy, lease owner/expiry, latest intent, tenant, active driver/account/vehicle, current published assignment, epoch, content compatibility, target, and capability. N03 reveals only release. N04/N05 retain timing through content revisions and resolve current authorized details. N06 requires its exact pending target. N07 is operations-only.

Capabilities bind schema v1, kinds, installation ID, app ID, token hash, and token update time. Token renewal invalidates the old capability. Clients without a new capability retain existing contracts. Legacy/new routing suppresses duplicates only when the new channel satisfies complete policy and capability checks.

Push payloads contain notification identity and minimal copy, without order/customer details. TTL is bounded by expiry and provider limits. N04/N05 expiry respects the business-day boundary; N05 is additionally bounded by noon. N06 retains its existing monitor-window boundary. N06 collapse tags include target and visit ordinal. Delivered messages cannot be recalled. Lease CAS prevents late worker result commits or token revocation. A crash after provider acceptance can cause a provider retry; network delivery is at-least-once.

Legacy businessReminderCap/maxReminderCount values do not limit logical N05 reminders. maxProviderAttempts remains a separate technical retry budget. Attempt count includes abandoned leases and is not an exact network counter. Operations uses the term workerAttemptCount.

## Additive API

All routes use private, no-store caching and exact parsers. Existing strict web DTOs and app endpoints remain unchanged. UUIDs are actual UUIDs. P0 symbolic IDs are fixture notation. assignmentEpoch and assignmentGeneration are decimal strings; routeVersion is an integer. Instants are UTC ISO strings.

| Method/path | Contract |
|---|---|
| GET /api/dsv/driver/executions | Current authorized contexts and both fence sets; optional serviceDate |
| POST /api/dsv/driver/executions/:id/start | commandId, occurredAt, routeVersion, assignmentEpoch, assignmentGeneration, expectedRouteVersionId |
| POST /api/dsv/driver/executions/:id/delivery-exceptions | Same fences plus targetStopId and reason (1–1000 characters); legacy reasonCode/explanation remain accepted |
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

## Default OFF and remaining rollout gates

No operational environment or deployment settings change. New contexts default OFF. Geofence runtime requires DSV_GEOFENCE_ENABLED=true and valid DSV_GEOFENCE_POLICY_JSON. Otherwise it is a no-op. Required GPS values include entry/exit radii, dwell/counts, gap, delay, speed, future tolerance, TTL, and version. Synthetic values are not fleet settings.

New sending requires DSV_OPERATIONAL_SEND_ENABLED=true and complete DSV_OPERATIONAL_SEND_POLICY_JSON. Missing or invalid configuration disables it. Required values include authorization ID, approved geofence version, tenant/account/kind allowlists, provider retry budget, monitor window for N06, and notification send validity. Context mode, activation, and matching authorization/version must also exist. N01/N02 have no time window. N04 uses the business day; N05 uses the business day before noon. Legacy monitor bounds do not impose a 06:00 gate on N04/N05. Policy is re-read before send. This PR provides no production activation/bootstrap operation.

DSV_GEOFENCE_JOB_RETRY_DELAY_MS, DSV_GEOFENCE_JOB_RETRY_MAX_AGE_MS, and DSV_GEOFENCE_JOB_RETRY_MAX_ATTEMPTS are technical queue bounds. Defaults are 30 seconds, 10 minutes, and 5 claims. These are not reminder policy.

| Decision | Remaining evidence/decision | Blocked stage |
|---|---|---|
| D01 | Confirmed: unlimited N05 every five minutes until service-date noon KST. | Field/release verification remains |
| D02 | Confirmed: GPS-based N04 without morning gate; immediate N01/N02 at night. | Field/release verification remains |
| D03 | Technical identity/mapping/version/epoch recorded here and #482/#310 | Server P1 implemented; operations workflow review remains |
| D04 | Fleet labels, GPS parameters, false-positive/negative and latency acceptance | Actual GPS shadow evaluation/LIVE acceptance |
| D05 | Confirmed: free text and prepared staff email; no required handling workflow. | App form and recipient/transport configuration |
| D06 | Business trail visibility and exceptional boundaries | P7; excluded here |
| D07 | Confirmed: no age-based deletion of notification/report history. Existing GPS/photo/technical-log policies remain. | No new retention job |

No age-based purge or new read-audit policy is introduced. Finite notification expiry controls sending and inbox visibility, not storage retention. Fleet acceptance, device proof, runtime proof, migration/deploy rehearsal, and activation remain separate work.

Driver dev: 4009a9f522372a9cf23272ba723bfbbb76d96253.
Driver Draft PR61: a7959e5a84393d7dc57e2caa654ea2f8edad202c.
Driver Issue62 blocks app integration/release only. Other repositories were read only.
Web baseline: 4f261b67cfb22669cb26a093eb1f3f59ab9c7606.
