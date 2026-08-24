CREATE TABLE "shopify_redacted_webhook_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "appId" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "redactedAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shopify_redacted_webhook_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shopify_redacted_webhook_receipt_key"
  ON "shopify_redacted_webhook_receipts"("appId", "shopDomain", "webhookId");
CREATE INDEX "shopify_redacted_webhook_receipts_appId_shopDomain_redactedAt_idx"
  ON "shopify_redacted_webhook_receipts"("appId", "shopDomain", "redactedAt");
