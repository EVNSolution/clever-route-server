CREATE TYPE "DriverBundleHandoffRequestStatus" AS ENUM (
  'PROPOSED',
  'PROCESSING',
  'REJECTED',
  'APPLIED',
  'CANCELLED',
  'INVALIDATED'
);

CREATE TABLE "driver_bundle_handoff_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "groupingId" UUID NOT NULL,
  "destinationId" TEXT NOT NULL,
  "sourceDriverId" UUID NOT NULL,
  "sourceRoutePlanId" UUID NOT NULL,
  "targetDriverId" UUID NOT NULL,
  "targetRoutePlanId" UUID NOT NULL,
  "expectedVersion" TEXT NOT NULL,
  "status" "DriverBundleHandoffRequestStatus" NOT NULL DEFAULT 'PROPOSED',
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "respondedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "driver_bundle_handoff_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "driver_bundle_handoff_requests_shopId_sourceDriverId_status_createdAt_idx"
  ON "driver_bundle_handoff_requests"("shopId", "sourceDriverId", "status", "createdAt");

CREATE INDEX "driver_bundle_handoff_requests_shopId_targetDriverId_status_createdAt_idx"
  ON "driver_bundle_handoff_requests"("shopId", "targetDriverId", "status", "createdAt");

CREATE INDEX "driver_bundle_handoff_requests_shopId_groupingId_destinationId_status_idx"
  ON "driver_bundle_handoff_requests"("shopId", "groupingId", "destinationId", "status");

CREATE UNIQUE INDEX "driver_bundle_handoff_requests_one_active_destination_idx"
  ON "driver_bundle_handoff_requests"("shopId", "groupingId", "destinationId")
  WHERE "status" IN ('PROPOSED', 'PROCESSING');

ALTER TABLE "driver_bundle_handoff_requests"
  ADD CONSTRAINT "driver_bundle_handoff_requests_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
