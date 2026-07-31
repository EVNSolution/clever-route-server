-- Enforce one default DSV vehicle assignment per driver and per vehicle inside a shop.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "dsv_vehicle_driver_assignments"
    GROUP BY "shopId", "driverId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one-to-one DSV assignments: duplicate shop/driver assignments exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "dsv_vehicle_driver_assignments"
    GROUP BY "shopId", "vehicleId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one-to-one DSV assignments: duplicate shop/vehicle assignments exist';
  END IF;
END $$;

DROP INDEX IF EXISTS "dsv_vehicle_driver_assignments_shopId_driverId_idx";
DROP INDEX IF EXISTS "dsv_vehicle_driver_assignments_shopId_vehicleId_idx";
DROP INDEX IF EXISTS "dsv_vehicle_driver_assignments_shopId_vehicleId_driverId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "dsv_vehicle_driver_assignments_shopId_driverId_key"
  ON "dsv_vehicle_driver_assignments"("shopId", "driverId");

CREATE UNIQUE INDEX IF NOT EXISTS "dsv_vehicle_driver_assignments_shopId_vehicleId_key"
  ON "dsv_vehicle_driver_assignments"("shopId", "vehicleId");
