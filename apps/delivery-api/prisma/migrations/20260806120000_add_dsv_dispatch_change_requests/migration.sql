CREATE TYPE "DsvDispatchChangeRequestType" AS ENUM (
  'TIME_CONSTRAINT_CHANGE',
  'ACTIVE_ROUTE_ORDER_REMOVAL'
);

CREATE TYPE "DsvDispatchChangeRequestStatus" AS ENUM (
  'PENDING_ACK',
  'APPLIED',
  'CANCELLED'
);

ALTER TYPE "DriverEventType" ADD VALUE IF NOT EXISTS 'DISPATCH_CHANGE_ACKNOWLEDGED';

CREATE TYPE "OrderMessageAudience" AS ENUM (
  'DRIVER',
  'CUSTOMER'
);

ALTER TABLE "customers"
ADD COLUMN "notificationEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "notificationEmailRecipient" TEXT;

ALTER TABLE "driver_route_notification_attempts"
ADD COLUMN "metadata" JSONB;

CREATE TABLE "order_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "audience" "OrderMessageAudience" NOT NULL,
  "commandId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "authorType" TEXT NOT NULL,
  "authorId" TEXT,
  "readByDriverAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "order_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_messages_shop_order_audience_createdAt_idx"
ON "order_messages"("shopId", "orderId", "audience", "createdAt");

CREATE UNIQUE INDEX "order_messages_shopId_commandId_key"
ON "order_messages"("shopId", "commandId");

ALTER TABLE "order_messages"
ADD CONSTRAINT "order_messages_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_messages"
ADD CONSTRAINT "order_messages_orderId_shopId_fkey"
FOREIGN KEY ("orderId", "shopId") REFERENCES "orders"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "dsv_dispatch_change_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "commandReceiptId" UUID NOT NULL,
  "sellerOrderId" UUID NOT NULL,
  "deliveryStopId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "routeVersionId" UUID NOT NULL,
  "driverId" UUID,
  "type" "DsvDispatchChangeRequestType" NOT NULL,
  "status" "DsvDispatchChangeRequestStatus" NOT NULL DEFAULT 'PENDING_ACK',
  "timeWindowStart" TIMESTAMPTZ(6),
  "timeWindowEnd" TIMESTAMPTZ(6),
  "removalReason" TEXT,
  "priorSnapshot" JSONB NOT NULL,
  "requestedByActorType" TEXT NOT NULL,
  "requestedByActorId" TEXT,
  "requestId" TEXT NOT NULL,
  "appliedDriverEventId" UUID,
  "appliedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dsv_dispatch_change_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dsv_dispatch_change_requests_shape_check" CHECK (
    (
      "type" = 'TIME_CONSTRAINT_CHANGE'
      AND "removalReason" IS NULL
    )
    OR (
      "type" = 'ACTIVE_ROUTE_ORDER_REMOVAL'
      AND "timeWindowStart" IS NULL
      AND "timeWindowEnd" IS NULL
    )
  ),
  CONSTRAINT "dsv_dispatch_change_requests_applied_check" CHECK (
    ("status" = 'APPLIED' AND "appliedAt" IS NOT NULL AND "appliedDriverEventId" IS NOT NULL)
    OR ("status" <> 'APPLIED' AND "appliedAt" IS NULL AND "appliedDriverEventId" IS NULL)
  )
);

CREATE UNIQUE INDEX "dsv_dispatch_change_requests_shopId_commandReceiptId_key"
ON "dsv_dispatch_change_requests"("shopId", "commandReceiptId");

CREATE UNIQUE INDEX "dsv_dispatch_change_requests_shopId_appliedDriverEventId_key"
ON "dsv_dispatch_change_requests"("shopId", "appliedDriverEventId");

CREATE INDEX "dsv_change_requests_shop_status_route_stop_createdAt_idx"
ON "dsv_dispatch_change_requests"("shopId", "status", "routePlanId", "deliveryStopId", "createdAt");

CREATE INDEX "dsv_change_requests_shop_order_status_idx"
ON "dsv_dispatch_change_requests"("shopId", "sellerOrderId", "status");

ALTER TABLE "dsv_dispatch_change_requests"
ADD CONSTRAINT "dsv_dispatch_change_requests_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dsv_dispatch_change_requests"
ADD CONSTRAINT "dsv_dispatch_change_requests_commandReceiptId_shopId_fkey"
FOREIGN KEY ("commandReceiptId", "shopId") REFERENCES "dsv_command_receipts"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_dispatch_change_requests"
ADD CONSTRAINT "dsv_dispatch_change_requests_sellerOrderId_shopId_fkey"
FOREIGN KEY ("sellerOrderId", "shopId") REFERENCES "orders"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_dispatch_change_requests"
ADD CONSTRAINT "dsv_dispatch_change_requests_deliveryStopId_shopId_fkey"
FOREIGN KEY ("deliveryStopId", "shopId") REFERENCES "delivery_stops"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_dispatch_change_requests"
ADD CONSTRAINT "dsv_dispatch_change_requests_appliedDriverEventId_fkey"
FOREIGN KEY ("appliedDriverEventId") REFERENCES "driver_events"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
