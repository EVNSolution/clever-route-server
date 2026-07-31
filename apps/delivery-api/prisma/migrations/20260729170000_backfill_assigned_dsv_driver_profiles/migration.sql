-- Existing DSV vehicle assignments prove that the driver belongs to the DSV
-- workspace. Backfill only assigned drivers that predate DSV driver profiles;
-- preserve the canonical driver row, phone number, and assignment relation.
INSERT INTO "dsv_driver_profiles" (
  "driverId",
  "shopId",
  "lookupName",
  "age",
  "gender",
  "career",
  "zone",
  "score",
  "traits",
  "createdAt",
  "updatedAt"
)
SELECT
  driver.id,
  driver."shopId",
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM "dsv_driver_profiles" existing
      WHERE existing."shopId" = driver."shopId"
        AND existing."lookupName" = driver."displayName"
    )
      THEN driver."displayName" || ' (' || LEFT(driver.id::text, 8) || ')'
    ELSE driver."displayName"
  END,
  18,
  '미제공',
  '미제공',
  '미제공',
  '미제공',
  ARRAY[]::TEXT[],
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "drivers" driver
WHERE NOT EXISTS (
  SELECT 1
  FROM "dsv_driver_profiles" profile
  WHERE profile."driverId" = driver.id
)
AND EXISTS (
  SELECT 1
  FROM "dsv_vehicle_driver_assignments" assignment
  WHERE assignment."driverId" = driver.id
    AND assignment."shopId" = driver."shopId"
);
