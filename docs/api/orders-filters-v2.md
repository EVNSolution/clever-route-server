# Orders filters v2

This additive query contract follows PR467 (received-date source/timezone). It introduces no migrations, collection/backfill, mutation policy, or route execution changes. Unversioned requests keep v1 predicates, including overlapping legacy `deliveryState` and raw `deliveryWeekday` semantics. `filterVersion=2` cannot be mixed with v1 keys; unknown versions/keys, invalid dates/enums, duplicate scalars and incompatible missing-date/range requests return 400.

All Orders resources (`/admin/orders`, `/page`, `/facets`, `/map-points`, `/selection-snapshots`) use `toCanonicalOrderWhere`. Authentication and shop/app scope are unchanged. Default v2 means all imported upstream orders, including cancelled and missing fields; existing CUSTOM and CLEVER_ROUTE_COPY exclusions remain. Selection snapshots record the same base cohort, then retain the existing cancellation/action eligibility exclusions. Map results retain the existing coordinate requirement and 2,000 cap, with omittedCount. Pagination retains the existing watermark/sequence rules.

| Key | Meaning |
| --- | --- |
| receivedDateFrom / receivedDateTo | Shopify Order.processedAt; inclusive store calendar dates via [from midnight, day after to midnight). Store IANA required; the Shopify BFF overrides any client timezone with authenticated metadata. |
| scheduledDateFrom / scheduledDateTo | Inclusive date-only OrderDeliveryFact.deliveryDate; the current scheduled date, not completion. |
| scheduledDateMissing=true | Fact.date null or no fact; excludes range and weekdays. |
| scheduledWeekdays | Actual date weekdays; EXTRACT(DOW) from DB date, never raw service weekday/category. |
| serviceTypes | DELIVERY, EVENING_DELIVERY, PICKUP, UNKNOWN (absent/unclassified fact type). |
| deliveryProgress | unplanned, planned, assigned_in_progress, delivered, failed, skipped, cancelled, pickup_elapsed, unknown. |
| fulfillmentStatuses | Shopify display fulfillment; OPEN/RESTOCKED grouped UNFULFILLED, PENDING_FULFILLMENT grouped IN_PROGRESS. Null/unrecognized = UNKNOWN. Raw source values remain stored and returned. |
| paymentStatuses | Operational payment: valid cleverManualPaymentStatus PAID/PENDING/UNKNOWN wins, otherwise DB financialStatus. Null/unrecognized = UNKNOWN. Not payment method/gateway. |
| cancelled | Upstream cancelledAt presence; independent from payment VOIDED and delivery stop CANCELLED. |
| areas / areaMissing=true | Current fact area values, OR null/empty/no fact. |
| search | Existing text search semantics. |
| orderNumberPrefix | Displayed order number (`Order.name`) prefix only. The boundary trims whitespace and one optional leading `#`. A prefix with no value or another leading `#` is invalid. Matching is case-insensitive, left-to-right, and treats `%`, `_`, and `\\` as literal characters. It does not search source IDs, customer data, addresses, phones, GIDs, delivery fields, or planning status. Internal predicates consume the boundary-normalized value and do not strip `#` again. |

Arrays are repeated URL keys or JSON string arrays (empty means all); values are deduplicated/sorted by the request boundary. Dimensions AND; values in one dimension OR. Range AND weekday operates on the same fact date. Reversed date bounds are sorted. BFF requests use body transport for session tokens; tokens never appear in query URLs. `orderedDateTimeZone` is authenticated store metadata on BFF requests. Internal actual-date resolution is never accepted from clients or added to cursor/filter hashes.

Progress precedence: invalid current ownership / no stop → unknown; CURRENT unsuperseded ownership uses its route, otherwise only orders without an owner pointer use existing route membership. Awaiting READY/legacy preparation route → planned, preventing historical Stop DELIVERED from winning. Without an awaiting route, explicit terminal Stop wins; then pickup deadline/date elapsed → pickup_elapsed; then IN_PROGRESS route or assigned/en_route/arrived stop → assigned_in_progress; otherwise pending/no active route → unplanned. Pickup elapsed does not confirm collection or fulfillment. No date-delay state is invented.

Facets count the whole cohort after removing their own dimension. Current selected zero-count options are retained by the UI. No client-side filtering of paginated v2 rows. V2 query rows add filterVersion/queryDeliveryProgress and use fact date/area/type, including actual nulls, to match the predicate.

Example: `filterVersion=2&scheduledWeekdays=FRIDAY&serviceTypes=PICKUP&fulfillmentStatuses=UNFULFILLED&paymentStatuses=PENDING&orderedDateTimeZone=America%2FToronto`. Dates/type/status remain independent. No saved view or persistence is added.

## Release/rollback

Followup is stacked on PR467, not merged/deployed by this change. Pair with the web filter followup stacked on PR310. Deploy API before the new web UI after separate approval; revert/restore the web first if v2 is withdrawn. This schema-free change needs no DB restore; revert only filter commits to retain the received-date/Copy fixes. Keep v1 support through rollback. 2026-10-01T06:13:40Z observed operating API f17338f, image `ghcr.io/evnsolution/clever-route-server-delivery-api@sha256:e420970dcc790d29c5e3cc600d5245abb6f0924bc45036a86bc9806e472a7535`; web f41d3c2, Kfood image ID `sha256:9370ac18a4e08ab4104a44a8132c7dd99e8aca8c9e203d0d1ce9403b7820afa2`. Re-read actual runtime before any future deployment.

## Validation

Unit/API auth boundaries, repeated arrays, v1 compatibility, nulls and DST are covered by order-filters-v2 tests. Guarded integration suite uses synthetic fixtures in the task-owned localhost disposable DB only (`ORDERS_V2_DATABASE_TARGET_CLASS=safe-local-orders-v2-disposable` and explicit ORDERS_V2_DATABASE_URL). It compares actual SQL/Prisma cohorts for page/count/facets/map/snapshot and row progress. No production browser/mobile acceptance is claimed.
