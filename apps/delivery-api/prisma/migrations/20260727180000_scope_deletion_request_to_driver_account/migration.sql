BEGIN;

ALTER TABLE "driver_account_deletion_requests"
  ADD COLUMN "accountId" UUID,
  ALTER COLUMN "shopDomain" DROP NOT NULL;

CREATE UNIQUE INDEX "driver_account_deletion_requests_accountId_key"
  ON "driver_account_deletion_requests"("accountId");

ALTER TABLE "driver_account_deletion_requests"
  ADD CONSTRAINT "driver_account_deletion_requests_accountId_fkey"
  FOREIGN KEY ("accountId")
  REFERENCES "driver_accounts"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

COMMIT;
