-- Additive opt-in contract. Existing routes and legacy child versions are unchanged.
CREATE TABLE "route_live_change_states" (
  "routePlanId" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "assignmentGeneration" BIGINT NOT NULL,
  "driverId" UUID NOT NULL,
  "baselineRouteVersionId" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "draftSnapshot" JSONB NOT NULL,
  "draftHash" TEXT NOT NULL,
  "latestPublicationId" UUID NOT NULL,
  "latestSequence" INTEGER NOT NULL DEFAULT 0,
  "appliedPublicationId" UUID,
  "appliedSequence" INTEGER NOT NULL DEFAULT 0,
  "appliedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "route_live_change_states_pkey" PRIMARY KEY ("routePlanId"),
  CONSTRAINT "route_live_change_states_routePlanId_shopId_fkey"
    FOREIGN KEY ("routePlanId", "shopId") REFERENCES "route_plans"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "route_live_change_states_revision_check" CHECK ("revision" >= 0 AND "latestSequence" >= 0 AND "appliedSequence" BETWEEN 0 AND "latestSequence" AND "assignmentGeneration" > 0)
);
CREATE UNIQUE INDEX "route_live_change_states_routePlanId_shopId_key" ON "route_live_change_states"("routePlanId", "shopId");
CREATE INDEX "route_live_change_states_shopId_driverId_idx" ON "route_live_change_states"("shopId", "driverId");

CREATE TABLE "route_live_change_publications" (
  "id" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "assignmentGeneration" BIGINT NOT NULL,
  "driverId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "contentHash" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "publishedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notificationStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMPTZ(6),
  "providerId" TEXT,
  "errorCode" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMPTZ(6),
  CONSTRAINT "route_live_change_publications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "route_live_change_publications_routePlanId_shopId_fkey"
    FOREIGN KEY ("routePlanId", "shopId") REFERENCES "route_plans"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "route_live_change_publications_sequence_check" CHECK ("sequence" >= 0 AND "assignmentGeneration" > 0 AND "attemptCount" >= 0),
  CONSTRAINT "route_live_change_publications_notification_check" CHECK ("notificationStatus" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'))
);
CREATE UNIQUE INDEX "route_live_change_publications_identity_key" ON "route_live_change_publications"("routePlanId", "shopId", "assignmentGeneration", "driverId", "sequence");
CREATE INDEX "route_live_change_publications_shopId_routePlanId_published_idx" ON "route_live_change_publications"("shopId", "routePlanId", "publishedAt");
CREATE INDEX "route_live_change_publications_notificationStatus_nextAttem_idx" ON "route_live_change_publications"("notificationStatus", "nextAttemptAt");

CREATE FUNCTION "protect_route_live_change_publication"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."routePlanId", NEW."shopId", NEW."assignmentGeneration", NEW."driverId", NEW."sequence", NEW."contentHash", NEW."snapshot", NEW."publishedAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."routePlanId", OLD."shopId", OLD."assignmentGeneration", OLD."driverId", OLD."sequence", OLD."contentHash", OLD."snapshot", OLD."publishedAt") THEN
    RAISE EXCEPTION 'Live route publication content is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "route_live_change_publication_immutable" BEFORE UPDATE ON "route_live_change_publications"
  FOR EACH ROW EXECUTE FUNCTION "protect_route_live_change_publication"();

CREATE TABLE "route_live_change_command_receipts" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "routePlanId" UUID NOT NULL,
  "assignmentGeneration" BIGINT NOT NULL,
  "driverId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "commandId" UUID NOT NULL,
  "requestHash" TEXT NOT NULL,
  "response" JSONB NOT NULL,
  "publicationId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "route_live_change_command_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "route_live_change_command_receipts_routePlanId_shopId_fkey"
    FOREIGN KEY ("routePlanId", "shopId") REFERENCES "route_plans"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "route_live_change_command_receipts_kind_check" CHECK ("kind" IN ('SAVE', 'DISPATCH') AND "assignmentGeneration" > 0)
);
CREATE UNIQUE INDEX "route_live_change_command_receipts_identity_key" ON "route_live_change_command_receipts"("shopId", "routePlanId", "assignmentGeneration", "driverId", "kind", "commandId");
CREATE INDEX "route_live_change_command_receipts_shopId_routePlanId_kind__idx" ON "route_live_change_command_receipts"("shopId", "routePlanId", "kind", "commandId");

CREATE FUNCTION "protect_route_live_change_command_receipt"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Live route command receipt is immutable';
END;
$$;
CREATE TRIGGER "route_live_change_command_receipt_immutable" BEFORE UPDATE ON "route_live_change_command_receipts"
  FOR EACH ROW EXECUTE FUNCTION "protect_route_live_change_command_receipt"();
