CREATE TABLE "driver_route_completion_gate_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "outcome" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "retainedUntil" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "driver_route_completion_gate_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_route_completion_gate_history_outcome_check" CHECK ("outcome" IN ('CONFIRMED_CORRECT', 'FALSE_POSITIVE')),
  CONSTRAINT "driver_route_completion_gate_history_source_check" CHECK ("source" IN ('ROUTE_OPS_UI', 'REPORT_RECONCILIATION')),
  CONSTRAINT "driver_route_completion_gate_history_retention_check" CHECK ("retainedUntil" >= "createdAt")
);

CREATE INDEX "driver_route_completion_gate_history_createdAt_outcome_idx"
  ON "driver_route_completion_gate_history"("createdAt", "outcome");
CREATE INDEX "driver_route_completion_gate_history_retainedUntil_idx"
  ON "driver_route_completion_gate_history"("retainedUntil");
