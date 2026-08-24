LOCK TABLE "shops" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "shopify_shop_redaction_tombstones" IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION "canonical_shop_privacy_domain"(value TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT regexp_replace(
    regexp_replace(lower(btrim(value)), '^https?://', '', 'i'),
    '/.*$',
    ''
  )
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "shops" AS shop
    INNER JOIN "shopify_shop_redaction_tombstones" AS tombstone
      ON lower(btrim(tombstone."appId")) = lower(btrim(shop."appId"))
      AND "canonical_shop_privacy_domain"(tombstone."shopDomain")
        = "canonical_shop_privacy_domain"(shop."shopDomain")
    WHERE tombstone."reinstalledAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot enforce Shop privacy invariant while an active tombstone has a Shop row',
      CONSTRAINT = 'shops_active_privacy_tombstone_check';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "lock_shop_privacy_identity"(app_id TEXT, shop_domain TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'shop:' || lower(btrim(app_id)) || ':' || "canonical_shop_privacy_domain"(shop_domain),
    0
  ));
END;
$$;

CREATE OR REPLACE FUNCTION "lock_shop_privacy_write_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  identity_hash BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR identity_hash IN
      SELECT DISTINCT candidate.identity_hash
      FROM (
        VALUES
          (hashtextextended(
            'shop:' || lower(btrim(OLD."appId")) || ':' || "canonical_shop_privacy_domain"(OLD."shopDomain"),
            0
          )),
          (hashtextextended(
            'shop:' || lower(btrim(NEW."appId")) || ':' || "canonical_shop_privacy_domain"(NEW."shopDomain"),
            0
          ))
      ) AS candidate(identity_hash)
      ORDER BY candidate.identity_hash
    LOOP
      PERFORM pg_advisory_xact_lock(identity_hash);
    END LOOP;
  ELSE
    PERFORM "lock_shop_privacy_identity"(NEW."appId", NEW."shopDomain");
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "assert_shop_privacy_identity_consistent"(app_id TEXT, shop_domain TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "shops" AS shop
    WHERE lower(btrim(shop."appId")) = lower(btrim(app_id))
      AND "canonical_shop_privacy_domain"(shop."shopDomain")
        = "canonical_shop_privacy_domain"(shop_domain)
  ) AND EXISTS (
    SELECT 1
    FROM "shopify_shop_redaction_tombstones" AS tombstone
    WHERE lower(btrim(tombstone."appId")) = lower(btrim(app_id))
      AND "canonical_shop_privacy_domain"(tombstone."shopDomain")
        = "canonical_shop_privacy_domain"(shop_domain)
      AND tombstone."reinstalledAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Shop write blocked by active privacy tombstone',
      CONSTRAINT = 'shops_active_privacy_tombstone_check';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "validate_shop_privacy_write_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "assert_shop_privacy_identity_consistent"(NEW."appId", NEW."shopDomain");
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "shops_active_privacy_tombstone_guard" ON "shops";
DROP TRIGGER IF EXISTS "shops_privacy_identity_lock" ON "shops";
CREATE TRIGGER "shops_privacy_identity_lock"
BEFORE INSERT OR UPDATE ON "shops"
FOR EACH ROW
EXECUTE FUNCTION "lock_shop_privacy_write_identity"();

DROP TRIGGER IF EXISTS "shop_tombstones_privacy_identity_lock" ON "shopify_shop_redaction_tombstones";
CREATE TRIGGER "shop_tombstones_privacy_identity_lock"
BEFORE INSERT OR UPDATE ON "shopify_shop_redaction_tombstones"
FOR EACH ROW
EXECUTE FUNCTION "lock_shop_privacy_write_identity"();

DROP TRIGGER IF EXISTS "shops_privacy_identity_consistency" ON "shops";
CREATE CONSTRAINT TRIGGER "shops_privacy_identity_consistency"
AFTER INSERT OR UPDATE ON "shops"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_shop_privacy_write_identity"();

DROP TRIGGER IF EXISTS "shop_tombstones_privacy_identity_consistency" ON "shopify_shop_redaction_tombstones";
CREATE CONSTRAINT TRIGGER "shop_tombstones_privacy_identity_consistency"
AFTER INSERT OR UPDATE ON "shopify_shop_redaction_tombstones"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_shop_privacy_write_identity"();
