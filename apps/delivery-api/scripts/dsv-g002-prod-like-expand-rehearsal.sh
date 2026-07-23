#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
invocation_root="${INIT_CWD:-$repo_root}"
cd "$script_dir/.."

schema_path="${G002_SCHEMA_PATH:-prisma/schema.prisma}"
g002_migration_path="${G002_MIGRATION_PATH:-prisma/migrations/20260722170000_dsv_customer_auth_foundation/migration.sql}"
repair_migration_path="${G002_REPAIR_MIGRATION_PATH:-prisma/migrations/20260722193000_repair_g002_tenant_integrity/migration.sql}"
evidence_dir="${G002_EVIDENCE_DIR:-docs/evidence/g002/prod-like-expand}"
manifest_path="${G002_REHEARSAL_MANIFEST_PATH:-$repo_root/docs/migration/g002-rehearsal-manifest.md}"
database_url="${G002_PROD_LIKE_DATABASE_URL:-}"
target_class="${G002_DATABASE_TARGET_CLASS:-${G002_PROD_LIKE_TARGET_CLASS:-}}"
prepare_pre_g002="${G002_PREPARE_PRE_G002_FROM_MIGRATIONS:-0}"
prepare_current_schema_as_pre_g002="${G002_PREPARE_CURRENT_SCHEMA_AS_PRE_G002:-0}"
backfill_report_only=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      shift
      ;;
    --backfill-report-only)
      backfill_report_only=1
      shift
      ;;
    --evidence)
      evidence_dir="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 64
      ;;
  esac
done

resolve_invocation_path() {
  case "$1" in
    /*)
      printf '%s\n' "$1"
      ;;
    *)
      printf '%s/%s\n' "$invocation_root" "$1"
      ;;
  esac
}

manifest_hash_for() {
  local artifact="$1"
  awk -F'`' -v artifact="$artifact" 'index($0, artifact) > 0 { print $4; exit }' "$manifest_path"
}

assert_manifest_hash() {
  local artifact="$1"
  local actual_sha256="$2"
  local expected_sha256
  expected_sha256="$(manifest_hash_for "$artifact")"
  if [ "$expected_sha256" = "" ]; then
    echo "G002 rehearsal manifest is missing SHA-256 for $artifact." >&2
    exit 69
  fi
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    echo "G002 rehearsal manifest SHA-256 mismatch for $artifact: expected $expected_sha256, got $actual_sha256." >&2
    exit 69
  fi
}

require_disposable_database() {
  if [ "$database_url" = "" ]; then
    echo "G002_PROD_LIKE_DATABASE_URL is required and must point to a non-production clone or snapshot." >&2
    exit 64
  fi
  case "$target_class" in
    safe-local-pre-g002-temp-cluster|safe-local-current-schema-temp-cluster|disposable-local-docker|disposable-local-postgres|production-like-disposable-clone)
      ;;
    *)
      echo "G002_DATABASE_TARGET_CLASS or G002_PROD_LIKE_TARGET_CLASS must explicitly mark a disposable non-production target." >&2
      exit 64
      ;;
  esac
  case "$database_url" in
    *amazonaws.com*|*rds.amazonaws.com*|*render.com*|*supabase.co*|*neon.tech*)
      echo "Refusing to run a G002 production-like rehearsal against a hosted database URL." >&2
      exit 64
      ;;
  esac
}

require_report_only_target() {
  case "$target_class" in
    safe-local-current-schema-temp-cluster|safe-local-empty-temp-cluster|disposable-local-docker|disposable-local-postgres)
      ;;
    *)
      echo "--backfill-report-only requires G002_DATABASE_TARGET_CLASS to explicitly mark a safe disposable current-schema target." >&2
      exit 64
      ;;
  esac
}

assert_current_schema_for_backfill_report() {
  local missing_schema
  missing_schema="$(
    psql "$database_url" -AtX -v ON_ERROR_STOP=1 <<'SQL'
WITH required_tables(table_name) AS (
  VALUES
    ('orders'),
    ('dsv_dispatch_import_rows'),
    ('customers'),
    ('delivery_customer_profiles'),
    ('dsv_command_receipts'),
    ('dsv_audit_events')
),
required_columns(table_name, column_name) AS (
  VALUES
    ('orders', 'shopId'),
    ('orders', 'customerId'),
    ('orders', 'destinationId'),
    ('orders', 'sellerOrderKey'),
    ('dsv_dispatch_import_rows', 'shopId'),
    ('dsv_dispatch_import_rows', 'sellerOrderKey'),
    ('dsv_dispatch_import_rows', 'customerCode'),
    ('dsv_dispatch_import_rows', 'address')
),
missing_tables AS (
  SELECT 'table public.' || required_tables.table_name AS missing
    FROM required_tables
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = required_tables.table_name
   )
),
missing_columns AS (
  SELECT 'column public.' || required_columns.table_name || '.' || required_columns.column_name AS missing
    FROM required_columns
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = required_columns.table_name
        AND column_name = required_columns.column_name
   )
)
SELECT string_agg(missing, ', ' ORDER BY missing)
  FROM (
    SELECT missing FROM missing_tables
    UNION ALL
    SELECT missing FROM missing_columns
  ) missing_schema;
SQL
  )"
  if [ "$missing_schema" != "" ]; then
    echo "--backfill-report-only target must already have current G002 schema; missing: $missing_schema." >&2
    exit 65
  fi
}

assert_empty_database() {
  local table_count
  table_count="$(psql "$database_url" -AtX -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")"
  if [ "$table_count" != "0" ]; then
    echo "Prepared pre-G002 target must start empty; public table count=$table_count." >&2
    exit 65
  fi
}

apply_pre_g002_migrations() {
  local migration
  assert_empty_database
  for migration in prisma/migrations/*/migration.sql; do
    case "$migration" in
      "$g002_migration_path"|"$repair_migration_path"|prisma/migrations/20260722170000_dsv_customer_auth_foundation/migration.sql|prisma/migrations/20260722193000_repair_g002_tenant_integrity/migration.sql)
        break
        ;;
      *)
        psql "$database_url" -v ON_ERROR_STOP=1 -f "$migration" >> "$evidence_dir/prepare-pre-g002.log"
        ;;
    esac
  done
}

prepare_current_schema_as_pre_g002() {
  local bootstrap_path="$evidence_dir/current-schema-bootstrap.sql"
  local rewind_path="$evidence_dir/current-schema-to-pre-g002.sql"
  assert_empty_database
  npx prisma migrate diff \
    --from-empty \
    --to-schema-datamodel "$schema_path" \
    --script > "$bootstrap_path"
  psql "$database_url" -v ON_ERROR_STOP=1 -f "$bootstrap_path" > "$evidence_dir/current-schema-bootstrap.log"
  cat > "$rewind_path" <<'SQL'
DROP TABLE "dsv_audit_events";
DROP TABLE "dsv_command_receipts";
DROP TABLE "customer_accounts";

ALTER TABLE "orders" DROP CONSTRAINT "orders_currentRouteVersionId_shopId_fkey";
ALTER TABLE "orders" DROP CONSTRAINT "orders_customerId_shopId_fkey";
ALTER TABLE "orders" DROP CONSTRAINT "orders_destinationId_shopId_fkey";
DROP TABLE "customers";
DROP INDEX "orders_id_shopId_key";
DROP INDEX "orders_shopId_sellerOrderSourceKind_sellerOrderKey_key";
ALTER TABLE "orders" DROP COLUMN "sellerOrderSourceKind";
ALTER TABLE "orders" DROP COLUMN "sellerOrderKey";
ALTER TABLE "orders" DROP COLUMN "sellerOrderVersion";
ALTER TABLE "orders" DROP COLUMN "customerId";
ALTER TABLE "orders" DROP COLUMN "destinationId";
ALTER TABLE "orders" DROP COLUMN "currentRouteVersionId";

ALTER TABLE "route_grouping_child_versions" DROP CONSTRAINT "route_grouping_child_versions_routePlanId_shopId_fkey";
DROP INDEX "route_grouping_child_versions_id_shopId_key";
ALTER TABLE "route_grouping_child_versions"
  ADD CONSTRAINT "route_grouping_child_versions_routePlanId_fkey"
  FOREIGN KEY ("routePlanId") REFERENCES "route_plans"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "route_plans_id_shopId_key";

ALTER TABLE "dsv_dispatch_import_rows" DROP CONSTRAINT "dsv_dispatch_import_rows_importId_shopId_fkey";
ALTER TABLE "dsv_dispatch_import_rows"
  ADD CONSTRAINT "dsv_dispatch_import_rows_importId_fkey"
  FOREIGN KEY ("importId") REFERENCES "dsv_dispatch_imports"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "dsv_dispatch_imports_id_shopId_key";

DROP INDEX "dsv_transport_conditions_shopId_comparisonKey_key";
DROP INDEX "dsv_transport_conditions_shopId_status_updatedAt_idx";
ALTER TABLE "dsv_transport_conditions" DROP COLUMN "rawValue";
ALTER TABLE "dsv_transport_conditions" DROP COLUMN "comparisonKey";
ALTER TABLE "dsv_transport_conditions" DROP COLUMN "status";
ALTER TABLE "dsv_transport_conditions" DROP COLUMN "activatedAt";
ALTER TABLE "dsv_transport_conditions" DROP COLUMN "deactivatedAt";
SQL
  psql "$database_url" -v ON_ERROR_STOP=1 -f "$rewind_path" > "$evidence_dir/current-schema-to-pre-g002.log"
}

classify_drift() {
  local drift_path="$1"
  local approved_repair_constraint_pattern
  approved_repair_constraint_pattern='DROP\s+CONSTRAINT\s+"(orders_currentRouteVersionId_fkey|route_grouping_child_versions_routePlanId_fkey|dsv_dispatch_import_rows_importId_fkey|dsv_command_receipts_importId_fkey|dsv_command_receipts_sellerOrderId_fkey|dsv_command_receipts_previousRoutePlanId_fkey|dsv_command_receipts_nextRoutePlanId_fkey|dsv_command_receipts_previousRouteVersionId_fkey|dsv_command_receipts_nextRouteVersionId_fkey|dsv_audit_events_sellerOrderId_fkey|dsv_audit_events_commandReceiptId_fkey|dsv_audit_events_importId_fkey|dsv_audit_events_previousRoutePlanId_fkey|dsv_audit_events_nextRoutePlanId_fkey|dsv_audit_events_previousRouteVersionId_fkey|dsv_audit_events_nextRouteVersionId_fkey)"'
  if rg -n '\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+.*\s+DROP\s+COLUMN|ALTER\s+COLUMN\s+"[^"]+"\s+SET\s+NOT\s+NULL)\b' "$drift_path" > "$evidence_dir/destructive-drift.log"; then
    echo "Destructive drift detected; see $evidence_dir/destructive-drift.log." >&2
    exit 66
  fi
  if rg -n 'DROP\s+CONSTRAINT' "$drift_path" > "$evidence_dir/classified-repair-drift.log"; then
    if rg -n 'DROP\s+CONSTRAINT' "$drift_path" | rg -v "$approved_repair_constraint_pattern" > "$evidence_dir/destructive-drift.log"; then
      echo "Unexpected DROP CONSTRAINT drift detected; see $evidence_dir/destructive-drift.log." >&2
      exit 66
    fi
    echo "Detected approved repair drift: exact named tenant FK replacement constraints only." > "$evidence_dir/drift-classification.txt"
  else
    echo "Detected additive or empty drift only." > "$evidence_dir/drift-classification.txt"
  fi
}

assert_zero_drift() {
  local drift_path="$1"
  if rg -q 'CREATE|ALTER|DROP|TRUNCATE|DELETE|INSERT|UPDATE' "$drift_path"; then
    echo "Post-apply drift is not zero; see $drift_path." >&2
    exit 67
  fi
}

read_backfill_domain_counts() {
  node -e "const fs = require('fs'); const report = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (!report.domainCounts) throw new Error('missing domainCounts'); process.stdout.write(JSON.stringify(report.domainCounts, null, 2));" "$backfill_report_path"
}

run_backfill_report_only() {
  local wrote_database_rows
  local backfill_domain_counts
  require_report_only_target
  assert_current_schema_for_backfill_report
  DATABASE_URL="$database_url" \
  G002_DATABASE_TARGET_CLASS="$target_class" \
  G002_BACKFILL_REPORT_PATH="$backfill_report_path" \
  npm run dsv:g002:backfill:dry-run > "$evidence_dir/backfill-dry-run.log"

  wrote_database_rows="$(
    node -e "const fs = require('fs'); const report = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(String(report.wroteDatabaseRows));" "$backfill_report_path"
  )"
  if [ "$wrote_database_rows" != "false" ]; then
    echo "Backfill dry-run report did not prove wroteDatabaseRows:false; got $wrote_database_rows." >&2
    exit 68
  fi
  backfill_domain_counts="$(read_backfill_domain_counts)"

  schema_sha256="$(shasum -a 256 "$schema_path" | awk '{print $1}')"
  assert_manifest_hash "apps/delivery-api/prisma/schema.prisma" "$schema_sha256"
  cat > "$metadata_path" <<JSON
{
  "goal": "G002",
  "mode": "backfill-report-only",
  "targetClass": "$target_class",
  "commands": [
    "npm run dsv:g002:backfill:dry-run"
  ],
  "schemaSha256": "$schema_sha256",
  "backfillReport": "$backfill_report_path",
  "backfillCounts": $backfill_domain_counts,
  "wroteDatabaseRows": false,
  "appliedMigrations": false,
  "ranTenantProbes": false,
  "exitCode": 0
}
JSON

  echo "$metadata_path"
}

write_tenant_integrity_probe() {
  local probe_path="$1"
  cat > "$probe_path" <<'SQL'
BEGIN;

DO $$
DECLARE
  shop_a UUID := gen_random_uuid();
  shop_b UUID := gen_random_uuid();
  order_a UUID := gen_random_uuid();
  import_a UUID := gen_random_uuid();
  route_plan_a UUID := gen_random_uuid();
  grouping_a UUID := gen_random_uuid();
  grouping_version_a UUID := gen_random_uuid();
  route_version_a UUID := gen_random_uuid();
  receipt_a UUID := gen_random_uuid();
BEGIN
  INSERT INTO "shops" ("id", "appId", "shopDomain", "createdAt", "updatedAt")
  VALUES
    (shop_a, 'clever', 'g002-prod-a.example', now(), now()),
    (shop_b, 'clever', 'g002-prod-b.example', now(), now());

  INSERT INTO "orders" ("id", "shopId", "shopifyOrderGid", "name", "rawPayload", "createdAt", "updatedAt")
  VALUES (order_a, shop_a, 'gid://shopify/Order/g002-prod-a', '#G002-PROD-A', '{}'::jsonb, now(), now());

  INSERT INTO "route_plans" ("id", "shopId", "name", "planDate", "optimizerVersion", "constraints", "metrics", "createdAt", "updatedAt")
  VALUES (route_plan_a, shop_a, 'G002 prod route A', CURRENT_DATE, 'g002', '{}'::jsonb, '{}'::jsonb, now(), now());

  INSERT INTO "route_groupings" ("id", "shopId", "name", "planDate", "createdAt", "updatedAt")
  VALUES (grouping_a, shop_a, 'G002 prod grouping A', CURRENT_DATE, now(), now());

  INSERT INTO "route_grouping_versions" ("id", "shopId", "groupingId", "version", "createdAt")
  VALUES (grouping_version_a, shop_a, grouping_a, 1, now());

  INSERT INTO "route_grouping_child_versions" (
    "id", "shopId", "groupingId", "groupingVersionId", "routePlanId", "version", "snapshot", "createdAt", "updatedAt"
  )
  VALUES (route_version_a, shop_a, grouping_a, grouping_version_a, route_plan_a, 1, '{}'::jsonb, now(), now());

  INSERT INTO "dsv_dispatch_imports" ("id", "shopId", "fileName", "planDate", "status", "rowCount", "createdAt", "updatedAt")
  VALUES (import_a, shop_a, 'g002-prod.csv', CURRENT_DATE, 'READY', 0, now(), now());

  INSERT INTO "dsv_command_receipts" (
    "id", "shopId", "commandName", "commandId", "payloadHash", "actorType", "principalType", "requestId", "createdAt"
  )
  VALUES (receipt_a, shop_a, 'seed', 'receipt-prod-a', 'hash-a', 'system', 'SYSTEM_WORKER', 'request-a', now());

  BEGIN
    INSERT INTO "orders" ("id", "shopId", "shopifyOrderGid", "name", "rawPayload", "currentRouteVersionId", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), shop_b, 'gid://shopify/Order/g002-prod-b-route-version', '#G002-PROD-B-RV', '{}'::jsonb, route_version_a, now(), now());
    RAISE EXCEPTION 'cross-shop order currentRouteVersionId unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "dsv_command_receipts" (
      "id", "shopId", "commandName", "commandId", "payloadHash", "actorType", "principalType", "requestId",
      "sellerOrderId", "importId", "previousRoutePlanId", "nextRouteVersionId", "createdAt"
    )
    VALUES (
      gen_random_uuid(), shop_b, 'cross', 'receipt-prod-cross', 'hash-b', 'system', 'SYSTEM_WORKER', 'request-b',
      order_a, import_a, route_plan_a, route_version_a, now()
    );
    RAISE EXCEPTION 'cross-shop command receipt references unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "dsv_audit_events" (
      "id", "shopId", "eventType", "entityType", "entityId", "actorType", "principalType", "requestId",
      "sellerOrderId", "commandReceiptId", "importId", "previousRoutePlanId", "nextRouteVersionId", "occurredAt"
    )
    VALUES (
      gen_random_uuid(), shop_b, 'cross', 'order', order_a::text, 'system', 'SYSTEM_WORKER', 'request-c',
      order_a, receipt_a, import_a, route_plan_a, route_version_a, now()
    );
    RAISE EXCEPTION 'cross-shop audit event references unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

ROLLBACK;
SQL
}

require_disposable_database
evidence_dir="$(resolve_invocation_path "$evidence_dir")"
mkdir -p "$evidence_dir"

pre_drift_path="$evidence_dir/pre-apply-drift.sql"
post_drift_path="$evidence_dir/post-apply-drift.sql"
probe_path="$evidence_dir/cross-shop-tenant-integrity.sql"
backfill_report_path="$evidence_dir/backfill-dry-run-report.json"
metadata_path="$evidence_dir/rehearsal.json"

if [ "$backfill_report_only" = "1" ]; then
  run_backfill_report_only
  exit 0
fi

if [ "$prepare_current_schema_as_pre_g002" = "1" ]; then
  prepare_current_schema_as_pre_g002
elif [ "$prepare_pre_g002" = "1" ]; then
  : > "$evidence_dir/prepare-pre-g002.log"
  apply_pre_g002_migrations
fi

npx prisma migrate diff \
  --from-url "$database_url" \
  --to-schema-datamodel "$schema_path" \
  --script > "$pre_drift_path"
classify_drift "$pre_drift_path"

psql "$database_url" -v ON_ERROR_STOP=1 -f "$g002_migration_path" > "$evidence_dir/apply-g002.log"
psql "$database_url" -v ON_ERROR_STOP=1 -f "$repair_migration_path" > "$evidence_dir/apply-repair.log"

write_tenant_integrity_probe "$probe_path"
psql "$database_url" -v ON_ERROR_STOP=1 -f "$probe_path" > "$evidence_dir/cross-shop-tenant-integrity.log"

npx prisma migrate diff \
  --from-url "$database_url" \
  --to-schema-datamodel "$schema_path" \
  --script > "$post_drift_path"
assert_zero_drift "$post_drift_path"

DATABASE_URL="$database_url" \
G002_DATABASE_TARGET_CLASS="$target_class" \
G002_BACKFILL_REPORT_PATH="$backfill_report_path" \
npm run dsv:g002:backfill:dry-run > "$evidence_dir/backfill-dry-run.log"
backfill_domain_counts="$(read_backfill_domain_counts)"

schema_sha256="$(shasum -a 256 "$schema_path" | awk '{print $1}')"
g002_migration_sha256="$(shasum -a 256 "$g002_migration_path" | awk '{print $1}')"
repair_migration_sha256="$(shasum -a 256 "$repair_migration_path" | awk '{print $1}')"
assert_manifest_hash "apps/delivery-api/prisma/schema.prisma" "$schema_sha256"
assert_manifest_hash "apps/delivery-api/prisma/migrations/20260722170000_dsv_customer_auth_foundation/migration.sql" "$g002_migration_sha256"
assert_manifest_hash "apps/delivery-api/prisma/migrations/20260722193000_repair_g002_tenant_integrity/migration.sql" "$repair_migration_sha256"

cat > "$metadata_path" <<JSON
{
  "goal": "G002",
  "targetClass": "$target_class",
  "preparedPreG002FromMigrations": $prepare_pre_g002,
  "preparedCurrentSchemaAsPreG002": $prepare_current_schema_as_pre_g002,
  "commands": [
    "npx prisma migrate diff --from-url [REDACTED] --to-schema-datamodel $schema_path --script",
    "psql [REDACTED] -v ON_ERROR_STOP=1 -f $g002_migration_path",
    "psql [REDACTED] -v ON_ERROR_STOP=1 -f $repair_migration_path",
    "psql [REDACTED] -v ON_ERROR_STOP=1 -f $probe_path",
    "npx prisma migrate diff --from-url [REDACTED] --to-schema-datamodel $schema_path --script",
    "npm run dsv:g002:backfill:dry-run"
  ],
  "schemaSha256": "$schema_sha256",
  "g002MigrationSha256": "$g002_migration_sha256",
  "repairMigrationSha256": "$repair_migration_sha256",
  "preApplyDrift": "$pre_drift_path",
  "postApplyDrift": "$post_drift_path",
  "tenantIntegrityProbe": "$probe_path",
  "backfillReport": "$backfill_report_path",
  "backfillCounts": $backfill_domain_counts,
  "wroteProbeRows": false,
  "exitCode": 0
}
JSON

echo "$metadata_path"
