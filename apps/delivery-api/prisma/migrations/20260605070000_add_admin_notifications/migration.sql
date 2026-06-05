-- Persist tenant-scoped admin notifications for Route Ops alerts.

CREATE TABLE IF NOT EXISTS "admin_notifications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "href" TEXT,
  "orderId" UUID,
  "routePlanId" UUID,
  "payload" JSONB,
  "readAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "admin_notifications_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "admin_notifications"
    ADD CONSTRAINT "admin_notifications_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "admin_notifications_shopId_dedupeKey_key"
  ON "admin_notifications"("shopId", "dedupeKey");

CREATE INDEX IF NOT EXISTS "admin_notifications_shopId_readAt_createdAt_idx"
  ON "admin_notifications"("shopId", "readAt", "createdAt");

CREATE INDEX IF NOT EXISTS "admin_notifications_shopId_type_createdAt_idx"
  ON "admin_notifications"("shopId", "type", "createdAt");
