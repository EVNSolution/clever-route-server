CREATE TABLE "driver_account_password_reset_links" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_account_password_reset_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "driver_account_password_reset_links_tokenHash_key"
    ON "driver_account_password_reset_links"("tokenHash");

CREATE INDEX "driver_account_password_reset_links_accountId_createdAt_idx"
    ON "driver_account_password_reset_links"("accountId", "createdAt");

CREATE INDEX "driver_account_password_reset_links_accountId_expiresAt_idx"
    ON "driver_account_password_reset_links"("accountId", "expiresAt");

ALTER TABLE "driver_account_password_reset_links"
    ADD CONSTRAINT "driver_account_password_reset_links_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "driver_accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "driver_account_password_reset_links"
    ADD CONSTRAINT "driver_account_password_reset_links_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
