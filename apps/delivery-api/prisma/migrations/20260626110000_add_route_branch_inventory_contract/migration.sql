ALTER TABLE "route_grouping_branches"
  ADD COLUMN IF NOT EXISTS "color" TEXT,
  ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "route_grouping_branches_groupingId_sortOrder_idx" ON "route_grouping_branches"("groupingId", "sortOrder");

CREATE TABLE IF NOT EXISTS "inventories" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "note" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "inventory_orders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "inventoryId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "addedBy" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "inventory_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "inventoryId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "orderItemId" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "productId" INTEGER NOT NULL,
  "variationId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "sku" TEXT,
  "options" JSONB NOT NULL,
  "quantity" INTEGER NOT NULL,
  "actor" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "inventories_shopId_createdAt_idx" ON "inventories"("shopId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_orders_inventoryId_orderId_key" ON "inventory_orders"("inventoryId", "orderId");
CREATE INDEX IF NOT EXISTS "inventory_orders_shopId_orderId_idx" ON "inventory_orders"("shopId", "orderId");
CREATE INDEX IF NOT EXISTS "inventory_events_inventoryId_createdAt_idx" ON "inventory_events"("inventoryId", "createdAt");
CREATE INDEX IF NOT EXISTS "inventory_events_shopId_orderId_idx" ON "inventory_events"("shopId", "orderId");
CREATE INDEX IF NOT EXISTS "inventory_events_shopId_productId_variationId_idx" ON "inventory_events"("shopId", "productId", "variationId");

DO $$ BEGIN
  ALTER TABLE "inventories" ADD CONSTRAINT "inventories_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_orders" ADD CONSTRAINT "inventory_orders_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_orders" ADD CONSTRAINT "inventory_orders_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "inventories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_orders" ADD CONSTRAINT "inventory_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "inventories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
