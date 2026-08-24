ALTER TABLE "driver_proof_media"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(120);

CREATE UNIQUE INDEX IF NOT EXISTS "driver_proof_media_idempotency_scope_key"
  ON "driver_proof_media"("shopId", "driverId", "routePlanId", "deliveryStopId", "idempotencyKey");
