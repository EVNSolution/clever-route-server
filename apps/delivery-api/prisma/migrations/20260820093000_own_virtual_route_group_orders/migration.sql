-- Abort before backfill when legacy CUSTOM orders are shared across route groups.
-- The exception rolls the migration transaction back, including the new column.
DO $$
DECLARE
  shared_count INTEGER;
  orphan_count INTEGER;
  foreign_route_plan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO shared_count
  FROM (
    SELECT rgo."orderId"
    FROM "route_grouping_orders" rgo
    JOIN "orders" o ON o."id" = rgo."orderId"
    WHERE o."sourcePlatform" = 'CUSTOM'
    GROUP BY rgo."orderId"
    HAVING COUNT(DISTINCT rgo."groupingId") > 1
  ) shared;

  SELECT COUNT(*) INTO orphan_count
  FROM "orders" o
  WHERE o."sourcePlatform" = 'CUSTOM'
    AND NOT EXISTS (
      SELECT 1 FROM "route_grouping_orders" rgo WHERE rgo."orderId" = o."id"
    );

  SELECT COUNT(DISTINCT o."id") INTO foreign_route_plan_count
  FROM "orders" o
  JOIN "delivery_stops" ds ON ds."orderId" = o."id"
  JOIN "route_plan_stops" rps ON rps."deliveryStopId" = ds."id"
  WHERE o."sourcePlatform" = 'CUSTOM'
    AND (
      NOT EXISTS (
        SELECT 1
        FROM "route_grouping_orders" owner_membership
        JOIN "route_grouping_child_versions" child
          ON child."groupingId" = owner_membership."groupingId"
         AND child."routePlanId" = rps."routePlanId"
         AND child."shopId" = o."shopId"
        WHERE owner_membership."orderId" = o."id"
      )
      OR EXISTS (
        SELECT 1
        FROM "route_grouping_child_versions" foreign_child
        WHERE foreign_child."routePlanId" = rps."routePlanId"
          AND NOT EXISTS (
            SELECT 1
            FROM "route_grouping_orders" owner_membership
            WHERE owner_membership."orderId" = o."id"
              AND owner_membership."groupingId" = foreign_child."groupingId"
          )
      )
    );

  IF shared_count > 0 OR orphan_count > 0 OR foreign_route_plan_count > 0 THEN
    RAISE EXCEPTION
      'CUSTOM ownership audit failed (shared=%, orphaned=%, foreignRoutePlans=%). Stop deploy and run route-groups:custom-ownership:audit.',
      shared_count,
      orphan_count,
      foreign_route_plan_count;
  END IF;
END $$;

ALTER TABLE "orders" ADD COLUMN "ownedRouteGroupingId" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "route_groupings_id_shopId_key"
  ON "route_groupings"("id", "shopId");

UPDATE "orders" o
SET "ownedRouteGroupingId" = owned."groupingId"
FROM (
  SELECT rgo."orderId", MIN(rgo."groupingId"::TEXT)::UUID AS "groupingId"
  FROM "route_grouping_orders" rgo
  JOIN "orders" source_order ON source_order."id" = rgo."orderId"
  WHERE source_order."sourcePlatform" = 'CUSTOM'
  GROUP BY rgo."orderId"
) owned
WHERE o."id" = owned."orderId";

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_ownedRouteGroupingId_shopId_fkey"
  FOREIGN KEY ("ownedRouteGroupingId", "shopId")
  REFERENCES "route_groupings"("id", "shopId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_custom_route_group_owner_check"
  CHECK (
    ("sourcePlatform" = 'CUSTOM' AND "ownedRouteGroupingId" IS NOT NULL)
    OR
    ("sourcePlatform" <> 'CUSTOM' AND "ownedRouteGroupingId" IS NULL)
  );

CREATE INDEX "orders_shopId_ownedRouteGroupingId_idx"
  ON "orders"("shopId", "ownedRouteGroupingId");

CREATE FUNCTION "enforce_custom_route_group_membership_owner"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  order_owner UUID;
  order_platform TEXT;
  order_shop UUID;
BEGIN
  SELECT o."ownedRouteGroupingId", o."sourcePlatform"::TEXT, o."shopId"
  INTO order_owner, order_platform, order_shop
  FROM "orders" o
  WHERE o."id" = NEW."orderId"
  FOR SHARE;

  IF order_platform = 'CUSTOM'
    AND (
      order_owner IS DISTINCT FROM NEW."groupingId"
      OR order_shop IS DISTINCT FROM NEW."shopId"
    )
  THEN
    RAISE EXCEPTION 'CUSTOM order membership must match its owning route group'
      USING ERRCODE = '23514',
            CONSTRAINT = 'route_grouping_orders_custom_owner_match';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "route_grouping_orders_custom_owner_match_trigger"
BEFORE INSERT OR UPDATE ON "route_grouping_orders"
FOR EACH ROW
EXECUTE FUNCTION "enforce_custom_route_group_membership_owner"();

CREATE FUNCTION "enforce_custom_route_group_membership_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "orders" o
    WHERE o."id" = OLD."orderId"
      AND o."sourcePlatform" = 'CUSTOM'
      AND o."ownedRouteGroupingId" = OLD."groupingId"
      AND NOT EXISTS (
        SELECT 1
        FROM "route_grouping_orders" remaining
        WHERE remaining."orderId" = OLD."orderId"
          AND remaining."groupingId" = OLD."groupingId"
      )
  )
  THEN
    RAISE EXCEPTION 'CUSTOM order must retain its owning route group membership'
      USING ERRCODE = '23514',
            CONSTRAINT = 'route_grouping_orders_custom_owner_required';
  END IF;

  RETURN OLD;
END $$;

CREATE CONSTRAINT TRIGGER "route_grouping_orders_custom_owner_required_trigger"
AFTER DELETE ON "route_grouping_orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_custom_route_group_membership_delete"();

CREATE FUNCTION "enforce_custom_order_owner_memberships"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."sourcePlatform" = 'CUSTOM'
    AND (
      EXISTS (
        SELECT 1
        FROM "route_grouping_orders" rgo
        WHERE rgo."orderId" = NEW."id"
          AND (
            rgo."groupingId" IS DISTINCT FROM NEW."ownedRouteGroupingId"
            OR rgo."shopId" IS DISTINCT FROM NEW."shopId"
          )
      )
      OR EXISTS (
        SELECT 1
        FROM "route_plan_stops" rps
        JOIN "delivery_stops" ds ON ds."id" = rps."deliveryStopId"
        WHERE ds."orderId" = NEW."id"
          AND NOT EXISTS (
            SELECT 1
            FROM "route_grouping_child_versions" child
            WHERE child."routePlanId" = rps."routePlanId"
              AND child."groupingId" = NEW."ownedRouteGroupingId"
              AND child."shopId" = NEW."shopId"
          )
      )
    )
  THEN
    RAISE EXCEPTION 'CUSTOM order owner must match every route group membership'
      USING ERRCODE = '23514',
            CONSTRAINT = 'orders_custom_owner_memberships_match';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "orders_custom_owner_memberships_match_trigger"
BEFORE UPDATE OF "sourcePlatform", "ownedRouteGroupingId", "shopId" ON "orders"
FOR EACH ROW
EXECUTE FUNCTION "enforce_custom_order_owner_memberships"();

CREATE FUNCTION "enforce_custom_route_plan_stop_owner"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  order_owner UUID;
  order_platform TEXT;
BEGIN
  PERFORM 1
  FROM "route_plans" rp
  WHERE rp."id" = NEW."routePlanId"
  FOR UPDATE;

  SELECT o."ownedRouteGroupingId", o."sourcePlatform"::TEXT
  INTO order_owner, order_platform
  FROM "delivery_stops" ds
  JOIN "orders" o ON o."id" = ds."orderId"
  WHERE ds."id" = NEW."deliveryStopId"
  FOR SHARE OF o;

  IF order_platform = 'CUSTOM'
    AND NOT EXISTS (
      SELECT 1
      FROM "route_grouping_child_versions" child
      WHERE child."routePlanId" = NEW."routePlanId"
        AND child."groupingId" = order_owner
        AND child."shopId" = NEW."shopId"
    )
  THEN
    RAISE EXCEPTION 'CUSTOM stop route plan must belong to its owning route group'
      USING ERRCODE = '23514',
            CONSTRAINT = 'route_plan_stops_custom_owner_match';
  END IF;

  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER "route_plan_stops_custom_owner_match_trigger"
AFTER INSERT OR UPDATE ON "route_plan_stops"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_custom_route_plan_stop_owner"();

CREATE FUNCTION "enforce_custom_route_plan_child_owner"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
  FROM "route_plans" rp
  WHERE rp."id" IN (NEW."routePlanId", OLD."routePlanId")
  ORDER BY rp."id"
  FOR UPDATE;

  IF TG_OP <> 'DELETE'
    AND NEW."routePlanId" IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM "route_plan_stops" rps
      JOIN "delivery_stops" ds ON ds."id" = rps."deliveryStopId"
      JOIN "orders" o ON o."id" = ds."orderId"
      WHERE rps."routePlanId" = NEW."routePlanId"
        AND o."sourcePlatform" = 'CUSTOM'
        AND (
          o."ownedRouteGroupingId" IS DISTINCT FROM NEW."groupingId"
          OR o."shopId" IS DISTINCT FROM NEW."shopId"
        )
    )
  THEN
    RAISE EXCEPTION 'Route plan child group must own every CUSTOM stop'
      USING ERRCODE = '23514',
            CONSTRAINT = 'route_grouping_child_versions_custom_owner_match';
  END IF;

  IF TG_OP <> 'INSERT'
    AND OLD."routePlanId" IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM "route_plan_stops" rps
      JOIN "delivery_stops" ds ON ds."id" = rps."deliveryStopId"
      JOIN "orders" o ON o."id" = ds."orderId"
      WHERE rps."routePlanId" = OLD."routePlanId"
        AND o."sourcePlatform" = 'CUSTOM'
        AND NOT EXISTS (
          SELECT 1
          FROM "route_grouping_child_versions" remaining
          WHERE remaining."routePlanId" = OLD."routePlanId"
            AND remaining."groupingId" = o."ownedRouteGroupingId"
            AND remaining."shopId" = o."shopId"
        )
    )
  THEN
    RAISE EXCEPTION 'CUSTOM stop route plan must retain an owning route group child'
      USING ERRCODE = '23514',
            CONSTRAINT = 'route_grouping_child_versions_custom_owner_required';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER "route_grouping_child_versions_custom_owner_match_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "route_grouping_child_versions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_custom_route_plan_child_owner"();
