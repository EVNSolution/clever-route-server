ALTER TABLE "customer_accounts"
  ADD COLUMN "previousPasswordHash" TEXT,
  ADD COLUMN "previousPasswordSalt" TEXT,
  ADD CONSTRAINT "customer_accounts_previous_password_pair"
    CHECK (("previousPasswordHash" IS NULL) = ("previousPasswordSalt" IS NULL));

ALTER TABLE "dsv_admin_accounts"
  ADD COLUMN "previousPasswordHash" TEXT,
  ADD COLUMN "previousPasswordSalt" TEXT,
  ADD CONSTRAINT "dsv_admin_accounts_previous_password_pair"
    CHECK (("previousPasswordHash" IS NULL) = ("previousPasswordSalt" IS NULL));
