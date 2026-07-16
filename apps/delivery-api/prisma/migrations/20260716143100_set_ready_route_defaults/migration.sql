-- New route plans and route groupings are immediately executable-ready.
-- Existing legacy values remain unchanged and are normalized by application code.
ALTER TABLE "route_plans" ALTER COLUMN "status" SET DEFAULT 'READY';
ALTER TABLE "route_groupings" ALTER COLUMN "status" SET DEFAULT 'READY';
