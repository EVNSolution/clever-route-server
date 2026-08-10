BEGIN;

CREATE TABLE "uvis_vehicle_trail_materializations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "vehicleId" UUID NOT NULL,
  "serviceDate" DATE NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "sourceWatermark" TEXT NOT NULL,
  "sourceSampleCount" INTEGER NOT NULL,
  "generatedAt" TIMESTAMPTZ(6) NOT NULL,
  "finalizedAt" TIMESTAMPTZ(6),
  "document" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "uvis_vehicle_trail_materializations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uvis_vehicle_trail_materializations_shop_vehicle_day_schema_key"
  ON "uvis_vehicle_trail_materializations"("shopId", "vehicleId", "serviceDate", "schemaVersion");

CREATE INDEX "uvis_vehicle_trail_materializations_shopId_serviceDate_idx"
  ON "uvis_vehicle_trail_materializations"("shopId", "serviceDate");

CREATE INDEX "uvis_vehicle_trail_materializations_shopId_vehicleId_serviceDate_idx"
  ON "uvis_vehicle_trail_materializations"("shopId", "vehicleId", "serviceDate");

CREATE INDEX "uvis_vehicle_trail_materializations_finalizedAt_idx"
  ON "uvis_vehicle_trail_materializations"("finalizedAt");

ALTER TABLE "uvis_vehicle_trail_materializations"
  ADD CONSTRAINT "uvis_vehicle_trail_materializations_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "uvis_vehicle_trail_materializations"
  ADD CONSTRAINT "uvis_vehicle_trail_materializations_vehicleId_shopId_fkey"
  FOREIGN KEY ("vehicleId", "shopId") REFERENCES "vehicles"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
