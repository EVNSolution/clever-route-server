ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "serviceDate" DATE;

UPDATE "orders" AS order_row
SET "serviceDate" = (
  SELECT stop."deliveryDate"
  FROM "delivery_stops" AS stop
  WHERE stop."shopId" = order_row."shopId"
    AND stop."orderId" = order_row."id"
  ORDER BY stop."createdAt" ASC
  LIMIT 1
)
WHERE order_row."sellerOrderSourceKind" = 'DSV_DISPATCH_IMPORT'
  AND order_row."serviceDate" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "orders"
    WHERE "sellerOrderSourceKind" = 'DSV_DISPATCH_IMPORT'
      AND "serviceDate" IS NULL
  ) THEN
    RAISE EXCEPTION 'DSV order serviceDate backfill failed: serviceDate is still null';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_dsv_serviceDate_not_null_chk'
      AND conrelid = '"orders"'::regclass
  ) THEN
    ALTER TABLE "orders"
      ADD CONSTRAINT "orders_dsv_serviceDate_not_null_chk"
      CHECK ("sellerOrderSourceKind" <> 'DSV_DISPATCH_IMPORT' OR "serviceDate" IS NOT NULL)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_dsv_serviceDate_not_null_chk";

DROP INDEX IF EXISTS "orders_shopId_sellerOrderSourceKind_sellerOrderKey_key";

CREATE UNIQUE INDEX "orders_shopId_sellerOrderSourceKind_sellerOrderKey_serviceDate_key"
  ON "orders"("shopId", "sellerOrderSourceKind", "sellerOrderKey", "serviceDate");
