ALTER TABLE "inventories"
  ADD COLUMN IF NOT EXISTS "routeGroupingId" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "inventories_routeGroupingId_key" ON "inventories"("routeGroupingId");

DO $$ BEGIN
  ALTER TABLE "inventories" ADD CONSTRAINT "inventories_routeGroupingId_fkey" FOREIGN KEY ("routeGroupingId") REFERENCES "route_groupings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "inventory_events"
  ADD COLUMN IF NOT EXISTS "quantityDelta" INTEGER,
  ALTER COLUMN "orderItemId" DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE "inventory_events" DROP CONSTRAINT IF EXISTS "inventory_events_orderItemId_fkey";
  ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

WITH missing_group_inventories AS (
  INSERT INTO "inventories" ("id", "shopId", "routeGroupingId", "name", "createdBy", "createdAt", "updatedAt")
  SELECT gen_random_uuid(), rg."shopId", rg."id", rg."name", rg."createdBy", rg."createdAt", rg."updatedAt"
  FROM "route_groupings" rg
  LEFT JOIN "inventories" i ON i."routeGroupingId" = rg."id"
  WHERE i."id" IS NULL
  ON CONFLICT ("routeGroupingId") DO NOTHING
  RETURNING "id", "shopId", "routeGroupingId", "createdBy"
)
INSERT INTO "inventory_orders" ("id", "shopId", "inventoryId", "orderId", "addedBy", "createdAt", "updatedAt")
SELECT gen_random_uuid(), mgi."shopId", mgi."id", rgo."orderId", COALESCE(mgi."createdBy", 'route-grouping-backfill'), rgo."createdAt", rgo."updatedAt"
FROM missing_group_inventories mgi
JOIN "route_grouping_orders" rgo ON rgo."groupingId" = mgi."routeGroupingId" AND rgo."shopId" = mgi."shopId"
ON CONFLICT ("inventoryId", "orderId") DO NOTHING;
