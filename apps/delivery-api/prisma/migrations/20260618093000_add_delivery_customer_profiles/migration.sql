CREATE TABLE IF NOT EXISTS "delivery_customer_profiles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "canonicalName" TEXT,
  "canonicalPhone" TEXT,
  "canonicalEmail" TEXT,
  "addressFingerprint" TEXT NOT NULL,
  "normalizedAddress" JSONB NOT NULL,
  "normalizedNameKey" TEXT,
  "adminMemo" TEXT,
  "mergedIntoProfileId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delivery_customer_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "delivery_customer_profiles_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "delivery_customer_profiles_mergedIntoProfileId_fkey" FOREIGN KEY ("mergedIntoProfileId") REFERENCES "delivery_customer_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "delivery_customer_profile_order_links" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "profileId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "matchStatus" TEXT NOT NULL,
  "matchScore" DECIMAL(5,4),
  "matchReasons" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delivery_customer_profile_order_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "delivery_customer_profile_order_links_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "delivery_customer_profile_order_links_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "delivery_customer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "delivery_customer_profile_order_links_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "delivery_customer_profile_order_links_shopId_orderId_key" ON "delivery_customer_profile_order_links"("shopId", "orderId");
CREATE INDEX IF NOT EXISTS "delivery_customer_profiles_shopId_addressFingerprint_idx" ON "delivery_customer_profiles"("shopId", "addressFingerprint");
CREATE INDEX IF NOT EXISTS "delivery_customer_profiles_shopId_canonicalPhone_idx" ON "delivery_customer_profiles"("shopId", "canonicalPhone");
CREATE INDEX IF NOT EXISTS "delivery_customer_profiles_shopId_canonicalEmail_idx" ON "delivery_customer_profiles"("shopId", "canonicalEmail");
CREATE INDEX IF NOT EXISTS "delivery_customer_profiles_shopId_mergedIntoProfileId_idx" ON "delivery_customer_profiles"("shopId", "mergedIntoProfileId");
CREATE INDEX IF NOT EXISTS "delivery_customer_profile_order_links_shopId_profileId_idx" ON "delivery_customer_profile_order_links"("shopId", "profileId");
