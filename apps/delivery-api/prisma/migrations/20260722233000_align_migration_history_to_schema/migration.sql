-- G007 final drift repair: align historical object names and preserved DB defaults
-- with the current Prisma schema without deleting data or dropping defaults.

ALTER TYPE "RoutePlanStatus" ADD VALUE IF NOT EXISTS 'PUBLISHED';

-- The stale 5433 source was maintained by db push and is missing defaults
-- already present in historical migration SQL. Reassert them idempotently so
-- a fingerprint-proved clone converges to the same schema as a fresh deploy.
ALTER TABLE "admin_notifications" ALTER COLUMN "id" SET DEFAULT gen_random_uuid(), ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "commerce_raw_order_ingest_events" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "commerce_raw_order_ingests" ALTER COLUMN "id" SET DEFAULT gen_random_uuid(), ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "commerce_sync_runs" ALTER COLUMN "warnings" SET DEFAULT '[]'::jsonb;
ALTER TABLE "customer_route_notification_facts" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "delivery_customer_profile_order_links" ALTER COLUMN "id" SET DEFAULT gen_random_uuid(), ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "delivery_customer_profiles" ALTER COLUMN "id" SET DEFAULT gen_random_uuid(), ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "driver_push_tokens" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "driver_route_notification_attempts" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "inventories" ALTER COLUMN "id" SET DEFAULT gen_random_uuid(), ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "inventory_events" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "inventory_orders" ALTER COLUMN "id" SET DEFAULT gen_random_uuid(), ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "order_items" ALTER COLUMN "id" SET DEFAULT gen_random_uuid(), ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "route_grouping_branch_order_locks" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "route_grouping_branches" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "route_grouping_child_versions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "route_grouping_orders" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "route_grouping_polygons" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "route_grouping_versions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "route_groupings" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "route_optimization_jobs" ALTER COLUMN "id" SET DEFAULT gen_random_uuid(), ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "route_plan_geometry_caches" ALTER COLUMN "id" SET DEFAULT gen_random_uuid(), ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "route_tracking_geometries" ALTER COLUMN "id" SET DEFAULT gen_random_uuid(), ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

DO $$
DECLARE
  rename_pair text[];
  index_renames constant text[][] := ARRAY[
    ARRAY['commerce_raw_order_ingests_connection_order_receivedAt_idx', 'commerce_raw_order_ingests_commerceConnectionId_sourceOrder_idx'],
    ARRAY['commerce_raw_order_ingests_connection_order_hash_key', 'commerce_raw_order_ingests_commerceConnectionId_sourceOrder_key'],
    ARRAY['commerce_raw_order_ingests_run_chunk_order_hash_key', 'commerce_raw_order_ingests_syncRunId_chunkId_sourceOrderId__key'],
    ARRAY['commerce_connection_audit_logs_commerceConnectionId_createdAt_idx', 'commerce_connection_audit_logs_commerceConnectionId_created_idx'],
    ARRAY['wordpress_plugin_pairing_codes_commerceConnectionId_expiresAt_idx', 'wordpress_plugin_pairing_codes_commerceConnectionId_expires_idx'],
    ARRAY['orders_shopId_sourcePlatform_sourceSiteUrl_sourceOrderNumber_idx', 'orders_shopId_sourcePlatform_sourceSiteUrl_sourceOrderNumbe_idx'],
    ARRAY['order_delivery_facts_shopId_sourcePlatform_sourceSiteUrl_sourceOrderId_idx', 'order_delivery_facts_shopId_sourcePlatform_sourceSiteUrl_so_idx'],
    ARRAY['driver_route_notification_attempts_groupingId_groupingVersion_idx', 'driver_route_notification_attempts_groupingId_groupingVersi_idx']
  ];
BEGIN
  FOREACH rename_pair SLICE 1 IN ARRAY index_renames LOOP
    IF to_regclass(format('public.%I', rename_pair[1])) IS NOT NULL
       AND to_regclass(format('public.%I', rename_pair[2])) IS NULL THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', rename_pair[1], rename_pair[2]);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'route_plan_stops'
      AND c.conname = 'route_plan_stops_etaInputRouteVersionId_fkey'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'route_plan_stops'
      AND c.conname = 'route_plan_stops_etaInputRouteVersionId_shopId_routePlanId_fkey'
  ) THEN
    ALTER TABLE "route_plan_stops"
      RENAME CONSTRAINT "route_plan_stops_etaInputRouteVersionId_fkey"
      TO "route_plan_stops_etaInputRouteVersionId_shopId_routePlanId_fkey";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'driver_events'
      AND c.conname = 'driver_events_routeVersionId_shopId_fkey'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'driver_events'
      AND c.conname = 'driver_events_routeVersionId_shopId_routePlanId_fkey'
  ) THEN
    ALTER TABLE "driver_events"
      RENAME CONSTRAINT "driver_events_routeVersionId_shopId_fkey"
      TO "driver_events_routeVersionId_shopId_routePlanId_fkey";
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.route_plan_stops') IS NOT NULL
     AND to_regclass('public.shops') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint c
       JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = 'route_plan_stops'
         AND c.conname = 'route_plan_stops_shopId_fkey'
     ) THEN
    IF EXISTS (
      SELECT 1
      FROM "route_plan_stops" rps
      LEFT JOIN "shops" s ON s."id" = rps."shopId"
      WHERE s."id" IS NULL
      LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot add route_plan_stops_shopId_fkey: orphan route_plan_stops.shopId values exist';
    END IF;

    ALTER TABLE "route_plan_stops"
      ADD CONSTRAINT "route_plan_stops_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "shops"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
