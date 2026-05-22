-- Add WordPress/WooCommerce plugin connector auth and split freshness watermarks.

DO $$
BEGIN
  CREATE TYPE "WordPressPluginTokenStatus" AS ENUM ('ACTIVE', 'REVOKED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "commerce_connections"
  ADD COLUMN IF NOT EXISTS "lastWebhookAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "lastRestSyncAt" TIMESTAMPTZ(6);

CREATE TABLE IF NOT EXISTS "wordpress_plugin_tokens" (
  "id" UUID NOT NULL,
  "commerceConnectionId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "tokenPrefix" TEXT NOT NULL,
  "status" "WordPressPluginTokenStatus" NOT NULL DEFAULT 'ACTIVE',
  "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMPTZ(6),
  "rotatedAt" TIMESTAMPTZ(6),
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "wordpress_plugin_tokens_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "wordpress_plugin_tokens"
    ADD CONSTRAINT "wordpress_plugin_tokens_commerceConnectionId_fkey"
    FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "wordpress_plugin_tokens_tokenHash_key"
  ON "wordpress_plugin_tokens"("tokenHash");

CREATE INDEX IF NOT EXISTS "wordpress_plugin_tokens_commerceConnectionId_status_idx"
  ON "wordpress_plugin_tokens"("commerceConnectionId", "status");

CREATE TABLE IF NOT EXISTS "wordpress_plugin_pairing_codes" (
  "id" UUID NOT NULL,
  "commerceConnectionId" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "codeHash" TEXT NOT NULL,
  "siteUrl" TEXT NOT NULL,
  "issuedBy" TEXT,
  "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "consumedAt" TIMESTAMPTZ(6),
  "consumedBySiteUrl" TEXT,
  "failedAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastFailedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "wordpress_plugin_pairing_codes_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "wordpress_plugin_pairing_codes"
    ADD CONSTRAINT "wordpress_plugin_pairing_codes_commerceConnectionId_fkey"
    FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "wordpress_plugin_pairing_codes"
    ADD CONSTRAINT "wordpress_plugin_pairing_codes_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "wordpress_plugin_pairing_codes_codeHash_key"
  ON "wordpress_plugin_pairing_codes"("codeHash");

CREATE INDEX IF NOT EXISTS "wordpress_plugin_pairing_codes_commerceConnectionId_expiresAt_idx"
  ON "wordpress_plugin_pairing_codes"("commerceConnectionId", "expiresAt");

CREATE INDEX IF NOT EXISTS "wordpress_plugin_pairing_codes_shopId_expiresAt_idx"
  ON "wordpress_plugin_pairing_codes"("shopId", "expiresAt");
