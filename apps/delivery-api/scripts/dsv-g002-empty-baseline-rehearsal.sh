#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
invocation_root="${INIT_CWD:-$repo_root}"
cd "$script_dir/.."

schema_path="${G002_SCHEMA_PATH:-prisma/schema.prisma}"
evidence_dir="${G002_EVIDENCE_DIR:-docs/evidence/g002/empty-baseline}"
manifest_path="${G002_REHEARSAL_MANIFEST_PATH:-$repo_root/docs/migration/g002-rehearsal-manifest.md}"
database_url="${G002_EMPTY_DATABASE_URL:-${G002_REHEARSAL_DATABASE_URL:-}}"
target_class="${G002_DATABASE_TARGET_CLASS:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
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
    echo "G002_EMPTY_DATABASE_URL or G002_REHEARSAL_DATABASE_URL is required." >&2
    exit 64
  fi
  case "$target_class" in
    safe-local-empty-temp-cluster|disposable-local-docker|disposable-local-postgres|local-disposable-empty)
      ;;
    *)
      echo "G002_DATABASE_TARGET_CLASS must explicitly mark a disposable local target." >&2
      exit 64
      ;;
  esac
  case "$database_url" in
    *amazonaws.com*|*rds.amazonaws.com*|*render.com*|*supabase.co*|*neon.tech*)
      echo "Refusing to run an empty rehearsal against a hosted database URL." >&2
      exit 64
      ;;
  esac
}

assert_empty_database() {
  local table_count
  table_count="$(psql "$database_url" -AtX -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")"
  if [ "$table_count" != "0" ]; then
    echo "Empty rehearsal target is not empty; public table count=$table_count." >&2
    exit 65
  fi
}

assert_zero_drift() {
  local drift_path="$1"
  if rg -q 'CREATE|ALTER|DROP|TRUNCATE|DELETE|INSERT|UPDATE' "$drift_path"; then
    echo "Post-apply drift is not zero; see $drift_path." >&2
    exit 66
  fi
}

postgres_count() {
  psql "$database_url" -AtX -v ON_ERROR_STOP=1 -c "$1" | awk '/^[0-9]+$/ { value = $0 } END { print value }'
}

collect_post_apply_schema_evidence() {
  post_apply_table_count="$(
    postgres_count "BEGIN READ ONLY; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'; ROLLBACK;"
  )"
  post_apply_enum_count="$(
    postgres_count "BEGIN READ ONLY; SELECT COUNT(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'; ROLLBACK;"
  )"
  post_apply_named_object_count="$(
    postgres_count "BEGIN READ ONLY; WITH required_objects(kind, name) AS (VALUES ('table', 'shops'), ('table', 'orders'), ('table', 'customers'), ('table', 'delivery_customer_profiles'), ('table', 'dsv_command_receipts'), ('table', 'dsv_audit_events'), ('enum', 'CustomerStatus'), ('enum', 'DsvCommandReceiptStatus'), ('enum', 'DsvPrincipalType')) SELECT COUNT(*) FROM required_objects ro WHERE (ro.kind = 'table' AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ro.name)) OR (ro.kind = 'enum' AND EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e' AND t.typname = ro.name)); ROLLBACK;"
  )"
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
    (shop_a, 'clever', 'g002-a.example', now(), now()),
    (shop_b, 'clever', 'g002-b.example', now(), now());

  INSERT INTO "orders" ("id", "shopId", "shopifyOrderGid", "name", "rawPayload", "createdAt", "updatedAt")
  VALUES (order_a, shop_a, 'gid://shopify/Order/g002-a', '#G002-A', '{}'::jsonb, now(), now());

  INSERT INTO "route_plans" ("id", "shopId", "name", "planDate", "optimizerVersion", "constraints", "metrics", "createdAt", "updatedAt")
  VALUES (route_plan_a, shop_a, 'G002 route A', CURRENT_DATE, 'g002', '{}'::jsonb, '{}'::jsonb, now(), now());

  INSERT INTO "route_groupings" ("id", "shopId", "name", "planDate", "createdAt", "updatedAt")
  VALUES (grouping_a, shop_a, 'G002 grouping A', CURRENT_DATE, now(), now());

  INSERT INTO "route_grouping_versions" ("id", "shopId", "groupingId", "version", "createdAt")
  VALUES (grouping_version_a, shop_a, grouping_a, 1, now());

  INSERT INTO "route_grouping_child_versions" (
    "id", "shopId", "groupingId", "groupingVersionId", "routePlanId", "version", "snapshot", "createdAt", "updatedAt"
  )
  VALUES (route_version_a, shop_a, grouping_a, grouping_version_a, route_plan_a, 1, '{}'::jsonb, now(), now());

  INSERT INTO "dsv_dispatch_imports" ("id", "shopId", "fileName", "planDate", "status", "rowCount", "createdAt", "updatedAt")
  VALUES (import_a, shop_a, 'g002.csv', CURRENT_DATE, 'READY', 0, now(), now());

  INSERT INTO "dsv_command_receipts" (
    "id", "shopId", "commandName", "commandId", "payloadHash", "actorType", "principalType", "requestId", "createdAt"
  )
  VALUES (receipt_a, shop_a, 'seed', 'receipt-a', 'hash-a', 'system', 'SYSTEM_WORKER', 'request-a', now());

  BEGIN
    INSERT INTO "orders" ("id", "shopId", "shopifyOrderGid", "name", "rawPayload", "currentRouteVersionId", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), shop_b, 'gid://shopify/Order/g002-b-route-version', '#G002-B-RV', '{}'::jsonb, route_version_a, now(), now());
    RAISE EXCEPTION 'cross-shop order currentRouteVersionId unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "dsv_dispatch_import_rows" (
      "id", "shopId", "importId", "rowNumber", "driverName", "vehiclePlate", "destinationName", "conditionCode",
      "shippedBoxes", "address", "customerCode", "sellerOrderKey", "status", "issues", "createdAt", "updatedAt"
    )
    VALUES (
      gen_random_uuid(), shop_b, import_a, 1, 'Driver', 'Plate', 'Destination', 'NORMAL',
      1, 'Address', 'Customer', 'SO-XSHOP-IMPORT', 'READY', '{}'::jsonb, now(), now()
    );
    RAISE EXCEPTION 'cross-shop dispatch import row unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "dsv_command_receipts" (
      "id", "shopId", "commandName", "commandId", "payloadHash", "actorType", "principalType", "requestId",
      "sellerOrderId", "importId", "previousRoutePlanId", "nextRouteVersionId", "createdAt"
    )
    VALUES (
      gen_random_uuid(), shop_b, 'cross', 'receipt-cross', 'hash-b', 'system', 'SYSTEM_WORKER', 'request-b',
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

generated_path="$evidence_dir/full-schema-from-empty.sql"
post_drift_path="$evidence_dir/post-apply-drift.sql"
probe_path="$evidence_dir/cross-shop-tenant-integrity.sql"
metadata_path="$evidence_dir/rehearsal.json"

npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel "$schema_path" \
  --script > "$generated_path"

schema_sha256="$(shasum -a 256 "$schema_path" | awk '{print $1}')"
generated_sha256="$(shasum -a 256 "$generated_path" | awk '{print $1}')"
assert_manifest_hash "apps/delivery-api/prisma/schema.prisma" "$schema_sha256"
assert_manifest_hash "docs/evidence/g002/empty-baseline/full-schema-from-empty.sql" "$generated_sha256"

assert_empty_database
psql "$database_url" -v ON_ERROR_STOP=1 -f "$generated_path" > "$evidence_dir/apply.log"
collect_post_apply_schema_evidence

write_tenant_integrity_probe "$probe_path"
psql "$database_url" -v ON_ERROR_STOP=1 -f "$probe_path" > "$evidence_dir/cross-shop-tenant-integrity.log"

npx prisma migrate diff \
  --from-url "$database_url" \
  --to-schema-datamodel "$schema_path" \
  --script > "$post_drift_path"
assert_zero_drift "$post_drift_path"

npm run prisma:validate > "$evidence_dir/prisma-validate.log"

cat > "$metadata_path" <<JSON
{
  "goal": "G002",
  "targetClass": "$target_class",
  "commands": [
    "npx prisma migrate diff --from-empty --to-schema-datamodel $schema_path --script",
    "psql [REDACTED] -v ON_ERROR_STOP=1 -f $generated_path",
    "psql [REDACTED] -v ON_ERROR_STOP=1 -f $probe_path",
    "npx prisma migrate diff --from-url [REDACTED] --to-schema-datamodel $schema_path --script",
    "npm run prisma:validate"
  ],
  "schemaSha256": "$schema_sha256",
  "generatedSqlSha256": "$generated_sha256",
  "generatedSql": "$generated_path",
  "postApplyDrift": "$post_drift_path",
  "postApplySchema": {
    "tableCount": $post_apply_table_count,
    "expectedMinimumTableCount": 1,
    "enumCount": $post_apply_enum_count,
    "expectedMinimumEnumCount": 1,
    "namedObjectCount": $post_apply_named_object_count,
    "expectedNamedObjectCount": 9
  },
  "tenantIntegrityProbe": "$probe_path",
  "wroteProbeRows": false,
  "exitCode": 0
}
JSON

echo "$metadata_path"
