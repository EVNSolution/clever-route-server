-- Route grouping parent workbench + child driver route projection support.
CREATE TYPE "RouteGroupingStatus" AS ENUM ('DRAFT', 'READY', 'PUBLISHED', 'CHANGED', 'CANCELLED');
CREATE TYPE "RouteGroupingAssignmentStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'OVERLAP', 'EXCLUDED');
CREATE TYPE "RouteGroupingVersionStatus" AS ENUM ('DRAFT', 'CURRENT', 'ARCHIVED', 'ROLLED_BACK');
CREATE TYPE "RouteGroupingChildVersionStatus" AS ENUM ('CURRENT', 'ARCHIVED', 'ROLLED_BACK');
CREATE TYPE "DriverPushTokenStatus" AS ENUM ('ACTIVE', 'REVOKED', 'INVALID');
CREATE TYPE "DriverRouteNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');
CREATE TYPE "DriverRouteNotificationAction" AS ENUM ('ASSIGNED', 'CHANGED');
CREATE TYPE "CustomerRouteNotificationStatus" AS ENUM ('QUEUED', 'SENT');

CREATE TABLE "route_groupings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "planDate" DATE NOT NULL,
  "routeScopeKey" TEXT,
  "serviceType" TEXT,
  "deliverySession" TEXT,
  "status" "RouteGroupingStatus" NOT NULL DEFAULT 'DRAFT',
  "currentVersion" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "route_groupings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "route_grouping_polygons" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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

CREATE TABLE "route_grouping_orders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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

CREATE TABLE "route_grouping_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "groupingId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "RouteGroupingVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "changeReason" TEXT,
  "actor" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "route_grouping_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "route_grouping_child_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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

CREATE TABLE "driver_push_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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

CREATE TABLE "driver_route_notification_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "groupingId" UUID NOT NULL,
  "groupingVersion" INTEGER NOT NULL,
  "childVersionId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "driverId" UUID NOT NULL,
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

CREATE TABLE "customer_route_notification_facts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "status" "CustomerRouteNotificationStatus" NOT NULL,
  "metadata" JSONB,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_route_notification_facts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "route_groupings_shopId_planDate_status_idx" ON "route_groupings"("shopId", "planDate", "status");
CREATE INDEX "route_grouping_polygons_groupingId_drawOrder_idx" ON "route_grouping_polygons"("groupingId", "drawOrder");
CREATE INDEX "route_grouping_polygons_shopId_driverId_idx" ON "route_grouping_polygons"("shopId", "driverId");
CREATE UNIQUE INDEX "route_grouping_orders_groupingId_orderId_key" ON "route_grouping_orders"("groupingId", "orderId");
CREATE UNIQUE INDEX "route_grouping_orders_groupingId_deliveryStopId_key" ON "route_grouping_orders"("groupingId", "deliveryStopId");
CREATE INDEX "route_grouping_orders_shopId_assignedDriverId_idx" ON "route_grouping_orders"("shopId", "assignedDriverId");
CREATE INDEX "route_grouping_orders_groupingId_assignmentStatus_idx" ON "route_grouping_orders"("groupingId", "assignmentStatus");
CREATE UNIQUE INDEX "route_grouping_versions_groupingId_version_key" ON "route_grouping_versions"("groupingId", "version");
CREATE INDEX "route_grouping_versions_shopId_status_createdAt_idx" ON "route_grouping_versions"("shopId", "status", "createdAt");
CREATE INDEX "route_grouping_child_versions_groupingId_version_status_idx" ON "route_grouping_child_versions"("groupingId", "version", "status");
CREATE INDEX "route_grouping_child_versions_shopId_routePlanId_idx" ON "route_grouping_child_versions"("shopId", "routePlanId");
CREATE UNIQUE INDEX "driver_push_tokens_driverId_tokenHash_key" ON "driver_push_tokens"("driverId", "tokenHash");
CREATE INDEX "driver_push_tokens_shopId_driverId_status_idx" ON "driver_push_tokens"("shopId", "driverId", "status");
CREATE UNIQUE INDEX "driver_route_notification_attempts_idempotencyKey_key" ON "driver_route_notification_attempts"("idempotencyKey");
CREATE INDEX "driver_route_notification_attempts_groupingId_groupingVersion_idx" ON "driver_route_notification_attempts"("groupingId", "groupingVersion");
CREATE INDEX "driver_route_notification_attempts_routePlanId_driverId_idx" ON "driver_route_notification_attempts"("routePlanId", "driverId");
CREATE INDEX "customer_route_notification_facts_shopId_orderId_status_idx" ON "customer_route_notification_facts"("shopId", "orderId", "status");

ALTER TABLE "route_groupings" ADD CONSTRAINT "route_groupings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_polygons" ADD CONSTRAINT "route_grouping_polygons_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_polygons" ADD CONSTRAINT "route_grouping_polygons_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_polygons" ADD CONSTRAINT "route_grouping_polygons_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_deliveryStopId_fkey" FOREIGN KEY ("deliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_assignedDriverId_fkey" FOREIGN KEY ("assignedDriverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "route_grouping_orders" ADD CONSTRAINT "route_grouping_orders_assignedPolygonId_fkey" FOREIGN KEY ("assignedPolygonId") REFERENCES "route_grouping_polygons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "route_grouping_versions" ADD CONSTRAINT "route_grouping_versions_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_versions" ADD CONSTRAINT "route_grouping_versions_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_child_versions" ADD CONSTRAINT "route_grouping_child_versions_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_child_versions" ADD CONSTRAINT "route_grouping_child_versions_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_child_versions" ADD CONSTRAINT "route_grouping_child_versions_groupingVersionId_fkey" FOREIGN KEY ("groupingVersionId") REFERENCES "route_grouping_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "route_grouping_child_versions" ADD CONSTRAINT "route_grouping_child_versions_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "route_grouping_child_versions" ADD CONSTRAINT "route_grouping_child_versions_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "driver_push_tokens" ADD CONSTRAINT "driver_push_tokens_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_push_tokens" ADD CONSTRAINT "driver_push_tokens_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_route_notification_attempts" ADD CONSTRAINT "driver_route_notification_attempts_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_route_notification_attempts" ADD CONSTRAINT "driver_route_notification_attempts_groupingId_fkey" FOREIGN KEY ("groupingId") REFERENCES "route_groupings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_route_notification_attempts" ADD CONSTRAINT "driver_route_notification_attempts_childVersionId_fkey" FOREIGN KEY ("childVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_route_notification_attempts" ADD CONSTRAINT "driver_route_notification_attempts_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_route_notification_attempts" ADD CONSTRAINT "driver_route_notification_attempts_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_route_notification_facts" ADD CONSTRAINT "customer_route_notification_facts_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_route_notification_facts" ADD CONSTRAINT "customer_route_notification_facts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
