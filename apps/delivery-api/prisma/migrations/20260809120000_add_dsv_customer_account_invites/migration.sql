DO $$
BEGIN
  CREATE TYPE "DsvCustomerAccountInvitePurpose" AS ENUM ('SIGNUP', 'PASSWORD_RESET');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "customer_accounts" ADD COLUMN IF NOT EXISTS "loginId" TEXT;
ALTER TABLE "customer_accounts" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
ALTER TABLE "customer_accounts" ADD COLUMN IF NOT EXISTS "passwordSalt" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "customer_accounts_loginId_key"
ON "customer_accounts"("loginId");

CREATE INDEX IF NOT EXISTS "customer_accounts_shopId_loginId_idx"
ON "customer_accounts"("shopId", "loginId");

CREATE UNIQUE INDEX IF NOT EXISTS "customer_accounts_id_shopId_key"
ON "customer_accounts"("id", "shopId");

CREATE TABLE IF NOT EXISTS "dsv_customer_account_invites" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "purpose" "DsvCustomerAccountInvitePurpose" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "consumedAt" TIMESTAMPTZ(6),
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dsv_customer_account_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dsv_customer_account_invites_tokenHash_key"
ON "dsv_customer_account_invites"("tokenHash");

CREATE INDEX IF NOT EXISTS "dsv_customer_account_invites_accountId_purpose_expiresAt_idx"
ON "dsv_customer_account_invites"("accountId", "purpose", "expiresAt");

CREATE INDEX IF NOT EXISTS "dsv_customer_account_invites_shopId_customerId_purpose_expiresAt_idx"
ON "dsv_customer_account_invites"("shopId", "customerId", "purpose", "expiresAt");

DO $$
BEGIN
  ALTER TABLE "dsv_customer_account_invites"
    ADD CONSTRAINT "dsv_customer_account_invites_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_customer_account_invites"
    ADD CONSTRAINT "dsv_customer_account_invites_customerId_shopId_fkey"
    FOREIGN KEY ("customerId", "shopId") REFERENCES "customers"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_customer_account_invites"
    ADD CONSTRAINT "dsv_customer_account_invites_accountId_shopId_fkey"
    FOREIGN KEY ("accountId", "shopId") REFERENCES "customer_accounts"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
