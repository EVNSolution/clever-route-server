-- Run with non-PII fixture values in a production-like clone:
-- psql "$DATABASE_URL" -v shop_id=... -v watermark=... -v sequence=... -v order_id=... -f scripts/orders-pagination-query-plan.sql
BEGIN;
SET LOCAL statement_timeout = '5s';

EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT "id", "displayOrderSequence"
FROM "orders"
WHERE "shopId" = :'shop_id'::uuid
  AND "createdAt" <= :'watermark'::timestamptz
  AND "displayOrderSequence" IS NOT NULL
  AND "displayOrderSequence" <= :'sequence'::bigint
  AND (
    "displayOrderSequence" < :'sequence'::bigint
    OR ("displayOrderSequence" = :'sequence'::bigint AND "id" < :'order_id'::uuid)
  )
ORDER BY "displayOrderSequence" DESC, "id" DESC
LIMIT 51;

ROLLBACK;
