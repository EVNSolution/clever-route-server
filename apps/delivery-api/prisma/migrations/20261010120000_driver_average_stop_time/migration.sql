-- Average Stop time of a driver in whole minutes. NULL means none, so the default of 5 minutes applies.
ALTER TABLE "drivers" ADD COLUMN "averageServiceMinutes" INTEGER;
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_averageServiceMinutes_check"
  CHECK ("averageServiceMinutes" IS NULL OR ("averageServiceMinutes" >= 0 AND "averageServiceMinutes" <= 1440));
-- Who chose a stop's Stop time (serviceMinutes): STOP (the office changed it on that stop), ROUTE (the unified time of a
-- new route), DRIVER (taken from the driver's average) or NULL (the system default of 5 minutes).
ALTER TABLE "delivery_stops" ADD COLUMN "serviceMinutesSource" TEXT;
ALTER TABLE "delivery_stops" ADD CONSTRAINT "delivery_stops_serviceMinutesSource_check"
  CHECK ("serviceMinutesSource" IS NULL OR "serviceMinutesSource" IN ('STOP', 'ROUTE', 'DRIVER'));
-- A time that is not the default was chosen by a person (or imported); it must never be taken for a default.
UPDATE "delivery_stops" SET "serviceMinutesSource" = 'STOP' WHERE "serviceMinutes" <> 5;
