-- Exact schema-only deviations observed on the protected db-push sources:
-- stale 5433 after 20260722150000 and G005 after 20260722223000.
-- This file runs only on an empty fingerprint database. It never runs against
-- a protected source or rehearsal target.

ALTER TYPE "RoutePlanStatus" ADD VALUE IF NOT EXISTS 'PUBLISHED';

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
    SELECT 1 FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'route_plan_stops'
      AND c.conname = 'route_plan_stops_etaInputRouteVersionId_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'route_plan_stops'
      AND c.conname = 'route_plan_stops_etaInputRouteVersionId_shopId_routePlanId_fkey'
  ) THEN
    ALTER TABLE "route_plan_stops"
      RENAME CONSTRAINT "route_plan_stops_etaInputRouteVersionId_fkey"
      TO "route_plan_stops_etaInputRouteVersionId_shopId_routePlanId_fkey";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'driver_events'
      AND c.conname = 'driver_events_routeVersionId_shopId_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'driver_events'
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
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'route_plan_stops' AND column_name = 'shopId'
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint c
       JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND t.relname = 'route_plan_stops'
         AND c.conname = 'route_plan_stops_shopId_fkey'
     ) THEN
    IF EXISTS (
      SELECT 1 FROM "route_plan_stops" rps
      LEFT JOIN "shops" s ON s."id" = rps."shopId"
      WHERE s."id" IS NULL LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Fingerprint cannot add route_plan_stops_shopId_fkey: orphan values exist';
    END IF;
    ALTER TABLE "route_plan_stops"
      ADD CONSTRAINT "route_plan_stops_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "shops"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "admin_notifications" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "commerce_raw_order_ingest_events" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "commerce_raw_order_ingests" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "commerce_sync_runs" ALTER COLUMN "warnings" DROP DEFAULT;
ALTER TABLE "customer_route_notification_facts" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "delivery_customer_profile_order_links" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "delivery_customer_profiles" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "driver_push_tokens" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "driver_route_notification_attempts" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "inventories" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "inventory_events" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "inventory_orders" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "order_items" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "route_grouping_branch_order_locks" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "route_grouping_branches" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "route_grouping_child_versions" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "route_grouping_orders" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "route_grouping_polygons" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "route_grouping_versions" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "route_groupings" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "route_optimization_jobs" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "route_plan_geometry_caches" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "route_tracking_geometries" ALTER COLUMN "id" DROP DEFAULT, ALTER COLUMN "updatedAt" DROP DEFAULT;
