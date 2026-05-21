-- Add encrypted multi-tenant commerce connector storage for WooCommerce.

DO $$
BEGIN
  CREATE TYPE "CommerceConnectionStatus" AS ENUM ('ACTIVE', 'DISABLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "commerce_connections" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "platform" "CommerceSourcePlatform" NOT NULL,
  "status" "CommerceConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  "label" TEXT,
  "siteUrl" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "timezone" TEXT,
  "consumerKeyCiphertext" TEXT NOT NULL,
  "consumerSecretCiphertext" TEXT NOT NULL,
  "webhookSecretCiphertext" TEXT NOT NULL,
  "lastSyncAt" TIMESTAMPTZ(6),
  "lastSyncStatus" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "commerce_connections_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "commerce_connections"
    ADD CONSTRAINT "commerce_connections_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "commerce_connections_shopId_platform_siteUrl_key"
  ON "commerce_connections"("shopId", "platform", "siteUrl");

CREATE INDEX IF NOT EXISTS "commerce_connections_shopId_platform_status_idx"
  ON "commerce_connections"("shopId", "platform", "status");

CREATE INDEX IF NOT EXISTS "commerce_connections_platform_siteUrl_idx"
  ON "commerce_connections"("platform", "siteUrl");

CREATE UNIQUE INDEX IF NOT EXISTS "orders_shopId_sourcePlatform_sourceSiteUrl_sourceOrderId_key"
  ON "orders"("shopId", "sourcePlatform", "sourceSiteUrl", "sourceOrderId");

DROP INDEX IF EXISTS "orders_shopId_sourcePlatform_sourceOrderId_key";

CREATE INDEX IF NOT EXISTS "orders_shopId_sourcePlatform_sourceSiteUrl_sourceOrderNumber_idx"
  ON "orders"("shopId", "sourcePlatform", "sourceSiteUrl", "sourceOrderNumber");

DROP INDEX IF EXISTS "orders_shopId_sourcePlatform_sourceOrderNumber_idx";
