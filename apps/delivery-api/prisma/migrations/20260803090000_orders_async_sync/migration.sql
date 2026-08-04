-- Add durable Shopify webhook queue lifecycle and background order reconciliation jobs.

ALTER TYPE "ShopifyWebhookEventStatus" ADD VALUE IF NOT EXISTS 'QUEUED';
ALTER TYPE "ShopifyWebhookEventStatus" ADD VALUE IF NOT EXISTS 'RETRY_WAIT';
ALTER TYPE "ShopifyWebhookEventStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTER';

CREATE TYPE "ShopifyOrderReconciliationJobStatus" AS ENUM (
  'QUEUED',
  'RUNNING',
  'RETRY_WAIT',
  'SUCCEEDED',
  'FAILED',
  'DEAD_LETTER',
  'CANCELLED'
);

CREATE TYPE "ShopifyOrderReconciliationJobMode" AS ENUM (
  'INCREMENTAL',
  'FULL'
);

ALTER TABLE "shopify_webhook_events"
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN "nextRunAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(6),
  ADD COLUMN "workerId" TEXT,
  ADD COLUMN "deadLetteredAt" TIMESTAMPTZ(6),
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "lastErrorMessageRedacted" TEXT;

UPDATE "shopify_webhook_events"
SET "nextRunAt" = COALESCE("receivedAt", "createdAt", CURRENT_TIMESTAMP)
WHERE "nextRunAt" IS NULL;

CREATE INDEX "shopify_webhook_events_status_nextRunAt_idx"
  ON "shopify_webhook_events"("status", "nextRunAt");

CREATE INDEX "shopify_webhook_events_leaseExpiresAt_idx"
  ON "shopify_webhook_events"("leaseExpiresAt");

CREATE TABLE "shopify_order_reconciliation_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "appId" TEXT NOT NULL DEFAULT 'clever',
  "shopDomain" TEXT NOT NULL,
  "mode" "ShopifyOrderReconciliationJobMode" NOT NULL DEFAULT 'INCREMENTAL',
  "status" "ShopifyOrderReconciliationJobStatus" NOT NULL DEFAULT 'QUEUED',
  "pageCursor" TEXT,
  "highWatermark" TIMESTAMPTZ(6),
  "startedFrom" TIMESTAMPTZ(6),
  "overlapWindowSeconds" INTEGER NOT NULL DEFAULT 600,
  "pageSize" INTEGER NOT NULL DEFAULT 50,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "nextRunAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ(6),
  "workerId" TEXT,
  "scannedCount" INTEGER NOT NULL DEFAULT 0,
  "createdCount" INTEGER NOT NULL DEFAULT 0,
  "updatedCount" INTEGER NOT NULL DEFAULT 0,
  "unchangedCount" INTEGER NOT NULL DEFAULT 0,
  "staleSkippedCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "warningCount" INTEGER NOT NULL DEFAULT 0,
  "finalCanonicalCount" INTEGER,
  "lastErrorCode" TEXT,
  "lastErrorMessageRedacted" TEXT,
  "warnings" JSONB,
  "requestedBy" TEXT,
  "correlationId" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ(6),
  "finishedAt" TIMESTAMPTZ(6),
  "deadLetteredAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shopify_order_reconciliation_jobs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "shopify_order_reconciliation_jobs"
  ADD CONSTRAINT "shopify_order_reconciliation_jobs_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "shopify_order_reconciliation_jobs_shopId_status_createdAt_idx"
  ON "shopify_order_reconciliation_jobs"("shopId", "status", "createdAt");

CREATE INDEX "shopify_order_reconciliation_jobs_status_nextRunAt_idx"
  ON "shopify_order_reconciliation_jobs"("status", "nextRunAt");

CREATE INDEX "shopify_order_reconciliation_jobs_leaseExpiresAt_idx"
  ON "shopify_order_reconciliation_jobs"("leaseExpiresAt");

CREATE INDEX "shopify_order_reconciliation_jobs_correlationId_idx"
  ON "shopify_order_reconciliation_jobs"("correlationId");
