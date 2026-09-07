BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE "commerce_sync_runs" IN SHARE MODE;
LOCK TABLE "route_optimization_jobs" IN SHARE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "commerce_sync_runs"
    WHERE "status" IN ('QUEUED', 'RUNNING')
    GROUP BY "commerceConnectionId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot restore commerce_sync_runs_one_active_per_connection_idx: duplicate active runs exist'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "route_optimization_jobs"
    WHERE "status" IN ('QUEUED', 'RUNNING')
    GROUP BY "routePlanId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot restore route_optimization_jobs_one_active_per_route_idx: duplicate active jobs exist'
      USING ERRCODE = '23505';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "commerce_sync_runs_one_active_per_connection_idx"
  ON "commerce_sync_runs"("commerceConnectionId")
  WHERE "status" IN ('QUEUED', 'RUNNING');

CREATE UNIQUE INDEX IF NOT EXISTS "route_optimization_jobs_one_active_per_route_idx"
  ON "route_optimization_jobs"("routePlanId")
  WHERE "status" IN ('QUEUED', 'RUNNING');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index index_meta
    JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
    JOIN pg_class table_class ON table_class.oid = index_meta.indrelid
    JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
    JOIN pg_am access_method ON access_method.oid = index_class.relam
    JOIN pg_attribute key_attribute
      ON key_attribute.attrelid = table_class.oid
     AND key_attribute.attnum = index_meta.indkey[0]
    WHERE table_namespace.nspname = current_schema()
      AND table_class.relname = 'commerce_sync_runs'
      AND index_class.relname = 'commerce_sync_runs_one_active_per_connection_idx'
      AND index_meta.indisvalid
      AND index_meta.indisready
      AND index_meta.indisunique
      AND NOT index_meta.indisprimary
      AND index_meta.indnkeyatts = 1
      AND index_meta.indnatts = 1
      AND index_meta.indexprs IS NULL
      AND index_meta.indpred IS NOT NULL
      AND index_meta.indoption[0] = 0
      AND access_method.amname = 'btree'
      AND key_attribute.attname = 'commerceConnectionId'
      AND pg_get_expr(index_meta.indpred, index_meta.indrelid) =
        '(status = ANY (ARRAY[''QUEUED''::"CommerceSyncRunStatus", ''RUNNING''::"CommerceSyncRunStatus"]))'
  ) THEN
    RAISE EXCEPTION 'commerce_sync_runs_one_active_per_connection_idx exists with an unexpected definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index index_meta
    JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
    JOIN pg_class table_class ON table_class.oid = index_meta.indrelid
    JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
    JOIN pg_am access_method ON access_method.oid = index_class.relam
    JOIN pg_attribute key_attribute
      ON key_attribute.attrelid = table_class.oid
     AND key_attribute.attnum = index_meta.indkey[0]
    WHERE table_namespace.nspname = current_schema()
      AND table_class.relname = 'route_optimization_jobs'
      AND index_class.relname = 'route_optimization_jobs_one_active_per_route_idx'
      AND index_meta.indisvalid
      AND index_meta.indisready
      AND index_meta.indisunique
      AND NOT index_meta.indisprimary
      AND index_meta.indnkeyatts = 1
      AND index_meta.indnatts = 1
      AND index_meta.indexprs IS NULL
      AND index_meta.indpred IS NOT NULL
      AND index_meta.indoption[0] = 0
      AND access_method.amname = 'btree'
      AND key_attribute.attname = 'routePlanId'
      AND pg_get_expr(index_meta.indpred, index_meta.indrelid) =
        '(status = ANY (ARRAY[''QUEUED''::"RouteOptimizationJobStatus", ''RUNNING''::"RouteOptimizationJobStatus"]))'
  ) THEN
    RAISE EXCEPTION 'route_optimization_jobs_one_active_per_route_idx exists with an unexpected definition';
  END IF;
END $$;

COMMIT;
