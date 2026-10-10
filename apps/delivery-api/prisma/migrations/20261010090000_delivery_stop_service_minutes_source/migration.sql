-- Where a stop's Stop time (serviceMinutes) came from: STOP (the office set it on that stop), ROUTE (the unified
-- time of a new route), DRIVER (the driver's average, reserved) or NULL (the system default of 5 minutes).
ALTER TABLE "delivery_stops" ADD COLUMN "serviceMinutesSource" TEXT;
ALTER TABLE "delivery_stops" ADD CONSTRAINT "delivery_stops_serviceMinutesSource_check"
  CHECK ("serviceMinutesSource" IS NULL OR "serviceMinutesSource" IN ('STOP', 'ROUTE', 'DRIVER'));
-- A time that is not the default was chosen by a person (or imported); it must never be taken for a default.
UPDATE "delivery_stops" SET "serviceMinutesSource" = 'STOP' WHERE "serviceMinutes" <> 5;
