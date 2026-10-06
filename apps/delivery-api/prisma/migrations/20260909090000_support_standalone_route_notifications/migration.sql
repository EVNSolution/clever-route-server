ALTER TABLE "driver_route_notification_attempts"
  ALTER COLUMN "groupingId" DROP NOT NULL,
  ALTER COLUMN "groupingVersion" DROP NOT NULL,
  ALTER COLUMN "childVersionId" DROP NOT NULL;
