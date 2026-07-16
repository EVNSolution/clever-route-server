CREATE TABLE "destination_tips" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "destinationId" UUID NOT NULL,
  "sourceDeliveryStopId" UUID,
  "category" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "archivedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "destination_tips_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "destination_tip_audits" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "tipId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "actor" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "destination_tip_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "destination_tips_shopId_destinationId_status_updatedAt_idx"
  ON "destination_tips"("shopId", "destinationId", "status", "updatedAt");
CREATE INDEX "destination_tips_shopId_sourceDeliveryStopId_idx"
  ON "destination_tips"("shopId", "sourceDeliveryStopId");
CREATE UNIQUE INDEX "destination_tip_audits_tipId_revision_key"
  ON "destination_tip_audits"("tipId", "revision");
CREATE INDEX "destination_tip_audits_shopId_createdAt_idx"
  ON "destination_tip_audits"("shopId", "createdAt");

ALTER TABLE "destination_tips"
  ADD CONSTRAINT "destination_tips_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "destination_tips"
  ADD CONSTRAINT "destination_tips_destinationId_fkey"
  FOREIGN KEY ("destinationId") REFERENCES "delivery_customer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "destination_tips"
  ADD CONSTRAINT "destination_tips_sourceDeliveryStopId_fkey"
  FOREIGN KEY ("sourceDeliveryStopId") REFERENCES "delivery_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "destination_tip_audits"
  ADD CONSTRAINT "destination_tip_audits_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "destination_tip_audits"
  ADD CONSTRAINT "destination_tip_audits_tipId_fkey"
  FOREIGN KEY ("tipId") REFERENCES "destination_tips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
