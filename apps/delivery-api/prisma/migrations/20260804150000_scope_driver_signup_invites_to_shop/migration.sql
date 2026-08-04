ALTER TABLE "dsv_driver_account_signup_invites"
ADD COLUMN "shopId" UUID;

UPDATE "dsv_driver_account_signup_invites" AS invite
SET "shopId" = driver."shopId"
FROM "drivers" AS driver
WHERE invite."driverId" = driver."id";

ALTER TABLE "dsv_driver_account_signup_invites"
ALTER COLUMN "shopId" SET NOT NULL,
ALTER COLUMN "driverId" DROP NOT NULL;

CREATE INDEX "dsv_driver_account_signup_invites_shopId_expiresAt_idx"
ON "dsv_driver_account_signup_invites"("shopId", "expiresAt");

ALTER TABLE "dsv_driver_account_signup_invites"
ADD CONSTRAINT "dsv_driver_account_signup_invites_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dsv_driver_profiles"
ALTER COLUMN "age" DROP NOT NULL,
ALTER COLUMN "gender" DROP NOT NULL,
ALTER COLUMN "career" DROP NOT NULL,
ALTER COLUMN "zone" DROP NOT NULL,
ALTER COLUMN "score" DROP NOT NULL;
