-- G003: immutable DSV import staging and explicit apply schema.
-- Deterministic forward migration; preserves staged history and replaces only the
-- old global dispatch-row seller-order uniqueness with import-scoped uniqueness.

ALTER TYPE "DsvDispatchImportStatus" ADD VALUE IF NOT EXISTS 'STAGED';
ALTER TYPE "DsvDispatchImportStatus" ADD VALUE IF NOT EXISTS 'APPLYING';
ALTER TYPE "DsvDispatchImportStatus" ADD VALUE IF NOT EXISTS 'APPLIED';
ALTER TYPE "DsvDispatchImportStatus" ADD VALUE IF NOT EXISTS 'FAILED';

ALTER TYPE "DsvDispatchImportRowStatus" ADD VALUE IF NOT EXISTS 'APPLYING';
ALTER TYPE "DsvDispatchImportRowStatus" ADD VALUE IF NOT EXISTS 'APPLIED';
ALTER TYPE "DsvDispatchImportRowStatus" ADD VALUE IF NOT EXISTS 'BLOCKED';

DO $$
DECLARE
  duplicate_count integer;
BEGIN
  SELECT COUNT(*)::integer
    INTO duplicate_count
  FROM (
    SELECT "importId", "sellerOrderKey"
    FROM "dsv_dispatch_import_rows"
    GROUP BY "importId", "sellerOrderKey"
    HAVING COUNT(*) > 1
  ) duplicate_seller_keys;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'G003 migration aborted: duplicate sellerOrderKey values exist within the same DSV import batch';
  END IF;
END $$;

ALTER TABLE "dsv_dispatch_imports" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'DSV_DISPATCH_IMPORT';
ALTER TABLE "dsv_dispatch_imports" ADD COLUMN "sourceHash" TEXT;
ALTER TABLE "dsv_dispatch_imports" ADD COLUMN "previewHash" TEXT;
ALTER TABLE "dsv_dispatch_imports" ADD COLUMN "appliedAt" TIMESTAMPTZ(6);
ALTER TABLE "dsv_dispatch_imports" ADD COLUMN "appliedBy" TEXT;
ALTER TABLE "dsv_dispatch_imports" ADD COLUMN "applyReceiptId" UUID;
ALTER TABLE "dsv_dispatch_imports" ADD COLUMN "applyResult" JSONB;
ALTER TABLE "dsv_dispatch_imports" ADD COLUMN "failureCode" TEXT;
ALTER TABLE "dsv_dispatch_imports" ADD COLUMN "failureMessage" TEXT;

UPDATE "dsv_dispatch_imports"
SET
  "sourceHash" = 'legacy-g003-source:' || "id"::text,
  "previewHash" = 'legacy-g003-preview:' || "id"::text
WHERE "sourceHash" IS NULL
   OR "previewHash" IS NULL;

ALTER TABLE "dsv_dispatch_imports" ALTER COLUMN "sourceHash" SET NOT NULL;
ALTER TABLE "dsv_dispatch_imports" ALTER COLUMN "previewHash" SET NOT NULL;

ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'DSV_DISPATCH_IMPORT';
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "normalized" JSONB;
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "diffKind" TEXT;
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "sourceHash" TEXT;
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "previewHash" TEXT;
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "customerId" UUID;
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "destinationId" UUID;
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "conditionId" UUID;
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "sellerOrderId" UUID;
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "deliveryStopId" UUID;
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "applyReceiptId" UUID;
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "appliedAt" TIMESTAMPTZ(6);
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "canonicalLink" JSONB;
ALTER TABLE "dsv_dispatch_import_rows" ADD COLUMN "candidateDiff" JSONB;

UPDATE "dsv_dispatch_import_rows" row
SET
  "normalized" = jsonb_build_object(
    'rowNumber', row."rowNumber",
    'driverName', row."driverName",
    'vehiclePlate', row."vehiclePlate",
    'destinationName', row."destinationName",
    'conditionCode', row."conditionCode",
    'shippedBoxes', row."shippedBoxes",
    'address', row."address",
    'customerCode', row."customerCode",
    'sellerOrderKey', row."sellerOrderKey",
    'notes', row."notes",
    'latitude', row."latitude",
    'longitude', row."longitude"
  ),
  "diffKind" = CASE
    WHEN row."status" = 'READY' THEN 'NEW'
    ELSE 'CONFLICT'
  END,
  "sourceHash" = import."sourceHash",
  "previewHash" = import."previewHash"
FROM "dsv_dispatch_imports" import
WHERE row."importId" = import."id"
  AND row."shopId" = import."shopId"
  AND (
    row."normalized" IS NULL
    OR row."diffKind" IS NULL
    OR row."sourceHash" IS NULL
    OR row."previewHash" IS NULL
  );

ALTER TABLE "dsv_dispatch_import_rows" ALTER COLUMN "normalized" SET NOT NULL;
ALTER TABLE "dsv_dispatch_import_rows" ALTER COLUMN "diffKind" SET NOT NULL;
ALTER TABLE "dsv_dispatch_import_rows" ALTER COLUMN "sourceHash" SET NOT NULL;
ALTER TABLE "dsv_dispatch_import_rows" ALTER COLUMN "previewHash" SET NOT NULL;

DROP INDEX "dsv_dispatch_import_rows_shopId_sellerOrderKey_key";

CREATE UNIQUE INDEX "delivery_stops_id_shopId_key" ON "delivery_stops"("id", "shopId");
CREATE UNIQUE INDEX "dsv_transport_conditions_id_shopId_key" ON "dsv_transport_conditions"("id", "shopId");
CREATE UNIQUE INDEX "dsv_dispatch_import_rows_importId_sellerOrderKey_key" ON "dsv_dispatch_import_rows"("importId", "sellerOrderKey");

CREATE INDEX "dsv_dispatch_imports_shopId_sourceHash_idx" ON "dsv_dispatch_imports"("shopId", "sourceHash");
CREATE INDEX "dsv_dispatch_imports_shopId_status_createdAt_idx" ON "dsv_dispatch_imports"("shopId", "status", "createdAt");
CREATE INDEX "dsv_dispatch_imports_shopId_previewHash_idx" ON "dsv_dispatch_imports"("shopId", "previewHash");
CREATE INDEX "dsv_dispatch_import_rows_shopId_sellerOrderKey_createdAt_idx" ON "dsv_dispatch_import_rows"("shopId", "sellerOrderKey", "createdAt");
CREATE INDEX "dsv_dispatch_import_rows_shopId_sellerOrderId_idx" ON "dsv_dispatch_import_rows"("shopId", "sellerOrderId");
CREATE INDEX "dsv_dispatch_import_rows_shopId_deliveryStopId_idx" ON "dsv_dispatch_import_rows"("shopId", "deliveryStopId");
CREATE INDEX "dsv_dispatch_import_rows_importId_diffKind_rowNumber_idx" ON "dsv_dispatch_import_rows"("importId", "diffKind", "rowNumber");

ALTER TABLE "dsv_dispatch_imports"
  ADD CONSTRAINT "dsv_dispatch_imports_applyReceiptId_shopId_fkey"
  FOREIGN KEY ("applyReceiptId", "shopId") REFERENCES "dsv_command_receipts"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_dispatch_import_rows"
  ADD CONSTRAINT "dsv_dispatch_import_rows_customerId_shopId_fkey"
  FOREIGN KEY ("customerId", "shopId") REFERENCES "customers"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_dispatch_import_rows"
  ADD CONSTRAINT "dsv_dispatch_import_rows_destinationId_shopId_fkey"
  FOREIGN KEY ("destinationId", "shopId") REFERENCES "delivery_customer_profiles"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_dispatch_import_rows"
  ADD CONSTRAINT "dsv_dispatch_import_rows_conditionId_shopId_fkey"
  FOREIGN KEY ("conditionId", "shopId") REFERENCES "dsv_transport_conditions"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_dispatch_import_rows"
  ADD CONSTRAINT "dsv_dispatch_import_rows_sellerOrderId_shopId_fkey"
  FOREIGN KEY ("sellerOrderId", "shopId") REFERENCES "orders"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_dispatch_import_rows"
  ADD CONSTRAINT "dsv_dispatch_import_rows_deliveryStopId_shopId_fkey"
  FOREIGN KEY ("deliveryStopId", "shopId") REFERENCES "delivery_stops"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_dispatch_import_rows"
  ADD CONSTRAINT "dsv_dispatch_import_rows_applyReceiptId_shopId_fkey"
  FOREIGN KEY ("applyReceiptId", "shopId") REFERENCES "dsv_command_receipts"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;
