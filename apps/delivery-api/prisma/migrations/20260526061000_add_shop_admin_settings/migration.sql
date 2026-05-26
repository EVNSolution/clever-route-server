-- Add server-admin defaults used by the WooCommerce route workspace.

ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "defaultDepotAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "defaultDepotLatitude" DECIMAL(10, 7),
  ADD COLUMN IF NOT EXISTS "defaultDepotLongitude" DECIMAL(10, 7),
  ADD COLUMN IF NOT EXISTS "locale" TEXT;
