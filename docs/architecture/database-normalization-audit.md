# Database normalization audit

Issue: [#80](https://github.com/EVNSolution/clever-route-server/issues/80)<br>
Companion: [`driver-route-session-restore-erd.md`](./driver-route-session-restore-erd.md)

## Scope

This audit reviews the current `apps/delivery-api/prisma/schema.prisma` table
shape before implementing driver app route-session restore. It is documentation
only: no schema migration, runtime code, deployment workflow, or infrastructure
file is changed by this branch.

The immediate question is whether the existing database tables should be fixed
or simplified before adding a driver route-session restore API. The answer is:

- do **not** repurpose `driver_sessions`; it is an auth refresh-token table;
- keep most current normalization boundaries intact;
- retain several denormalized/read-model tables intentionally;
- add an operational route-session projection later if exact server-side session
  restore is required;
- use a short-lived bridge from existing route/event state only if migration
  timing blocks the projection, and label that bridge as **best-effort active route resume**, not deterministic session restore.

## Audit rules

| Classification | Meaning | Action |
|---|---|---|
| Keep normalized | Entity/join/event boundary is clear and should not be merged | No schema change |
| Purposeful denormalization/read model | Data repeats because it is a snapshot, idempotency key, query scope, job summary, or computed projection | Keep, document source of truth |
| Suspicious duplication or overloaded naming | Same concept appears to have multiple homes or a misleading name | Investigate before implementation |
| Needs schema/API follow-up | Current table shape cannot support required behavior cleanly | Create narrow follow-up issue/API design |

Principles:

1. Auth/session tables must not be reused for operational workflow state.
2. Event tables are audit truth, but not always efficient restore projections.
3. Denormalization is acceptable when it is a snapshot, read model, idempotency
   record, tenant-scope accelerator, or external-source compatibility buffer.
4. Legacy compatibility debt is not the same thing as current domain modeling
   error.
5. Prefer additive changes until driver app and commerce integrations have a
   tested rollback path.

## Current table catalog

The schema currently defines 25 Prisma models/tables.

| # | Model | Table | Lines | Type | Bounded context | Key relationships / constraints | Audit status |
|---|---|---:|---:|---|---|---|---|
| 1 | `Shop` | `shops` | 169-213 | Tenant root | Tenant/shop | Unique `shopDomain`, `shopifyShopGid`; owns most child tables; `routeScopeConfig` JSON | Keep normalized with compatibility debt |
| 2 | `AdminNotification` | `admin_notifications` | 215-236 | Ops read model | Admin ops | `shopId` FK; unique `(shopId, dedupeKey)`; optional `orderId`/`routePlanId` scalar refs | Purposeful denormalization/read model |
| 3 | `CommerceConnection` | `commerce_connections` | 238-274 | Entity | Commerce integration | `shopId` FK; unique `(shopId, platform, siteUrl)`; owns tokens, mappings, sync runs | Keep normalized |
| 4 | `CommerceSyncRun` | `commerce_sync_runs` | 276-312 | Job/run summary | Commerce ingestion | `shopId`, `commerceConnectionId`; counters and warnings JSON | Purposeful denormalization/job summary |
| 5 | `CommerceRawOrderIngest` | `commerce_raw_order_ingests` | 314-349 | Raw ingest/event | Commerce ingestion | `shopId`, connection, sync run; unique source/raw hash keys | Purposeful idempotency/audit table |
| 6 | `CommerceConnectionAuditLog` | `commerce_connection_audit_logs` | 351-366 | Append-only audit | Commerce audit | `shopId`; optional connection `SetNull`; metadata JSON | Keep as audit table |
| 7 | `CommerceConnectionOrderMapping` | `commerce_connection_order_mappings` | 368-382 | Config entity | Commerce mapping | one-to-one connection via unique `commerceConnectionId`; config JSON | Purposeful JSON config, follow stable-subentity growth |
| 8 | `WordPressPluginToken` | `wordpress_plugin_tokens` | 384-400 | Auth token | WP connector auth | connection FK; unique `tokenHash`; status lifecycle | Keep normalized |
| 9 | `WordPressPluginPairingCode` | `wordpress_plugin_pairing_codes` | 402-423 | Auth pairing | WP connector auth | connection + shop FKs; unique `codeHash`; expiry/consumed fields | Keep; repeated shop scope is useful |
| 10 | `ShopifyWebhookEvent` | `shopify_webhook_events` | 425-448 | Legacy ingest event | Legacy Shopify ingestion | `shopId`; unique `(shopId, webhookId)`; raw payload JSON | Keep while Shopify compatibility remains |
| 11 | `Order` | `orders` | 450-486 | Canonical entity/snapshot | Order canonical | `shopId`; unique Shopify GID and generic source tuple; raw/shipping JSON | Mixed legacy/generic identifiers; acceptable compatibility buffer |
| 12 | `DeliveryStop` | `delivery_stops` | 488-521 | Delivery task entity | Delivery planning/execution | `shopId`, `orderId`; unique `(shopId, orderId)`; address/geocode/status | Keep snapshot separate from `Order` |
| 13 | `OrderDeliveryFact` | `order_delivery_facts` | 523-572 | Computed read model | Planning readiness | `shopId`, `orderId`, optional connection; unique `(shopId, orderId)`; many source/readiness fields | Purposeful denormalization/read model |
| 14 | `RoutePlan` | `route_plans` | 574-602 | Route aggregate | Route planning/execution | `shopId`; optional driver/vehicle; `constraints` and `metrics` JSON | Keep; watch JSON growth and status lifecycle |
| 15 | `RouteOptimizationJob` | `route_optimization_jobs` | 604-630 | Job/run artifact | Route optimization | `shopId`, route plan; engine result sequence JSON; trace id index | Purposeful job artifact |
| 16 | `RoutePlanStop` | `route_plan_stops` | 632-649 | Ordered join | Route planning | route plan + delivery stop; unique route sequence, route/stop, and `deliveryStopId` | Mostly normalized; `deliveryStopId` global uniqueness is a watch item |
| 17 | `Driver` | `drivers` | 651-677 | Identity entity | Driver identity/auth | `shopId`; unique `authSubject`; unique `(shopId, inviteCode)` | Keep; auth fields are profile-adjacent but acceptable |
| 18 | `DriverSession` | `driver_sessions` | 679-691 | Auth session | Driver auth | driver FK; unique `refreshTokenHash`; expiry/revocation/last use | Keep auth-only; do not use for delivery session |
| 19 | `DriverConsentRecord` | `driver_consent_records` | 693-712 | Compliance record | Driver compliance | shop/driver FKs; unique `(driverId, consentType, consentVersion)` | Keep; routeContext uniqueness may be future question |
| 20 | `DriverProofMedia` | `driver_proof_media` | 714-739 | Evidence metadata | Driver proof | shop/driver/route/stop FKs; unique `(shopId, storageKey)` | Keep normalized evidence table |
| 21 | `DriverRouteFeedback` | `driver_route_feedback` | 741-757 | Feedback record | Driver feedback | shop/driver/route FKs; review note | Keep simple route-level feedback |
| 22 | `DriverAccountDeletionRequest` | `driver_account_deletion_requests` | 759-776 | Compliance snapshot | Privacy/compliance | nullable shop/driver `SetNull`; denormalized shop/domain/name/phone snapshot | Purposeful compliance snapshot |
| 23 | `RetentionJobRun` | `retention_job_runs` | 778-797 | Job/run summary | Retention ops | no tenant FK; job counters/evidence ref | Purposeful ops summary |
| 24 | `Vehicle` | `vehicles` | 799-815 | Fleet entity | Fleet | `shopId`; unique `(shopId, licensePlate)`; status | Keep; nullable plate uniqueness behavior should be accepted explicitly |
| 25 | `DriverEvent` | `driver_events` | 817-839 | Append-only event/audit | Driver execution audit | shop/driver/optional route/optional stop; unique `(driverId, clientEventId)`; payload JSON | Keep audit; not enough alone for exact restore |

## Bounded-context assessment

### Tenant and configuration

`Shop` is the correct tenant root. Its `routeScopeConfig` JSON is not a
normalization bug today because the admin UI treats service types, delivery
sessions, and route scope settings as configurable settings rather than stable
first-class entities yet. If those values later need independent lifecycle,
permissions, or analytics, they can be promoted into dedicated tables.

Risk to watch: `Shop.shopifyShopGid` and `apiVersion` are legacy Shopify-shaped
fields in a repository that now also serves WooCommerce/WordPress. This is
compatibility debt, not an immediate driver-session blocker.

### Commerce ingestion and source identifiers

`CommerceConnection`, `CommerceSyncRun`, `CommerceRawOrderIngest`,
`CommerceConnectionOrderMapping`, `WordPressPluginToken`, and
`WordPressPluginPairingCode` form a coherent ingestion/auth boundary.

Repeated source identifiers across `CommerceRawOrderIngest`, `Order`, and
`OrderDeliveryFact` look duplicated but serve different purposes:

- raw ingest: idempotency and replay of external payloads;
- order: canonical order snapshot and current source identity;
- delivery fact: computed planning readiness and source-derived delivery
  metadata.

This should remain denormalized unless a field becomes mutable in more than one
place. The audit judgment is **purposeful denormalization**, not a table merge.

### Order, stop, and planning readiness

`Order` keeps commerce source payload and status. `DeliveryStop` snapshots the
operational delivery destination/task for one order. Duplicating customer address
from `Order.shippingAddress` into `DeliveryStop` is acceptable because delivery
execution needs a stable task snapshot even if the source order changes later.

`OrderDeliveryFact` is intentionally wide. It holds parsed delivery day/session,
route scope keys, readiness, review reasons, and geocode/readiness status. This
is a read model/projection that prevents route planning from repeatedly parsing
raw commerce payloads. Keep it, but continue treating `Order` and raw ingest as
the source/audit trail.

### Route planning and replanning

`RoutePlan` and `RoutePlanStop` are mostly normalized well. `RoutePlanStop` is
the ordered join between a plan and stops, and the route sequence belongs there.

The important watch item is `RoutePlanStop @@unique([deliveryStopId])`. Runtime
code also checks whether a delivery stop is already planned before creating or
updating route stops. That means the current model enforces **one delivery stop
in one route plan globally**, not merely one stop per route. This appears
intentional for the current operational model because both schema uniqueness and
route-plan update code enforce already-planned stop checks, but it limits
historical route versions or parallel replanning scenarios. Do not change it
for driver session restore; create a separate route-versioning/replanning issue
if route history becomes required.

`RoutePlan.constraints` and `RoutePlan.metrics` are acceptable JSON fields for
optimizer/config/result metadata. They should not absorb driver progress state.
If a field becomes required for mobile restore or route lifecycle transitions,
promote that field into either `RoutePlan` columns or a route-session
projection.

### Driver identity, auth, and execution

`Driver` mixes profile fields with auth-related fields such as `authSubject`,
`tokenVersion`, and invite code fields. That is acceptable at current scale
because the driver identity aggregate owns invite and token invalidation state.

`DriverSession` is unambiguously auth-only:

- schema fields are `refreshTokenHash`, `expiresAt`, `revokedAt`, `lastUsedAt`;
- `driver-auth.repository.ts` finds sessions by refresh-token hash and updates
  `lastUsedAt` on refresh;
- invite verification creates a `DriverSession` with a refresh token.

Therefore, using `driver_sessions` to store delivery progress would create a
real domain conflict. The operational delivery session should be named
separately, e.g. `DriverRouteSession` / `driver_route_sessions`.

`DriverEvent` is correctly append-only/audit-oriented. It can record
`ROUTE_STARTED`, stop terminal events, location, notes, and completion. However,
current state transition behavior only updates terminal stop state and route
completion. It does not promote `ROUTE_STARTED` to `RoutePlan.status =
IN_PROGRESS`. That means existing active-route reads can disagree with the
app-local session state.

## Duplication and normalization matrix

| Area | Looks duplicated because | Judgment | Follow-up |
|---|---|---|---|
| `DriverSession` vs route session | both use “session” language | Overloaded naming, not same concept | Add `DriverRouteSession`; keep `DriverSession` auth-only |
| `Order.source*`, `CommerceRawOrderIngest.source*`, `OrderDeliveryFact.source*` | source order identifiers appear in three places | Purposeful stage-specific denormalization | Document source-of-truth per stage; do not merge |
| `Order.shippingAddress` vs `DeliveryStop.address*` | address copied into stop | Purposeful delivery snapshot | Keep; stop address is execution snapshot |
| `OrderDeliveryFact.deliveryDate/session/area` vs `DeliveryStop.deliveryDate` and route scope | parsed facts flow into planning/execution | Purposeful read model with possible stale-copy risk | Keep; ensure recomputation rules are explicit |
| `Shop.routeScopeConfig` JSON vs facts route scope fields | settings and computed keys both mention route scope | Acceptable config/read-model split | Promote only if settings gain independent lifecycle |
| `RoutePlan.constraints/metrics` JSON vs typed route columns | metadata/result fields are not all relational | Acceptable optimizer/read-model buffer | Do not store driver progress here |
| `shopId` on many child tables despite parent FKs | tenant scope is repeated | Purposeful tenant query/scope denormalization | Keep; write paths must validate parent shop consistency |
| `ShopifyWebhookEvent` and generic commerce ingestion | legacy Shopify table remains beside Woo ingest | Legacy compatibility debt | Keep until Shopify rollback/compatibility policy changes |
| `RoutePlanStop.deliveryStopId` global uniqueness | one stop cannot appear in more than one plan | Possible future replanning limitation | Do not change for restore; separate route-version issue |
| `DriverConsentRecord.routeContext` with uniqueness only on driver/type/version | route-specific consent context is not part of unique key | Potential compliance semantics question | If route-specific consent matters, revisit uniqueness |
| `Vehicle.licensePlate` nullable unique per shop | null plate behavior may allow multiple unplated vehicles | Likely acceptable | Document expected Postgres nullable-unique behavior |

## Driver route-session restore recommendation

### Do not change these tables for session restore

- `driver_sessions`: auth refresh-token lifecycle only.
- `driver_events`: append-only audit/events only.
- `route_plans`: keep assignment/status at route level; do not pack app step
  pointers into `constraints`.
- `route_plan_stops`: sequence join; do not add app-local navigation step here.

### Minimum bridge if migration is blocked

A temporary `GET /driver/route-session/active` can derive a weak active session
from existing tables. This bridge should be product-labeled as **best-effort
active route resume**, not exact session restore, because the current schema has
no single server-side source of truth for app step position:

1. find the authenticated driver's `RoutePlan` in `IN_PROGRESS`, or newest
   `ROUTE_STARTED` event without completion **only after joining it back to an
   authenticated driver-owned `RoutePlan` by `shopId`, `driverId`, and
   `routePlanId`**;
2. include the assigned-route payload already returned by
   `GET /driver/assigned-route`;
3. infer next stop from `RoutePlanStop.sequence` and terminal `DeliveryStop`
   statuses;
4. return `navigationStepIndex` as best effort.

Bridge limitations:

- cannot know whether the app-local pickup/company step was completed;
- cannot restore offline events that never reached the server;
- depends on fixing or consistently interpreting route status transitions;
- must ignore unscoped `ROUTE_STARTED` events unless event validation is
  hardened or the event is joined to an owned route plan first;
- still leaves no database-level one-active-route-per-driver rule.

### Stable target

For deterministic restore, add a small operational projection table later. The
snippet below shows the minimum durable fields, but the real migration/model
must include FK relations to `Shop`, `Driver`, `RoutePlan`, optional `RoutePlanStop`, and optional
`DriverEvent`; scalar IDs without referential integrity are not sufficient for
this design.

```prisma
model DriverRouteSession {
  id                     String                   @id @default(uuid()) @db.Uuid
  shopId                 String                   @db.Uuid
  shop                   Shop                     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  driverId               String                   @db.Uuid
  driver                 Driver                   @relation(fields: [driverId], references: [id], onDelete: Cascade)
  routePlanId            String                   @db.Uuid
  routePlan              RoutePlan                @relation(fields: [routePlanId], references: [id], onDelete: Cascade)
  status                 DriverRouteSessionStatus @default(ACTIVE)
  currentRoutePlanStopId String?                  @db.Uuid
  currentRoutePlanStop   RoutePlanStop?           @relation(fields: [currentRoutePlanStopId], references: [id], onDelete: SetNull)
  navigationStepIndex    Int                      @default(0)
  startedAt              DateTime                 @db.Timestamptz(6)
  lastResumedAt          DateTime?                @db.Timestamptz(6)
  completedAt            DateTime?                @db.Timestamptz(6)
  lastEventId            String?                  @db.Uuid
  lastEvent              DriverEvent?             @relation(fields: [lastEventId], references: [id], onDelete: SetNull)
  createdAt              DateTime                 @default(now()) @db.Timestamptz(6)
  updatedAt              DateTime                 @updatedAt @db.Timestamptz(6)

  @@unique([driverId, routePlanId])
  @@index([shopId, driverId, status, updatedAt])
  @@index([shopId, routePlanId, status])
  @@map("driver_route_sessions")
}
```

The SQL migration should also enforce one active/paused operational route per
driver with a partial unique index. Prisma cannot fully express that rule, so it
must be migration/test documented.

## Recommended changes / no-changes

### No schema change now

- Keep `DriverSession` as auth-only.
- Keep `DriverEvent` as append-only audit.
- Keep `OrderDeliveryFact` as a planning readiness read model.
- Keep `DeliveryStop` as an execution snapshot of order delivery information.
- Keep tenant `shopId` repetitions for scope/indexing, with write-path
  validation.
- Keep legacy Shopify tables/fields until a separate commerce compatibility
  cleanup is approved.

### Narrow follow-up issues

1. **Driver route-session projection**
   - Add `DriverRouteSession` and `GET /driver/route-session/active`.
   - Harden start/progress/completion transactions against event/projection
     drift.
2. **No-migration bridge**
   - If deployment cannot take a migration, derive active session from
     `RoutePlan.status` + `DriverEvent` with documented limitations.
3. **Route status transition hardening**
   - `ROUTE_STARTED` should either promote eligible assigned/optimized route
     plans to `IN_PROGRESS`, or every restore/read path must resolve the event
     through a driver-owned route join before trusting it.
4. **Route replanning/history review**
   - Validate whether `RoutePlanStop @@unique([deliveryStopId])` should remain
     global if historical route versions are needed.
5. **Legacy commerce naming cleanup**
   - Later, decide whether Shopify-specific fields/tables should be renamed,
     wrapped, or retained as compatibility artifacts.

## Source anchors

- `apps/delivery-api/prisma/schema.prisma:169-213` — `Shop` tenant root and
  `routeScopeConfig` JSON.
- `apps/delivery-api/prisma/schema.prisma:314-349` — raw commerce ingest
  idempotency keys.
- `apps/delivery-api/prisma/schema.prisma:450-486` — canonical `Order` source
  identifiers and payload snapshots.
- `apps/delivery-api/prisma/schema.prisma:488-521` — `DeliveryStop` execution
  snapshot and stop status.
- `apps/delivery-api/prisma/schema.prisma:523-572` — `OrderDeliveryFact` read
  model/projection.
- `apps/delivery-api/prisma/schema.prisma:574-602` — `RoutePlan` assignment,
  constraints, metrics, and status.
- `apps/delivery-api/prisma/schema.prisma:632-649` — `RoutePlanStop` ordered
  join and uniqueness constraints.
- `apps/delivery-api/prisma/schema.prisma:679-691` — `DriverSession` auth
  refresh-token table.
- `apps/delivery-api/prisma/schema.prisma:817-839` — `DriverEvent` audit/event
  table.
- `apps/delivery-api/src/modules/driver/driver-auth.repository.ts:31-58` —
  refresh-token session lookup and `lastUsedAt` update.
- `apps/delivery-api/src/modules/driver/driver-auth.repository.ts:61-104` —
  invite verification creates a refresh-token `DriverSession`.
- `apps/delivery-api/src/modules/driver/driver-assigned-route.repository.ts:104-119` —
  assigned-route read scopes by authenticated driver/shop and active-ish route
  status.
- `apps/delivery-api/src/modules/driver/driver-event.repository.ts:52-95` —
  event write transaction.
- `apps/delivery-api/src/modules/driver/driver-event.repository.ts:130-170` —
  current event state transitions omit `ROUTE_STARTED` status promotion.
- `apps/delivery-api/src/modules/driver/driver-event.repository.ts:210-265` —
  route completion is gated by terminal stops plus `ROUTE_COMPLETED`.
- `apps/delivery-api/src/modules/route-plans/route-plan.repository.ts` — route
  stop updates enforce already-planned stop checks and recreate ordered stops.
- `apps/delivery-api/docs/api/driver-assigned-route.md:89` — assigned route
  status is limited to `ASSIGNED`, `IN_PROGRESS`, and `OPTIMIZED`.

## Verification expectation for this audit

Audit-only changes should pass:

- `git diff --check`
- an exact model-list check against `schema.prisma`
- markdown sanity checks for required sections and balanced code fences
- `npm --prefix apps/delivery-api run prisma:validate`

Implementation follow-up should additionally run `prisma:generate`, lint,
typecheck, targeted driver route-session tests, and the delivery API test suite.
