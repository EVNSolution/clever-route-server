CREATE TYPE "UvisTelemetryActivity" AS ENUM ('ACTIVE', 'DORMANT');

ALTER TABLE "uvis_telemetry_poll_states"
ADD COLUMN "activity" "UvisTelemetryActivity" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "allVehiclesStoppedSince" TIMESTAMPTZ(6),
ADD COLUMN "activeProtectionEndedAt" TIMESTAMPTZ(6),
ADD COLUMN "lastActivitySignalAt" TIMESTAMPTZ(6);
