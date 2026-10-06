CREATE TYPE "RouteTrackingRoadMatchJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SUCCEEDED', 'DEAD');

CREATE TABLE "route_tracking_road_match_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "routePlanId" UUID NOT NULL,
    "status" "RouteTrackingRoadMatchJobStatus" NOT NULL DEFAULT 'QUEUED',
    "targetSourcePointCount" INTEGER NOT NULL,
    "targetLastInputOccurredAt" TIMESTAMPTZ(6) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "processingStartedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_tracking_road_match_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "route_tracking_road_match_jobs_routePlanId_key"
ON "route_tracking_road_match_jobs"("routePlanId");

CREATE INDEX "route_tracking_road_match_jobs_status_nextAttemptAt_idx"
ON "route_tracking_road_match_jobs"("status", "nextAttemptAt");

CREATE INDEX "route_tracking_road_match_jobs_status_leaseExpiresAt_idx"
ON "route_tracking_road_match_jobs"("status", "leaseExpiresAt");

ALTER TABLE "route_tracking_road_match_jobs"
ADD CONSTRAINT "route_tracking_road_match_jobs_routePlanId_fkey"
FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Queue every usable input that does not already carry the contextual v5 cache
-- without clearing any currently published geometry while the durable job runs.
INSERT INTO "route_tracking_road_match_jobs" (
    "routePlanId",
    "targetSourcePointCount",
    "targetLastInputOccurredAt"
)
SELECT
    "routePlanId",
    "sourcePointCount",
    "lastOccurredAt"
FROM "route_tracking_geometries"
WHERE "sourcePointCount" >= 2
  AND "roadMatchedSchemaVersion" IS DISTINCT FROM 'route_tracking_road_match.v5';
