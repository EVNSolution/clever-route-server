CREATE TYPE "UvisTelemetrySourceKind" AS ENUM ('VEHICLE_GPS', 'TEMPERATURE_RECORDER');

CREATE TABLE "uvis_vehicle_telemetry_samples" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "sourceDeviceIdentifier" TEXT NOT NULL,
    "sourceKind" "UvisTelemetrySourceKind" NOT NULL,
    "observedAt" TIMESTAMPTZ(6) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "staleAfter" TIMESTAMPTZ(6) NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "ignitionOn" BOOLEAN,
    "speedKph" DECIMAL(8,2),
    "distanceTodayKm" DECIMAL(10,2),
    "temperatureA" DECIMAL(6,2),
    "temperatureB" DECIMAL(6,2),
    "sourcePlate" TEXT,
    "plateMatched" BOOLEAN,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uvis_vehicle_telemetry_samples_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "uvis_vehicle_telemetry_current" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "sourceDeviceIdentifier" TEXT NOT NULL,
    "sourceKind" "UvisTelemetrySourceKind" NOT NULL,
    "observedAt" TIMESTAMPTZ(6) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "staleAfter" TIMESTAMPTZ(6) NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "ignitionOn" BOOLEAN,
    "speedKph" DECIMAL(8,2),
    "distanceTodayKm" DECIMAL(10,2),
    "temperatureA" DECIMAL(6,2),
    "temperatureB" DECIMAL(6,2),
    "sourcePlate" TEXT,
    "plateMatched" BOOLEAN,
    "lastSampleId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "uvis_vehicle_telemetry_current_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "uvis_telemetry_poll_states" (
    "shopId" UUID NOT NULL,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "lastLocationStartedAt" TIMESTAMPTZ(6),
    "lastLocationSucceededAt" TIMESTAMPTZ(6),
    "lastLocationFailedAt" TIMESTAMPTZ(6),
    "lastLocationErrorCode" TEXT,
    "lastTemperatureStartedAt" TIMESTAMPTZ(6),
    "lastTemperatureSucceededAt" TIMESTAMPTZ(6),
    "lastTemperatureFailedAt" TIMESTAMPTZ(6),
    "lastTemperatureErrorCode" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "uvis_telemetry_poll_states_pkey" PRIMARY KEY ("shopId")
);

CREATE UNIQUE INDEX "uvis_vehicle_telemetry_samples_deviceId_sourceKind_observedAt_key"
ON "uvis_vehicle_telemetry_samples"("deviceId", "sourceKind", "observedAt");

CREATE UNIQUE INDEX "uvis_vehicle_telemetry_samples_id_shopId_deviceId_sourceKind_key"
ON "uvis_vehicle_telemetry_samples"("id", "shopId", "deviceId", "sourceKind");

CREATE INDEX "uvis_vehicle_telemetry_samples_shopId_vehicleId_observedAt_idx"
ON "uvis_vehicle_telemetry_samples"("shopId", "vehicleId", "observedAt");

CREATE INDEX "uvis_vehicle_telemetry_samples_shopId_deviceId_observedAt_idx"
ON "uvis_vehicle_telemetry_samples"("shopId", "deviceId", "observedAt");

CREATE INDEX "uvis_vehicle_telemetry_samples_shopId_staleAfter_idx"
ON "uvis_vehicle_telemetry_samples"("shopId", "staleAfter");

CREATE UNIQUE INDEX "uvis_vehicle_telemetry_current_shopId_deviceId_sourceKind_key"
ON "uvis_vehicle_telemetry_current"("shopId", "deviceId", "sourceKind");

CREATE INDEX "uvis_vehicle_telemetry_current_shopId_vehicleId_idx"
ON "uvis_vehicle_telemetry_current"("shopId", "vehicleId");

CREATE INDEX "uvis_vehicle_telemetry_current_shopId_observedAt_idx"
ON "uvis_vehicle_telemetry_current"("shopId", "observedAt");

CREATE INDEX "uvis_vehicle_telemetry_current_shopId_staleAfter_idx"
ON "uvis_vehicle_telemetry_current"("shopId", "staleAfter");

CREATE INDEX "uvis_vehicle_telemetry_current_shopId_sourceKind_observedAt_idx"
ON "uvis_vehicle_telemetry_current"("shopId", "sourceKind", "observedAt");

CREATE INDEX "uvis_telemetry_poll_states_leaseExpiresAt_idx"
ON "uvis_telemetry_poll_states"("leaseExpiresAt");

ALTER TABLE "uvis_vehicle_telemetry_samples"
ADD CONSTRAINT "uvis_vehicle_telemetry_samples_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "uvis_vehicle_telemetry_samples"
ADD CONSTRAINT "uvis_vehicle_telemetry_samples_vehicleId_shopId_fkey"
FOREIGN KEY ("vehicleId", "shopId") REFERENCES "vehicles"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "uvis_vehicle_telemetry_samples"
ADD CONSTRAINT "uvis_vehicle_telemetry_samples_deviceId_shopId_fkey"
FOREIGN KEY ("deviceId", "shopId") REFERENCES "dsv_vehicle_telematics_devices"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "uvis_vehicle_telemetry_current"
ADD CONSTRAINT "uvis_vehicle_telemetry_current_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "uvis_vehicle_telemetry_current"
ADD CONSTRAINT "uvis_vehicle_telemetry_current_vehicleId_shopId_fkey"
FOREIGN KEY ("vehicleId", "shopId") REFERENCES "vehicles"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "uvis_vehicle_telemetry_current"
ADD CONSTRAINT "uvis_vehicle_telemetry_current_deviceId_shopId_fkey"
FOREIGN KEY ("deviceId", "shopId") REFERENCES "dsv_vehicle_telematics_devices"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "uvis_vehicle_telemetry_current"
ADD CONSTRAINT "uvis_vehicle_telemetry_current_lastSampleId_shopId_deviceId_sourceKind_fkey"
FOREIGN KEY ("lastSampleId", "shopId", "deviceId", "sourceKind") REFERENCES "uvis_vehicle_telemetry_samples"("id", "shopId", "deviceId", "sourceKind") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "uvis_telemetry_poll_states"
ADD CONSTRAINT "uvis_telemetry_poll_states_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
