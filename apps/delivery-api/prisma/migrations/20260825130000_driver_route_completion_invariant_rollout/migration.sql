CREATE TABLE "driver_route_completion_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "attemptId" UUID,
  "driverEventId" UUID,
  "mode" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "receiptAware" BOOLEAN NOT NULL,
  "driverContractVersion" INTEGER,
  "totalStopCount" INTEGER NOT NULL,
  "unresolvedStopCount" INTEGER NOT NULL,
  "wouldReject" BOOLEAN NOT NULL,
  "reviewOutcome" TEXT,
  "reviewedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_route_completion_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_route_completion_reviews_mode_check" CHECK ("mode" IN ('OBSERVE', 'GUARDED', 'FULL')),
  CONSTRAINT "driver_route_completion_reviews_decision_check" CHECK ("decision" IN ('PERMITTED', 'REJECTED')),
  CONSTRAINT "driver_route_completion_reviews_count_check" CHECK ("totalStopCount" >= 0 AND "unresolvedStopCount" >= 0 AND "unresolvedStopCount" <= "totalStopCount"),
  CONSTRAINT "driver_route_completion_reviews_outcome_check" CHECK ("reviewOutcome" IS NULL OR "reviewOutcome" IN ('CONFIRMED_CORRECT', 'FALSE_POSITIVE')),
  CONSTRAINT "driver_route_completion_reviews_shop_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE,
  CONSTRAINT "driver_route_completion_reviews_route_fkey" FOREIGN KEY ("routePlanId", "shopId") REFERENCES "route_plans"("id", "shopId") ON DELETE CASCADE,
  CONSTRAINT "driver_route_completion_reviews_attempt_fkey" FOREIGN KEY ("attemptId") REFERENCES "driver_event_attempts"("id") ON DELETE SET NULL,
  CONSTRAINT "driver_route_completion_reviews_event_fkey" FOREIGN KEY ("driverEventId") REFERENCES "driver_events"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "driver_route_completion_reviews_attemptId_key" ON "driver_route_completion_reviews"("attemptId");
CREATE UNIQUE INDEX "driver_route_completion_reviews_driverEventId_key" ON "driver_route_completion_reviews"("driverEventId");
CREATE INDEX "driver_route_completion_reviews_createdAt_mode_decision_idx" ON "driver_route_completion_reviews"("createdAt", "mode", "decision");
CREATE INDEX "driver_route_completion_reviews_createdAt_receiptAware_idx" ON "driver_route_completion_reviews"("createdAt", "receiptAware");
CREATE INDEX "driver_route_completion_reviews_createdAt_reviewOutcome_idx" ON "driver_route_completion_reviews"("createdAt", "reviewOutcome");
