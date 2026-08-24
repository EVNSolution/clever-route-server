CREATE TABLE "shopify_shop_redaction_tombstones" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "appId" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "complianceWebhookId" TEXT NOT NULL,
  "redactedAt" TIMESTAMPTZ(6) NOT NULL,
  "reinstalledAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "shopify_shop_redaction_tombstones_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shopify_shop_redaction_identity_key"
  ON "shopify_shop_redaction_tombstones"("appId", "shopDomain");
CREATE INDEX "shopify_shop_redaction_tombstones_redactedAt_idx"
  ON "shopify_shop_redaction_tombstones"("redactedAt");
