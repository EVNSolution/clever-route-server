CREATE TABLE IF NOT EXISTS "commerce_raw_order_ingest_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "commerceConnectionId" UUID,
  "syncRunId" UUID,
  "rawOrderIngestId" UUID,
  "sourceLine" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "sourceOrderId" TEXT,
  "sourceOrderNumber" TEXT,
  "rawPayloadSha256" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commerce_raw_order_ingest_events_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "commerce_raw_order_ingest_events"
    ADD CONSTRAINT "commerce_raw_order_ingest_events_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "commerce_raw_order_ingest_events"
    ADD CONSTRAINT "commerce_raw_order_ingest_events_commerceConnectionId_fkey"
    FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "commerce_raw_order_ingest_events"
    ADD CONSTRAINT "commerce_raw_order_ingest_events_syncRunId_fkey"
    FOREIGN KEY ("syncRunId") REFERENCES "commerce_sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "commerce_raw_order_ingest_events"
    ADD CONSTRAINT "commerce_raw_order_ingest_events_rawOrderIngestId_fkey"
    FOREIGN KEY ("rawOrderIngestId") REFERENCES "commerce_raw_order_ingests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "raw_ingest_events_shop_order_number_createdAt_idx"
  ON "commerce_raw_order_ingest_events"("shopId", "sourceOrderNumber", "createdAt");

CREATE INDEX IF NOT EXISTS "raw_ingest_events_shop_order_id_createdAt_idx"
  ON "commerce_raw_order_ingest_events"("shopId", "sourceOrderId", "createdAt");

CREATE INDEX IF NOT EXISTS "raw_ingest_events_raw_ingest_createdAt_idx"
  ON "commerce_raw_order_ingest_events"("rawOrderIngestId", "createdAt");

CREATE INDEX IF NOT EXISTS "raw_ingest_events_sync_run_createdAt_idx"
  ON "commerce_raw_order_ingest_events"("syncRunId", "createdAt");

CREATE INDEX IF NOT EXISTS "raw_ingest_events_shop_code_createdAt_idx"
  ON "commerce_raw_order_ingest_events"("shopId", "code", "createdAt");
