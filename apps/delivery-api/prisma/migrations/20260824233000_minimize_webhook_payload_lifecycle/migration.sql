ALTER TABLE "shopify_webhook_events"
  ADD COLUMN "payloadRedactedAt" TIMESTAMPTZ(6);

UPDATE "shopify_webhook_events"
SET
  "payload" = jsonb_build_object(
    'redacted', true,
    'schema', 'shopify_webhook_tombstone_v1',
    'terminalStatus', "status"::text
  ),
  "payloadRedactedAt" = COALESCE("processedAt", "updatedAt", CURRENT_TIMESTAMP)
WHERE "status" IN ('PROCESSED', 'IGNORED');

CREATE INDEX "shopify_webhook_events_status_processedAt_idx"
  ON "shopify_webhook_events"("status", "processedAt");
