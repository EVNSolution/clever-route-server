ALTER TYPE "CustomerRouteNotificationStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

ALTER TABLE "customer_route_notification_facts"
  ADD COLUMN "providerStatus" TEXT,
  ADD COLUMN "providerEventAt" TIMESTAMPTZ(6);

ALTER TABLE "customer_email_manual_dispatch_recipients"
  ADD COLUMN "providerStatus" TEXT,
  ADD COLUMN "providerEventAt" TIMESTAMPTZ(6);

CREATE INDEX "customer_route_notification_facts_providerMessageId_idx"
  ON "customer_route_notification_facts"("providerMessageId");

CREATE INDEX "customer_email_manual_dispatch_recipients_providerMessageId_idx"
  ON "customer_email_manual_dispatch_recipients"("providerMessageId");
