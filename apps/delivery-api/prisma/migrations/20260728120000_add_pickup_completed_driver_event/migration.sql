ALTER TYPE "DriverEventType" ADD VALUE IF NOT EXISTS 'PICKUP_COMPLETED';

CREATE UNIQUE INDEX IF NOT EXISTS "driver_events_pickup_completed_driver_route_key"
  ON "driver_events"("driverId", "routePlanId")
  WHERE "eventType" = 'PICKUP_COMPLETED' AND "driverId" IS NOT NULL AND "routePlanId" IS NOT NULL;
