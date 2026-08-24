-- CC-265 G003 additive operational health, alert lifecycle, and email-attempt evidence.
CREATE TABLE "driver_sync_sessions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "shopId" UUID NOT NULL, "routePlanId" UUID NOT NULL,
  "driverId" UUID NOT NULL, "deviceInstanceHash" TEXT NOT NULL, "sessionGeneration" TEXT NOT NULL,
  "driverContractVersion" INTEGER NOT NULL, "appVersion" TEXT NOT NULL, "versionCode" INTEGER NOT NULL,
  "firstObservedAt" TIMESTAMPTZ(6) NOT NULL, "lastObservedAt" TIMESTAMPTZ(6) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL, "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "driver_sync_sessions_shop_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE,
  CONSTRAINT "driver_sync_sessions_route_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE,
  CONSTRAINT "driver_sync_sessions_driver_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE,
  CONSTRAINT "driver_sync_sessions_generation_check" CHECK ("sessionGeneration" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'),
  CONSTRAINT "driver_sync_sessions_version_check" CHECK ("driverContractVersion" >= 1 AND "versionCode" >= 1),
  UNIQUE ("routePlanId", "driverId", "deviceInstanceHash", "sessionGeneration")
);
CREATE INDEX "driver_sync_sessions_route_driver_expires_idx" ON "driver_sync_sessions"("routePlanId", "driverId", "expiresAt");
CREATE INDEX "driver_sync_sessions_last_observed_idx" ON "driver_sync_sessions"("lastObservedAt");

CREATE TABLE "driver_sync_heartbeats" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "syncSessionId" UUID NOT NULL,
  "heartbeatSequence" INTEGER NOT NULL, "state" TEXT NOT NULL,
  "clientOccurredAt" TIMESTAMPTZ(6) NOT NULL, "serverReceivedAt" TIMESTAMPTZ(6) NOT NULL,
  "queueDepth" INTEGER, "oldestQueuedAt" TIMESTAMPTZ(6), "lastAcknowledgedAt" TIMESTAMPTZ(6),
  "firstFailedAt" TIMESTAMPTZ(6), "firstErrorCode" TEXT, "lastErrorCode" TEXT,
  "lastRetryAt" TIMESTAMPTZ(6), "nextRetryAt" TIMESTAMPTZ(6), "retryCount" INTEGER NOT NULL DEFAULT 0,
  "finishPending" BOOLEAN NOT NULL DEFAULT false, "completedStopCount" INTEGER,
  "currentStopSequence" INTEGER, "totalStopCount" INTEGER, "locallyFinished" BOOLEAN,
  "retryJournal" JSONB, "retainedUntil" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "driver_sync_heartbeats_session_fkey" FOREIGN KEY ("syncSessionId") REFERENCES "driver_sync_sessions"("id") ON DELETE CASCADE,
  CONSTRAINT "driver_sync_heartbeats_state_check" CHECK ("state" IN ('HEALTHY','DELAYED','BLOCKED','UNKNOWN')),
  CONSTRAINT "driver_sync_heartbeats_values_check" CHECK ("heartbeatSequence" >= 1 AND "retryCount" >= 0 AND ("queueDepth" IS NULL OR "queueDepth" >= 0)),
  UNIQUE ("syncSessionId", "heartbeatSequence")
);
CREATE INDEX "driver_sync_heartbeats_session_received_idx" ON "driver_sync_heartbeats"("syncSessionId", "serverReceivedAt");
CREATE INDEX "driver_sync_heartbeats_retention_idx" ON "driver_sync_heartbeats"("retainedUntil");

CREATE TABLE "driver_route_session_leases" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "shopId" UUID NOT NULL, "routePlanId" UUID NOT NULL,
  "driverId" UUID NOT NULL, "syncSessionId" UUID NOT NULL, "deviceInstanceHash" TEXT NOT NULL,
  "sessionGeneration" TEXT NOT NULL, "issuedAt" TIMESTAMPTZ(6) NOT NULL, "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6), "takeoverFromHash" TEXT, "takeoverActorId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "driver_route_session_leases_shop_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE,
  CONSTRAINT "driver_route_session_leases_route_fkey" FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id") ON DELETE CASCADE,
  CONSTRAINT "driver_route_session_leases_driver_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE,
  CONSTRAINT "driver_route_session_leases_session_fkey" FOREIGN KEY ("syncSessionId") REFERENCES "driver_sync_sessions"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "driver_route_session_leases_one_active_idx" ON "driver_route_session_leases"("routePlanId", "driverId") WHERE "revokedAt" IS NULL;
CREATE INDEX "driver_route_session_leases_session_idx" ON "driver_route_session_leases"("syncSessionId");

CREATE TABLE "alert_conditions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "shopId" UUID NOT NULL, "dedupeKey" TEXT NOT NULL,
  "type" TEXT NOT NULL, "routePlanId" UUID, "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "alert_conditions_shop_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE,
  UNIQUE ("shopId", "dedupeKey")
);
CREATE INDEX "alert_conditions_shop_type_idx" ON "alert_conditions"("shopId", "type", "updatedAt");

CREATE TABLE "alert_cycles" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "conditionId" UUID NOT NULL, "legacyNotificationId" UUID,
  "severity" TEXT NOT NULL, "payload" JSONB, "openedAt" TIMESTAMPTZ(6) NOT NULL,
  "lastObservedAt" TIMESTAMPTZ(6) NOT NULL, "readAt" TIMESTAMPTZ(6), "acknowledgedAt" TIMESTAMPTZ(6),
  "acknowledgedBy" TEXT, "resolvedAt" TIMESTAMPTZ(6), "resolutionCode" TEXT,
  "compatibilityMetadata" JSONB, "retainedUntil" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "alert_cycles_condition_fkey" FOREIGN KEY ("conditionId") REFERENCES "alert_conditions"("id") ON DELETE CASCADE,
  CONSTRAINT "alert_cycles_legacy_fkey" FOREIGN KEY ("legacyNotificationId") REFERENCES "admin_notifications"("id") ON DELETE SET NULL,
  CONSTRAINT "alert_cycles_severity_check" CHECK ("severity" IN ('WARNING','CRITICAL')),
  CONSTRAINT "alert_cycles_resolution_check" CHECK (("resolvedAt" IS NULL AND "resolutionCode" IS NULL) OR ("resolvedAt" IS NOT NULL AND "resolutionCode" IS NOT NULL))
);
CREATE UNIQUE INDEX "alert_cycles_one_unresolved_idx" ON "alert_cycles"("conditionId") WHERE "resolvedAt" IS NULL;
CREATE INDEX "alert_cycles_condition_opened_idx" ON "alert_cycles"("conditionId", "openedAt");
CREATE INDEX "alert_cycles_legacy_idx" ON "alert_cycles"("legacyNotificationId");
CREATE INDEX "alert_cycles_retention_idx" ON "alert_cycles"("resolvedAt", "retainedUntil");

-- Idempotent compatibility backfill. Existing legacy rows remain the public projection.
INSERT INTO "alert_conditions" ("shopId", "dedupeKey", "type", "routePlanId", "createdAt", "updatedAt")
SELECT "shopId", "dedupeKey", "type", "routePlanId", "createdAt", "updatedAt" FROM "admin_notifications"
ON CONFLICT ("shopId", "dedupeKey") DO NOTHING;
INSERT INTO "alert_cycles" ("conditionId", "legacyNotificationId", "severity", "payload", "openedAt", "lastObservedAt", "readAt", "compatibilityMetadata", "retainedUntil", "createdAt", "updatedAt")
SELECT condition."id", notification."id",
  CASE WHEN notification."severity" = 'critical' THEN 'CRITICAL' ELSE 'WARNING' END,
  notification."payload", notification."createdAt", notification."updatedAt", notification."readAt",
  jsonb_build_object('source', 'ADMIN_NOTIFICATION_BACKFILL', 'legacyNotificationId', notification."id"),
  notification."createdAt" + INTERVAL '365 days', notification."createdAt", notification."updatedAt"
FROM "admin_notifications" notification
JOIN "alert_conditions" condition ON condition."shopId" = notification."shopId" AND condition."dedupeKey" = notification."dedupeKey"
WHERE NOT EXISTS (
  SELECT 1 FROM "alert_cycles" existing WHERE existing."legacyNotificationId" = notification."id"
);

CREATE TABLE "customer_delivery_notification_attempts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "shopId" UUID NOT NULL, "factId" UUID,
  "manualDispatchRecipientId" UUID, "attemptNumber" INTEGER NOT NULL, "startedAt" TIMESTAMPTZ(6) NOT NULL,
  "completedAt" TIMESTAMPTZ(6), "provider" TEXT NOT NULL, "outcome" TEXT NOT NULL,
  "errorCode" TEXT, "correlationId" TEXT NOT NULL, "providerMessageId" TEXT,
  "retainedUntil" TIMESTAMPTZ(6) NOT NULL, "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "customer_delivery_notification_attempts_shop_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE,
  CONSTRAINT "customer_delivery_notification_attempts_fact_fkey" FOREIGN KEY ("factId") REFERENCES "customer_route_notification_facts"("id") ON DELETE CASCADE,
  CONSTRAINT "customer_delivery_notification_attempts_manual_fkey" FOREIGN KEY ("manualDispatchRecipientId") REFERENCES "customer_email_manual_dispatch_recipients"("id") ON DELETE CASCADE,
  CONSTRAINT "customer_delivery_notification_attempts_parent_check" CHECK (num_nonnulls("factId", "manualDispatchRecipientId") = 1),
  CONSTRAINT "customer_delivery_notification_attempts_number_check" CHECK ("attemptNumber" >= 1),
  CONSTRAINT "customer_delivery_notification_attempts_outcome_check" CHECK ("outcome" IN ('STARTED','SENT','RETRYABLE_FAILURE','TERMINAL_FAILURE'))
);
CREATE UNIQUE INDEX "customer_delivery_notification_attempts_fact_number_idx" ON "customer_delivery_notification_attempts"("factId", "attemptNumber") WHERE "factId" IS NOT NULL;
CREATE UNIQUE INDEX "customer_delivery_notification_attempts_manual_number_idx" ON "customer_delivery_notification_attempts"("manualDispatchRecipientId", "attemptNumber") WHERE "manualDispatchRecipientId" IS NOT NULL;
CREATE INDEX "customer_delivery_notification_attempts_shop_created_idx" ON "customer_delivery_notification_attempts"("shopId", "createdAt");
CREATE INDEX "customer_delivery_notification_attempts_retention_idx" ON "customer_delivery_notification_attempts"("retainedUntil");
