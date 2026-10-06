-- CreateTable
CREATE TABLE "dsv_execution_contexts" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "serviceDate" DATE NOT NULL,
    "routePlanId" UUID NOT NULL,
    "routeVersion" INTEGER NOT NULL DEFAULT 1,
    "assignmentEpoch" BIGINT NOT NULL DEFAULT 1,
    "driverId" UUID,
    "recipientAccountId" UUID,
    "vehicleId" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "contentFingerprint" TEXT NOT NULL,
    "contentSnapshot" JSONB NOT NULL,
    "effectiveAt" TIMESTAMPTZ(6) NOT NULL,
    "startedAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "monitorStartAt" TIMESTAMPTZ(6),
    "monitorEndAt" TIMESTAMPTZ(6),
    "notificationMode" TEXT NOT NULL DEFAULT 'OFF',
    "liveEligibleAt" TIMESTAMPTZ(6),
    "policy" JSONB,
    "warehouseNotifiedAt" TIMESTAMPTZ(6),
    "departureObservedAt" TIMESTAMPTZ(6),
    "reminderDueAt" TIMESTAMPTZ(6),
    "reminderOrdinal" INTEGER NOT NULL DEFAULT 0,
    "reminderIncidentId" UUID,
    "reminderStatus" TEXT NOT NULL DEFAULT 'AWAITING_DEPARTURE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_execution_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_execution_route_mappings" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "executionContextId" UUID NOT NULL,
    "routePlanId" UUID NOT NULL,
    "validFrom" TIMESTAMPTZ(6) NOT NULL,
    "validUntil" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsv_execution_route_mappings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "dsv_execution_route_mappings"
  ADD CONSTRAINT "dsv_execution_route_mappings_valid_interval"
  CHECK ("validUntil" IS NULL OR "validUntil" >= "validFrom");

-- CreateTable
CREATE TABLE "dsv_execution_selections" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "executionContextId" UUID NOT NULL,
    "validFrom" TIMESTAMPTZ(6) NOT NULL,
    "validUntil" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_execution_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_execution_commands" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "commandName" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsv_execution_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_operational_notifications" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "executionContextId" UUID NOT NULL,
    "routeVersion" INTEGER NOT NULL,
    "assignmentEpoch" BIGINT NOT NULL,
    "recipientAccountId" UUID,
    "audience" TEXT NOT NULL DEFAULT 'DRIVER',
    "kind" TEXT NOT NULL,
    "logicalKey" TEXT NOT NULL,
    "targetStopId" UUID,
    "eventId" UUID,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "businessStatus" TEXT NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolutionReason" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsv_operational_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_operational_notification_acks" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "ackKind" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsv_operational_notification_acks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_notification_capabilities" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "tokenId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenUpdatedAt" TIMESTAMPTZ(6) NOT NULL,
    "installationId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "kinds" TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsv_notification_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_operational_notification_attempts" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "tokenId" UUID NOT NULL,
    "capabilityId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsv_operational_notification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_geofence_jobs" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "sampleId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "resultReason" TEXT,
    "processedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsv_geofence_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_geofence_states" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "executionContextId" UUID NOT NULL,
    "assignmentEpoch" BIGINT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dsv_geofence_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsv_delivery_exceptions" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "executionContextId" UUID NOT NULL,
    "routeVersion" INTEGER NOT NULL,
    "assignmentEpoch" BIGINT NOT NULL,
    "driverId" UUID NOT NULL,
    "recipientAccountId" UUID NOT NULL,
    "targetStopId" UUID NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "explanation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMPTZ(6),
    "resolvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "dsv_delivery_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dsv_execution_contexts_shopId_vehicleId_status_idx" ON "dsv_execution_contexts"("shopId", "vehicleId", "status");

-- CreateIndex
CREATE INDEX "dsv_execution_contexts_shopId_routePlanId_status_idx" ON "dsv_execution_contexts"("shopId", "routePlanId", "status");

-- CreateIndex
CREATE INDEX "dsv_execution_contexts_reminderStatus_reminderDueAt_idx" ON "dsv_execution_contexts"("reminderStatus", "reminderDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_execution_contexts_id_shopId_key" ON "dsv_execution_contexts"("id", "shopId");

-- CreateIndex
CREATE INDEX "dsv_execution_route_mappings_shopId_routePlanId_validUntil_idx" ON "dsv_execution_route_mappings"("shopId", "routePlanId", "validUntil");

-- CreateIndex
CREATE INDEX "dsv_execution_selections_shopId_vehicleId_validFrom_validUntil_idx" ON "dsv_execution_selections"("shopId", "vehicleId", "validFrom", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_execution_commands_shopId_commandName_commandId_key" ON "dsv_execution_commands"("shopId", "commandName", "commandId");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_operational_notifications_logicalKey_key" ON "dsv_operational_notifications"("logicalKey");

-- CreateIndex
CREATE INDEX "dsv_operational_notifications_shopId_recipientAccountId_cre_idx" ON "dsv_operational_notifications"("shopId", "recipientAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "dsv_operational_notifications_shopId_executionContextId_bus_idx" ON "dsv_operational_notifications"("shopId", "executionContextId", "businessStatus");

-- CreateIndex
CREATE INDEX "dsv_operational_notifications_stop_status_idx" ON "dsv_operational_notifications"("shopId", "targetStopId", "kind", "businessStatus");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_operational_notifications_id_shopId_key" ON "dsv_operational_notifications"("id", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_operational_notification_acks_notificationId_accountId__key" ON "dsv_operational_notification_acks"("notificationId", "accountId", "ackKind");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_notification_capabilities_tokenId_key" ON "dsv_notification_capabilities"("tokenId");

-- CreateIndex
CREATE INDEX "dsv_operational_notification_attempts_status_nextAttemptAt__idx" ON "dsv_operational_notification_attempts"("status", "nextAttemptAt", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_operational_notification_attempts_notificationId_tokenI_key" ON "dsv_operational_notification_attempts"("notificationId", "tokenId", "capabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_geofence_jobs_sampleId_key" ON "dsv_geofence_jobs"("sampleId");

-- CreateIndex
CREATE INDEX "dsv_geofence_jobs_status_nextAttemptAt_leaseExpiresAt_idx" ON "dsv_geofence_jobs"("status", "nextAttemptAt", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "dsv_geofence_states_executionContextId_assignmentEpoch_targ_key" ON "dsv_geofence_states"("executionContextId", "assignmentEpoch", "targetKey");

-- CreateIndex
CREATE INDEX "dsv_delivery_exceptions_shopId_status_createdAt_idx" ON "dsv_delivery_exceptions"("shopId", "status", "createdAt");

-- Tenant boundaries remain database constraints, not application conventions.
ALTER TABLE dsv_execution_contexts ADD CONSTRAINT dsv_execution_shop_fk FOREIGN KEY ("shopId") REFERENCES shops(id) ON DELETE CASCADE;
ALTER TABLE dsv_execution_contexts ADD CONSTRAINT dsv_execution_revision_check CHECK ("routeVersion" > 0 AND "assignmentEpoch" > 0 AND "reminderOrdinal" >= 0);
CREATE UNIQUE INDEX dsv_execution_active_route_key ON dsv_execution_contexts ("shopId", "routePlanId") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX dsv_execution_current_mapping_key ON dsv_execution_route_mappings ("shopId", "routePlanId") WHERE "validUntil" IS NULL;
ALTER TABLE dsv_execution_route_mappings ADD CONSTRAINT dsv_mapping_context_fk FOREIGN KEY ("executionContextId", "shopId") REFERENCES dsv_execution_contexts(id,"shopId") ON DELETE CASCADE;
ALTER TABLE dsv_execution_selections ADD CONSTRAINT dsv_selection_context_fk FOREIGN KEY ("executionContextId", "shopId") REFERENCES dsv_execution_contexts(id,"shopId") ON DELETE CASCADE;
ALTER TABLE dsv_execution_selections ADD CONSTRAINT dsv_selection_interval_check CHECK ("validUntil" > "validFrom");
ALTER TABLE dsv_execution_commands ADD CONSTRAINT dsv_command_shop_fk FOREIGN KEY ("shopId") REFERENCES shops(id) ON DELETE CASCADE;
ALTER TABLE dsv_operational_notifications ADD CONSTRAINT dsv_notification_context_fk FOREIGN KEY ("executionContextId", "shopId") REFERENCES dsv_execution_contexts(id,"shopId") ON DELETE CASCADE;
ALTER TABLE dsv_operational_notification_acks ADD CONSTRAINT dsv_ack_notification_fk FOREIGN KEY ("notificationId", "shopId") REFERENCES dsv_operational_notifications(id,"shopId") ON DELETE CASCADE;
ALTER TABLE dsv_notification_capabilities ADD CONSTRAINT dsv_capability_shop_fk FOREIGN KEY ("shopId") REFERENCES shops(id) ON DELETE CASCADE;
ALTER TABLE dsv_notification_capabilities ADD CONSTRAINT dsv_capability_token_fk FOREIGN KEY ("tokenId") REFERENCES driver_push_tokens(id) ON DELETE CASCADE;
ALTER TABLE dsv_operational_notification_attempts ADD CONSTRAINT dsv_attempt_notification_fk FOREIGN KEY ("notificationId", "shopId") REFERENCES dsv_operational_notifications(id,"shopId") ON DELETE CASCADE;
ALTER TABLE dsv_operational_notification_attempts ADD CONSTRAINT dsv_attempt_capability_fk FOREIGN KEY ("capabilityId") REFERENCES dsv_notification_capabilities(id) ON DELETE CASCADE;
ALTER TABLE dsv_geofence_jobs ADD CONSTRAINT dsv_geofence_shop_fk FOREIGN KEY ("shopId") REFERENCES shops(id) ON DELETE CASCADE;
ALTER TABLE dsv_geofence_jobs ADD CONSTRAINT dsv_geofence_sample_fk FOREIGN KEY ("sampleId") REFERENCES uvis_vehicle_telemetry_samples(id) ON DELETE CASCADE;
ALTER TABLE dsv_geofence_states ADD CONSTRAINT dsv_geofence_context_fk FOREIGN KEY ("executionContextId", "shopId") REFERENCES dsv_execution_contexts(id,"shopId") ON DELETE CASCADE;
ALTER TABLE dsv_delivery_exceptions ADD CONSTRAINT dsv_exception_context_fk FOREIGN KEY ("executionContextId", "shopId") REFERENCES dsv_execution_contexts(id,"shopId") ON DELETE CASCADE;

-- Preserve selector history. Overlapping vehicle attribution windows are forbidden.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "dsv_execution_selections" ADD CONSTRAINT "dsv_execution_selection_no_overlap"
  EXCLUDE USING gist ("shopId" WITH =, "vehicleId" WITH =, tstzrange("validFrom", "validUntil", '[)') WITH &&);

-- Immutable derived verdict evidence refers to original UVIS samples without copying raw GPS.
CREATE TABLE "dsv_geofence_events" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "executionContextId" UUID NOT NULL,
  "routeVersion" INTEGER NOT NULL,
  "assignmentEpoch" BIGINT NOT NULL,
  "targetKey" TEXT NOT NULL,
  "transition" TEXT NOT NULL,
  "visitOrdinal" INTEGER NOT NULL,
  "sourceSampleId" UUID NOT NULL,
  "firstObservedAt" TIMESTAMPTZ(6) NOT NULL,
  "confirmedObservedAt" TIMESTAMPTZ(6) NOT NULL,
  "confirmedAt" TIMESTAMPTZ(6) NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "logicalKey" TEXT NOT NULL,
  CONSTRAINT "dsv_geofence_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dsv_geofence_events_context_tenant_fk" FOREIGN KEY ("executionContextId", "shopId") REFERENCES "dsv_execution_contexts"("id", "shopId") ON DELETE CASCADE,
  CONSTRAINT "dsv_geofence_events_transition_check" CHECK ("transition" IN ('ARRIVED', 'DEPARTED')),
  CONSTRAINT "dsv_geofence_events_time_check" CHECK ("firstObservedAt" <= "confirmedObservedAt" AND "confirmedObservedAt" <= "confirmedAt")
);
CREATE UNIQUE INDEX "dsv_geofence_events_logicalKey_key" ON "dsv_geofence_events"("logicalKey");
CREATE INDEX "dsv_geofence_events_context_observed_idx" ON "dsv_geofence_events"("shopId", "executionContextId", "confirmedObservedAt");
