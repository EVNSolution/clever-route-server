-- Persist the full recorded driver path as one route-scoped geometry artifact.
-- Raw DriverEvent rows remain the audit source; this projection removes any
-- fixed event-count limit from route-history reads.
CREATE TABLE "route_tracking_geometries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "routePlanId" UUID NOT NULL,
  "geometry" JSONB,
  "sampleMetadata" JSONB NOT NULL,
  "sourcePointCount" INTEGER NOT NULL,
  "geometryPointCount" INTEGER NOT NULL,
  "firstOccurredAt" TIMESTAMPTZ(6) NOT NULL,
  "lastOccurredAt" TIMESTAMPTZ(6) NOT NULL,
  "lastReceivedAt" TIMESTAMPTZ(6) NOT NULL,
  "lastEventId" UUID NOT NULL,
  "lastDriverId" UUID,
  "lastLatitude" DECIMAL(10, 7) NOT NULL,
  "lastLongitude" DECIMAL(10, 7) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "route_tracking_geometries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "route_tracking_geometries_routePlanId_key"
  ON "route_tracking_geometries"("routePlanId");

CREATE INDEX "route_tracking_geometries_expiresAt_idx"
  ON "route_tracking_geometries"("expiresAt");

ALTER TABLE "route_tracking_geometries"
  ADD CONSTRAINT "route_tracking_geometries_routePlanId_fkey"
  FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing routes are backfilled without dropping points. New writes use the
-- server-side route geometry simplifier before updating this route-level row.
WITH tracking_points AS (
  SELECT
    "routePlanId",
    "id",
    "driverId",
    "latitude",
    "longitude",
    "occurredAt",
    "createdAt"
  FROM "driver_events"
  WHERE
    "eventType" = 'LOCATION_UPDATED'
    AND "routePlanId" IS NOT NULL
    AND "latitude" IS NOT NULL
    AND "longitude" IS NOT NULL
), grouped_paths AS (
  SELECT
    "routePlanId",
    jsonb_agg(jsonb_build_array("longitude"::double precision, "latitude"::double precision)
      ORDER BY "occurredAt", "createdAt", "id") AS coordinates,
    jsonb_agg(jsonb_build_object(
      'eventId', "id"::text,
      'driverId', CASE WHEN "driverId" IS NULL THEN NULL ELSE "driverId"::text END,
      'occurredAt', "occurredAt",
      'receivedAt', "createdAt"
    ) ORDER BY "occurredAt", "createdAt", "id") AS sample_metadata,
    count(*) AS point_count,
    min("occurredAt") AS first_occurred_at
  FROM tracking_points
  GROUP BY "routePlanId"
), latest_points AS (
  SELECT DISTINCT ON ("routePlanId")
    "routePlanId",
    "id",
    "driverId",
    "latitude",
    "longitude",
    "occurredAt",
    "createdAt"
  FROM tracking_points
  ORDER BY "routePlanId", "occurredAt" DESC, "createdAt" DESC, "id" DESC
)
INSERT INTO "route_tracking_geometries" (
  "routePlanId",
  "geometry",
  "sampleMetadata",
  "sourcePointCount",
  "geometryPointCount",
  "firstOccurredAt",
  "lastOccurredAt",
  "lastReceivedAt",
  "lastEventId",
  "lastDriverId",
  "lastLatitude",
  "lastLongitude",
  "expiresAt"
)
SELECT
  grouped_paths."routePlanId",
  CASE
    WHEN point_count >= 2 THEN jsonb_build_object('type', 'LineString', 'coordinates', coordinates)
    ELSE NULL
  END,
  sample_metadata,
  point_count::integer,
  point_count::integer,
  first_occurred_at,
  latest_points."occurredAt",
  latest_points."createdAt",
  latest_points."id",
  latest_points."driverId",
  latest_points."latitude",
  latest_points."longitude",
  latest_points."occurredAt" + INTERVAL '90 days'
FROM grouped_paths
JOIN latest_points USING ("routePlanId");
