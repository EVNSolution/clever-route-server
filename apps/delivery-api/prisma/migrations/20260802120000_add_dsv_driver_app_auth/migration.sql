ALTER TABLE "driver_accounts"
  ALTER COLUMN "pinHash" DROP NOT NULL,
  ALTER COLUMN "pinSalt" DROP NOT NULL,
  ADD COLUMN "loginId" TEXT,
  ADD COLUMN "passwordHash" TEXT,
  ADD COLUMN "passwordSalt" TEXT,
  ADD COLUMN "residentNumberFrontFingerprint" TEXT,
  ADD COLUMN "failedPasswordAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "passwordLockedUntil" TIMESTAMPTZ(6);

ALTER TABLE "dsv_driver_profiles"
  ADD COLUMN "residentNumberFrontFingerprint" TEXT;

CREATE UNIQUE INDEX "driver_accounts_loginId_key"
  ON "driver_accounts"("loginId");

CREATE INDEX "dsv_driver_profiles_shopId_residentNumberFrontFingerprint_idx"
  ON "dsv_driver_profiles"("shopId", "residentNumberFrontFingerprint");
