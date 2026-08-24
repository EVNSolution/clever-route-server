ALTER TABLE "driver_event_attempts" ADD COLUMN IF NOT EXISTS "transportRequestId" TEXT;
CREATE INDEX IF NOT EXISTS "driver_event_attempts_shopId_transportRequestId_createdAt_idx"
  ON "driver_event_attempts"("shopId", "transportRequestId", "createdAt");
