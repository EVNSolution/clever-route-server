ALTER TABLE "shops" ADD COLUMN "appId" TEXT NOT NULL DEFAULT 'clever';

DROP INDEX IF EXISTS "shops_shopDomain_key";
DROP INDEX IF EXISTS "shops_shopifyShopGid_key";

CREATE UNIQUE INDEX "shops_appId_shopDomain_key" ON "shops"("appId", "shopDomain");
CREATE UNIQUE INDEX "shops_appId_shopifyShopGid_key" ON "shops"("appId", "shopifyShopGid");
CREATE INDEX "shops_shopDomain_idx" ON "shops"("shopDomain");
