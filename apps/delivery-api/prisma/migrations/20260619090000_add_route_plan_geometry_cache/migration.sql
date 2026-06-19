-- Persist route geometry as an explicit artifact so route reads do not call OSRM/VROOM.
CREATE TABLE "route_plan_geometry_caches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "routePlanId" UUID NOT NULL,
  "shapeSignature" TEXT NOT NULL,
  "geometry" JSONB,
  "metrics" JSONB,
  "stopPoints" JSONB NOT NULL,
  "provider" TEXT NOT NULL,
  "providerVersion" TEXT,
  "overview" TEXT NOT NULL DEFAULT 'simplified',
  "source" TEXT NOT NULL,
  "generatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "route_plan_geometry_caches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "route_plan_geometry_caches_routePlanId_shapeSignature_key"
  ON "route_plan_geometry_caches"("routePlanId", "shapeSignature");

CREATE INDEX "route_plan_geometry_caches_shapeSignature_idx"
  ON "route_plan_geometry_caches"("shapeSignature");

ALTER TABLE "route_plan_geometry_caches"
  ADD CONSTRAINT "route_plan_geometry_caches_routePlanId_fkey"
  FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
