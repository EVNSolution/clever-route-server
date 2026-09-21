CREATE TABLE "driver_completion_policies" (
  "version" TEXT NOT NULL,
  "policy" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_completion_policies_pkey" PRIMARY KEY ("version"),
  CONSTRAINT "driver_completion_policies_version_check" CHECK (char_length("version") > 0),
  CONSTRAINT "driver_completion_policies_policy_check" CHECK (jsonb_typeof("policy") = 'object')
);

CREATE TABLE "driver_completion_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "accountId" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "driverId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "assignmentGeneration" BIGINT NOT NULL,
  "expectedRouteVersionId" UUID NOT NULL,
  "routeName" TEXT NOT NULL,
  "stops" JSONB NOT NULL,
  "policyVersions" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "activationId" TEXT,
  "trackingEndedAt" TIMESTAMPTZ(6),
  "invalidatedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_completion_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_completion_runs_assignment_generation_check" CHECK ("assignmentGeneration" > 0),
  CONSTRAINT "driver_completion_runs_stops_check" CHECK (jsonb_typeof("stops") = 'array'),
  CONSTRAINT "driver_completion_runs_policy_versions_check" CHECK (
    jsonb_typeof("policyVersions") = 'array'
    AND NOT jsonb_path_exists("policyVersions", '$[*] ? (@.type() != "string")')
  )
);

CREATE UNIQUE INDEX "driver_completion_runs_assignment_identity_key"
  ON "driver_completion_runs"("routePlanId", "assignmentGeneration", "expectedRouteVersionId");
CREATE INDEX "driver_completion_runs_accountId_createdAt_idx"
  ON "driver_completion_runs"("accountId", "createdAt");

CREATE TABLE "driver_completion_candidates" (
  "id" TEXT NOT NULL,
  "runId" UUID NOT NULL,
  "deliveryStopId" UUID NOT NULL,
  "projection" JSONB NOT NULL,
  "originalCommand" JSONB NOT NULL,
  "proposedExitAt" TIMESTAMPTZ(6) NOT NULL,
  "verifiedExitAt" TIMESTAMPTZ(6),
  "responseDeadlineAt" TIMESTAMPTZ(6),
  "verifiedAt" TIMESTAMPTZ(6),
  "policyVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "response" TEXT,
  "responseAt" TIMESTAMPTZ(6),
  "lastResponseCommandId" TEXT,
  "autoCompletedAt" TIMESTAMPTZ(6),
  "automationActivationId" TEXT,
  "statusBeforeCandidateOutcome" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "driver_completion_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_completion_candidates_id_check" CHECK (char_length("id") > 0),
  CONSTRAINT "driver_completion_candidates_projection_check" CHECK (jsonb_typeof("projection") = 'object'),
  CONSTRAINT "driver_completion_candidates_original_command_check" CHECK (jsonb_typeof("originalCommand") = 'object'),
  CONSTRAINT "driver_completion_candidates_status_check" CHECK (
    "status" IN ('awaiting_response', 'responded', 'inferred_completed', 'held', 'invalidated')
  ),
  CONSTRAINT "driver_completion_candidates_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "driver_completion_candidates_response_check" CHECK (
    "response" IS NULL OR "response" IN ('completed', 'failed', 'not_completed')
  ),
  CONSTRAINT "driver_completion_candidates_previous_status_check" CHECK (
    "statusBeforeCandidateOutcome" IS NULL
    OR "statusBeforeCandidateOutcome" IN ('PENDING', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED')
  ),
  CONSTRAINT "driver_completion_candidates_deadline_check" CHECK (
    "responseDeadlineAt" IS NULL
    OR (
      "verifiedExitAt" IS NOT NULL
      AND "responseDeadlineAt" = "verifiedExitAt" + INTERVAL '24 hours'
    )
  ),
  CONSTRAINT "driver_completion_candidates_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "driver_completion_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "driver_completion_candidates_policyVersion_fkey"
    FOREIGN KEY ("policyVersion") REFERENCES "driver_completion_policies"("version") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "driver_completion_candidates_visit_key"
  ON "driver_completion_candidates"("runId", "deliveryStopId", "proposedExitAt");
CREATE INDEX "driver_completion_candidates_status_deadline_idx"
  ON "driver_completion_candidates"("status", "responseDeadlineAt");

CREATE TABLE "driver_completion_receipts" (
  "accountId" UUID NOT NULL,
  "commandId" TEXT NOT NULL,
  "runId" UUID NOT NULL,
  "candidateId" TEXT,
  "kind" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_completion_receipts_pkey" PRIMARY KEY ("accountId", "commandId"),
  CONSTRAINT "driver_completion_receipts_command_id_check" CHECK (char_length("commandId") > 0),
  CONSTRAINT "driver_completion_receipts_kind_check" CHECK ("kind" IN ('candidate', 'response', 'return_intent')),
  CONSTRAINT "driver_completion_receipts_request_check" CHECK (jsonb_typeof("request") = 'object'),
  CONSTRAINT "driver_completion_receipts_result_check" CHECK (jsonb_typeof("result") = 'object'),
  CONSTRAINT "driver_completion_receipts_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "driver_completion_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "driver_completion_receipts_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "driver_completion_candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "driver_completion_receipts_candidateId_idx"
  ON "driver_completion_receipts"("candidateId");

CREATE TABLE "driver_completion_outcomes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "candidateId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  "commandId" TEXT,
  "previousStatus" TEXT,
  "nextStatus" TEXT,
  "previousProjection" JSONB NOT NULL,
  "projection" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_completion_outcomes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_completion_outcomes_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "driver_completion_outcomes_projection_check" CHECK (
    jsonb_typeof("previousProjection") = 'object' AND jsonb_typeof("projection") = 'object'
  ),
  CONSTRAINT "driver_completion_outcomes_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "driver_completion_candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "driver_completion_outcomes_candidateId_revision_key"
  ON "driver_completion_outcomes"("candidateId", "revision");

ALTER TABLE "delivery_stops"
  ADD COLUMN "completionAssistanceCandidateId" TEXT,
  ADD COLUMN "completionAssistanceRevision" INTEGER,
  ADD CONSTRAINT "delivery_stops_completion_assistance_ownership_check" CHECK (
    ("completionAssistanceCandidateId" IS NULL) = ("completionAssistanceRevision" IS NULL)
    AND ("completionAssistanceRevision" IS NULL OR "completionAssistanceRevision" >= 0)
  );

CREATE OR REPLACE FUNCTION "preserve_driver_completion_run_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
    OR NEW."shopId" IS DISTINCT FROM OLD."shopId"
    OR NEW."driverId" IS DISTINCT FROM OLD."driverId"
    OR NEW."routePlanId" IS DISTINCT FROM OLD."routePlanId"
    OR NEW."assignmentGeneration" IS DISTINCT FROM OLD."assignmentGeneration"
    OR NEW."expectedRouteVersionId" IS DISTINCT FROM OLD."expectedRouteVersionId"
    OR NEW."routeName" IS DISTINCT FROM OLD."routeName"
    OR NEW."stops" IS DISTINCT FROM OLD."stops"
    OR NEW."activationId" IS DISTINCT FROM OLD."activationId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Driver completion run ownership and stop snapshot are immutable',
      CONSTRAINT = 'driver_completion_runs_immutable_identity';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "driver_completion_runs_immutable_identity"
BEFORE UPDATE ON "driver_completion_runs"
FOR EACH ROW
EXECUTE FUNCTION "preserve_driver_completion_run_identity"();

CREATE OR REPLACE FUNCTION "preserve_driver_completion_candidate_evidence"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."runId" IS DISTINCT FROM OLD."runId"
    OR NEW."deliveryStopId" IS DISTINCT FROM OLD."deliveryStopId"
    OR NEW."originalCommand" IS DISTINCT FROM OLD."originalCommand"
    OR NEW."proposedExitAt" IS DISTINCT FROM OLD."proposedExitAt"
    OR NEW."verifiedExitAt" IS DISTINCT FROM OLD."verifiedExitAt"
    OR NEW."responseDeadlineAt" IS DISTINCT FROM OLD."responseDeadlineAt"
    OR NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt"
    OR NEW."policyVersion" IS DISTINCT FROM OLD."policyVersion"
    OR NEW."automationActivationId" IS DISTINCT FROM OLD."automationActivationId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Driver completion candidate identity and proposed evidence are immutable',
      CONSTRAINT = 'driver_completion_candidates_immutable_evidence';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "driver_completion_candidates_immutable_evidence"
BEFORE UPDATE ON "driver_completion_candidates"
FOR EACH ROW
EXECUTE FUNCTION "preserve_driver_completion_candidate_evidence"();

CREATE OR REPLACE FUNCTION "reject_driver_completion_ledger_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = format('%s is append-only', TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER "driver_completion_policies_append_only"
BEFORE UPDATE OR DELETE ON "driver_completion_policies"
FOR EACH ROW
EXECUTE FUNCTION "reject_driver_completion_ledger_mutation"();

CREATE TRIGGER "driver_completion_receipts_append_only"
BEFORE UPDATE OR DELETE ON "driver_completion_receipts"
FOR EACH ROW
EXECUTE FUNCTION "reject_driver_completion_ledger_mutation"();

CREATE TRIGGER "driver_completion_outcomes_append_only"
BEFORE UPDATE OR DELETE ON "driver_completion_outcomes"
FOR EACH ROW
EXECUTE FUNCTION "reject_driver_completion_ledger_mutation"();

CREATE OR REPLACE FUNCTION "invalidate_completion_candidates_on_manual_stop_status"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected RECORD;
  next_revision INTEGER;
  next_projection JSONB;
BEGIN
  -- Completion-assistance writes advance the ownership marker. A status writer
  -- that retains the exact old marker (including NULL/NULL) is independent.
  IF NEW."completionAssistanceCandidateId" IS NOT DISTINCT FROM OLD."completionAssistanceCandidateId"
    AND NEW."completionAssistanceRevision" IS NOT DISTINCT FROM OLD."completionAssistanceRevision"
    AND (
      NEW."status" IN ('DELIVERED', 'FAILED', 'CANCELLED', 'SKIPPED')
      OR OLD."completionAssistanceCandidateId" IS NOT NULL
    )
  THEN
    NEW."completionAssistanceCandidateId" := NULL;
    NEW."completionAssistanceRevision" := NULL;

    FOR affected IN
      SELECT candidate."id", candidate."revision", candidate."projection"
      FROM "driver_completion_candidates" AS candidate
      WHERE candidate."deliveryStopId" = OLD."id"
        AND candidate."status" <> 'invalidated'
      ORDER BY candidate."id"
      FOR UPDATE
    LOOP
      next_revision := affected."revision" + 1;
      next_projection := jsonb_set(
        jsonb_set(
          jsonb_set(affected."projection", '{status}', '"invalidated"'::jsonb, true),
          '{revision}', to_jsonb(next_revision), true
        ),
        '{holdReason}', '"manual_stop_override"'::jsonb, true
      );

      UPDATE "driver_completion_candidates"
      SET "status" = 'invalidated',
          "revision" = next_revision,
          "projection" = next_projection,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = affected."id";

      INSERT INTO "driver_completion_outcomes" (
        "candidateId",
        "revision",
        "source",
        "commandId",
        "previousStatus",
        "nextStatus",
        "previousProjection",
        "projection"
      ) VALUES (
        affected."id",
        next_revision,
        'MANUAL_STOP',
        NULL,
        OLD."status"::text,
        NEW."status"::text,
        affected."projection",
        next_projection
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "delivery_stops_completion_assistance_manual_priority"
BEFORE UPDATE OF "status" ON "delivery_stops"
FOR EACH ROW
EXECUTE FUNCTION "invalidate_completion_candidates_on_manual_stop_status"();
