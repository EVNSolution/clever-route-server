CREATE TABLE "shopify_order_redaction_tombstones" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "appId" TEXT NOT NULL,
  "shopId" UUID NOT NULL,
  "shopifyOrderLegacyId" BIGINT NOT NULL,
  "complianceWebhookId" TEXT NOT NULL,
  "redactedAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "shopify_order_redaction_tombstones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "shopify_order_redaction_tombstones_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "shopify_order_redaction_identity_key"
  ON "shopify_order_redaction_tombstones"("appId", "shopId", "shopifyOrderLegacyId");
CREATE INDEX "shopify_order_redaction_tombstones_shopId_redactedAt_idx"
  ON "shopify_order_redaction_tombstones"("shopId", "redactedAt");

INSERT INTO "shopify_order_redaction_tombstones" (
  "appId",
  "shopId",
  "shopifyOrderLegacyId",
  "complianceWebhookId",
  "redactedAt",
  "updatedAt"
)
SELECT
  shop."appId",
  event."shopId",
  substring(event."payload"->>'orderId' FROM '([0-9]+)$')::BIGINT,
  'migration:' || event."webhookId",
  COALESCE(event."payloadRedactedAt", event."updatedAt"),
  CURRENT_TIMESTAMP
FROM "shopify_webhook_events" event
JOIN "shops" shop ON shop."id" = event."shopId"
WHERE event."payload"->>'schema' = 'shopify_order_reference_v1'
  AND event."payload"->>'orderId' ~ '^gid://shopify/Order/[0-9]+$'
  AND event."payloadRedactedAt" IS NOT NULL
ON CONFLICT ("appId", "shopId", "shopifyOrderLegacyId") DO NOTHING;

UPDATE "shopify_webhook_events"
SET
  "payload" = CASE
    WHEN "status" IN ('PROCESSED', 'IGNORED') THEN jsonb_build_object(
      'redacted', true,
      'schema', 'shopify_webhook_tombstone_v1',
      'terminalStatus', "status"::text
    )
    ELSE jsonb_strip_nulls(jsonb_build_object(
      'admin_graphql_api_id', COALESCE(
        "payload"->>'admin_graphql_api_id',
        "payload"->>'orderId',
        CASE
          WHEN COALESCE("payload"->>'id', '') ~ '^[0-9]+$'
            THEN 'gid://shopify/Order/' || ("payload"->>'id')
          ELSE NULL
        END
      ),
      'orderId', COALESCE(
        "payload"->>'admin_graphql_api_id',
        "payload"->>'orderId',
        CASE
          WHEN COALESCE("payload"->>'id', '') ~ '^[0-9]+$'
            THEN 'gid://shopify/Order/' || ("payload"->>'id')
          ELSE NULL
        END
      ),
      'redacted', true,
      'schema', 'shopify_order_reference_v1'
    ))
  END,
  "payloadRedactedAt" = COALESCE("payloadRedactedAt", CURRENT_TIMESTAMP)
WHERE "topic" IN (
  'orders/create',
  'orders/updated',
  'orders/edited',
  'orders/cancelled',
  'orders/fulfilled',
  'orders/partially_fulfilled',
  'orders/delete'
);
