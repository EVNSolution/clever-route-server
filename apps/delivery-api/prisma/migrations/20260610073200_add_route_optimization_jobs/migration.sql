-- Persist server-owned route optimization jobs for Route Ops route_engine UX.

DO $$
BEGIN
  CREATE TYPE "RouteOptimizationJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'APPLIED', 'TIMEOUT', 'FAILED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "RouteOptimizationJobStep" AS ENUM ('QUEUED', 'CALLING_ENGINE', 'APPLYING_RESULT', 'COMPLETED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "route_optimization_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "status" "RouteOptimizationJobStatus" NOT NULL DEFAULT 'QUEUED',
  "currentStep" "RouteOptimizationJobStep" NOT NULL DEFAULT 'QUEUED',
  "timeoutBudgetMs" INTEGER NOT NULL,
  "elapsedMs" INTEGER,
  "engineResultSequence" JSONB,
  "appliedAt" TIMESTAMPTZ(6),
  "invalidatedReason" TEXT,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "traceId" TEXT NOT NULL,
  "createdBy" TEXT,
  "startedAt" TIMESTAMPTZ(6),
  "finishedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "route_optimization_jobs_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "route_optimization_jobs"
    ADD CONSTRAINT "route_optimization_jobs_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "route_optimization_jobs"
    ADD CONSTRAINT "route_optimization_jobs_routePlanId_fkey"
    FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "route_optimization_jobs_routePlanId_createdAt_idx"
  ON "route_optimization_jobs"("routePlanId", "createdAt");

CREATE INDEX IF NOT EXISTS "route_optimization_jobs_shopId_status_createdAt_idx"
  ON "route_optimization_jobs"("shopId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "route_optimization_jobs_traceId_idx"
  ON "route_optimization_jobs"("traceId");

CREATE UNIQUE INDEX IF NOT EXISTS "route_optimization_jobs_one_active_per_route_idx"
  ON "route_optimization_jobs"("routePlanId")
  WHERE "status" IN ('QUEUED', 'RUNNING');
