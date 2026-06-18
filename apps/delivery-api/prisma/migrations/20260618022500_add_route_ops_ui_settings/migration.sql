-- Add phase-1 Route Ops UI settings without changing routeScopeConfig compatibility.
ALTER TABLE "Shop"
  ADD COLUMN IF NOT EXISTS "routeOpsUiSettings" JSONB;
