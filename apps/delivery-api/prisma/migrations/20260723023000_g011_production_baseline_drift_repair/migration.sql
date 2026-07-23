-- G011 repairs the exact residual drift proven on the restored production
-- baseline clone after G002 repair through G010. Fail closed before replacing
-- tenant-composite relations; no rows, tables, or indexes are removed.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "orders" child
      LEFT JOIN "customers" parent
        ON parent."id" = child."customerId"
     WHERE child."customerId" IS NOT NULL
       AND (parent."id" IS NULL OR parent."shopId" <> child."shopId")
     LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot repair orders_customerId_shopId_fkey: missing or cross-shop customer references exist';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "orders" child
      LEFT JOIN "delivery_customer_profiles" parent
        ON parent."id" = child."destinationId"
     WHERE child."destinationId" IS NOT NULL
       AND (parent."id" IS NULL OR parent."shopId" <> child."shopId")
     LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot repair orders_destinationId_shopId_fkey: missing or cross-shop destination references exist';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "dsv_audit_events" child
      LEFT JOIN "customers" parent
        ON parent."id" = child."customerId"
     WHERE child."customerId" IS NOT NULL
       AND (parent."id" IS NULL OR parent."shopId" <> child."shopId")
     LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot repair dsv_audit_events_customerId_shopId_fkey: missing or cross-shop customer references exist';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "dsv_audit_events" child
      LEFT JOIN "delivery_customer_profiles" parent
        ON parent."id" = child."destinationId"
     WHERE child."destinationId" IS NOT NULL
       AND (parent."id" IS NULL OR parent."shopId" <> child."shopId")
     LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot repair dsv_audit_events_destinationId_shopId_fkey: missing or cross-shop destination references exist';
  END IF;
END $$;

ALTER TABLE "customer_accounts" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "customers" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "dsv_audit_events" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "dsv_command_receipts" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

ALTER TABLE "dsv_audit_events"
  DROP CONSTRAINT IF EXISTS "dsv_audit_events_customerId_shopId_fkey",
  DROP CONSTRAINT IF EXISTS "dsv_audit_events_destinationId_shopId_fkey";

ALTER TABLE "orders"
  DROP CONSTRAINT IF EXISTS "orders_customerId_shopId_fkey",
  DROP CONSTRAINT IF EXISTS "orders_destinationId_shopId_fkey";

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_customerId_shopId_fkey"
    FOREIGN KEY ("customerId", "shopId") REFERENCES "customers"("id", "shopId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "orders_destinationId_shopId_fkey"
    FOREIGN KEY ("destinationId", "shopId") REFERENCES "delivery_customer_profiles"("id", "shopId")
    ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "dsv_audit_events"
  ADD CONSTRAINT "dsv_audit_events_customerId_shopId_fkey"
    FOREIGN KEY ("customerId", "shopId") REFERENCES "customers"("id", "shopId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "dsv_audit_events_destinationId_shopId_fkey"
    FOREIGN KEY ("destinationId", "shopId") REFERENCES "delivery_customer_profiles"("id", "shopId")
    ON DELETE NO ACTION ON UPDATE CASCADE;
