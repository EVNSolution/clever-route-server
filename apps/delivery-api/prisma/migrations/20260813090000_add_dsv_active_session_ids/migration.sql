ALTER TABLE "customer_accounts"
ADD COLUMN "activeSessionId" UUID;

ALTER TABLE "dsv_admin_accounts"
ADD COLUMN "activeSessionId" UUID;
