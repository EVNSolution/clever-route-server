ALTER TABLE "route_groupings"
  ADD COLUMN "dateRangeStart" DATE,
  ADD COLUMN "dateRangeEnd" DATE;

UPDATE "route_groupings"
SET "dateRangeStart" = "planDate",
    "dateRangeEnd" = "planDate"
WHERE "dateRangeStart" IS NULL
   OR "dateRangeEnd" IS NULL;

CREATE INDEX "route_groupings_shopId_dateRangeStart_dateRangeEnd_status_idx"
  ON "route_groupings"("shopId", "dateRangeStart", "dateRangeEnd", "status");
