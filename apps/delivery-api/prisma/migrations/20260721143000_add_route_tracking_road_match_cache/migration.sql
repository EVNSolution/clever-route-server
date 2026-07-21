-- Optional display-only road-match cache for route tracking.
-- Raw DriverEvent rows and RouteTrackingGeometry.geometry remain unchanged.
ALTER TABLE "route_tracking_geometries"
  ADD COLUMN "roadMatchedGeometry" JSONB,
  ADD COLUMN "roadMatchedUncertainGeometry" JSONB,
  ADD COLUMN "roadMatchedCoverage" TEXT,
  ADD COLUMN "roadMatchedSchemaVersion" TEXT,
  ADD COLUMN "roadMatchedSourcePointCount" INTEGER,
  ADD COLUMN "roadMatchedPointCount" INTEGER,
  ADD COLUMN "roadMatchedLastInputOccurredAt" TIMESTAMPTZ(6),
  ADD COLUMN "roadMatchedLastPosition" JSONB,
  ADD COLUMN "roadMatchedWatermark" TEXT;
