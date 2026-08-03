ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "customerEmailSettings" JSONB;

CREATE TABLE IF NOT EXISTS "customer_email_manual_dispatches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "commandId" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "signal" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'ADMIN_MANUAL_CUSTOMER_EMAIL',
  "request" JSONB NOT NULL,
  "template" JSONB NOT NULL,
  "counts" JSONB NOT NULL,
  "duplicate" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "customer_email_manual_dispatches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_email_manual_dispatches_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "customer_email_manual_dispatch_recipients" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "dispatchId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "deliveryStopId" UUID,
  "orderId" UUID,
  "recipientEmail" TEXT,
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "provider" TEXT,
  "providerMessageId" TEXT,
  "renderedSubject" TEXT,
  "renderedBody" TEXT,
  "sentAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "customer_email_manual_dispatch_recipients_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_email_manual_dispatch_recipients_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "customer_email_manual_dispatch_recipients_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "customer_email_manual_dispatches"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "customer_email_manual_dispatches_shopId_commandId_key"
  ON "customer_email_manual_dispatches"("shopId", "commandId");

CREATE INDEX IF NOT EXISTS "customer_email_manual_dispatches_shopId_routePlanId_createdAt_idx"
  ON "customer_email_manual_dispatches"("shopId", "routePlanId", "createdAt");

CREATE INDEX IF NOT EXISTS "customer_email_manual_dispatches_shopId_signal_createdAt_idx"
  ON "customer_email_manual_dispatches"("shopId", "signal", "createdAt");

CREATE INDEX IF NOT EXISTS "customer_email_manual_dispatch_recipients_shopId_routePlanId_deliveryStopId_idx"
  ON "customer_email_manual_dispatch_recipients"("shopId", "routePlanId", "deliveryStopId");

CREATE INDEX IF NOT EXISTS "customer_email_manual_dispatch_recipients_dispatchId_status_idx"
  ON "customer_email_manual_dispatch_recipients"("dispatchId", "status");
