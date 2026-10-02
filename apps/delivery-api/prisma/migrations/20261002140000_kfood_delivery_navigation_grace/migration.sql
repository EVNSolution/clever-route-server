-- Delivery work ends before the existing mobile return-navigation session.
-- No historical route is marked completed by this additive migration.
ALTER TABLE "route_plans"
  ADD COLUMN "deliveryWorkCompletedAt" TIMESTAMPTZ(6),
  ADD COLUMN "driverNavigationUntil" TIMESTAMPTZ(6),
  ADD COLUMN "deliveryWorkCompletedGeneration" BIGINT,
  ADD COLUMN "deliveryWorkCompletedVersionId" UUID;
