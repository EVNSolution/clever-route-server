DO $$ BEGIN
  CREATE TYPE "CommerceRawOrderIngestStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'SKIPPED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "commerce_raw_order_ingests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "commerceConnectionId" UUID NOT NULL,
  "syncRunId" UUID NOT NULL,
  "platform" "CommerceSourcePlatform" NOT NULL DEFAULT 'WOOCOMMERCE',
  "sourceSiteUrl" TEXT NOT NULL,
  "sourceOrderId" TEXT NOT NULL,
  "sourceOrderNumber" TEXT,
  "sourceUpdatedAt" TIMESTAMPTZ(6),
  "rawPayload" JSONB NOT NULL,
  "rawPayloadSha256" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "chunkId" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "status" "CommerceRawOrderIngestStatus" NOT NULL DEFAULT 'RECEIVED',
  "canonicalOrderId" UUID,
  "processingStartedAt" TIMESTAMPTZ(6),
  "processedAt" TIMESTAMPTZ(6),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT true,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commerce_raw_order_ingests_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "commerce_raw_order_ingests"
    ADD CONSTRAINT "commerce_raw_order_ingests_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "commerce_raw_order_ingests"
    ADD CONSTRAINT "commerce_raw_order_ingests_commerceConnectionId_fkey"
    FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "commerce_raw_order_ingests"
    ADD CONSTRAINT "commerce_raw_order_ingests_syncRunId_fkey"
    FOREIGN KEY ("syncRunId") REFERENCES "commerce_sync_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "commerce_raw_order_ingests_connection_order_hash_key"
  ON "commerce_raw_order_ingests"("commerceConnectionId", "sourceOrderId", "rawPayloadSha256");

CREATE UNIQUE INDEX IF NOT EXISTS "commerce_raw_order_ingests_run_chunk_order_hash_key"
  ON "commerce_raw_order_ingests"("syncRunId", "chunkId", "sourceOrderId", "rawPayloadSha256");

CREATE INDEX IF NOT EXISTS "commerce_raw_order_ingests_syncRunId_status_receivedAt_idx"
  ON "commerce_raw_order_ingests"("syncRunId", "status", "receivedAt");

CREATE INDEX IF NOT EXISTS "commerce_raw_order_ingests_connection_order_receivedAt_idx"
  ON "commerce_raw_order_ingests"("commerceConnectionId", "sourceOrderId", "receivedAt");
