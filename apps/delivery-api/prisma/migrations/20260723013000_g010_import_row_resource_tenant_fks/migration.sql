-- G010 tenant-composite FK repair for DSV dispatch import-row resource links.
-- Fail closed on parent deletes because shopId is non-null and composite SET NULL
-- is unsafe for nullable resource IDs tied to a required tenant key.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "dsv_dispatch_import_rows" child
    LEFT JOIN "drivers" parent
      ON parent."id" = child."driverId"
    WHERE child."driverId" IS NOT NULL
      AND (
        parent."id" IS NULL
        OR parent."shopId" <> child."shopId"
      )
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace dsv_dispatch_import_rows_driverId_fkey: import rows reference missing or cross-shop drivers';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "dsv_dispatch_import_rows" child
    LEFT JOIN "vehicles" parent
      ON parent."id" = child."vehicleId"
    WHERE child."vehicleId" IS NOT NULL
      AND (
        parent."id" IS NULL
        OR parent."shopId" <> child."shopId"
      )
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace dsv_dispatch_import_rows_vehicleId_fkey: import rows reference missing or cross-shop vehicles';
  END IF;
END $$;

ALTER TABLE "dsv_dispatch_import_rows"
  DROP CONSTRAINT IF EXISTS "dsv_dispatch_import_rows_driverId_fkey",
  DROP CONSTRAINT IF EXISTS "dsv_dispatch_import_rows_vehicleId_fkey";

DO $$
BEGIN
  ALTER TABLE "dsv_dispatch_import_rows"
    ADD CONSTRAINT "dsv_dispatch_import_rows_driverId_shopId_fkey"
    FOREIGN KEY ("driverId", "shopId") REFERENCES "drivers"("id", "shopId")
    ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_dispatch_import_rows"
    ADD CONSTRAINT "dsv_dispatch_import_rows_vehicleId_shopId_fkey"
    FOREIGN KEY ("vehicleId", "shopId") REFERENCES "vehicles"("id", "shopId")
    ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
