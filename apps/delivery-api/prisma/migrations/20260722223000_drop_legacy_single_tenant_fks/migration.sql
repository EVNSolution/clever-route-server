-- G007 cleanup: remove legacy single-column ownership FKs superseded by G004 tenant-composite FKs.

ALTER TABLE "route_plan_stops" DROP CONSTRAINT IF EXISTS "route_plan_stops_routePlanId_fkey";
ALTER TABLE "route_plan_stops" DROP CONSTRAINT IF EXISTS "route_plan_stops_deliveryStopId_fkey";
ALTER TABLE "driver_events" DROP CONSTRAINT IF EXISTS "driver_events_routePlanId_fkey";
