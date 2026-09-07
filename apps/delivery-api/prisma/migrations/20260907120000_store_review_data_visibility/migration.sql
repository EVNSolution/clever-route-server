ALTER TABLE "orders" ADD COLUMN "isStoreReviewData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN "isStoreReviewData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "delivery_customer_profiles" ADD COLUMN "isStoreReviewData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "route_plans" ADD COLUMN "isStoreReviewData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "drivers" ADD COLUMN "isStoreReviewData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "driver_accounts" ADD COLUMN "isStoreReviewAccount" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "dsv_dispatch_imports" ADD COLUMN "isStoreReviewData" BOOLEAN NOT NULL DEFAULT false;
