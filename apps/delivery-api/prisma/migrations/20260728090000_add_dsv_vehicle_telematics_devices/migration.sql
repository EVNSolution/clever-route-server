CREATE TABLE "dsv_vehicle_telematics_devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "installedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_vehicle_telematics_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dsv_vehicle_telematics_devices_id_shopId_key"
ON "dsv_vehicle_telematics_devices"("id", "shopId");

CREATE UNIQUE INDEX "dsv_vehicle_telematics_devices_vehicleId_shopId_key"
ON "dsv_vehicle_telematics_devices"("vehicleId", "shopId");

CREATE UNIQUE INDEX "dsv_vehicle_telematics_devices_shopId_serialNumber_key"
ON "dsv_vehicle_telematics_devices"("shopId", "serialNumber");

CREATE INDEX "dsv_vehicle_telematics_devices_shopId_installedAt_idx"
ON "dsv_vehicle_telematics_devices"("shopId", "installedAt");

ALTER TABLE "dsv_vehicle_telematics_devices"
ADD CONSTRAINT "dsv_vehicle_telematics_devices_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dsv_vehicle_telematics_devices"
ADD CONSTRAINT "dsv_vehicle_telematics_devices_vehicleId_shopId_fkey"
FOREIGN KEY ("vehicleId", "shopId") REFERENCES "vehicles"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;
