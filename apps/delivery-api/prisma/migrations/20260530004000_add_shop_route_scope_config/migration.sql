-- Store per-shop Route Ops route-scope values/help without rewriting existing order facts.

ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "routeScopeConfig" JSONB;
