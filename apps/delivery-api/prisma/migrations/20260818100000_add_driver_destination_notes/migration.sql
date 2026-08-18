ALTER TABLE "delivery_customer_profiles"
  ADD COLUMN "driverMemo" TEXT,
  ADD COLUMN "driverMemoUpdatedAt" TIMESTAMPTZ(6),
  ADD COLUMN "driverLunchTimeRange" VARCHAR(11),
  ADD COLUMN "driverLunchTimeRangeUpdatedAt" TIMESTAMPTZ(6),
  ADD COLUMN "driverLunchEntryStatus" VARCHAR(16),
  ADD COLUMN "driverLunchEntryStatusUpdatedAt" TIMESTAMPTZ(6),
  ADD COLUMN "driverRequiredArrivalTime" VARCHAR(5),
  ADD COLUMN "driverRequiredArrivalTimeUpdatedAt" TIMESTAMPTZ(6);

ALTER TABLE "delivery_customer_profiles"
  ADD CONSTRAINT "delivery_customer_profiles_driverLunchEntryStatus_check"
  CHECK ("driverLunchEntryStatus" IS NULL OR "driverLunchEntryStatus" IN ('AVAILABLE', 'UNAVAILABLE'));
