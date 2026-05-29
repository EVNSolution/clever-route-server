-- Persist WordPress-triggered Woo REST/geocoding sync runs for async status reporting.

DO $$
BEGIN
  CREATE TYPE "CommerceSyncRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "commerce_sync_runs" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "commerceConnectionId" UUID NOT NULL,
  "platform" "CommerceSourcePlatform" NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'wordpress_plugin',
  "trigger" TEXT NOT NULL,
  "status" "CommerceSyncRunStatus" NOT NULL DEFAULT 'QUEUED',
  "requestPayload" JSONB NOT NULL,
  "pagesRead" INTEGER,
  "received" INTEGER,
  "created" INTEGER,
  "updated" INTEGER,
  "unchanged" INTEGER,
  "skipped" INTEGER,
  "readyToPlan" INTEGER,
  "needsReview" INTEGER,
  "geocodeResolved" INTEGER,
  "geocodeFailed" INTEGER,
  "geocodePending" INTEGER,
  "geocodeNotRequired" INTEGER,
  "warnings" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "errorMessage" TEXT,
  "acceptedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "commerce_sync_runs_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "commerce_sync_runs"
    ADD CONSTRAINT "commerce_sync_runs_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "commerce_sync_runs"
    ADD CONSTRAINT "commerce_sync_runs_commerceConnectionId_fkey"
    FOREIGN KEY ("commerceConnectionId") REFERENCES "commerce_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "commerce_sync_runs_commerceConnectionId_status_createdAt_idx"
  ON "commerce_sync_runs"("commerceConnectionId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "commerce_sync_runs_commerceConnectionId_createdAt_idx"
  ON "commerce_sync_runs"("commerceConnectionId", "createdAt");

CREATE INDEX IF NOT EXISTS "commerce_sync_runs_shopId_platform_createdAt_idx"
  ON "commerce_sync_runs"("shopId", "platform", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "commerce_sync_runs_one_active_per_connection_idx"
  ON "commerce_sync_runs"("commerceConnectionId")
  WHERE "status" IN ('QUEUED', 'RUNNING');
