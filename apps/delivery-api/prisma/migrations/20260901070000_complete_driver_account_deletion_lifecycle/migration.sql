BEGIN;

ALTER TYPE "DriverAccountDeletionRequestStatus" ADD VALUE IF NOT EXISTS 'DEFERRED';
ALTER TYPE "DriverAccountDeletionRequestStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "DriverAccountDeletionRequestStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';
ALTER TYPE "DriverAccountDeletionRequestStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE "DriverAccountDeletionRequestStatus" ADD VALUE IF NOT EXISTS 'FAILED';

COMMIT;

BEGIN;

DO $$
BEGIN
  CREATE TYPE "DriverAccountDeletionRequestChannel" AS ENUM ('IN_APP', 'EXTERNAL_SUPPORT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "DriverAccountDeletionVerificationMethod" AS ENUM (
    'AUTHENTICATED_ACCOUNT',
    'LEGACY_DRIVER_TOKEN',
    'OPERATOR_VERIFIED_CONTACT'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "driver_account_deletion_requests"
  ADD COLUMN IF NOT EXISTS "requestChannel" "DriverAccountDeletionRequestChannel" NOT NULL DEFAULT 'IN_APP',
  ADD COLUMN IF NOT EXISTS "verificationMethod" "DriverAccountDeletionVerificationMethod" NOT NULL DEFAULT 'AUTHENTICATED_ACCOUNT',
  ADD COLUMN IF NOT EXISTS "requestedBy" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "processingKey" UUID,
  ADD COLUMN IF NOT EXISTS "processingStartedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "processingLeaseExpiresAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "processedBy" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failureCode" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "rejectionCode" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "supersededByRequestId" UUID;

UPDATE "driver_account_deletion_requests"
SET "verificationMethod" = 'LEGACY_DRIVER_TOKEN'
WHERE "accountId" IS NULL AND "driverId" IS NOT NULL;

CREATE TEMP TABLE driver_account_deletion_reconciliation ON COMMIT DROP AS
WITH candidates AS (
  SELECT
    request.id,
    request."accountId",
    request."driverId",
    request."requestedAt",
    COALESCE(request."accountId", driver."accountId") AS "targetAccountId",
    CASE
      WHEN COALESCE(request."accountId", driver."accountId") IS NOT NULL
        THEN 'account:' || COALESCE(request."accountId", driver."accountId")::text
      WHEN request."driverId" IS NOT NULL
        THEN 'driver:' || request."driverId"::text
      ELSE 'request:' || request.id::text
    END AS "reconciliationKey"
  FROM "driver_account_deletion_requests" request
  LEFT JOIN "drivers" driver ON driver.id = request."driverId"
)
SELECT
  id,
  "targetAccountId",
  FIRST_VALUE(id) OVER (
    PARTITION BY "reconciliationKey"
    ORDER BY
      CASE WHEN "accountId" IS NOT NULL THEN 0 ELSE 1 END,
      "requestedAt",
      id
  ) AS "canonicalRequestId"
FROM candidates;

UPDATE "driver_account_deletion_requests" request
SET
  "accountId" = reconciliation."targetAccountId",
  "driverId" = NULL,
  "shopDomain" = NULL
FROM driver_account_deletion_reconciliation reconciliation
WHERE request.id = reconciliation.id
  AND request.id = reconciliation."canonicalRequestId"
  AND reconciliation."targetAccountId" IS NOT NULL;

UPDATE "driver_account_deletion_requests" request
SET
  "accountId" = NULL,
  "driverId" = NULL,
  "shopDomain" = NULL,
  "driverDisplayName" = NULL,
  "driverPhone" = NULL,
  reason = NULL,
  status = 'REJECTED',
  "processedAt" = COALESCE(request."processedAt", CURRENT_TIMESTAMP),
  "processedBy" = 'migration-20260901',
  "failureCode" = NULL,
  "rejectionCode" = 'DUPLICATE_MIGRATION_RECONCILED',
  "supersededByRequestId" = reconciliation."canonicalRequestId"
FROM driver_account_deletion_reconciliation reconciliation
WHERE request.id = reconciliation.id
  AND request.id <> reconciliation."canonicalRequestId";

CREATE UNIQUE INDEX IF NOT EXISTS "driver_account_deletion_requests_driverId_key"
  ON "driver_account_deletion_requests"("driverId");

CREATE INDEX IF NOT EXISTS "driver_account_deletion_requests_status_lease_idx"
  ON "driver_account_deletion_requests"("status", "processingLeaseExpiresAt");

CREATE INDEX IF NOT EXISTS "driver_account_deletion_requests_superseded_request_idx"
  ON "driver_account_deletion_requests"("supersededByRequestId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'driver_account_deletion_requests_superseded_request_fkey'
  ) THEN
    ALTER TABLE "driver_account_deletion_requests"
      ADD CONSTRAINT "driver_account_deletion_requests_superseded_request_fkey"
      FOREIGN KEY ("supersededByRequestId")
      REFERENCES "driver_account_deletion_requests"(id)
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
