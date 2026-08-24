-- CC-265 verifier hardening: retry lineage and evidence-preserving lifecycle states.
ALTER TABLE "driver_event_attempts"
  ADD COLUMN IF NOT EXISTS "attemptNumber" INTEGER,
  ADD COLUMN IF NOT EXISTS "reconciledAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "reconciliationCode" TEXT;

WITH numbered AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "driverId", "clientEventId"
           ORDER BY "createdAt", "id"
         ) AS attempt_number
  FROM "driver_event_attempts"
)
UPDATE "driver_event_attempts" attempt
SET "attemptNumber" = numbered.attempt_number
FROM numbered
WHERE attempt."id" = numbered."id"
  AND attempt."attemptNumber" IS NULL;

ALTER TABLE "driver_event_attempts"
  ALTER COLUMN "attemptNumber" SET NOT NULL,
  ALTER COLUMN "attemptNumber" SET DEFAULT 1,
  ALTER COLUMN "status" SET DEFAULT 'ACCEPTED',
  ALTER COLUMN "clientEventId" DROP NOT NULL,
  ALTER COLUMN "eventType" DROP NOT NULL,
  ALTER COLUMN "occurredAt" DROP NOT NULL,
  ALTER COLUMN "routePlanId" DROP NOT NULL;

-- The original constraint rejects the replacement values. Remove it before
-- transforming populated databases, then install the expanded constraint.
ALTER TABLE "driver_event_attempts"
  DROP CONSTRAINT IF EXISTS "driver_event_attempts_status_check";

UPDATE "driver_event_attempts"
SET "status" = CASE
  WHEN "status" = 'ADMITTED' THEN 'ACCEPTED'
  WHEN "status" = 'TRANSIENT_FAILURE' THEN 'FAILED'
  ELSE "status"
END;

ALTER TABLE "driver_event_attempts"
  ADD CONSTRAINT "driver_event_attempts_status_check"
  CHECK ("status" IN ('ACCEPTED', 'APPLIED', 'DUPLICATE', 'REJECTED', 'FAILED'));

CREATE UNIQUE INDEX IF NOT EXISTS "driver_event_attempts_driverId_clientEventId_attemptNumber_key"
  ON "driver_event_attempts"("driverId", "clientEventId", "attemptNumber");

ALTER TABLE "driver_event_attempts"
  DROP CONSTRAINT IF EXISTS "driver_event_attempts_attempt_number_check";
ALTER TABLE "driver_event_attempts"
  ADD CONSTRAINT "driver_event_attempts_attempt_number_check"
  CHECK ("attemptNumber" >= 1);

ALTER TABLE "driver_event_attempts"
  ADD CONSTRAINT "driver_event_attempts_reconciliation_check"
  CHECK (
    ("reconciledAt" IS NULL AND "reconciliationCode" IS NULL)
    OR (
      "status" = 'REJECTED'
      AND "reconciledAt" IS NOT NULL
      AND "reconciliationCode" IN ('CONFIRMED_REJECTED', 'SUPERSEDED', 'APPLIED_OUT_OF_BAND')
    )
  );
