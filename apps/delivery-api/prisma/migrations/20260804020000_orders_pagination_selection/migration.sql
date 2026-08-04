ALTER TABLE "orders"
ADD COLUMN "displayOrderSequence" BIGINT;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "orders_name_trgm_idx" ON "orders" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "orders_email_trgm_idx" ON "orders" USING GIN ("email" gin_trgm_ops);
CREATE INDEX "orders_phone_trgm_idx" ON "orders" USING GIN ("phone" gin_trgm_ops);
CREATE INDEX "orders_sourceOrderId_trgm_idx" ON "orders" USING GIN ("sourceOrderId" gin_trgm_ops);
CREATE INDEX "orders_sourceOrderNumber_trgm_idx" ON "orders" USING GIN ("sourceOrderNumber" gin_trgm_ops);
CREATE INDEX "orders_shopifyOrderGid_trgm_idx" ON "orders" USING GIN ("shopifyOrderGid" gin_trgm_ops);

CREATE INDEX "delivery_stops_recipientName_trgm_idx" ON "delivery_stops" USING GIN ("recipientName" gin_trgm_ops);
CREATE INDEX "delivery_stops_phone_trgm_idx" ON "delivery_stops" USING GIN ("phone" gin_trgm_ops);
CREATE INDEX "delivery_stops_address1_trgm_idx" ON "delivery_stops" USING GIN ("address1" gin_trgm_ops);
CREATE INDEX "delivery_stops_address2_trgm_idx" ON "delivery_stops" USING GIN ("address2" gin_trgm_ops);
CREATE INDEX "delivery_stops_city_trgm_idx" ON "delivery_stops" USING GIN ("city" gin_trgm_ops);
CREATE INDEX "delivery_stops_province_trgm_idx" ON "delivery_stops" USING GIN ("province" gin_trgm_ops);
CREATE INDEX "delivery_stops_postalCode_trgm_idx" ON "delivery_stops" USING GIN ("postalCode" gin_trgm_ops);
CREATE INDEX "delivery_stops_countryCode_trgm_idx" ON "delivery_stops" USING GIN ("countryCode" gin_trgm_ops);

CREATE INDEX "order_delivery_facts_deliveryArea_trgm_idx" ON "order_delivery_facts" USING GIN ("deliveryArea" gin_trgm_ops);
CREATE INDEX "order_delivery_facts_rawDeliveryArea_trgm_idx" ON "order_delivery_facts" USING GIN ("rawDeliveryArea" gin_trgm_ops);
CREATE INDEX "order_delivery_facts_rawDeliveryDate_trgm_idx" ON "order_delivery_facts" USING GIN ("rawDeliveryDate" gin_trgm_ops);
CREATE INDEX "order_delivery_facts_rawDeliveryDay_trgm_idx" ON "order_delivery_facts" USING GIN ("rawDeliveryDay" gin_trgm_ops);
CREATE INDEX "order_delivery_facts_rawTimeWindow_trgm_idx" ON "order_delivery_facts" USING GIN ("rawDeliveryTimeWindow" gin_trgm_ops);
CREATE INDEX "order_delivery_facts_rawPickupDay_trgm_idx" ON "order_delivery_facts" USING GIN ("rawPickupDay" gin_trgm_ops);
CREATE INDEX "order_delivery_facts_weekday_trgm_idx" ON "order_delivery_facts" USING GIN ("deliveryWeekday" gin_trgm_ops);
CREATE INDEX "order_delivery_facts_dateWeekday_trgm_idx" ON "order_delivery_facts" USING GIN ("deliveryDateWeekday" gin_trgm_ops);
CREATE INDEX "order_delivery_facts_session_trgm_idx" ON "order_delivery_facts" USING GIN ("deliverySession" gin_trgm_ops);
CREATE INDEX "order_delivery_facts_serviceType_trgm_idx" ON "order_delivery_facts" USING GIN ("serviceType" gin_trgm_ops);
CREATE INDEX "order_delivery_facts_routeScopeKey_trgm_idx" ON "order_delivery_facts" USING GIN ("routeScopeKey" gin_trgm_ops);
CREATE INDEX "order_delivery_facts_planningGroupKey_trgm_idx" ON "order_delivery_facts" USING GIN ("planningGroupKey" gin_trgm_ops);

CREATE INDEX "orders_shopId_displayOrderSequence_id_idx"
ON "orders" ("shopId", "displayOrderSequence" DESC, "id" DESC);

CREATE TABLE "order_selection_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "appId" TEXT NOT NULL,
  "actorSubjectHash" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "filterHash" TEXT NOT NULL,
  "sort" TEXT NOT NULL,
  "selectedCount" INTEGER NOT NULL,
  "snapshotWatermark" TIMESTAMPTZ(6) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "consumedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_selection_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_selection_snapshots_tokenHash_key"
ON "order_selection_snapshots" ("tokenHash");
CREATE INDEX "order_selection_snapshots_shopId_appId_actorSubjectHash_expiresAt_idx"
ON "order_selection_snapshots" ("shopId", "appId", "actorSubjectHash", "expiresAt");
CREATE INDEX "order_selection_snapshots_expiresAt_consumedAt_idx"
ON "order_selection_snapshots" ("expiresAt", "consumedAt");

CREATE TABLE "order_selection_snapshot_orders" (
  "snapshotId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "excludedAt" TIMESTAMPTZ(6),
  CONSTRAINT "order_selection_snapshot_orders_pkey" PRIMARY KEY ("snapshotId", "orderId")
);

CREATE INDEX "order_selection_snapshot_orders_snapshotId_excludedAt_idx"
ON "order_selection_snapshot_orders" ("snapshotId", "excludedAt");
CREATE INDEX "order_selection_snapshot_orders_orderId_idx"
ON "order_selection_snapshot_orders" ("orderId");

ALTER TABLE "order_selection_snapshots"
ADD CONSTRAINT "order_selection_snapshots_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_selection_snapshot_orders"
ADD CONSTRAINT "order_selection_snapshot_orders_snapshotId_fkey"
FOREIGN KEY ("snapshotId") REFERENCES "order_selection_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_selection_snapshot_orders"
ADD CONSTRAINT "order_selection_snapshot_orders_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
