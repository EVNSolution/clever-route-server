-- IANA timezone of the tenant's center (departure) location. Computed from the center coordinates
-- when the settings are saved, so no reader has to guess a route's timezone.
ALTER TABLE "shops" ADD COLUMN "defaultDepotTimezone" TEXT;
