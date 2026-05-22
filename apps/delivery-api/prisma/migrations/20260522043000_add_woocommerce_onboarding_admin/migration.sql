-- Add support-safe WooCommerce credential onboarding metadata and audit trail.

ALTER TABLE "commerce_connections"
  ADD COLUMN IF NOT EXISTS "lastVerifiedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "lastVerificationStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "credentialRotatedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "webhookSecretRotatedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "credentialFingerprint" TEXT;

CREATE TABLE IF NOT EXISTS "commerce_connection_audit_logs" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "commerceConnectionId" UUID,
  "actorSubject" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "commerce_connection_audit_logs_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "commerce_connection_audit_logs"
    ADD CONSTRAINT "commerce_connection_audit_logs_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "commerce_connection_audit_logs"
    ADD CONSTRAINT "commerce_connection_audit_logs_commerceConnectionId_fkey"
    FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "commerce_connection_audit_logs_shopId_createdAt_idx"
  ON "commerce_connection_audit_logs"("shopId", "createdAt");

CREATE INDEX IF NOT EXISTS "commerce_connection_audit_logs_commerceConnectionId_createdAt_idx"
  ON "commerce_connection_audit_logs"("commerceConnectionId", "createdAt");
