-- Append-only history of driver destination notes. The current values stay on delivery_customer_profiles.
CREATE TABLE "destination_note_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "field" VARCHAR(32) NOT NULL,
    "value" TEXT,
    "source" VARCHAR(16) NOT NULL,
    "driverId" UUID,
    "routePlanId" UUID,
    "changedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "destination_note_revisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "destination_note_revisions_shopId_destinationId_changedAt_idx" ON "destination_note_revisions"("shopId", "destinationId", "changedAt");
CREATE INDEX "destination_note_revisions_shopId_routePlanId_idx" ON "destination_note_revisions"("shopId", "routePlanId");

ALTER TABLE "destination_note_revisions" ADD CONSTRAINT "destination_note_revisions_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "destination_note_revisions" ADD CONSTRAINT "destination_note_revisions_destinationId_shopId_fkey" FOREIGN KEY ("destinationId", "shopId") REFERENCES "delivery_customer_profiles"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- The values already saved become LEGACY revisions at the time they were last changed.
INSERT INTO "destination_note_revisions" ("shopId", "destinationId", "field", "value", "source", "changedAt")
SELECT "shopId", "id", 'memo', "driverMemo", 'LEGACY', "driverMemoUpdatedAt" FROM "delivery_customer_profiles" WHERE "driverMemoUpdatedAt" IS NOT NULL
UNION ALL
SELECT "shopId", "id", 'openTime', "driverOpenTime", 'LEGACY', "driverOpenTimeUpdatedAt" FROM "delivery_customer_profiles" WHERE "driverOpenTimeUpdatedAt" IS NOT NULL
UNION ALL
SELECT "shopId", "id", 'lunchTimeRange', "driverLunchTimeRange", 'LEGACY', "driverLunchTimeRangeUpdatedAt" FROM "delivery_customer_profiles" WHERE "driverLunchTimeRangeUpdatedAt" IS NOT NULL
UNION ALL
SELECT "shopId", "id", 'lunchEntryStatus', "driverLunchEntryStatus", 'LEGACY', "driverLunchEntryStatusUpdatedAt" FROM "delivery_customer_profiles" WHERE "driverLunchEntryStatusUpdatedAt" IS NOT NULL
UNION ALL
SELECT "shopId", "id", 'requiredArrivalTime', "driverRequiredArrivalTime", 'LEGACY', "driverRequiredArrivalTimeUpdatedAt" FROM "delivery_customer_profiles" WHERE "driverRequiredArrivalTimeUpdatedAt" IS NOT NULL;
