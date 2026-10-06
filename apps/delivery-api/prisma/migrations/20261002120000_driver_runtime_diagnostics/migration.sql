BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE "driver_runtime_diagnostic_devices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" UUID NOT NULL,
  "deviceInstanceHash" TEXT NOT NULL,
  "lastContactAt" TIMESTAMPTZ(6),
  "lastFailureAt" TIMESTAMPTZ(6),
  "lastFailureCode" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_runtime_diagnostic_devices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "driver_runtime_diagnostic_credentials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "deviceId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "accountTokenVersion" INTEGER NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),
  "lastAuthenticatedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_runtime_diagnostic_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "driver_runtime_diagnostic_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "deviceId" UUID NOT NULL,
  "diagnosticId" UUID NOT NULL,
  "shopId" UUID,
  "driverId" UUID,
  "routePlanId" UUID,
  "batchId" UUID NOT NULL,
  "bootId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "observedAt" TIMESTAMPTZ(6) NOT NULL,
  "sentAt" TIMESTAMPTZ(6) NOT NULL,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL,
  "isHistoricalReplay" BOOLEAN NOT NULL DEFAULT false,
  "payloadHash" TEXT NOT NULL,
  "context" JSONB NOT NULL,
  "snapshot" JSONB NOT NULL,
  "identifiers" JSONB,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_runtime_diagnostic_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "driver_runtime_diagnostic_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "deviceId" UUID NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "shopId" UUID,
  "driverId" UUID,
  "routePlanId" UUID,
  "bootId" UUID NOT NULL,
  "sessionGeneration" TEXT,
  "assignmentGeneration" TEXT,
  "snapshotObservedAt" TIMESTAMPTZ(6) NOT NULL,
  "snapshotTimeValid" BOOLEAN NOT NULL DEFAULT true,
  "firstObservedAt" TIMESTAMPTZ(6) NOT NULL,
  "lastScopedContactAt" TIMESTAMPTZ(6) NOT NULL,
  "sentAt" TIMESTAMPTZ(6) NOT NULL,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL,
  "lastIngestionFailureAt" TIMESTAMPTZ(6),
  "lastIngestionFailureCode" TEXT,
  "discardedRecordCount" INTEGER NOT NULL DEFAULT 0,
  "context" JSONB NOT NULL,
  "snapshot" JSONB NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_runtime_diagnostic_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "driver_runtime_diagnostic_devices_accountId_deviceInstanceH_key"
  ON "driver_runtime_diagnostic_devices"("accountId", "deviceInstanceHash");
CREATE INDEX "driver_runtime_diagnostic_devices_lastContactAt_idx"
  ON "driver_runtime_diagnostic_devices"("lastContactAt");
CREATE UNIQUE INDEX "driver_runtime_diagnostic_credentials_tokenHash_key"
  ON "driver_runtime_diagnostic_credentials"("tokenHash");
CREATE INDEX "driver_runtime_diagnostic_credentials_deviceId_expiresAt_idx"
  ON "driver_runtime_diagnostic_credentials"("deviceId", "expiresAt");
CREATE INDEX "driver_runtime_diagnostic_credentials_expiresAt_revokedAt_idx"
  ON "driver_runtime_diagnostic_credentials"("expiresAt", "revokedAt");
CREATE UNIQUE INDEX "driver_runtime_diagnostic_records_deviceId_diagnosticId_key"
  ON "driver_runtime_diagnostic_records"("deviceId", "diagnosticId");
CREATE INDEX "driver_runtime_diagnostic_records_shopId_routePlanId_observ_idx"
  ON "driver_runtime_diagnostic_records"("shopId", "routePlanId", "observedAt");
CREATE INDEX "driver_runtime_diagnostic_records_driverId_observedAt_idx"
  ON "driver_runtime_diagnostic_records"("driverId", "observedAt");
CREATE INDEX "driver_runtime_diagnostic_records_expiresAt_idx"
  ON "driver_runtime_diagnostic_records"("expiresAt");
CREATE UNIQUE INDEX "driver_runtime_diagnostic_snapshots_deviceId_scopeKey_key"
  ON "driver_runtime_diagnostic_snapshots"("deviceId", "scopeKey");
CREATE INDEX "driver_runtime_diagnostic_snapshots_shopId_routePlanId_snap_idx"
  ON "driver_runtime_diagnostic_snapshots"("shopId", "routePlanId", "snapshotObservedAt");
CREATE INDEX "driver_runtime_diagnostic_snapshots_driverId_snapshotObserv_idx"
  ON "driver_runtime_diagnostic_snapshots"("driverId", "snapshotObservedAt");
CREATE INDEX "driver_runtime_diagnostic_snapshots_expiresAt_idx"
  ON "driver_runtime_diagnostic_snapshots"("expiresAt");

ALTER TABLE "driver_runtime_diagnostic_devices"
  ADD CONSTRAINT "driver_runtime_diagnostic_devices_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "driver_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_runtime_diagnostic_credentials"
  ADD CONSTRAINT "driver_runtime_diagnostic_credentials_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "driver_runtime_diagnostic_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_runtime_diagnostic_records"
  ADD CONSTRAINT "driver_runtime_diagnostic_records_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "driver_runtime_diagnostic_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_runtime_diagnostic_snapshots"
  ADD CONSTRAINT "driver_runtime_diagnostic_snapshots_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "driver_runtime_diagnostic_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "driver_event_attempts"
  DROP CONSTRAINT "driver_event_attempts_contract_version_check";
ALTER TABLE "driver_event_attempts"
  ADD CONSTRAINT "driver_event_attempts_contract_version_check" CHECK ("driverContractVersion" >= 1);

COMMIT;
