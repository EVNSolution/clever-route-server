-- Add server-owned Woo delivery mapping configuration and queryable delivery-facts projection.

DO $$
BEGIN
  CREATE TYPE "DeliveryDayParseStatus" AS ENUM ('NOT_PROVIDED', 'PARSED', 'UNPARSED', 'UNVERIFIED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "OrderDeliveryFactReadiness" AS ENUM ('READY_TO_PLAN', 'NEEDS_REVIEW', 'SKIPPED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "commerce_connection_order_mappings" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "commerceConnectionId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "config" JSONB NOT NULL,
  "discoveredPathStats" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "commerce_connection_order_mappings_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "commerce_connection_order_mappings"
    ADD CONSTRAINT "commerce_connection_order_mappings_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "commerce_connection_order_mappings"
    ADD CONSTRAINT "commerce_connection_order_mappings_commerceConnectionId_fkey"
    FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "commerce_connection_order_mappings_commerceConnectionId_key"
  ON "commerce_connection_order_mappings"("commerceConnectionId");

CREATE INDEX IF NOT EXISTS "commerce_connection_order_mappings_shopId_idx"
  ON "commerce_connection_order_mappings"("shopId");

CREATE TABLE IF NOT EXISTS "order_delivery_facts" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "commerceConnectionId" UUID,
  "sourcePlatform" "CommerceSourcePlatform" NOT NULL,
  "sourceSiteUrl" TEXT,
  "sourceOrderId" TEXT,
  "sourceOrderNumber" TEXT,
  "sourceUpdatedAt" TIMESTAMPTZ(6),
  "rawDeliveryDate" TEXT,
  "rawDeliveryDay" TEXT,
  "rawDeliveryTimeWindow" TEXT,
  "rawDeliveryArea" TEXT,
  "rawPickupDay" TEXT,
  "matchedMappingPaths" JSONB NOT NULL,
  "mappingDiagnostics" JSONB,
  "deliveryDayParseStatus" "DeliveryDayParseStatus" NOT NULL DEFAULT 'NOT_PROVIDED',
  "deliveryDayUnparsedReason" TEXT,
  "deliveryDateWeekdayVerified" BOOLEAN NOT NULL DEFAULT false,
  "deliveryDateWeekdayMismatch" BOOLEAN NOT NULL DEFAULT false,
  "deliveryDate" DATE,
  "deliveryWeekday" TEXT,
  "deliveryDateWeekday" TEXT,
  "deliverySession" TEXT,
  "serviceType" TEXT,
  "timeWindowStart" TIMESTAMPTZ(6),
  "timeWindowEnd" TIMESTAMPTZ(6),
  "deliveryArea" TEXT,
  "routeScopeKey" TEXT,
  "planningGroupKey" TEXT,
  "readiness" "OrderDeliveryFactReadiness" NOT NULL DEFAULT 'NEEDS_REVIEW',
  "reviewReasons" JSONB NOT NULL,
  "batchEligible" BOOLEAN NOT NULL DEFAULT false,
  "geocodeStatus" "GeocodeStatus" NOT NULL DEFAULT 'PENDING',
  "computedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "order_delivery_facts_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "order_delivery_facts"
    ADD CONSTRAINT "order_delivery_facts_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "order_delivery_facts"
    ADD CONSTRAINT "order_delivery_facts_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "order_delivery_facts"
    ADD CONSTRAINT "order_delivery_facts_commerceConnectionId_fkey"
    FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "order_delivery_facts_shopId_orderId_key"
  ON "order_delivery_facts"("shopId", "orderId");

CREATE INDEX IF NOT EXISTS "order_delivery_facts_shopId_deliveryDate_readiness_idx"
  ON "order_delivery_facts"("shopId", "deliveryDate", "readiness");

CREATE INDEX IF NOT EXISTS "order_delivery_facts_shopId_routeScopeKey_batchEligible_idx"
  ON "order_delivery_facts"("shopId", "routeScopeKey", "batchEligible");

CREATE INDEX IF NOT EXISTS "order_delivery_facts_shopId_planningGroupKey_idx"
  ON "order_delivery_facts"("shopId", "planningGroupKey");

CREATE INDEX IF NOT EXISTS "order_delivery_facts_commerceConnectionId_sourceUpdatedAt_idx"
  ON "order_delivery_facts"("commerceConnectionId", "sourceUpdatedAt");

CREATE INDEX IF NOT EXISTS "order_delivery_facts_shopId_sourcePlatform_sourceSiteUrl_sourceOrderId_idx"
  ON "order_delivery_facts"("shopId", "sourcePlatform", "sourceSiteUrl", "sourceOrderId");

-- Enforce that one delivery stop can belong to at most one route draft/plan at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "route_plan_stops_deliveryStopId_key"
  ON "route_plan_stops"("deliveryStopId");
