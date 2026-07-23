-- G004: canonical ETA state and route-version input ownership.
-- Additive schema only; assignment ownership remains on orders.currentRouteVersionId.

CREATE TYPE "DsvEtaStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'READY', 'FAILED', 'STALE');

ALTER TABLE "route_plan_stops"
  ADD COLUMN "shopId" UUID,
  ADD COLUMN "etaStatus" "DsvEtaStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "etaInputRouteVersionId" UUID,
  ADD COLUMN "etaSource" TEXT,
  ADD COLUMN "etaCalculatedAt" TIMESTAMPTZ(6),
  ADD COLUMN "etaFailureCode" TEXT,
  ADD COLUMN "etaFailureMessage" TEXT;

ALTER TABLE "driver_events"
  ADD COLUMN "routeVersionId" UUID;

UPDATE "route_plan_stops" route_stop
SET "shopId" = route_plan."shopId"
FROM "route_plans" route_plan
WHERE route_plan.id = route_stop."routePlanId";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "route_plan_stops"
    WHERE "shopId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enforce route_plan_stops.shopId: at least one stop has no owning route plan';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "route_plan_stops" route_stop
    JOIN "delivery_stops" delivery_stop ON delivery_stop.id = route_stop."deliveryStopId"
    WHERE delivery_stop."shopId" <> route_stop."shopId"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce route_plan_stops tenant ownership: delivery stop shop mismatch';
  END IF;
END $$;

ALTER TABLE "route_plan_stops"
  ALTER COLUMN "shopId" SET NOT NULL;

UPDATE "driver_events" driver_event
SET "routeVersionId" = (
  SELECT child_version.id
  FROM "route_grouping_child_versions" child_version
  WHERE child_version."routePlanId" = driver_event."routePlanId"
    AND child_version."shopId" = driver_event."shopId"
    AND child_version.status = 'CURRENT'
  ORDER BY child_version."createdAt" DESC
  LIMIT 1
)
WHERE driver_event."routePlanId" IS NOT NULL
  AND driver_event."routeVersionId" IS NULL;

CREATE INDEX "route_plan_stops_etaInputRouteVersionId_idx"
  ON "route_plan_stops"("etaInputRouteVersionId");

CREATE INDEX "route_plan_stops_routePlanId_etaStatus_idx"
  ON "route_plan_stops"("routePlanId", "etaStatus");

CREATE INDEX "route_plan_stops_shopId_routePlanId_idx"
  ON "route_plan_stops"("shopId", "routePlanId");

CREATE INDEX "driver_events_shopId_routeVersionId_occurredAt_idx"
  ON "driver_events"("shopId", "routeVersionId", "occurredAt");

CREATE UNIQUE INDEX "route_grouping_child_versions_id_shopId_routePlanId_key"
  ON "route_grouping_child_versions"("id", "shopId", "routePlanId");

ALTER TABLE "route_plan_stops"
  ADD CONSTRAINT "route_plan_stops_routePlanId_shopId_fkey"
  FOREIGN KEY ("routePlanId", "shopId") REFERENCES "route_plans"("id", "shopId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "route_plan_stops"
  ADD CONSTRAINT "route_plan_stops_deliveryStopId_shopId_fkey"
  FOREIGN KEY ("deliveryStopId", "shopId") REFERENCES "delivery_stops"("id", "shopId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "route_plan_stops"
  ADD CONSTRAINT "route_plan_stops_etaInputRouteVersionId_fkey"
  FOREIGN KEY ("etaInputRouteVersionId", "shopId", "routePlanId") REFERENCES "route_grouping_child_versions"("id", "shopId", "routePlanId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "driver_events"
  ADD CONSTRAINT "driver_events_routePlanId_shopId_fkey"
  FOREIGN KEY ("routePlanId", "shopId") REFERENCES "route_plans"("id", "shopId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "driver_events"
  ADD CONSTRAINT "driver_events_routeVersionId_shopId_fkey"
  FOREIGN KEY ("routeVersionId", "shopId", "routePlanId") REFERENCES "route_grouping_child_versions"("id", "shopId", "routePlanId")
  ON DELETE NO ACTION ON UPDATE CASCADE;
