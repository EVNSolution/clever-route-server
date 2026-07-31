ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "dsvOperationalSettings" JSONB;
