-- G002: DSV customer authorization, command receipt, audit, and baseline foundations.
-- Expand-only: new enums, nullable order links, new tables, and supporting indexes.

DO $$
BEGIN
  CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "CustomerAccountStatus" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "DsvTransportConditionStatus" AS ENUM ('CANDIDATE', 'ACTIVE', 'INACTIVE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "DsvCommandReceiptStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "DsvPrincipalType" AS ENUM ('DSV_ADMIN', 'CUSTOMER_USER', 'DRIVER', 'IMPORT_WORKER', 'DEVICE', 'SYSTEM_WORKER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "DsvAuditRedactionClass" AS ENUM ('STANDARD', 'PII_REDACTED', 'SECRET_REDACTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "customers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "externalCustomerCode" TEXT NOT NULL,
  "displayName" TEXT,
  "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "customer_accounts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "issuer" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "email" TEXT,
  "displayName" TEXT,
  "status" "CustomerAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "scopeVersion" INTEGER NOT NULL DEFAULT 1,
  "lastAuthenticatedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "customer_accounts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "sellerOrderSourceKind" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "sellerOrderKey" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "sellerOrderVersion" INTEGER;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customerId" UUID;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "destinationId" UUID;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "currentRouteVersionId" UUID;

ALTER TABLE "dsv_transport_conditions" ADD COLUMN IF NOT EXISTS "rawValue" TEXT;
ALTER TABLE "dsv_transport_conditions" ADD COLUMN IF NOT EXISTS "comparisonKey" TEXT;
ALTER TABLE "dsv_transport_conditions" ADD COLUMN IF NOT EXISTS "status" "DsvTransportConditionStatus" DEFAULT 'CANDIDATE';
ALTER TABLE "dsv_transport_conditions" ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMPTZ(6);
ALTER TABLE "dsv_transport_conditions" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMPTZ(6);

CREATE TABLE IF NOT EXISTS "dsv_command_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "commandName" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  "principalType" "DsvPrincipalType" NOT NULL,
  "requestId" TEXT NOT NULL,
  "status" "DsvCommandReceiptStatus" NOT NULL DEFAULT 'STARTED',
  "resultEntityType" TEXT,
  "resultEntityId" TEXT,
  "responseStatus" INTEGER,
  "responseBodyRef" TEXT,
  "importId" UUID,
  "sellerOrderId" UUID,
  "previousRoutePlanId" UUID,
  "nextRoutePlanId" UUID,
  "previousRouteVersionId" UUID,
  "nextRouteVersionId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  "retainedUntil" TIMESTAMPTZ(6),

  CONSTRAINT "dsv_command_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "dsv_audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "shopId" UUID NOT NULL,
  "eventType" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "sellerOrderId" UUID,
  "customerId" UUID,
  "destinationId" UUID,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  "principalType" "DsvPrincipalType" NOT NULL,
  "requestId" TEXT NOT NULL,
  "commandReceiptId" UUID,
  "importId" UUID,
  "previousRoutePlanId" UUID,
  "nextRoutePlanId" UUID,
  "previousRouteVersionId" UUID,
  "nextRouteVersionId" UUID,
  "redactedDiff" JSONB,
  "beforeSnapshotRef" TEXT,
  "afterSnapshotRef" TEXT,
  "reason" TEXT,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retainedUntil" TIMESTAMPTZ(6),
  "redactionClass" "DsvAuditRedactionClass" NOT NULL DEFAULT 'STANDARD',

  CONSTRAINT "dsv_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "customers_id_shopId_key" ON "customers"("id", "shopId");
CREATE UNIQUE INDEX IF NOT EXISTS "customers_shopId_sourceKind_externalCustomerCode_key" ON "customers"("shopId", "sourceKind", "externalCustomerCode");
CREATE INDEX IF NOT EXISTS "customers_shopId_status_idx" ON "customers"("shopId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "customer_accounts_shopId_issuer_subject_key" ON "customer_accounts"("shopId", "issuer", "subject");
CREATE INDEX IF NOT EXISTS "customer_accounts_shopId_customerId_status_idx" ON "customer_accounts"("shopId", "customerId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "delivery_customer_profiles_id_shopId_key" ON "delivery_customer_profiles"("id", "shopId");

CREATE UNIQUE INDEX IF NOT EXISTS "orders_shopId_sellerOrderSourceKind_sellerOrderKey_key" ON "orders"("shopId", "sellerOrderSourceKind", "sellerOrderKey");
CREATE INDEX IF NOT EXISTS "orders_shopId_customerId_deliveryStatus_idx" ON "orders"("shopId", "customerId", "deliveryStatus");
CREATE INDEX IF NOT EXISTS "orders_shopId_destinationId_idx" ON "orders"("shopId", "destinationId");
CREATE INDEX IF NOT EXISTS "orders_shopId_currentRouteVersionId_idx" ON "orders"("shopId", "currentRouteVersionId");

CREATE UNIQUE INDEX IF NOT EXISTS "dsv_transport_conditions_shopId_comparisonKey_key" ON "dsv_transport_conditions"("shopId", "comparisonKey");
CREATE INDEX IF NOT EXISTS "dsv_transport_conditions_shopId_status_updatedAt_idx" ON "dsv_transport_conditions"("shopId", "status", "updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "dsv_command_receipts_shopId_commandName_commandId_key" ON "dsv_command_receipts"("shopId", "commandName", "commandId");
CREATE INDEX IF NOT EXISTS "dsv_command_receipts_shopId_status_createdAt_idx" ON "dsv_command_receipts"("shopId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "dsv_command_receipts_shopId_requestId_idx" ON "dsv_command_receipts"("shopId", "requestId");
CREATE INDEX IF NOT EXISTS "dsv_command_receipts_shopId_sellerOrderId_createdAt_idx" ON "dsv_command_receipts"("shopId", "sellerOrderId", "createdAt");
CREATE INDEX IF NOT EXISTS "dsv_command_receipts_shopId_retainedUntil_idx" ON "dsv_command_receipts"("shopId", "retainedUntil");

CREATE INDEX IF NOT EXISTS "dsv_audit_events_shopId_eventType_occurredAt_idx" ON "dsv_audit_events"("shopId", "eventType", "occurredAt");
CREATE INDEX IF NOT EXISTS "dsv_audit_events_shopId_entityType_entityId_occurredAt_idx" ON "dsv_audit_events"("shopId", "entityType", "entityId", "occurredAt");
CREATE INDEX IF NOT EXISTS "dsv_audit_events_shopId_sellerOrderId_occurredAt_idx" ON "dsv_audit_events"("shopId", "sellerOrderId", "occurredAt");
CREATE INDEX IF NOT EXISTS "dsv_audit_events_shopId_customerId_occurredAt_idx" ON "dsv_audit_events"("shopId", "customerId", "occurredAt");
CREATE INDEX IF NOT EXISTS "dsv_audit_events_shopId_destinationId_occurredAt_idx" ON "dsv_audit_events"("shopId", "destinationId", "occurredAt");
CREATE INDEX IF NOT EXISTS "dsv_audit_events_shopId_commandReceiptId_idx" ON "dsv_audit_events"("shopId", "commandReceiptId");
CREATE INDEX IF NOT EXISTS "dsv_audit_events_shopId_requestId_idx" ON "dsv_audit_events"("shopId", "requestId");
CREATE INDEX IF NOT EXISTS "dsv_audit_events_shopId_retainedUntil_idx" ON "dsv_audit_events"("shopId", "retainedUntil");

DO $$
BEGIN
  ALTER TABLE "customers"
    ADD CONSTRAINT "customers_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "customer_accounts"
    ADD CONSTRAINT "customer_accounts_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "customer_accounts"
    ADD CONSTRAINT "customer_accounts_customerId_shopId_fkey"
    FOREIGN KEY ("customerId", "shopId") REFERENCES "customers"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "orders"
    ADD CONSTRAINT "orders_customerId_shopId_fkey"
    FOREIGN KEY ("customerId", "shopId") REFERENCES "customers"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "orders"
    ADD CONSTRAINT "orders_destinationId_shopId_fkey"
    FOREIGN KEY ("destinationId", "shopId") REFERENCES "delivery_customer_profiles"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "orders"
    ADD CONSTRAINT "orders_currentRouteVersionId_fkey"
    FOREIGN KEY ("currentRouteVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_command_receipts"
    ADD CONSTRAINT "dsv_command_receipts_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_command_receipts"
    ADD CONSTRAINT "dsv_command_receipts_importId_fkey"
    FOREIGN KEY ("importId") REFERENCES "dsv_dispatch_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_command_receipts"
    ADD CONSTRAINT "dsv_command_receipts_sellerOrderId_fkey"
    FOREIGN KEY ("sellerOrderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_command_receipts"
    ADD CONSTRAINT "dsv_command_receipts_previousRoutePlanId_fkey"
    FOREIGN KEY ("previousRoutePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_command_receipts"
    ADD CONSTRAINT "dsv_command_receipts_nextRoutePlanId_fkey"
    FOREIGN KEY ("nextRoutePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_command_receipts"
    ADD CONSTRAINT "dsv_command_receipts_previousRouteVersionId_fkey"
    FOREIGN KEY ("previousRouteVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_command_receipts"
    ADD CONSTRAINT "dsv_command_receipts_nextRouteVersionId_fkey"
    FOREIGN KEY ("nextRouteVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_audit_events"
    ADD CONSTRAINT "dsv_audit_events_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_audit_events"
    ADD CONSTRAINT "dsv_audit_events_sellerOrderId_fkey"
    FOREIGN KEY ("sellerOrderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_audit_events"
    ADD CONSTRAINT "dsv_audit_events_customerId_shopId_fkey"
    FOREIGN KEY ("customerId", "shopId") REFERENCES "customers"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_audit_events"
    ADD CONSTRAINT "dsv_audit_events_destinationId_shopId_fkey"
    FOREIGN KEY ("destinationId", "shopId") REFERENCES "delivery_customer_profiles"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_audit_events"
    ADD CONSTRAINT "dsv_audit_events_commandReceiptId_fkey"
    FOREIGN KEY ("commandReceiptId") REFERENCES "dsv_command_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_audit_events"
    ADD CONSTRAINT "dsv_audit_events_importId_fkey"
    FOREIGN KEY ("importId") REFERENCES "dsv_dispatch_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_audit_events"
    ADD CONSTRAINT "dsv_audit_events_previousRoutePlanId_fkey"
    FOREIGN KEY ("previousRoutePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_audit_events"
    ADD CONSTRAINT "dsv_audit_events_nextRoutePlanId_fkey"
    FOREIGN KEY ("nextRoutePlanId") REFERENCES "route_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_audit_events"
    ADD CONSTRAINT "dsv_audit_events_previousRouteVersionId_fkey"
    FOREIGN KEY ("previousRouteVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "dsv_audit_events"
    ADD CONSTRAINT "dsv_audit_events_nextRouteVersionId_fkey"
    FOREIGN KEY ("nextRouteVersionId") REFERENCES "route_grouping_child_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
