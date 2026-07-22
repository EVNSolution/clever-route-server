-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ShopifyWebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "CommerceSourcePlatform" AS ENUM ('SHOPIFY', 'WOOCOMMERCE');

-- CreateEnum
CREATE TYPE "CommerceConnectionStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "CommerceSyncRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "CommerceRawOrderIngestStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "WordPressPluginTokenStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "DeliveryOrderStatus" AS ENUM ('PENDING', 'READY', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GeocodeStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'RESOLVED', 'FAILED');

-- CreateEnum
CREATE TYPE "DeliveryStopStatus" AS ENUM ('PENDING', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryDayParseStatus" AS ENUM ('NOT_PROVIDED', 'PARSED', 'UNPARSED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "OrderDeliveryFactReadiness" AS ENUM ('READY_TO_PLAN', 'NEEDS_REVIEW', 'SKIPPED');

-- CreateEnum
CREATE TYPE "RoutePlanStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED', 'OPTIMIZED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'READY');

-- CreateEnum
CREATE TYPE "RouteOptimizationJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'APPLIED', 'TIMEOUT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RouteOptimizationJobStep" AS ENUM ('QUEUED', 'CALLING_ENGINE', 'APPLYING_RESULT', 'COMPLETED');

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

-- CreateEnum
CREATE TYPE "RouteGroupingStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED', 'READY', 'CHANGED');

-- CreateEnum
CREATE TYPE "RouteGroupingAssignmentStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'OVERLAP', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "RouteGroupingVersionStatus" AS ENUM ('DRAFT', 'CURRENT', 'ARCHIVED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "RouteGroupingChildVersionStatus" AS ENUM ('CURRENT', 'ARCHIVED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "DriverPushTokenStatus" AS ENUM ('ACTIVE', 'REVOKED', 'INVALID');

-- CreateEnum
CREATE TYPE "DriverRouteNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DriverRouteNotificationAction" AS ENUM ('ASSIGNED', 'CHANGED');

-- CreateEnum
CREATE TYPE "CustomerRouteNotificationStatus" AS ENUM ('QUEUED', 'SENT');

-- CreateEnum
CREATE TYPE "DsvDispatchImportStatus" AS ENUM ('READY', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "DsvDispatchImportRowStatus" AS ENUM ('READY', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CustomerAccountStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DsvTransportConditionStatus" AS ENUM ('CANDIDATE', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DsvCommandReceiptStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "DsvPrincipalType" AS ENUM ('DSV_ADMIN', 'CUSTOMER_USER', 'DRIVER', 'IMPORT_WORKER', 'DEVICE', 'SYSTEM_WORKER');

-- CreateEnum
CREATE TYPE "DsvAuditRedactionClass" AS ENUM ('STANDARD', 'PII_REDACTED', 'SECRET_REDACTED');

-- CreateTable
CREATE TABLE "shops" (
    "id" UUID NOT NULL,
    "appId" TEXT NOT NULL DEFAULT 'clever',
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
    "defaultDepotAddress" TEXT,
    "defaultDepotLatitude" DECIMAL(10,7),
    "defaultDepotLongitude" DECIMAL(10,7),
    "locale" TEXT,
    "routeScopeConfig" JSONB,
    "routeOpsUiSettings" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_notifications" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "orderId" UUID,
    "routePlanId" UUID,
    "payload" JSONB,
    "readAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_connections" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "platform" "CommerceSourcePlatform" NOT NULL,
    "status" "CommerceConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "label" TEXT,
    "siteUrl" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "timezone" TEXT,
    "consumerKeyCiphertext" TEXT NOT NULL,
    "consumerSecretCiphertext" TEXT NOT NULL,
    "webhookSecretCiphertext" TEXT NOT NULL,
    "lastWebhookAt" TIMESTAMPTZ(6),
    "lastRestSyncAt" TIMESTAMPTZ(6),
    "lastVerifiedAt" TIMESTAMPTZ(6),
    "lastVerificationStatus" TEXT,
    "credentialRotatedAt" TIMESTAMPTZ(6),
    "webhookSecretRotatedAt" TIMESTAMPTZ(6),
    "credentialFingerprint" TEXT,
    "lastSyncAt" TIMESTAMPTZ(6),
    "lastSyncStatus" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_sync_runs" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "commerceConnectionId" UUID NOT NULL,
    "platform" "CommerceSourcePlatform" NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'wordpress_plugin',
    "trigger" TEXT NOT NULL,
    "status" "CommerceSyncRunStatus" NOT NULL DEFAULT 'QUEUED',
    "requestPayload" JSONB NOT NULL,
    "pagesRead" INTEGER,
    "received" INTEGER,
    "created" INTEGER,
    "updated" INTEGER,
    "unchanged" INTEGER,
    "skipped" INTEGER,
    "readyToPlan" INTEGER,
    "needsReview" INTEGER,
    "geocodeResolved" INTEGER,
    "geocodeFailed" INTEGER,
    "geocodePending" INTEGER,
    "geocodeNotRequired" INTEGER,
    "warnings" JSONB NOT NULL,
    "errorMessage" TEXT,
    "acceptedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_raw_order_ingests" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "commerceConnectionId" UUID NOT NULL,
    "syncRunId" UUID NOT NULL,
    "platform" "CommerceSourcePlatform" NOT NULL DEFAULT 'WOOCOMMERCE',
    "sourceSiteUrl" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "sourceOrderNumber" TEXT,
    "sourceUpdatedAt" TIMESTAMPTZ(6),
    "rawPayload" JSONB NOT NULL,
    "rawPayloadSha256" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "status" "CommerceRawOrderIngestStatus" NOT NULL DEFAULT 'RECEIVED',
    "canonicalOrderId" UUID,
    "processingStartedAt" TIMESTAMPTZ(6),
    "processedAt" TIMESTAMPTZ(6),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT true,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_raw_order_ingests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_raw_order_ingest_events" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "commerceConnectionId" UUID,
    "syncRunId" UUID,
    "rawOrderIngestId" UUID,
    "sourceLine" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "sourceOrderId" TEXT,
    "sourceOrderNumber" TEXT,
    "rawPayloadSha256" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_raw_order_ingest_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_connection_audit_logs" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "commerceConnectionId" UUID,
    "actorSubject" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_connection_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_connection_order_mappings" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "commerceConnectionId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL,
    "discoveredPathStats" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_connection_order_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wordpress_plugin_tokens" (
    "id" UUID NOT NULL,
    "commerceConnectionId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "status" "WordPressPluginTokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(6),
    "rotatedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wordpress_plugin_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wordpress_plugin_pairing_codes" (
    "id" UUID NOT NULL,
    "commerceConnectionId" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "issuedBy" TEXT,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "consumedBySiteUrl" TEXT,
    "failedAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wordpress_plugin_pairing_codes_pkey" PRIMARY KEY ("id")
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
    "sellerOrderSourceKind" TEXT,
    "sellerOrderKey" TEXT,
    "sellerOrderVersion" INTEGER,
    "customerId" UUID,
    "destinationId" UUID,
    "currentRouteVersionId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "externalCustomerCode" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_accounts" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "status" "CustomerAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "scopeVersion" INTEGER NOT NULL DEFAULT 1,
    "lastAuthenticatedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" INTEGER NOT NULL,
    "variationId" INTEGER NOT NULL DEFAULT 0,
    "lineIndex" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "options" JSONB NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventories" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "routeGroupingId" UUID,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_orders" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "inventoryId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "addedBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_events" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "inventoryId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderItemId" UUID,
    "action" TEXT NOT NULL,
    "productId" INTEGER NOT NULL,
    "variationId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "options" JSONB NOT NULL,
    "quantity" INTEGER NOT NULL,
    "quantityDelta" INTEGER,
    "actor" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_events_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "delivery_customer_profiles" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "canonicalName" TEXT,
    "canonicalPhone" TEXT,
    "canonicalEmail" TEXT,
    "addressFingerprint" TEXT NOT NULL,
    "normalizedAddress" JSONB NOT NULL,
    "normalizedNameKey" TEXT,
    "adminMemo" TEXT,
    "mergedIntoProfileId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "delivery_customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "destination_tips" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "sourceDeliveryStopId" UUID,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "destination_tips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "destination_tip_audits" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "tipId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "destination_tip_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_customer_profile_order_links" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "matchStatus" TEXT NOT NULL,
    "matchScore" DECIMAL(5,4),
    "matchReasons" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "delivery_customer_profile_order_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_delivery_facts" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "commerceConnectionId" UUID,
    "sourcePlatform" "CommerceSourcePlatform" NOT NULL,
    "sourceSiteUrl" TEXT,
    "sourceOrderId" TEXT,
    "sourceOrderNumber" TEXT,
    "sourceUpdatedAt" TIMESTAMPTZ(6),
    "rawDeliveryDate" TEXT,
    "rawDeliveryDay" TEXT,
    "rawDeliveryTimeWindow" TEXT,
    "rawDeliveryArea" TEXT,
    "rawPickupDay" TEXT,
    "matchedMappingPaths" JSONB NOT NULL,
    "mappingDiagnostics" JSONB,
    "deliveryDayParseStatus" "DeliveryDayParseStatus" NOT NULL DEFAULT 'NOT_PROVIDED',
    "deliveryDayUnparsedReason" TEXT,
    "deliveryDateWeekdayVerified" BOOLEAN NOT NULL DEFAULT false,
    "deliveryDateWeekdayMismatch" BOOLEAN NOT NULL DEFAULT false,
    "deliveryDate" DATE,
    "deliveryWeekday" TEXT,
    "deliveryDateWeekday" TEXT,
    "deliverySession" TEXT,
    "serviceType" TEXT,
    "timeWindowStart" TIMESTAMPTZ(6),
    "timeWindowEnd" TIMESTAMPTZ(6),
    "deliveryArea" TEXT,
    "routeScopeKey" TEXT,
    "planningGroupKey" TEXT,
    "readiness" "OrderDeliveryFactReadiness" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "reviewReasons" JSONB NOT NULL,
    "batchEligible" BOOLEAN NOT NULL DEFAULT false,
    "geocodeStatus" "GeocodeStatus" NOT NULL DEFAULT 'PENDING',
    "computedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_delivery_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_plans" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "planDate" DATE NOT NULL,
    "status" "RoutePlanStatus" NOT NULL DEFAULT 'READY',
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
CREATE TABLE "route_tracking_geometries" (
    "id" UUID NOT NULL,
    "routePlanId" UUID NOT NULL,
    "geometry" JSONB,
    "sampleMetadata" JSONB NOT NULL,
    "sourcePointCount" INTEGER NOT NULL,
    "geometryPointCount" INTEGER NOT NULL,
    "firstOccurredAt" TIMESTAMPTZ(6) NOT NULL,
    "lastOccurredAt" TIMESTAMPTZ(6) NOT NULL,
    "lastReceivedAt" TIMESTAMPTZ(6) NOT NULL,
    "lastEventId" UUID NOT NULL,
    "lastDriverId" UUID,
    "lastLatitude" DECIMAL(10,7) NOT NULL,
    "lastLongitude" DECIMAL(10,7) NOT NULL,
    "roadMatchedGeometry" JSONB,
    "roadMatchedUncertainGeometry" JSONB,
    "roadMatchedCoverage" TEXT,
    "roadMatchedSchemaVersion" TEXT,
    "roadMatchedSourcePointCount" INTEGER,
    "roadMatchedPointCount" INTEGER,
    "roadMatchedLastInputOccurredAt" TIMESTAMPTZ(6),
    "roadMatchedLastPosition" JSONB,
    "roadMatchedWatermark" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "route_tracking_geometries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_plan_geometry_caches" (
    "id" UUID NOT NULL,
    "routePlanId" UUID NOT NULL,
    "shapeSignature" TEXT NOT NULL,
    "geometry" JSONB,
    "metrics" JSONB,
    "stopPoints" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "providerVersion" TEXT,
    "overview" TEXT NOT NULL DEFAULT 'simplified',
    "source" TEXT NOT NULL,
    "generatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "route_plan_geometry_caches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_optimization_jobs" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "routePlanId" UUID NOT NULL,
    "status" "RouteOptimizationJobStatus" NOT NULL DEFAULT 'QUEUED',
    "currentStep" "RouteOptimizationJobStep" NOT NULL DEFAULT 'QUEUED',
    "timeoutBudgetMs" INTEGER NOT NULL,
    "elapsedMs" INTEGER,
    "engineResultSequence" JSONB,
    "appliedAt" TIMESTAMPTZ(6),
    "invalidatedReason" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "traceId" TEXT NOT NULL,
    "createdBy" TEXT,
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "route_optimization_jobs_pkey" PRIMARY KEY ("id")
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
    "accountId" UUID,
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
CREATE TABLE "driver_accounts" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "name" VARCHAR(80),
    "pinHash" TEXT NOT NULL,
    "pinSalt" TEXT NOT NULL,
    "status" "DriverStatus" NOT NULL DEFAULT 'ACTIVE',
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "failedPinAttempts" INTEGER NOT NULL DEFAULT 0,
    "pinLockedUntil" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "driver_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_account_sessions" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(6),

    CONSTRAINT "driver_account_sessions_pkey" PRIMARY KEY ("id")
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
    "accountId" UUID,
    "shopId" UUID,
    "driverId" UUID,
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
    "driverId" UUID,
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
    "driverId" UUID,
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
CREATE TABLE "route_groupings" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "planDate" DATE NOT NULL,
    "dateRangeStart" DATE,
    "dateRangeEnd" DATE,
    "routeScopeKey" TEXT,
    "serviceType" TEXT,
    "deliverySession" TEXT,
    "status" "RouteGroupingStatus" NOT NULL DEFAULT 'READY',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "route_groupings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_grouping_orders" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "groupingId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "deliveryStopId" UUID NOT NULL,
    "assignmentStatus" "RouteGroupingAssignmentStatus" NOT NULL DEFAULT 'UNASSIGNED',
    "assignedDriverId" UUID,
    "assignedPolygonId" UUID,
    "sourceSequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "route_grouping_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_grouping_branches" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "groupingId" UUID NOT NULL,
    "driverId" UUID,
    "label" TEXT,
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "optimizedJson" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "route_grouping_branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_grouping_branch_order_locks" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "groupingId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "routeGroupingOrderId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "deliveryStopId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "route_grouping_branch_order_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_grouping_polygons" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "groupingId" UUID NOT NULL,
    "driverId" UUID,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "geometryJson" JSONB NOT NULL,
    "drawOrder" INTEGER NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "route_grouping_polygons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_grouping_versions" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "groupingId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "RouteGroupingVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "changeReason" TEXT,
    "actor" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_grouping_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_grouping_child_versions" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "groupingId" UUID NOT NULL,
    "groupingVersionId" UUID NOT NULL,
    "driverId" UUID,
    "routePlanId" UUID,
    "version" INTEGER NOT NULL,
    "status" "RouteGroupingChildVersionStatus" NOT NULL DEFAULT 'CURRENT',
    "snapshot" JSONB NOT NULL,
    "publishedAt" TIMESTAMPTZ(6),
    "supersededAt" TIMESTAMPTZ(6),
    "notificationStatus" "DriverRouteNotificationStatus" NOT NULL DEFAULT 'SKIPPED',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "route_grouping_child_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_push_tokens" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "devicePushToken" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "deviceId" TEXT,
    "appId" TEXT NOT NULL,
    "appVersion" TEXT,
    "locale" TEXT,
    "timezone" TEXT,
    "status" "DriverPushTokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "driver_push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_route_notification_attempts" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "groupingId" UUID NOT NULL,
    "groupingVersion" INTEGER NOT NULL,
    "childVersionId" UUID NOT NULL,
    "routePlanId" UUID NOT NULL,
    "driverId" UUID,
    "action" "DriverRouteNotificationAction" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "DriverRouteNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attemptedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "driver_route_notification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_route_notification_facts" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "status" "CustomerRouteNotificationStatus" NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_route_notification_facts_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "dsv_driver_profiles" (
    "driverId" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "lookupName" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "gender" TEXT NOT NULL,
    "career" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "score" TEXT NOT NULL,
    "traits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_driver_profiles_pkey" PRIMARY KEY ("driverId")
);

-- CreateTable
CREATE TABLE "dsv_vehicle_profiles" (
    "vehicleId" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "typeLabel" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_vehicle_profiles_pkey" PRIMARY KEY ("vehicleId")
);

-- CreateTable
CREATE TABLE "dsv_vehicle_driver_assignments" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsv_vehicle_driver_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_transport_conditions" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rawValue" TEXT,
    "comparisonKey" TEXT,
    "status" "DsvTransportConditionStatus" DEFAULT 'CANDIDATE',
    "activatedAt" TIMESTAMPTZ(6),
    "deactivatedAt" TIMESTAMPTZ(6),
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_transport_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_dispatch_imports" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "planDate" DATE NOT NULL,
    "status" "DsvDispatchImportStatus" NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_dispatch_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_dispatch_import_rows" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "driverId" UUID,
    "vehicleId" UUID,
    "driverName" TEXT NOT NULL,
    "vehiclePlate" TEXT NOT NULL,
    "destinationName" TEXT NOT NULL,
    "conditionCode" TEXT NOT NULL,
    "shippedBoxes" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "sellerOrderKey" TEXT NOT NULL,
    "notes" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "status" "DsvDispatchImportRowStatus" NOT NULL,
    "issues" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_dispatch_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_command_receipts" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "commandName" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "principalType" "DsvPrincipalType" NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" "DsvCommandReceiptStatus" NOT NULL DEFAULT 'STARTED',
    "resultEntityType" TEXT,
    "resultEntityId" TEXT,
    "responseStatus" INTEGER,
    "responseBodyRef" TEXT,
    "importId" UUID,
    "sellerOrderId" UUID,
    "previousRoutePlanId" UUID,
    "nextRoutePlanId" UUID,
    "previousRouteVersionId" UUID,
    "nextRouteVersionId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    "retainedUntil" TIMESTAMPTZ(6),

    CONSTRAINT "dsv_command_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_audit_events" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sellerOrderId" UUID,
    "customerId" UUID,
    "destinationId" UUID,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "principalType" "DsvPrincipalType" NOT NULL,
    "requestId" TEXT NOT NULL,
    "commandReceiptId" UUID,
    "importId" UUID,
    "previousRoutePlanId" UUID,
    "nextRoutePlanId" UUID,
    "previousRouteVersionId" UUID,
    "nextRouteVersionId" UUID,
    "redactedDiff" JSONB,
    "beforeSnapshotRef" TEXT,
    "afterSnapshotRef" TEXT,
    "reason" TEXT,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retainedUntil" TIMESTAMPTZ(6),
    "redactionClass" "DsvAuditRedactionClass" NOT NULL DEFAULT 'STANDARD',

    CONSTRAINT "dsv_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_events" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "driverId" UUID,
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
CREATE INDEX "shops_shopDomain_idx" ON "shops"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "shops_appId_shopDomain_key" ON "shops"("appId", "shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "shops_appId_shopifyShopGid_key" ON "shops"("appId", "shopifyShopGid");

-- CreateIndex
CREATE INDEX "admin_notifications_shopId_readAt_createdAt_idx" ON "admin_notifications"("shopId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "admin_notifications_shopId_type_createdAt_idx" ON "admin_notifications"("shopId", "type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_notifications_shopId_dedupeKey_key" ON "admin_notifications"("shopId", "dedupeKey");

-- CreateIndex
CREATE INDEX "commerce_connections_shopId_platform_status_idx" ON "commerce_connections"("shopId", "platform", "status");

-- CreateIndex
CREATE INDEX "commerce_connections_platform_siteUrl_idx" ON "commerce_connections"("platform", "siteUrl");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_connections_shopId_platform_siteUrl_key" ON "commerce_connections"("shopId", "platform", "siteUrl");

-- CreateIndex
CREATE INDEX "commerce_sync_runs_commerceConnectionId_status_createdAt_idx" ON "commerce_sync_runs"("commerceConnectionId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_sync_runs_commerceConnectionId_createdAt_idx" ON "commerce_sync_runs"("commerceConnectionId", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_sync_runs_shopId_platform_createdAt_idx" ON "commerce_sync_runs"("shopId", "platform", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_raw_order_ingests_syncRunId_status_receivedAt_idx" ON "commerce_raw_order_ingests"("syncRunId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "commerce_raw_order_ingests_commerceConnectionId_sourceOrder_idx" ON "commerce_raw_order_ingests"("commerceConnectionId", "sourceOrderId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_raw_order_ingests_commerceConnectionId_sourceOrder_key" ON "commerce_raw_order_ingests"("commerceConnectionId", "sourceOrderId", "rawPayloadSha256");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_raw_order_ingests_syncRunId_chunkId_sourceOrderId__key" ON "commerce_raw_order_ingests"("syncRunId", "chunkId", "sourceOrderId", "rawPayloadSha256");

-- CreateIndex
CREATE INDEX "raw_ingest_events_shop_order_number_createdAt_idx" ON "commerce_raw_order_ingest_events"("shopId", "sourceOrderNumber", "createdAt");

-- CreateIndex
CREATE INDEX "raw_ingest_events_shop_order_id_createdAt_idx" ON "commerce_raw_order_ingest_events"("shopId", "sourceOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "raw_ingest_events_raw_ingest_createdAt_idx" ON "commerce_raw_order_ingest_events"("rawOrderIngestId", "createdAt");

-- CreateIndex
CREATE INDEX "raw_ingest_events_sync_run_createdAt_idx" ON "commerce_raw_order_ingest_events"("syncRunId", "createdAt");

-- CreateIndex
CREATE INDEX "raw_ingest_events_shop_code_createdAt_idx" ON "commerce_raw_order_ingest_events"("shopId", "code", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_connection_audit_logs_shopId_createdAt_idx" ON "commerce_connection_audit_logs"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_connection_audit_logs_commerceConnectionId_created_idx" ON "commerce_connection_audit_logs"("commerceConnectionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_connection_order_mappings_commerceConnectionId_key" ON "commerce_connection_order_mappings"("commerceConnectionId");

-- CreateIndex
CREATE INDEX "commerce_connection_order_mappings_shopId_idx" ON "commerce_connection_order_mappings"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "wordpress_plugin_tokens_tokenHash_key" ON "wordpress_plugin_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "wordpress_plugin_tokens_commerceConnectionId_status_idx" ON "wordpress_plugin_tokens"("commerceConnectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wordpress_plugin_pairing_codes_codeHash_key" ON "wordpress_plugin_pairing_codes"("codeHash");

-- CreateIndex
CREATE INDEX "wordpress_plugin_pairing_codes_commerceConnectionId_expires_idx" ON "wordpress_plugin_pairing_codes"("commerceConnectionId", "expiresAt");

-- CreateIndex
CREATE INDEX "wordpress_plugin_pairing_codes_shopId_expiresAt_idx" ON "wordpress_plugin_pairing_codes"("shopId", "expiresAt");

-- CreateIndex
CREATE INDEX "shopify_webhook_events_shopId_topic_receivedAt_idx" ON "shopify_webhook_events"("shopId", "topic", "receivedAt");

-- CreateIndex
CREATE INDEX "shopify_webhook_events_status_receivedAt_idx" ON "shopify_webhook_events"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_webhook_events_shopId_webhookId_key" ON "shopify_webhook_events"("shopId", "webhookId");

-- CreateIndex
CREATE INDEX "orders_shopId_name_idx" ON "orders"("shopId", "name");

-- CreateIndex
CREATE INDEX "orders_shopId_sourcePlatform_sourceSiteUrl_sourceOrderNumbe_idx" ON "orders"("shopId", "sourcePlatform", "sourceSiteUrl", "sourceOrderNumber");

-- CreateIndex
CREATE INDEX "orders_shopId_sourcePlatform_sourceUpdatedAt_idx" ON "orders"("shopId", "sourcePlatform", "sourceUpdatedAt");

-- CreateIndex
CREATE INDEX "orders_shopId_deliveryStatus_processedAt_idx" ON "orders"("shopId", "deliveryStatus", "processedAt");

-- CreateIndex
CREATE INDEX "orders_shopId_customerId_deliveryStatus_idx" ON "orders"("shopId", "customerId", "deliveryStatus");

-- CreateIndex
CREATE INDEX "orders_shopId_destinationId_idx" ON "orders"("shopId", "destinationId");

-- CreateIndex
CREATE INDEX "orders_shopId_currentRouteVersionId_idx" ON "orders"("shopId", "currentRouteVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shopId_shopifyOrderGid_key" ON "orders"("shopId", "shopifyOrderGid");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shopId_sourcePlatform_sourceSiteUrl_sourceOrderId_key" ON "orders"("shopId", "sourcePlatform", "sourceSiteUrl", "sourceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shopId_sellerOrderSourceKind_sellerOrderKey_key" ON "orders"("shopId", "sellerOrderSourceKind", "sellerOrderKey");

-- CreateIndex
CREATE INDEX "customers_shopId_status_idx" ON "customers"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customers_id_shopId_key" ON "customers"("id", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_shopId_sourceKind_externalCustomerCode_key" ON "customers"("shopId", "sourceKind", "externalCustomerCode");

-- CreateIndex
CREATE INDEX "customer_accounts_shopId_customerId_status_idx" ON "customer_accounts"("shopId", "customerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_shopId_issuer_subject_key" ON "customer_accounts"("shopId", "issuer", "subject");

-- CreateIndex
CREATE INDEX "order_items_shopId_orderId_idx" ON "order_items"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "order_items_shopId_productId_variationId_idx" ON "order_items"("shopId", "productId", "variationId");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_orderId_lineIndex_key" ON "order_items"("orderId", "lineIndex");

-- CreateIndex
CREATE UNIQUE INDEX "inventories_routeGroupingId_key" ON "inventories"("routeGroupingId");

-- CreateIndex
CREATE INDEX "inventories_shopId_createdAt_idx" ON "inventories"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_orders_shopId_orderId_idx" ON "inventory_orders"("shopId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_orders_inventoryId_orderId_key" ON "inventory_orders"("inventoryId", "orderId");

-- CreateIndex
CREATE INDEX "inventory_events_inventoryId_createdAt_idx" ON "inventory_events"("inventoryId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_events_shopId_orderId_idx" ON "inventory_events"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "inventory_events_shopId_productId_variationId_idx" ON "inventory_events"("shopId", "productId", "variationId");

-- CreateIndex
CREATE INDEX "delivery_stops_shopId_deliveryDate_status_idx" ON "delivery_stops"("shopId", "deliveryDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_stops_shopId_orderId_key" ON "delivery_stops"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "delivery_customer_profiles_shopId_addressFingerprint_idx" ON "delivery_customer_profiles"("shopId", "addressFingerprint");

-- CreateIndex
CREATE INDEX "delivery_customer_profiles_shopId_canonicalPhone_idx" ON "delivery_customer_profiles"("shopId", "canonicalPhone");

-- CreateIndex
CREATE INDEX "delivery_customer_profiles_shopId_canonicalEmail_idx" ON "delivery_customer_profiles"("shopId", "canonicalEmail");

-- CreateIndex
CREATE INDEX "delivery_customer_profiles_shopId_mergedIntoProfileId_idx" ON "delivery_customer_profiles"("shopId", "mergedIntoProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_customer_profiles_id_shopId_key" ON "delivery_customer_profiles"("id", "shopId");

-- CreateIndex
CREATE INDEX "destination_tips_shopId_destinationId_status_updatedAt_idx" ON "destination_tips"("shopId", "destinationId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "destination_tips_shopId_sourceDeliveryStopId_idx" ON "destination_tips"("shopId", "sourceDeliveryStopId");

-- CreateIndex
CREATE INDEX "destination_tip_audits_shopId_createdAt_idx" ON "destination_tip_audits"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "destination_tip_audits_tipId_revision_key" ON "destination_tip_audits"("tipId", "revision");

-- CreateIndex
CREATE INDEX "delivery_customer_profile_order_links_shopId_profileId_idx" ON "delivery_customer_profile_order_links"("shopId", "profileId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_customer_profile_order_links_shopId_orderId_key" ON "delivery_customer_profile_order_links"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "order_delivery_facts_shopId_deliveryDate_readiness_idx" ON "order_delivery_facts"("shopId", "deliveryDate", "readiness");

-- CreateIndex
CREATE INDEX "order_delivery_facts_shopId_routeScopeKey_batchEligible_idx" ON "order_delivery_facts"("shopId", "routeScopeKey", "batchEligible");

-- CreateIndex
CREATE INDEX "order_delivery_facts_shopId_planningGroupKey_idx" ON "order_delivery_facts"("shopId", "planningGroupKey");

-- CreateIndex
CREATE INDEX "order_delivery_facts_commerceConnectionId_sourceUpdatedAt_idx" ON "order_delivery_facts"("commerceConnectionId", "sourceUpdatedAt");

-- CreateIndex
CREATE INDEX "order_delivery_facts_shopId_sourcePlatform_sourceSiteUrl_so_idx" ON "order_delivery_facts"("shopId", "sourcePlatform", "sourceSiteUrl", "sourceOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "order_delivery_facts_shopId_orderId_key" ON "order_delivery_facts"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "route_plans_shopId_planDate_status_idx" ON "route_plans"("shopId", "planDate", "status");

-- CreateIndex
CREATE INDEX "route_plans_shopId_driverId_status_idx" ON "route_plans"("shopId", "driverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "route_tracking_geometries_routePlanId_key" ON "route_tracking_geometries"("routePlanId");

-- CreateIndex
CREATE INDEX "route_tracking_geometries_expiresAt_idx" ON "route_tracking_geometries"("expiresAt");

-- CreateIndex
CREATE INDEX "route_plan_geometry_caches_shapeSignature_idx" ON "route_plan_geometry_caches"("shapeSignature");

-- CreateIndex
CREATE UNIQUE INDEX "route_plan_geometry_caches_routePlanId_shapeSignature_key" ON "route_plan_geometry_caches"("routePlanId", "shapeSignature");

-- CreateIndex
CREATE INDEX "route_optimization_jobs_routePlanId_createdAt_idx" ON "route_optimization_jobs"("routePlanId", "createdAt");

-- CreateIndex
CREATE INDEX "route_optimization_jobs_shopId_status_createdAt_idx" ON "route_optimization_jobs"("shopId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "route_optimization_jobs_traceId_idx" ON "route_optimization_jobs"("traceId");

-- CreateIndex
CREATE INDEX "route_plan_stops_deliveryStopId_idx" ON "route_plan_stops"("deliveryStopId");

-- CreateIndex
CREATE UNIQUE INDEX "route_plan_stops_routePlanId_sequence_key" ON "route_plan_stops"("routePlanId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "route_plan_stops_routePlanId_deliveryStopId_key" ON "route_plan_stops"("routePlanId", "deliveryStopId");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_authSubject_key" ON "drivers"("authSubject");

-- CreateIndex
CREATE INDEX "drivers_accountId_status_idx" ON "drivers"("accountId", "status");

-- CreateIndex
CREATE INDEX "drivers_shopId_status_idx" ON "drivers"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_shopId_inviteCode_key" ON "drivers"("shopId", "inviteCode");

-- CreateIndex
CREATE UNIQUE INDEX "driver_accounts_phone_key" ON "driver_accounts"("phone");

-- CreateIndex
CREATE INDEX "driver_accounts_status_idx" ON "driver_accounts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "driver_account_sessions_refreshTokenHash_key" ON "driver_account_sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "driver_account_sessions_accountId_expiresAt_idx" ON "driver_account_sessions"("accountId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "driver_sessions_refreshTokenHash_key" ON "driver_sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "driver_sessions_driverId_expiresAt_idx" ON "driver_sessions"("driverId", "expiresAt");

-- CreateIndex
CREATE INDEX "driver_consent_records_shopId_driverId_recordedAt_idx" ON "driver_consent_records"("shopId", "driverId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "driver_consent_records_accountId_consentType_consentVersion_key" ON "driver_consent_records"("accountId", "consentType", "consentVersion");

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
CREATE INDEX "route_groupings_shopId_planDate_status_idx" ON "route_groupings"("shopId", "planDate", "status");

-- CreateIndex
CREATE INDEX "route_groupings_shopId_dateRangeStart_dateRangeEnd_status_idx" ON "route_groupings"("shopId", "dateRangeStart", "dateRangeEnd", "status");

-- CreateIndex
CREATE INDEX "route_grouping_orders_shopId_assignedDriverId_idx" ON "route_grouping_orders"("shopId", "assignedDriverId");

-- CreateIndex
CREATE INDEX "route_grouping_orders_groupingId_assignmentStatus_idx" ON "route_grouping_orders"("groupingId", "assignmentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "route_grouping_orders_groupingId_orderId_key" ON "route_grouping_orders"("groupingId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "route_grouping_orders_groupingId_deliveryStopId_key" ON "route_grouping_orders"("groupingId", "deliveryStopId");

-- CreateIndex
CREATE INDEX "route_grouping_branches_groupingId_sortOrder_idx" ON "route_grouping_branches"("groupingId", "sortOrder");

-- CreateIndex
CREATE INDEX "route_grouping_branches_groupingId_createdAt_idx" ON "route_grouping_branches"("groupingId", "createdAt");

-- CreateIndex
CREATE INDEX "route_grouping_branches_shopId_driverId_idx" ON "route_grouping_branches"("shopId", "driverId");

-- CreateIndex
CREATE INDEX "route_grouping_branch_order_locks_groupingId_idx" ON "route_grouping_branch_order_locks"("groupingId");

-- CreateIndex
CREATE INDEX "route_grouping_branch_order_locks_branchId_idx" ON "route_grouping_branch_order_locks"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "route_grouping_branch_order_locks_groupingId_orderId_key" ON "route_grouping_branch_order_locks"("groupingId", "orderId");

-- CreateIndex
CREATE INDEX "route_grouping_polygons_groupingId_drawOrder_idx" ON "route_grouping_polygons"("groupingId", "drawOrder");

-- CreateIndex
CREATE INDEX "route_grouping_polygons_shopId_driverId_idx" ON "route_grouping_polygons"("shopId", "driverId");

-- CreateIndex
CREATE INDEX "route_grouping_versions_shopId_status_createdAt_idx" ON "route_grouping_versions"("shopId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "route_grouping_versions_groupingId_version_key" ON "route_grouping_versions"("groupingId", "version");

-- CreateIndex
CREATE INDEX "route_grouping_child_versions_groupingId_version_status_idx" ON "route_grouping_child_versions"("groupingId", "version", "status");

-- CreateIndex
CREATE INDEX "route_grouping_child_versions_shopId_routePlanId_idx" ON "route_grouping_child_versions"("shopId", "routePlanId");

-- CreateIndex
CREATE INDEX "driver_push_tokens_shopId_driverId_status_idx" ON "driver_push_tokens"("shopId", "driverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "driver_push_tokens_driverId_tokenHash_key" ON "driver_push_tokens"("driverId", "tokenHash");

-- CreateIndex
CREATE INDEX "driver_route_notification_attempts_groupingId_groupingVersi_idx" ON "driver_route_notification_attempts"("groupingId", "groupingVersion");

-- CreateIndex
CREATE INDEX "driver_route_notification_attempts_routePlanId_driverId_idx" ON "driver_route_notification_attempts"("routePlanId", "driverId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_route_notification_attempts_idempotencyKey_key" ON "driver_route_notification_attempts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "customer_route_notification_facts_shopId_orderId_status_idx" ON "customer_route_notification_facts"("shopId", "orderId", "status");

-- CreateIndex
CREATE INDEX "retention_job_runs_jobName_finishedAt_idx" ON "retention_job_runs"("jobName", "finishedAt");

-- CreateIndex
CREATE INDEX "retention_job_runs_status_finishedAt_idx" ON "retention_job_runs"("status", "finishedAt");

-- CreateIndex
CREATE INDEX "vehicles_shopId_status_idx" ON "vehicles"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_shopId_licensePlate_key" ON "vehicles"("shopId", "licensePlate");

-- CreateIndex
CREATE INDEX "dsv_driver_profiles_shopId_idx" ON "dsv_driver_profiles"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_driver_profiles_shopId_lookupName_key" ON "dsv_driver_profiles"("shopId", "lookupName");

-- CreateIndex
CREATE INDEX "dsv_vehicle_profiles_shopId_idx" ON "dsv_vehicle_profiles"("shopId");

-- CreateIndex
CREATE INDEX "dsv_vehicle_driver_assignments_shopId_driverId_idx" ON "dsv_vehicle_driver_assignments"("shopId", "driverId");

-- CreateIndex
CREATE INDEX "dsv_vehicle_driver_assignments_shopId_vehicleId_idx" ON "dsv_vehicle_driver_assignments"("shopId", "vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_vehicle_driver_assignments_shopId_vehicleId_driverId_key" ON "dsv_vehicle_driver_assignments"("shopId", "vehicleId", "driverId");

-- CreateIndex
CREATE INDEX "dsv_transport_conditions_shopId_status_updatedAt_idx" ON "dsv_transport_conditions"("shopId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "dsv_transport_conditions_shopId_createdAt_idx" ON "dsv_transport_conditions"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_transport_conditions_shopId_code_key" ON "dsv_transport_conditions"("shopId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_transport_conditions_shopId_comparisonKey_key" ON "dsv_transport_conditions"("shopId", "comparisonKey");

-- CreateIndex
CREATE INDEX "dsv_dispatch_imports_shopId_planDate_createdAt_idx" ON "dsv_dispatch_imports"("shopId", "planDate", "createdAt");

-- CreateIndex
CREATE INDEX "dsv_dispatch_import_rows_importId_status_rowNumber_idx" ON "dsv_dispatch_import_rows"("importId", "status", "rowNumber");

-- CreateIndex
CREATE INDEX "dsv_dispatch_import_rows_driverId_idx" ON "dsv_dispatch_import_rows"("driverId");

-- CreateIndex
CREATE INDEX "dsv_dispatch_import_rows_vehicleId_idx" ON "dsv_dispatch_import_rows"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_dispatch_import_rows_importId_rowNumber_key" ON "dsv_dispatch_import_rows"("importId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_dispatch_import_rows_shopId_sellerOrderKey_key" ON "dsv_dispatch_import_rows"("shopId", "sellerOrderKey");

-- CreateIndex
CREATE INDEX "dsv_command_receipts_shopId_status_createdAt_idx" ON "dsv_command_receipts"("shopId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "dsv_command_receipts_shopId_requestId_idx" ON "dsv_command_receipts"("shopId", "requestId");

-- CreateIndex
CREATE INDEX "dsv_command_receipts_shopId_sellerOrderId_createdAt_idx" ON "dsv_command_receipts"("shopId", "sellerOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "dsv_command_receipts_shopId_retainedUntil_idx" ON "dsv_command_receipts"("shopId", "retainedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_command_receipts_shopId_commandName_commandId_key" ON "dsv_command_receipts"("shopId", "commandName", "commandId");

-- CreateIndex
CREATE INDEX "dsv_audit_events_shopId_eventType_occurredAt_idx" ON "dsv_audit_events"("shopId", "eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "dsv_audit_events_shopId_entityType_entityId_occurredAt_idx" ON "dsv_audit_events"("shopId", "entityType", "entityId", "occurredAt");

-- CreateIndex
CREATE INDEX "dsv_audit_events_shopId_sellerOrderId_occurredAt_idx" ON "dsv_audit_events"("shopId", "sellerOrderId", "occurredAt");

-- CreateIndex
CREATE INDEX "dsv_audit_events_shopId_customerId_occurredAt_idx" ON "dsv_audit_events"("shopId", "customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "dsv_audit_events_shopId_destinationId_occurredAt_idx" ON "dsv_audit_events"("shopId", "destinationId", "occurredAt");

-- CreateIndex
CREATE INDEX "dsv_audit_events_shopId_commandReceiptId_idx" ON "dsv_audit_events"("shopId", "commandReceiptId");

-- CreateIndex
CREATE INDEX "dsv_audit_events_shopId_requestId_idx" ON "dsv_audit_events"("shopId", "requestId");

-- CreateIndex
CREATE INDEX "dsv_audit_events_shopId_retainedUntil_idx" ON "dsv_audit_events"("shopId", "retainedUntil");

-- CreateIndex
CREATE INDEX "driver_events_shopId_routePlanId_occurredAt_idx" ON "driver_events"("shopId", "routePlanId", "occurredAt");

-- CreateIndex
CREATE INDEX "driver_events_shopId_deliveryStopId_occurredAt_idx" ON "driver_events"("shopId", "deliveryStopId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "driver_events_driverId_clientEventId_key" ON "driver_events"("driverId", "clientEventId");

-- AddForeignKey
ALTER TABLE "admin_notifications" ADD CONSTRAINT "admin_notifications_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_connections" ADD CONSTRAINT "commerce_connections_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_sync_runs" ADD CONSTRAINT "commerce_sync_runs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_sync_runs" ADD CONSTRAINT "commerce_sync_runs_commerceConnectionId_fkey" FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_raw_order_ingests" ADD CONSTRAINT "commerce_raw_order_ingests_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_raw_order_ingests" ADD CONSTRAINT "commerce_raw_order_ingests_commerceConnectionId_fkey" FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_raw_order_ingests" ADD CONSTRAINT "commerce_raw_order_ingests_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "commerce_sync_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_raw_order_ingest_events" ADD CONSTRAINT "commerce_raw_order_ingest_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_raw_order_ingest_events" ADD CONSTRAINT "commerce_raw_order_ingest_events_commerceConnectionId_fkey" FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_raw_order_ingest_events" ADD CONSTRAINT "commerce_raw_order_ingest_events_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "commerce_sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_raw_order_ingest_events" ADD CONSTRAINT "commerce_raw_order_ingest_events_rawOrderIngestId_fkey" FOREIGN KEY ("rawOrderIngestId") REFERENCES "commerce_raw_order_ingests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_connection_audit_logs" ADD CONSTRAINT "commerce_connection_audit_logs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_connection_audit_logs" ADD CONSTRAINT "commerce_connection_audit_logs_commerceConnectionId_fkey" FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_connection_order_mappings" ADD CONSTRAINT "commerce_connection_order_mappings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_connection_order_mappings" ADD CONSTRAINT "commerce_connection_order_mappings_commerceConnectionId_fkey" FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wordpress_plugin_tokens" ADD CONSTRAINT "wordpress_plugin_tokens_commerceConnectionId_fkey" FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wordpress_plugin_pairing_codes" ADD CONSTRAINT "wordpress_plugin_pairing_codes_commerceConnectionId_fkey" FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wordpress_plugin_pairing_codes" ADD CONSTRAINT "wordpress_plugin_pairing_codes_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_webhook_events" ADD CONSTRAINT "shopify_webhook_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_shopId_fkey" FOREIGN KEY ("customerId", "shopId") REFERENCES "customers"("id", "shopId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_destinationId_shopId_fkey" FOREIGN KEY ("destinationId", "shopId") REFERENCES "delivery_customer_profiles"("id", "shopId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_currentRouteVersionId_fkey" FOREIGN KEY ("currentRouteVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_customerId_shopId_fkey" FOREIGN KEY ("customerId", "shopId") REFERENCES "customers"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_routeGroupingId_fkey" FOREIGN KEY ("routeGroupingId") REFERENCES "route_groupings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_orders" ADD CONSTRAINT "inventory_orders_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_orders" ADD CONSTRAINT "inventory_orders_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "inventories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_orders" ADD CONSTRAINT "inventory_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "inventories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_stops" ADD CONSTRAINT "delivery_stops_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_stops" ADD CONSTRAINT "delivery_stops_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_customer_profiles" ADD CONSTRAINT "delivery_customer_profiles_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_customer_profiles" ADD CONSTRAINT "delivery_customer_profiles_mergedIntoProfileId_fkey" FOREIGN KEY ("mergedIntoProfileId") REFERENCES "delivery_customer_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_tips" ADD CONSTRAINT "destination_tips_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_tips" ADD CONSTRAINT "destination_tips_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "delivery_customer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_tips" ADD CONSTRAINT "destination_tips_sourceDeliveryStopId_fkey" FOREIGN KEY ("sourceDeliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_tip_audits" ADD CONSTRAINT "destination_tip_audits_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_tip_audits" ADD CONSTRAINT "destination_tip_audits_tipId_fkey" FOREIGN KEY ("tipId") REFERENCES "destination_tips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_customer_profile_order_links" ADD CONSTRAINT "delivery_customer_profile_order_links_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_customer_profile_order_links" ADD CONSTRAINT "delivery_customer_profile_order_links_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "delivery_customer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_customer_profile_order_links" ADD CONSTRAINT "delivery_customer_profile_order_links_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_delivery_facts" ADD CONSTRAINT "order_delivery_facts_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_delivery_facts" ADD CONSTRAINT "order_delivery_facts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_delivery_facts" ADD CONSTRAINT "order_delivery_facts_commerceConnectionId_fkey" FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plans" ADD CONSTRAINT "route_plans_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plans" ADD CONSTRAINT "route_plans_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plans" ADD CONSTRAINT "route_plans_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_tracking_geometries" ADD CONSTRAINT "route_tracking_geometries_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plan_geometry_caches" ADD CONSTRAINT "route_plan_geometry_caches_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_optimization_jobs" ADD CONSTRAINT "route_optimization_jobs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_optimization_jobs" ADD CONSTRAINT "route_optimization_jobs_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plan_stops" ADD CONSTRAINT "route_plan_stops_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plan_stops" ADD CONSTRAINT "route_plan_stops_deliveryStopId_fkey" FOREIGN KEY ("deliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "driver_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_account_sessions" ADD CONSTRAINT "driver_account_sessions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "driver_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_sessions" ADD CONSTRAINT "driver_sessions_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_consent_records" ADD CONSTRAINT "driver_consent_records_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "driver_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_consent_records" ADD CONSTRAINT "driver_consent_records_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_consent_records" ADD CONSTRAINT "driver_consent_records_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_proof_media" ADD CONSTRAINT "driver_proof_media_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_proof_media" ADD CONSTRAINT "driver_proof_media_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_proof_media" ADD CONSTRAINT "driver_proof_media_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_proof_media" ADD CONSTRAINT "driver_proof_media_deliveryStopId_fkey" FOREIGN KEY ("deliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_route_feedback" ADD CONSTRAINT "driver_route_feedback_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_route_feedback" ADD CONSTRAINT "driver_route_feedback_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_route_feedback" ADD CONSTRAINT "driver_route_feedback_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_account_deletion_requests" ADD CONSTRAINT "driver_account_deletion_requests_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_account_deletion_requests" ADD CONSTRAINT "driver_account_deletion_requests_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_groupings" ADD CONSTRAINT "route_groupings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_deliveryStopId_fkey" FOREIGN KEY ("deliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_assignedDriverId_fkey" FOREIGN KEY ("assignedDriverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_assignedPolygonId_fkey" FOREIGN KEY ("assignedPolygonId") REFERENCES "route_grouping_polygons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_branches" ADD CONSTRAINT "route_grouping_branches_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_branches" ADD CONSTRAINT "route_grouping_branches_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_branches" ADD CONSTRAINT "route_grouping_branches_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_branch_order_locks" ADD CONSTRAINT "route_grouping_branch_order_locks_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_branch_order_locks" ADD CONSTRAINT "route_grouping_branch_order_locks_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_branch_order_locks" ADD CONSTRAINT "route_grouping_branch_order_locks_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "route_grouping_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_branch_order_locks" ADD CONSTRAINT "route_grouping_branch_order_locks_routeGroupingOrderId_fkey" FOREIGN KEY ("routeGroupingOrderId") REFERENCES "route_grouping_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_branch_order_locks" ADD CONSTRAINT "route_grouping_branch_order_locks_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_branch_order_locks" ADD CONSTRAINT "route_grouping_branch_order_locks_deliveryStopId_fkey" FOREIGN KEY ("deliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_polygons" ADD CONSTRAINT "route_grouping_polygons_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_polygons" ADD CONSTRAINT "route_grouping_polygons_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_polygons" ADD CONSTRAINT "route_grouping_polygons_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_versions" ADD CONSTRAINT "route_grouping_versions_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_versions" ADD CONSTRAINT "route_grouping_versions_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_child_versions" ADD CONSTRAINT "route_grouping_child_versions_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_child_versions" ADD CONSTRAINT "route_grouping_child_versions_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_child_versions" ADD CONSTRAINT "route_grouping_child_versions_groupingVersionId_fkey" FOREIGN KEY ("groupingVersionId") REFERENCES "route_grouping_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_child_versions" ADD CONSTRAINT "route_grouping_child_versions_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_grouping_child_versions" ADD CONSTRAINT "route_grouping_child_versions_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_push_tokens" ADD CONSTRAINT "driver_push_tokens_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_push_tokens" ADD CONSTRAINT "driver_push_tokens_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_route_notification_attempts" ADD CONSTRAINT "driver_route_notification_attempts_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_route_notification_attempts" ADD CONSTRAINT "driver_route_notification_attempts_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_route_notification_attempts" ADD CONSTRAINT "driver_route_notification_attempts_childVersionId_fkey" FOREIGN KEY ("childVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_route_notification_attempts" ADD CONSTRAINT "driver_route_notification_attempts_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_route_notification_attempts" ADD CONSTRAINT "driver_route_notification_attempts_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_route_notification_facts" ADD CONSTRAINT "customer_route_notification_facts_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_route_notification_facts" ADD CONSTRAINT "customer_route_notification_facts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_driver_profiles" ADD CONSTRAINT "dsv_driver_profiles_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_driver_profiles" ADD CONSTRAINT "dsv_driver_profiles_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_vehicle_profiles" ADD CONSTRAINT "dsv_vehicle_profiles_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_vehicle_profiles" ADD CONSTRAINT "dsv_vehicle_profiles_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_vehicle_driver_assignments" ADD CONSTRAINT "dsv_vehicle_driver_assignments_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_vehicle_driver_assignments" ADD CONSTRAINT "dsv_vehicle_driver_assignments_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_vehicle_driver_assignments" ADD CONSTRAINT "dsv_vehicle_driver_assignments_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_transport_conditions" ADD CONSTRAINT "dsv_transport_conditions_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_dispatch_imports" ADD CONSTRAINT "dsv_dispatch_imports_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_dispatch_import_rows" ADD CONSTRAINT "dsv_dispatch_import_rows_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_dispatch_import_rows" ADD CONSTRAINT "dsv_dispatch_import_rows_importId_fkey" FOREIGN KEY ("importId") REFERENCES "dsv_dispatch_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_dispatch_import_rows" ADD CONSTRAINT "dsv_dispatch_import_rows_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_dispatch_import_rows" ADD CONSTRAINT "dsv_dispatch_import_rows_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_command_receipts" ADD CONSTRAINT "dsv_command_receipts_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_command_receipts" ADD CONSTRAINT "dsv_command_receipts_importId_fkey" FOREIGN KEY ("importId") REFERENCES "dsv_dispatch_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_command_receipts" ADD CONSTRAINT "dsv_command_receipts_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_command_receipts" ADD CONSTRAINT "dsv_command_receipts_previousRoutePlanId_fkey" FOREIGN KEY ("previousRoutePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_command_receipts" ADD CONSTRAINT "dsv_command_receipts_nextRoutePlanId_fkey" FOREIGN KEY ("nextRoutePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_command_receipts" ADD CONSTRAINT "dsv_command_receipts_previousRouteVersionId_fkey" FOREIGN KEY ("previousRouteVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_command_receipts" ADD CONSTRAINT "dsv_command_receipts_nextRouteVersionId_fkey" FOREIGN KEY ("nextRouteVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_audit_events" ADD CONSTRAINT "dsv_audit_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_audit_events" ADD CONSTRAINT "dsv_audit_events_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_audit_events" ADD CONSTRAINT "dsv_audit_events_customerId_shopId_fkey" FOREIGN KEY ("customerId", "shopId") REFERENCES "customers"("id", "shopId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_audit_events" ADD CONSTRAINT "dsv_audit_events_destinationId_shopId_fkey" FOREIGN KEY ("destinationId", "shopId") REFERENCES "delivery_customer_profiles"("id", "shopId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_audit_events" ADD CONSTRAINT "dsv_audit_events_commandReceiptId_fkey" FOREIGN KEY ("commandReceiptId") REFERENCES "dsv_command_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_audit_events" ADD CONSTRAINT "dsv_audit_events_importId_fkey" FOREIGN KEY ("importId") REFERENCES "dsv_dispatch_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_audit_events" ADD CONSTRAINT "dsv_audit_events_previousRoutePlanId_fkey" FOREIGN KEY ("previousRoutePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_audit_events" ADD CONSTRAINT "dsv_audit_events_nextRoutePlanId_fkey" FOREIGN KEY ("nextRoutePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_audit_events" ADD CONSTRAINT "dsv_audit_events_previousRouteVersionId_fkey" FOREIGN KEY ("previousRouteVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsv_audit_events" ADD CONSTRAINT "dsv_audit_events_nextRouteVersionId_fkey" FOREIGN KEY ("nextRouteVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_events" ADD CONSTRAINT "driver_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_events" ADD CONSTRAINT "driver_events_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_events" ADD CONSTRAINT "driver_events_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_events" ADD CONSTRAINT "driver_events_deliveryStopId_fkey" FOREIGN KEY ("deliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
