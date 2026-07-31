-- Make previously applied DSV dispatch orders available to assignment commands.
-- Future imports create the same ownership rows in the apply transaction.
CREATE TEMP TABLE "_dsv_orphan_dispatch_rows" ON COMMIT DROP AS
SELECT
  candidate."shopId",
  candidate."importId",
  candidate."sellerOrderId",
  candidate."deliveryStopId",
  candidate."rowNumber"
FROM (
  SELECT
    row."shopId",
    row."importId",
    row."sellerOrderId",
    row."deliveryStopId",
    row."rowNumber",
    ROW_NUMBER() OVER (
      PARTITION BY row."shopId", row."sellerOrderId"
      ORDER BY import."appliedAt" DESC NULLS LAST, row."appliedAt" DESC NULLS LAST, row."createdAt" DESC
    ) AS "ownerRank"
  FROM "dsv_dispatch_import_rows" row
  JOIN "dsv_dispatch_imports" import ON import."id" = row."importId"
  WHERE row."status" = 'APPLIED'
    AND row."sellerOrderId" IS NOT NULL
    AND row."deliveryStopId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "route_grouping_orders" ownership
      WHERE ownership."shopId" = row."shopId"
        AND ownership."orderId" = row."sellerOrderId"
    )
) candidate
WHERE candidate."ownerRank" = 1;

CREATE TEMP TABLE "_dsv_dispatch_groupings" ON COMMIT DROP AS
SELECT
  import."id" AS "importId",
  import."shopId",
  gen_random_uuid() AS "groupingId",
  import."fileName",
  import."planDate",
  COALESCE(import."appliedBy", import."createdBy", 'dsv-grouping-backfill') AS actor
FROM "dsv_dispatch_imports" import
WHERE EXISTS (
  SELECT 1
  FROM "_dsv_orphan_dispatch_rows" row
  WHERE row."importId" = import."id"
);

INSERT INTO "route_groupings" (
  "id", "shopId", "name", "planDate", "routeScopeKey", "serviceType",
  "status", "currentVersion", "createdBy", "createdAt", "updatedAt"
)
SELECT
  grouping."groupingId",
  grouping."shopId",
  grouping."fileName",
  grouping."planDate",
  'dsv-import:' || grouping."importId"::text,
  'DSV_DISPATCH',
  'READY',
  1,
  grouping.actor,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_dsv_dispatch_groupings" grouping;

INSERT INTO "route_grouping_versions" (
  "id", "shopId", "groupingId", "version", "status", "changeReason", "actor", "createdAt"
)
SELECT
  gen_random_uuid(),
  grouping."shopId",
  grouping."groupingId",
  1,
  'CURRENT',
  'Backfill DSV dispatch assignment ownership',
  grouping.actor,
  CURRENT_TIMESTAMP
FROM "_dsv_dispatch_groupings" grouping;

INSERT INTO "route_grouping_orders" (
  "id", "shopId", "groupingId", "orderId", "deliveryStopId", "assignmentStatus",
  "sourceSequence", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  row."shopId",
  grouping."groupingId",
  row."sellerOrderId",
  row."deliveryStopId",
  'UNASSIGNED',
  ROW_NUMBER() OVER (PARTITION BY row."importId" ORDER BY row."rowNumber")::integer,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_dsv_orphan_dispatch_rows" row
JOIN "_dsv_dispatch_groupings" grouping ON grouping."importId" = row."importId";
