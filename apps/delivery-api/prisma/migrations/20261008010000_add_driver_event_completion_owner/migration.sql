ALTER TABLE "driver_events"
ADD COLUMN "completionOwnerAccountId" UUID;

CREATE INDEX "driver_events_completion_owner_route_client_idx"
ON "driver_events"("completionOwnerAccountId", "routePlanId", "clientEventId");
