-- CC-265 / issue #319: additive ordered driver-event contract and durable attempt evidence.
ALTER TABLE "route_plans"
  ADD COLUMN IF NOT EXISTS "assignmentGeneration" BIGINT NOT NULL DEFAULT 1;

ALTER TABLE "driver_events"
  ADD COLUMN IF NOT EXISTS "expectedRouteVersionId" UUID,
  ADD COLUMN IF NOT EXISTS "assignmentGeneration" BIGINT,
  ADD COLUMN IF NOT EXISTS "driverContractVersion" INTEGER;

CREATE TABLE IF NOT EXISTS "driver_event_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "requestId" TEXT NOT NULL,
  "shopId" UUID NOT NULL,
  "driverId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "clientEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "expectedRouteVersionId" UUID,
  "assignmentGeneration" BIGINT,
  "driverContractVersion" INTEGER NOT NULL,
  "appVersion" TEXT,
  "versionCode" INTEGER,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'ADMITTED',
  "failureStage" TEXT,
  "errorCode" TEXT,
  "retryable" BOOLEAN,
  "committedEventId" UUID,
  "retainedUntil" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_event_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_event_attempts_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "driver_event_attempts_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "driver_event_attempts_routePlanId_shopId_fkey" FOREIGN KEY ("routePlanId", "shopId") REFERENCES "route_plans"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "driver_event_attempts_assignment_generation_check" CHECK ("assignmentGeneration" IS NULL OR "assignmentGeneration" BETWEEN 1 AND 9223372036854775807),
  CONSTRAINT "driver_event_attempts_status_check" CHECK ("status" IN ('ADMITTED', 'APPLIED', 'REJECTED', 'TRANSIENT_FAILURE')),
  CONSTRAINT "driver_event_attempts_contract_version_check" CHECK ("driverContractVersion" >= 2)
);

CREATE UNIQUE INDEX IF NOT EXISTS "driver_event_attempts_requestId_key"
  ON "driver_event_attempts"("requestId");
CREATE INDEX IF NOT EXISTS "driver_event_attempts_driverId_clientEventId_createdAt_idx"
  ON "driver_event_attempts"("driverId", "clientEventId", "createdAt");
CREATE INDEX IF NOT EXISTS "driver_event_attempts_routePlanId_status_createdAt_idx"
  ON "driver_event_attempts"("routePlanId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "driver_event_attempts_retainedUntil_idx"
  ON "driver_event_attempts"("retainedUntil");

DO $$ BEGIN
  ALTER TABLE "route_plans"
    ADD CONSTRAINT "route_plans_assignment_generation_check"
    CHECK ("assignmentGeneration" BETWEEN 1 AND 9223372036854775807);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE "driver_event_attempts" IS
  'Redacted driver event admission and failure evidence. No tokens, customer data, addresses, proof payloads, or free-form errors.';
