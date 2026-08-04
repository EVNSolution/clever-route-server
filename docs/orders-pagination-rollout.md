# Orders pagination rollout evidence

## Sequence population gate

1. Apply the nullable schema migration.
2. Run `npm --prefix apps/delivery-api run orders:display-sequence:backfill` repeatedly until it exits `0` with `complete: true`.
3. Retain only aggregate output (`updated`, `rejected`, `remaining`, and per-source outcome counts). The script never logs order IDs or source order numbers.
4. Pagination remains disabled while `remaining > 0`; the API also returns `ORDERS_PAGINATION_NOT_READY` if any reachable row has a null sequence.

## Query-plan gate

Run `apps/delivery-api/scripts/orders-pagination-query-plan.sql` against a production-like clone with non-PII fixture parameters. Approve only when the JSON plan uses `orders_shopId_displayOrderSequence_id_idx`, reads no more than 51 post-filter candidates, and does not perform a sequential scan at the measured cohort size. Store the plan in private change-control evidence, not the repository.

Planning-scope page, facet, map, and selection requests must carry the shop-local
`routeOpsToday=YYYY-MM-DD`. The API rejects a missing reference date with `400`
instead of inferring server time or silently returning an empty result.

## Rollback rehearsal

Disable server pagination while keeping canonical-first reads enabled and automatic Shopify sync-on-load disabled. The existing unpaged `GET /admin/orders` remains the compatibility path. Leave `displayOrderSequence` and snapshot tables inert; do not delete canonical Orders or mutate Shopify. If the new index harms writes, drop only `orders_shopId_displayOrderSequence_id_idx` using the approved non-blocking production procedure after pagination is disabled.

At runtime, removing `ORDERS_PAGINATION_HMAC_KEY` cleanly disables the page,
facet, map, and snapshot resources with `404`; it does not expose configured
service methods that fail after request dispatch.
