-- CreateTable
CREATE TABLE "driver_stop_completion_receipts" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "clientEventId" TEXT NOT NULL,
    "shopId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "routePlanId" UUID NOT NULL,
    "deliveryStopId" UUID NOT NULL,
    "assignmentGeneration" BIGINT NOT NULL,
    "expectedRouteVersionId" UUID NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "payment" JSONB NOT NULL,
    "expectedAmount" DECIMAL(18,2),
    "actualAmount" DECIMAL(18,2),
    "differenceAmount" DECIMAL(18,2),
    "currencyCode" VARCHAR(3),
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" JSONB NOT NULL,

    CONSTRAINT "driver_stop_completion_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_stop_completion_receipts_eventId_key" ON "driver_stop_completion_receipts"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_stop_completion_receipts_clientEventId_key" ON "driver_stop_completion_receipts"("clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_stop_completion_receipts_deliveryStopId_key" ON "driver_stop_completion_receipts"("deliveryStopId");

-- CreateIndex
CREATE INDEX "driver_stop_completion_receipts_shopId_routePlanId_idx" ON "driver_stop_completion_receipts"("shopId", "routePlanId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_stop_completion_receipts_eventId_shopId_key" ON "driver_stop_completion_receipts"("eventId", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_stop_completion_receipts_deliveryStopId_shopId_key" ON "driver_stop_completion_receipts"("deliveryStopId", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_events_id_shopId_key" ON "driver_events"("id", "shopId");

-- AddForeignKey
ALTER TABLE "driver_stop_completion_receipts" ADD CONSTRAINT "driver_stop_completion_receipts_eventId_shopId_fkey" FOREIGN KEY ("eventId", "shopId") REFERENCES "driver_events"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_stop_completion_receipts" ADD CONSTRAINT "driver_stop_completion_receipts_deliveryStopId_shopId_fkey" FOREIGN KEY ("deliveryStopId", "shopId") REFERENCES "delivery_stops"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "driver_stop_completion_receipts"
  ADD CONSTRAINT "driver_stop_completion_receipts_amount_check" CHECK (
    ("actualAmount" IS NULL AND "differenceAmount" IS NULL)
    OR ("actualAmount" IS NOT NULL AND "actualAmount" >= 0 AND "currencyCode" IS NOT NULL AND
      (("expectedAmount" IS NULL AND "differenceAmount" IS NULL)
       OR ("expectedAmount" IS NOT NULL AND "differenceAmount" IS NOT NULL
         AND "differenceAmount" = "actualAmount" - "expectedAmount")))
  );

-- Preserve the first accepted result. Future corrections need a separate audited contract.
-- Deletion remains available through the existing account/order privacy lifecycle.
CREATE FUNCTION reject_driver_stop_completion_receipt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Driver stop completion receipt is immutable';
END;
$$;
CREATE TRIGGER driver_stop_completion_receipts_immutable
BEFORE UPDATE ON "driver_stop_completion_receipts"
FOR EACH ROW EXECUTE FUNCTION reject_driver_stop_completion_receipt_update();
