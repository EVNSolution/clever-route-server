ALTER TABLE "delivery_customer_profiles"
  ADD COLUMN "driverOpenTime" VARCHAR(5),
  ADD COLUMN "driverOpenTimeUpdatedAt" TIMESTAMPTZ(6);
