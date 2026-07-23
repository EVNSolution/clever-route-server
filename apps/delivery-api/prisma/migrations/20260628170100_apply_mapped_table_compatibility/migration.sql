-- G007 compatibility bridge cleanup.
-- Apply the intended historical effects to mapped lowercase tables, then remove only bridge-created placeholders.

ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "routeOpsUiSettings" JSONB;

UPDATE "route_plans"
SET "status" = CASE "status"::text
  WHEN 'OPTIMIZED' THEN 'DRAFT'
  WHEN 'ASSIGNED' THEN 'PUBLISHED'
  WHEN 'IN_PROGRESS' THEN 'PUBLISHED'
  WHEN 'COMPLETED' THEN 'PUBLISHED'
  ELSE "status"::text
END::"RoutePlanStatus"
WHERE "status"::text IN ('OPTIMIZED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED');

UPDATE "route_groupings"
SET "status" = CASE "status"::text
  WHEN 'READY' THEN 'DRAFT'
  WHEN 'CHANGED' THEN 'DRAFT'
  ELSE "status"::text
END::"RouteGroupingStatus"
WHERE "status"::text IN ('READY', 'CHANGED');

DO $$
DECLARE
  legacy_oid oid;
BEGIN
  SELECT to_regclass('"RouteGrouping"') INTO legacy_oid;
  IF legacy_oid IS NOT NULL
    AND obj_description(legacy_oid, 'pg_class') = 'G007 transient mapped-table compatibility bridge' THEN
    DROP TABLE "RouteGrouping";
  END IF;

  SELECT to_regclass('"RoutePlan"') INTO legacy_oid;
  IF legacy_oid IS NOT NULL
    AND obj_description(legacy_oid, 'pg_class') = 'G007 transient mapped-table compatibility bridge' THEN
    DROP TABLE "RoutePlan";
  END IF;

  SELECT to_regclass('"Shop"') INTO legacy_oid;
  IF legacy_oid IS NOT NULL
    AND obj_description(legacy_oid, 'pg_class') = 'G007 transient mapped-table compatibility bridge' THEN
    DROP TABLE "Shop";
  END IF;
END $$;
