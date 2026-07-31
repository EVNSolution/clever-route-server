BEGIN;

ALTER TYPE "DriverRouteNotificationAction" ADD VALUE 'CANCELLED';
ALTER TYPE "DriverRouteNotificationAction" ADD VALUE 'RELEASED';

ALTER TABLE "driver_push_tokens" ADD COLUMN "accountId" UUID;

UPDATE "driver_push_tokens" AS token
SET "accountId" = driver."accountId"
FROM "drivers" AS driver
WHERE driver."id" = token."driverId";

DELETE FROM "driver_push_tokens"
WHERE "accountId" IS NULL;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "tokenHash"
      ORDER BY "lastSeenAt" DESC, "updatedAt" DESC, "id" DESC
    ) AS token_rank
  FROM "driver_push_tokens"
)
DELETE FROM "driver_push_tokens" AS token
USING ranked
WHERE token."id" = ranked."id"
  AND ranked.token_rank > 1;

DROP INDEX "driver_push_tokens_driverId_tokenHash_key";
DROP INDEX "driver_push_tokens_shopId_driverId_status_idx";

ALTER TABLE "driver_push_tokens"
  DROP CONSTRAINT "driver_push_tokens_shopId_fkey",
  DROP CONSTRAINT "driver_push_tokens_driverId_fkey",
  ALTER COLUMN "accountId" SET NOT NULL,
  DROP COLUMN "shopId",
  DROP COLUMN "driverId";

CREATE UNIQUE INDEX "driver_push_tokens_tokenHash_key"
  ON "driver_push_tokens"("tokenHash");
CREATE INDEX "driver_push_tokens_accountId_status_idx"
  ON "driver_push_tokens"("accountId", "status");

ALTER TABLE "driver_push_tokens"
  ADD CONSTRAINT "driver_push_tokens_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "driver_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
