-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ShopifyWebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "CommerceSourcePlatform" AS ENUM ('SHOPIFY', 'WOOCOMMERCE');

-- CreateEnum
CREATE TYPE "DeliveryOrderStatus" AS ENUM ('PENDING', 'READY', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GeocodeStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'RESOLVED', 'FAILED');

-- CreateEnum
CREATE TYPE "DeliveryStopStatus" AS ENUM ('PENDING', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RoutePlanStatus" AS ENUM ('DRAFT', 'OPTIMIZED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('CAR', 'VAN', 'TRUCK', 'BIKE', 'SCOOTER', 'OTHER');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "DriverEventType" AS ENUM ('ROUTE_STARTED', 'ROUTE_PAUSED', 'ROUTE_COMPLETED', 'STOP_ARRIVED', 'STOP_DELIVERED', 'STOP_FAILED', 'LOCATION_UPDATED', 'NOTE_ADDED');

-- CreateEnum
CREATE TYPE "DriverConsentType" AS ENUM ('LOCATION_INFORMATION', 'PERSONAL_INFORMATION');

-- CreateEnum
CREATE TYPE "DriverProofMediaKind" AS ENUM ('PHOTO');

-- CreateEnum
CREATE TYPE "DriverProofMediaSource" AS ENUM ('CAMERA', 'LIBRARY');

-- CreateEnum
CREATE TYPE "RetentionJobRunStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "DriverAccountDeletionRequestStatus" AS ENUM ('REQUESTED');

-- CreateTable
CREATE TABLE "shops" (
    "id" UUID NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyShopGid" TEXT,
    "apiVersion" TEXT NOT NULL DEFAULT '2026-04',
    "adminAccessTokenCiphertext" TEXT,
    "adminAccessTokenExpiresAt" TIMESTAMPTZ(6),
    "adminRefreshTokenCiphertext" TEXT,
    "adminRefreshTokenExpiresAt" TIMESTAMPTZ(6),
    "tokenScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenIssuedAt" TIMESTAMPTZ(6),
    "installedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_webhook_events" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventId" TEXT,
    "topic" TEXT NOT NULL,
    "apiVersion" TEXT,
    "triggeredAt" TIMESTAMPTZ(6),
    "rawBodySha256" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ShopifyWebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shopify_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "shopifyOrderGid" TEXT NOT NULL,
    "shopifyOrderLegacyId" BIGINT,
    "sourcePlatform" "CommerceSourcePlatform" NOT NULL DEFAULT 'SHOPIFY',
    "sourceSiteUrl" TEXT,
    "sourceOrderId" TEXT,
    "sourceOrderNumber" TEXT,
    "sourceUpdatedAt" TIMESTAMPTZ(6),
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "cancelledAt" TIMESTAMPTZ(6),
    "processedAt" TIMESTAMPTZ(6),
    "updatedAtShopify" TIMESTAMPTZ(6),
    "totalPriceAmount" DECIMAL(12,2),
    "currencyCode" TEXT,
    "shippingAddress" JSONB,
    "rawPayload" JSONB NOT NULL,
    "deliveryStatus" "DeliveryOrderStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_stops" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "recipientName" TEXT,
    "phone" TEXT,
    "address1" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "province" TEXT,
    "postalCode" TEXT,
    "countryCode" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "geocodeStatus" "GeocodeStatus" NOT NULL DEFAULT 'PENDING',
    "deliveryDate" DATE,
    "timeWindowStart" TIMESTAMPTZ(6),
    "timeWindowEnd" TIMESTAMPTZ(6),
    "serviceMinutes" INTEGER NOT NULL DEFAULT 5,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "instructions" TEXT,
    "status" "DeliveryStopStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "delivery_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_plans" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "planDate" DATE NOT NULL,
    "status" "RoutePlanStatus" NOT NULL DEFAULT 'DRAFT',
    "driverId" UUID,
    "vehicleId" UUID,
    "depotLatitude" DECIMAL(10,7),
    "depotLongitude" DECIMAL(10,7),
    "optimizerVersion" TEXT NOT NULL,
    "constraints" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "route_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_plan_stops" (
    "id" UUID NOT NULL,
    "routePlanId" UUID NOT NULL,
    "deliveryStopId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "estimatedArrivalAt" TIMESTAMPTZ(6),
    "distanceFromPreviousMeters" INTEGER,
    "durationFromPreviousSeconds" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "route_plan_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "phone" TEXT,
    "status" "DriverStatus" NOT NULL DEFAULT 'ACTIVE',
    "inviteCode" TEXT,
    "inviteCodeExpiresAt" TIMESTAMPTZ(6),
    "authSubject" TEXT,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "tokensInvalidatedAt" TIMESTAMPTZ(6),
    "lastSeenAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_sessions" (
    "id" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(6),

    CONSTRAINT "driver_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_consent_records" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "consentType" "DriverConsentType" NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "routeContext" TEXT,
    "deviceContext" JSONB,
    "appContext" JSONB,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "driver_consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_proof_media" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "routePlanId" UUID NOT NULL,
    "deliveryStopId" UUID NOT NULL,
    "kind" "DriverProofMediaKind" NOT NULL DEFAULT 'PHOTO',
    "source" "DriverProofMediaSource" NOT NULL,
    "contentType" TEXT NOT NULL,
    "originalFilename" TEXT,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_proof_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_route_feedback" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "routePlanId" UUID NOT NULL,
    "reviewNote" TEXT NOT NULL,
    "submittedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "driver_route_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_account_deletion_requests" (
    "id" UUID NOT NULL,
    "shopId" UUID,
    "driverId" UUID,
    "shopDomain" TEXT NOT NULL,
    "driverDisplayName" TEXT,
    "driverPhone" TEXT,
    "status" "DriverAccountDeletionRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "requestedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_account_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_job_runs" (
    "id" UUID NOT NULL,
    "jobName" TEXT NOT NULL,
    "status" "RetentionJobRunStatus" NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6) NOT NULL,
    "retentionDays" INTEGER,
    "uploadedBefore" TIMESTAMPTZ(6),
    "batchLimit" INTEGER,
    "scannedCount" INTEGER,
    "deletedCount" INTEGER,
    "missingFilesCount" INTEGER,
    "errorSummary" TEXT,
    "evidenceRef" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "licensePlate" TEXT,
    "vehicleType" "VehicleType" NOT NULL DEFAULT 'OTHER',
    "capacityUnits" INTEGER NOT NULL DEFAULT 0,
    "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_events" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "routePlanId" UUID,
    "deliveryStopId" UUID,
    "clientEventId" TEXT,
    "eventType" "DriverEventType" NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_shopDomain_key" ON "shops"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "shops_shopifyShopGid_key" ON "shops"("shopifyShopGid");

-- CreateIndex
CREATE INDEX "shopify_webhook_events_shopId_topic_receivedAt_idx" ON "shopify_webhook_events"("shopId", "topic", "receivedAt");

-- CreateIndex
CREATE INDEX "shopify_webhook_events_status_receivedAt_idx" ON "shopify_webhook_events"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_webhook_events_shopId_webhookId_key" ON "shopify_webhook_events"("shopId", "webhookId");

-- CreateIndex
CREATE INDEX "orders_shopId_name_idx" ON "orders"("shopId", "name");

-- CreateIndex
CREATE INDEX "orders_shopId_sourcePlatform_sourceOrderNumber_idx" ON "orders"("shopId", "sourcePlatform", "sourceOrderNumber");

-- CreateIndex
CREATE INDEX "orders_shopId_sourcePlatform_sourceUpdatedAt_idx" ON "orders"("shopId", "sourcePlatform", "sourceUpdatedAt");

-- CreateIndex
CREATE INDEX "orders_shopId_deliveryStatus_processedAt_idx" ON "orders"("shopId", "deliveryStatus", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shopId_shopifyOrderGid_key" ON "orders"("shopId", "shopifyOrderGid");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shopId_sourcePlatform_sourceOrderId_key" ON "orders"("shopId", "sourcePlatform", "sourceOrderId");

-- CreateIndex
CREATE INDEX "delivery_stops_shopId_deliveryDate_status_idx" ON "delivery_stops"("shopId", "deliveryDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_stops_shopId_orderId_key" ON "delivery_stops"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "route_plans_shopId_planDate_status_idx" ON "route_plans"("shopId", "planDate", "status");

-- CreateIndex
CREATE INDEX "route_plans_shopId_driverId_status_idx" ON "route_plans"("shopId", "driverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "route_plan_stops_routePlanId_sequence_key" ON "route_plan_stops"("routePlanId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "route_plan_stops_routePlanId_deliveryStopId_key" ON "route_plan_stops"("routePlanId", "deliveryStopId");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_authSubject_key" ON "drivers"("authSubject");

-- CreateIndex
CREATE INDEX "drivers_shopId_status_idx" ON "drivers"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_shopId_inviteCode_key" ON "drivers"("shopId", "inviteCode");

-- CreateIndex
CREATE UNIQUE INDEX "driver_sessions_refreshTokenHash_key" ON "driver_sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "driver_sessions_driverId_expiresAt_idx" ON "driver_sessions"("driverId", "expiresAt");

-- CreateIndex
CREATE INDEX "driver_consent_records_shopId_driverId_recordedAt_idx" ON "driver_consent_records"("shopId", "driverId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "driver_consent_records_driverId_consentType_consentVersion_key" ON "driver_consent_records"("driverId", "consentType", "consentVersion");

-- CreateIndex
CREATE INDEX "driver_proof_media_shopId_routePlanId_deliveryStopId_upload_idx" ON "driver_proof_media"("shopId", "routePlanId", "deliveryStopId", "uploadedAt");

-- CreateIndex
CREATE INDEX "driver_proof_media_driverId_uploadedAt_idx" ON "driver_proof_media"("driverId", "uploadedAt");

-- CreateIndex
CREATE UNIQUE INDEX "driver_proof_media_shopId_storageKey_key" ON "driver_proof_media"("shopId", "storageKey");

-- CreateIndex
CREATE INDEX "driver_route_feedback_shopId_routePlanId_submittedAt_idx" ON "driver_route_feedback"("shopId", "routePlanId", "submittedAt");

-- CreateIndex
CREATE INDEX "driver_route_feedback_driverId_submittedAt_idx" ON "driver_route_feedback"("driverId", "submittedAt");

-- CreateIndex
CREATE INDEX "driver_account_deletion_requests_shopDomain_requestedAt_idx" ON "driver_account_deletion_requests"("shopDomain", "requestedAt");

-- CreateIndex
CREATE INDEX "driver_account_deletion_requests_driverId_requestedAt_idx" ON "driver_account_deletion_requests"("driverId", "requestedAt");

-- CreateIndex
CREATE INDEX "retention_job_runs_jobName_finishedAt_idx" ON "retention_job_runs"("jobName", "finishedAt");

-- CreateIndex
CREATE INDEX "retention_job_runs_status_finishedAt_idx" ON "retention_job_runs"("status", "finishedAt");

-- CreateIndex
CREATE INDEX "vehicles_shopId_status_idx" ON "vehicles"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_shopId_licensePlate_key" ON "vehicles"("shopId", "licensePlate");

-- CreateIndex
CREATE INDEX "driver_events_shopId_routePlanId_occurredAt_idx" ON "driver_events"("shopId", "routePlanId", "occurredAt");

-- CreateIndex
CREATE INDEX "driver_events_shopId_deliveryStopId_occurredAt_idx" ON "driver_events"("shopId", "deliveryStopId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "driver_events_driverId_clientEventId_key" ON "driver_events"("driverId", "clientEventId");

-- AddForeignKey
ALTER TABLE "shopify_webhook_events" ADD CONSTRAINT "shopify_webhook_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_stops" ADD CONSTRAINT "delivery_stops_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_stops" ADD CONSTRAINT "delivery_stops_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plans" ADD CONSTRAINT "route_plans_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plans" ADD CONSTRAINT "route_plans_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plans" ADD CONSTRAINT "route_plans_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plan_stops" ADD CONSTRAINT "route_plan_stops_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plan_stops" ADD CONSTRAINT "route_plan_stops_deliveryStopId_fkey" FOREIGN KEY ("deliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_sessions" ADD CONSTRAINT "driver_sessions_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_consent_records" ADD CONSTRAINT "driver_consent_records_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_consent_records" ADD CONSTRAINT "driver_consent_records_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_proof_media" ADD CONSTRAINT "driver_proof_media_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_proof_media" ADD CONSTRAINT "driver_proof_media_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_proof_media" ADD CONSTRAINT "driver_proof_media_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_proof_media" ADD CONSTRAINT "driver_proof_media_deliveryStopId_fkey" FOREIGN KEY ("deliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_route_feedback" ADD CONSTRAINT "driver_route_feedback_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_route_feedback" ADD CONSTRAINT "driver_route_feedback_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_route_feedback" ADD CONSTRAINT "driver_route_feedback_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_account_deletion_requests" ADD CONSTRAINT "driver_account_deletion_requests_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_account_deletion_requests" ADD CONSTRAINT "driver_account_deletion_requests_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_events" ADD CONSTRAINT "driver_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_events" ADD CONSTRAINT "driver_events_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_events" ADD CONSTRAINT "driver_events_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_events" ADD CONSTRAINT "driver_events_deliveryStopId_fkey" FOREIGN KEY ("deliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
