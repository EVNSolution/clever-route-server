CREATE TABLE IF NOT EXISTS "geocoding_caches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopDomain" TEXT NOT NULL,
  "cacheKey" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "cachedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "geocoding_caches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "geocoding_caches_shopDomain_cacheKey_key"
  ON "geocoding_caches"("shopDomain", "cacheKey");

CREATE INDEX IF NOT EXISTS "geocoding_caches_expiresAt_idx"
  ON "geocoding_caches"("expiresAt");
