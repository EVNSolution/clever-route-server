CREATE TABLE "driver_route_completion_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "routeVersionId" UUID,
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
  "reviewedByActor" TEXT,
  "reviewSource" TEXT,
  "reviewNote" TEXT,
  "reviewedAt" TIMESTAMPTZ(6),
  "retainedUntil" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_route_completion_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_route_completion_reviews_mode_check" CHECK ("mode" IN ('OBSERVE', 'GUARDED', 'FULL')),
  CONSTRAINT "driver_route_completion_reviews_decision_check" CHECK ("decision" IN ('PERMITTED', 'REJECTED')),
  CONSTRAINT "driver_route_completion_reviews_count_check" CHECK ("totalStopCount" >= 0 AND "unresolvedStopCount" >= 0 AND "unresolvedStopCount" <= "totalStopCount"),
  CONSTRAINT "driver_route_completion_reviews_retention_check" CHECK ("retainedUntil" >= "createdAt"),
  CONSTRAINT "driver_route_completion_reviews_outcome_check" CHECK ("reviewOutcome" IS NULL OR "reviewOutcome" IN ('CONFIRMED_CORRECT', 'FALSE_POSITIVE')),
  CONSTRAINT "driver_route_completion_reviews_review_source_check" CHECK ("reviewSource" IS NULL OR "reviewSource" IN ('ROUTE_OPS_UI', 'REPORT_RECONCILIATION')),
  CONSTRAINT "driver_route_completion_reviews_review_text_check" CHECK (
    ("reviewedByActor" IS NULL OR char_length("reviewedByActor") BETWEEN 1 AND 200)
    AND ("reviewNote" IS NULL OR char_length("reviewNote") BETWEEN 1 AND 500)
  ),
  CONSTRAINT "driver_route_completion_reviews_review_consistency_check" CHECK (
    ("reviewOutcome" IS NULL AND "reviewedAt" IS NULL AND "reviewedByActor" IS NULL AND "reviewSource" IS NULL AND "reviewNote" IS NULL)
    OR
    ("reviewOutcome" IS NOT NULL AND "reviewedAt" IS NOT NULL AND "reviewedByActor" IS NOT NULL AND "reviewSource" IS NOT NULL AND "reviewNote" IS NOT NULL)
  ),
  CONSTRAINT "driver_route_completion_reviews_shop_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE,
  CONSTRAINT "driver_route_completion_reviews_attempt_fkey" FOREIGN KEY ("attemptId") REFERENCES "driver_event_attempts"("id") ON DELETE SET NULL,
  CONSTRAINT "driver_route_completion_reviews_event_fkey" FOREIGN KEY ("driverEventId") REFERENCES "driver_events"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "driver_route_completion_reviews_attemptId_key" ON "driver_route_completion_reviews"("attemptId");
CREATE UNIQUE INDEX "driver_route_completion_reviews_driverEventId_key" ON "driver_route_completion_reviews"("driverEventId");
CREATE INDEX "driver_route_completion_reviews_createdAt_mode_decision_idx" ON "driver_route_completion_reviews"("createdAt", "mode", "decision");
CREATE INDEX "driver_route_completion_reviews_createdAt_receiptAware_idx" ON "driver_route_completion_reviews"("createdAt", "receiptAware");
CREATE INDEX "driver_route_completion_reviews_createdAt_reviewOutcome_idx" ON "driver_route_completion_reviews"("createdAt", "reviewOutcome");
CREATE INDEX "driver_route_completion_reviews_retainedUntil_reviewedAt_idx" ON "driver_route_completion_reviews"("retainedUntil", "reviewedAt");

CREATE TABLE "driver_route_completion_review_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "reviewId" UUID NOT NULL,
  "priorOutcome" TEXT,
  "outcome" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "retainedUntil" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_route_completion_review_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_route_completion_review_history_prior_outcome_check" CHECK ("priorOutcome" IS NULL OR "priorOutcome" IN ('CONFIRMED_CORRECT', 'FALSE_POSITIVE')),
  CONSTRAINT "driver_route_completion_review_history_outcome_check" CHECK ("outcome" IN ('CONFIRMED_CORRECT', 'FALSE_POSITIVE')),
  CONSTRAINT "driver_route_completion_review_history_source_check" CHECK ("source" IN ('ROUTE_OPS_UI', 'REPORT_RECONCILIATION')),
  CONSTRAINT "driver_route_completion_review_history_text_check" CHECK (char_length("actor") BETWEEN 1 AND 200 AND char_length("note") BETWEEN 1 AND 500),
  CONSTRAINT "driver_route_completion_review_history_retention_check" CHECK ("retainedUntil" >= "createdAt"),
  CONSTRAINT "driver_route_completion_review_history_review_fkey" FOREIGN KEY ("reviewId") REFERENCES "driver_route_completion_reviews"("id") ON DELETE CASCADE
);

CREATE INDEX "driver_route_completion_review_history_reviewId_createdAt_idx" ON "driver_route_completion_review_history"("reviewId", "createdAt");
CREATE INDEX "driver_route_completion_review_history_createdAt_outcome_idx" ON "driver_route_completion_review_history"("createdAt", "outcome");
CREATE INDEX "driver_route_completion_review_history_retainedUntil_idx" ON "driver_route_completion_review_history"("retainedUntil");

CREATE UNIQUE INDEX "route_grouping_child_versions_one_current_route_plan_idx"
  ON "route_grouping_child_versions"("routePlanId")
  WHERE "status" = 'CURRENT' AND "routePlanId" IS NOT NULL;
