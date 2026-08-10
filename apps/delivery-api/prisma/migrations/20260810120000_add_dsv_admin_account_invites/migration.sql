ALTER TABLE "dsv_admin_accounts" ADD COLUMN IF NOT EXISTS "email" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "dsv_admin_accounts_email_key"
ON "dsv_admin_accounts"("email");

CREATE TABLE IF NOT EXISTS "dsv_admin_account_invites" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "displayName" TEXT,
  "email" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "consumedAt" TIMESTAMPTZ(6),
  "revokedAt" TIMESTAMPTZ(6),
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dsv_admin_account_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dsv_admin_account_invites_tokenHash_key"
ON "dsv_admin_account_invites"("tokenHash");

CREATE INDEX IF NOT EXISTS "dsv_admin_account_invites_shopId_email_expiresAt_idx"
ON "dsv_admin_account_invites"("shopId", "email", "expiresAt");

DO $$
BEGIN
  ALTER TABLE "dsv_admin_account_invites"
    ADD CONSTRAINT "dsv_admin_account_invites_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
