BEGIN;

ALTER TABLE "driver_consent_records"
  ADD COLUMN "accountId" UUID;

WITH ranked_consents AS (
  SELECT
    consent.id,
    driver."accountId",
    ROW_NUMBER() OVER (
      PARTITION BY driver."accountId", consent."consentType", consent."consentVersion"
      ORDER BY consent."recordedAt" DESC, consent."createdAt" DESC, consent.id DESC
    ) AS account_rank
  FROM "driver_consent_records" AS consent
  JOIN "drivers" AS driver ON driver.id = consent."driverId"
  WHERE driver."accountId" IS NOT NULL
)
UPDATE "driver_consent_records" AS consent
SET "accountId" = ranked."accountId"
FROM ranked_consents AS ranked
WHERE consent.id = ranked.id
  AND ranked.account_rank = 1;

ALTER TABLE "driver_consent_records"
  ADD CONSTRAINT "driver_consent_records_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "driver_accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "driver_consent_records_accountId_consentType_consentVersion_key"
  ON "driver_consent_records"("accountId", "consentType", "consentVersion");

ALTER TABLE "driver_consent_records" DROP CONSTRAINT IF EXISTS "driver_consent_records_shopId_fkey";
ALTER TABLE "driver_consent_records" ALTER COLUMN "shopId" DROP NOT NULL;
ALTER TABLE "driver_consent_records"
  ADD CONSTRAINT "driver_consent_records_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "driver_consent_records" DROP CONSTRAINT IF EXISTS "driver_consent_records_driverId_fkey";
ALTER TABLE "driver_consent_records" ALTER COLUMN "driverId" DROP NOT NULL;
ALTER TABLE "driver_consent_records"
  ADD CONSTRAINT "driver_consent_records_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "drivers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "driver_proof_media" DROP CONSTRAINT IF EXISTS "driver_proof_media_driverId_fkey";
ALTER TABLE "driver_proof_media" ALTER COLUMN "driverId" DROP NOT NULL;
ALTER TABLE "driver_proof_media"
  ADD CONSTRAINT "driver_proof_media_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "drivers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "driver_route_feedback" DROP CONSTRAINT IF EXISTS "driver_route_feedback_driverId_fkey";
ALTER TABLE "driver_route_feedback" ALTER COLUMN "driverId" DROP NOT NULL;
ALTER TABLE "driver_route_feedback"
  ADD CONSTRAINT "driver_route_feedback_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "drivers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "driver_route_notification_attempts" DROP CONSTRAINT IF EXISTS "driver_route_notification_attempts_driverId_fkey";
ALTER TABLE "driver_route_notification_attempts" ALTER COLUMN "driverId" DROP NOT NULL;
ALTER TABLE "driver_route_notification_attempts"
  ADD CONSTRAINT "driver_route_notification_attempts_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "drivers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "driver_events" DROP CONSTRAINT IF EXISTS "driver_events_driverId_fkey";
ALTER TABLE "driver_events" ALTER COLUMN "driverId" DROP NOT NULL;
ALTER TABLE "driver_events"
  ADD CONSTRAINT "driver_events_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "drivers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
