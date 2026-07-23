ALTER TABLE "customer_route_notification_facts"
ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "customer_route_notification_facts_idempotencyKey_key"
ON "customer_route_notification_facts"("idempotencyKey");

CREATE TABLE "admin_route_stop_action_audits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "deliveryStopId" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'ADMIN',
  "action" TEXT NOT NULL,
  "requestedUiStatus" TEXT NOT NULL,
  "deliveryStopStatus" "DeliveryStopStatus" NOT NULL,
  "executionEventType" "DriverEventType",
  "driverEventId" UUID,
  "notificationFactId" UUID,
  "metadata" JSONB,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_route_stop_action_audits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_route_stop_action_audits_idempotencyKey_key"
ON "admin_route_stop_action_audits"("idempotencyKey");

CREATE INDEX "admin_route_stop_action_audits_shopId_routePlanId_deliveryStopId_occurredAt_idx"
ON "admin_route_stop_action_audits"("shopId", "routePlanId", "deliveryStopId", "occurredAt");

ALTER TABLE "admin_route_stop_action_audits"
ADD CONSTRAINT "admin_route_stop_action_audits_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
