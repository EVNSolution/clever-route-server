ALTER TYPE "DriverProofMediaKind" ADD VALUE 'SIGNATURE';
ALTER TYPE "DriverProofMediaSource" ADD VALUE 'SIGNATURE';
CREATE UNIQUE INDEX "driver_stop_completion_receipts_id_shopId_key" ON "driver_stop_completion_receipts"("id", "shopId");
CREATE TABLE "driver_cash_settlements" (
  "id" UUID NOT NULL, "shopId" UUID NOT NULL, "routePlanId" UUID NOT NULL, "receiptId" UUID NOT NULL,
  "commandId" UUID NOT NULL, "revision" INTEGER NOT NULL, "requestHash" VARCHAR(64) NOT NULL,
  "confirmedAmount" DECIMAL(18,2) NOT NULL, "currency" VARCHAR(3) NOT NULL,
  "differenceFromActual" DECIMAL(18,2) NOT NULL, "differenceFromExpected" DECIMAL(18,2),
  "reason" TEXT, "actor" TEXT NOT NULL, "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_cash_settlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_cash_settlements_receiptId_shopId_fkey" FOREIGN KEY ("receiptId", "shopId") REFERENCES "driver_stop_completion_receipts"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "driver_cash_settlements_amount_check" CHECK ("confirmedAmount" >= 0 AND "revision" > 0 AND ("revision" = 1 OR ("reason" IS NOT NULL AND length(trim("reason")) > 0)))
);
CREATE UNIQUE INDEX "driver_cash_settlements_shopId_commandId_key" ON "driver_cash_settlements"("shopId", "commandId");
CREATE UNIQUE INDEX "driver_cash_settlements_receiptId_revision_key" ON "driver_cash_settlements"("receiptId", "revision");
CREATE INDEX "driver_cash_settlements_shopId_routePlanId_idx" ON "driver_cash_settlements"("shopId", "routePlanId");
CREATE FUNCTION reject_driver_cash_settlement_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Cash settlement records are append-only'; END; $$;
CREATE TRIGGER driver_cash_settlements_immutable BEFORE UPDATE ON driver_cash_settlements FOR EACH ROW EXECUTE FUNCTION reject_driver_cash_settlement_update();

ALTER TABLE "driver_account_sessions"
 ADD COLUMN "deliveryProofCapability" TEXT,
 ADD COLUMN "capabilityVersionCode" INTEGER,
 ADD COLUMN "capabilityPackageId" TEXT,
 ADD COLUMN "capabilityTokenVersion" INTEGER,
 ADD COLUMN "capabilityReportedAt" TIMESTAMPTZ(6);
