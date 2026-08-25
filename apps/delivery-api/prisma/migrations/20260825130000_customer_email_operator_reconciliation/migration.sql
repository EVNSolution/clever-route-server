CREATE TABLE "customer_email_operator_reconciliations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "targetKind" TEXT NOT NULL,
  "targetId" UUID NOT NULL,
  "disposition" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "changeControlRef" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "manifestSha256" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "retainedUntil" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_email_operator_reconciliations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_email_operator_reconciliations_shop_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE,
  CONSTRAINT "customer_email_operator_reconciliations_kind_check"
    CHECK ("targetKind" = 'FACT'),
  CONSTRAINT "customer_email_operator_reconciliations_disposition_check"
    CHECK ("disposition" = 'DO_NOT_SEND'),
  CONSTRAINT "customer_email_operator_reconciliations_actor_check"
    CHECK ("actor" ~ '^[a-z0-9][a-z0-9._/-]{2,79}$'),
  CONSTRAINT "customer_email_operator_reconciliations_cc_check"
    CHECK ("changeControlRef" ~ '^EVNSolution/clever-change-control#[1-9][0-9]*$'),
  CONSTRAINT "customer_email_operator_reconciliations_reason_check"
    CHECK ("reasonCode" ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT "customer_email_operator_reconciliations_hash_check"
    CHECK ("manifestSha256" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "customer_email_operator_reconciliations_correlation_idx"
  ON "customer_email_operator_reconciliations"("correlationId");
CREATE INDEX "customer_email_operator_reconciliations_shop_created_idx"
  ON "customer_email_operator_reconciliations"("shopId", "createdAt");
CREATE INDEX "customer_email_operator_reconciliations_retention_idx"
  ON "customer_email_operator_reconciliations"("retainedUntil");

CREATE TABLE "customer_email_reconciliation_tombstones" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "targetId" UUID NOT NULL,
  "disposition" TEXT NOT NULL,
  "changeControlRef" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "manifestSha256" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_email_reconciliation_tombstones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_email_reconciliation_tombstones_shop_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE,
  CONSTRAINT "customer_email_reconciliation_tombstones_target_fkey"
    FOREIGN KEY ("targetId") REFERENCES "customer_route_notification_facts"("id") ON DELETE RESTRICT,
  CONSTRAINT "customer_email_reconciliation_tombstones_disposition_check"
    CHECK ("disposition" = 'DO_NOT_SEND'),
  CONSTRAINT "customer_email_reconciliation_tombstones_cc_check"
    CHECK ("changeControlRef" ~ '^EVNSolution/clever-change-control#[1-9][0-9]*$'),
  CONSTRAINT "customer_email_reconciliation_tombstones_reason_check"
    CHECK ("reasonCode" ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT "customer_email_reconciliation_tombstones_hash_check"
    CHECK ("manifestSha256" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "customer_email_reconciliation_tombstones_correlation_idx"
  ON "customer_email_reconciliation_tombstones"("correlationId");
CREATE UNIQUE INDEX "customer_email_reconciliation_tombstones_shop_target_idx"
  ON "customer_email_reconciliation_tombstones"("shopId", "targetId");
CREATE INDEX "customer_email_reconciliation_tombstones_shop_created_idx"
  ON "customer_email_reconciliation_tombstones"("shopId", "createdAt");
