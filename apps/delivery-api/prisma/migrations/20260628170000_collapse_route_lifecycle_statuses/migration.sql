-- Collapse route/group persisted lifecycle states to DRAFT/PUBLISHED/CANCELLED.
-- Operational progress is represented by driver events and delivery stop state.

ALTER TABLE "RoutePlan" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "RoutePlanStatus" RENAME TO "RoutePlanStatus_old";
CREATE TYPE "RoutePlanStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');
ALTER TABLE "RoutePlan" ALTER COLUMN "status" TYPE "RoutePlanStatus" USING (
  CASE "status"::text
    WHEN 'OPTIMIZED' THEN 'DRAFT'
    WHEN 'ASSIGNED' THEN 'PUBLISHED'
    WHEN 'IN_PROGRESS' THEN 'PUBLISHED'
    WHEN 'COMPLETED' THEN 'PUBLISHED'
    ELSE "status"::text
  END
)::"RoutePlanStatus";
ALTER TABLE "RoutePlan" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
DROP TYPE "RoutePlanStatus_old";

ALTER TABLE "RouteGrouping" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "RouteGroupingStatus" RENAME TO "RouteGroupingStatus_old";
CREATE TYPE "RouteGroupingStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');
ALTER TABLE "RouteGrouping" ALTER COLUMN "status" TYPE "RouteGroupingStatus" USING (
  CASE "status"::text
    WHEN 'READY' THEN 'DRAFT'
    WHEN 'CHANGED' THEN 'DRAFT'
    ELSE "status"::text
  END
)::"RouteGroupingStatus";
ALTER TABLE "RouteGrouping" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
DROP TYPE "RouteGroupingStatus_old";
