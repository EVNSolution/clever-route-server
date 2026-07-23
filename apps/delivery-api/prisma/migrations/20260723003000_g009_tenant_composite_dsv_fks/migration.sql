-- G009 tenant-composite FK repair for DSV/order resource links.
-- Fail closed before replacing legacy single-column parent references.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "delivery_stops" child
    LEFT JOIN "orders" parent
      ON parent."id" = child."orderId"
    WHERE parent."id" IS NULL
       OR parent."shopId" <> child."shopId"
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace delivery_stops_orderId_fkey: delivery_stops rows reference missing or cross-shop orders';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "dsv_driver_profiles" child
    LEFT JOIN "drivers" parent
      ON parent."id" = child."driverId"
    WHERE parent."id" IS NULL
       OR parent."shopId" <> child."shopId"
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace dsv_driver_profiles_driverId_fkey: dsv_driver_profiles rows reference missing or cross-shop drivers';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "dsv_vehicle_profiles" child
    LEFT JOIN "vehicles" parent
      ON parent."id" = child."vehicleId"
    WHERE parent."id" IS NULL
       OR parent."shopId" <> child."shopId"
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace dsv_vehicle_profiles_vehicleId_fkey: dsv_vehicle_profiles rows reference missing or cross-shop vehicles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "dsv_vehicle_driver_assignments" child
    LEFT JOIN "vehicles" parent
      ON parent."id" = child."vehicleId"
    WHERE parent."id" IS NULL
       OR parent."shopId" <> child."shopId"
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace dsv_vehicle_driver_assignments_vehicleId_fkey: dsv_vehicle_driver_assignments rows reference missing or cross-shop vehicles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "dsv_vehicle_driver_assignments" child
    LEFT JOIN "drivers" parent
      ON parent."id" = child."driverId"
    WHERE parent."id" IS NULL
       OR parent."shopId" <> child."shopId"
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot replace dsv_vehicle_driver_assignments_driverId_fkey: dsv_vehicle_driver_assignments rows reference missing or cross-shop drivers';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "drivers_id_shopId_key" ON "drivers"("id", "shopId");
CREATE UNIQUE INDEX IF NOT EXISTS "vehicles_id_shopId_key" ON "vehicles"("id", "shopId");
CREATE UNIQUE INDEX IF NOT EXISTS "dsv_driver_profiles_driverId_shopId_key" ON "dsv_driver_profiles"("driverId", "shopId");
CREATE UNIQUE INDEX IF NOT EXISTS "dsv_vehicle_profiles_vehicleId_shopId_key" ON "dsv_vehicle_profiles"("vehicleId", "shopId");

ALTER TABLE "delivery_stops"
  DROP CONSTRAINT IF EXISTS "delivery_stops_orderId_fkey";

ALTER TABLE "dsv_driver_profiles"
  DROP CONSTRAINT IF EXISTS "dsv_driver_profiles_driverId_fkey";

ALTER TABLE "dsv_vehicle_profiles"
  DROP CONSTRAINT IF EXISTS "dsv_vehicle_profiles_vehicleId_fkey";

ALTER TABLE "dsv_vehicle_driver_assignments"
  DROP CONSTRAINT IF EXISTS "dsv_vehicle_driver_assignments_vehicleId_fkey",
  DROP CONSTRAINT IF EXISTS "dsv_vehicle_driver_assignments_driverId_fkey";

DO $$
BEGIN
  ALTER TABLE "delivery_stops"
    ADD CONSTRAINT "delivery_stops_orderId_shopId_fkey"
    FOREIGN KEY ("orderId", "shopId") REFERENCES "orders"("id", "shopId")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_driver_profiles"
    ADD CONSTRAINT "dsv_driver_profiles_driverId_shopId_fkey"
    FOREIGN KEY ("driverId", "shopId") REFERENCES "drivers"("id", "shopId")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_vehicle_profiles"
    ADD CONSTRAINT "dsv_vehicle_profiles_vehicleId_shopId_fkey"
    FOREIGN KEY ("vehicleId", "shopId") REFERENCES "vehicles"("id", "shopId")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_vehicle_driver_assignments"
    ADD CONSTRAINT "dsv_vehicle_driver_assignments_vehicleId_shopId_fkey"
    FOREIGN KEY ("vehicleId", "shopId") REFERENCES "vehicles"("id", "shopId")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_vehicle_driver_assignments"
    ADD CONSTRAINT "dsv_vehicle_driver_assignments_driverId_shopId_fkey"
    FOREIGN KEY ("driverId", "shopId") REFERENCES "drivers"("id", "shopId")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
