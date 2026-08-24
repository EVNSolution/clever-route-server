DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "shops" AS shop
    INNER JOIN "shopify_shop_redaction_tombstones" AS tombstone
      ON tombstone."appId" = shop."appId"
      AND tombstone."shopDomain" = shop."shopDomain"
    WHERE tombstone."reinstalledAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot enforce Shop privacy invariant while an active tombstone has a Shop row',
      CONSTRAINT = 'shops_active_privacy_tombstone_check';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_shop_privacy_tombstone"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "shopify_shop_redaction_tombstones" AS tombstone
    WHERE tombstone."appId" = NEW."appId"
      AND tombstone."shopDomain" = NEW."shopDomain"
      AND tombstone."reinstalledAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Shop write blocked by active privacy tombstone',
      CONSTRAINT = 'shops_active_privacy_tombstone_check';
  END IF;

  IF TG_OP = 'UPDATE'
    AND (OLD."appId", OLD."shopDomain") IS DISTINCT FROM (NEW."appId", NEW."shopDomain")
    AND EXISTS (
      SELECT 1
      FROM "shopify_shop_redaction_tombstones" AS tombstone
      WHERE tombstone."appId" = OLD."appId"
        AND tombstone."shopDomain" = OLD."shopDomain"
        AND tombstone."reinstalledAt" IS NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Shop write blocked by active privacy tombstone',
      CONSTRAINT = 'shops_active_privacy_tombstone_check';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "shops_active_privacy_tombstone_guard" ON "shops";
CREATE TRIGGER "shops_active_privacy_tombstone_guard"
BEFORE INSERT OR UPDATE ON "shops"
FOR EACH ROW
EXECUTE FUNCTION "enforce_shop_privacy_tombstone"();
