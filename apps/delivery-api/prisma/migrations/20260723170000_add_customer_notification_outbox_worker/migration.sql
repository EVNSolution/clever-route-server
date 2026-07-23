ALTER TYPE "CustomerRouteNotificationStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "CustomerRouteNotificationStatus" ADD VALUE 'DEAD';

ALTER TABLE "customer_route_notification_facts"
  ADD COLUMN "routePlanId" UUID,
  ADD COLUMN "deliveryStopId" UUID,
  ADD COLUMN "recipientEmailSnapshot" TEXT,
  ADD COLUMN "requestedUiStatus" TEXT,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "processingStartedAt" TIMESTAMPTZ(6),
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(6),
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "providerMessageId" TEXT,
  ADD COLUMN "errorCode" TEXT,
  ADD COLUMN "errorMessage" TEXT,
  ADD COLUMN "sentAt" TIMESTAMPTZ(6),
  ADD COLUMN "deadAt" TIMESTAMPTZ(6),
  ADD COLUMN "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "customer_route_notification_facts" AS fact
SET
  "routePlanId" = audit."routePlanId",
  "deliveryStopId" = audit."deliveryStopId",
  "recipientEmailSnapshot" = CASE
    WHEN fact."status" = 'QUEUED' THEN canonical_order."email"
    ELSE NULL
  END,
  "requestedUiStatus" = audit."requestedUiStatus"
FROM "admin_route_stop_action_audits" AS audit, "orders" AS canonical_order
WHERE
  audit."notificationFactId" = fact."id"
  AND canonical_order."id" = fact."orderId";

UPDATE "customer_route_notification_facts" AS fact
SET
  "routePlanId" = CASE
    WHEN fact."metadata"->>'routePlanId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (fact."metadata"->>'routePlanId')::UUID
    ELSE fact."routePlanId"
  END,
  "deliveryStopId" = CASE
    WHEN fact."metadata"->>'deliveryStopId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (fact."metadata"->>'deliveryStopId')::UUID
    ELSE fact."deliveryStopId"
  END,
  "recipientEmailSnapshot" = CASE
    WHEN fact."status" = 'QUEUED'
      THEN COALESCE(fact."recipientEmailSnapshot", canonical_order."email")
    ELSE NULL
  END,
  "requestedUiStatus" = COALESCE(fact."requestedUiStatus", fact."metadata"->>'uiStatus')
FROM "orders" AS canonical_order
WHERE canonical_order."id" = fact."orderId";

UPDATE "customer_route_notification_facts"
SET "recipientEmailSnapshot" = NULL
WHERE "status" IN ('SENT', 'DEAD');

CREATE INDEX "customer_route_notification_facts_status_nextAttemptAt_idx"
  ON "customer_route_notification_facts"("status", "nextAttemptAt");

CREATE INDEX "customer_route_notification_facts_status_leaseExpiresAt_idx"
  ON "customer_route_notification_facts"("status", "leaseExpiresAt");

CREATE INDEX "customer_route_notification_facts_deliveryStopId_occurredAt_idx"
  ON "customer_route_notification_facts"("deliveryStopId", "occurredAt");
