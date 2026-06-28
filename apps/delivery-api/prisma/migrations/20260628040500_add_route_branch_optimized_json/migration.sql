ALTER TABLE "route_grouping_branches"
  ADD COLUMN IF NOT EXISTS "optimizedJson" JSONB;
