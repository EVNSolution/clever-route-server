CREATE TABLE "dsv_driver_inquiries" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "clientRequestId" UUID NOT NULL,
  "authorName" VARCHAR(80) NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "body" VARCHAR(4000) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dsv_driver_inquiries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dsv_driver_inquiries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "driver_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "dsv_driver_inquiries_accountId_clientRequestId_key" ON "dsv_driver_inquiries"("accountId", "clientRequestId");
CREATE INDEX "dsv_driver_inquiries_accountId_createdAt_id_idx" ON "dsv_driver_inquiries"("accountId", "createdAt", "id");
