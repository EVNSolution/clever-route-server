#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
api_root="$script_dir/.."
invocation_root="${INIT_CWD:-$repo_root}"

target_class="${G007_DATABASE_TARGET_CLASS:-}"
target_url="${G007_REHEARSAL_DATABASE_URL:-${DATABASE_URL:-}}"
source_url="${G007_STALE_SOURCE_DATABASE_URL:-}"
fingerprint_url="${G007_FINGERPRINT_DATABASE_URL:-}"
expected_applied_through="${G007_EXPECTED_APPLIED_THROUGH:-}"
backup_file="${G007_REHEARSAL_BACKUP_FILE:-}"
backup_dir="${G007_REHEARSAL_BACKUP_DIR:-$repo_root/docs/evidence/g007/rehearsal-backups}"
evidence_dir="${G007_EVIDENCE_DIR:-docs/evidence/g007/rehearsal}"
fake_commands="${G007_FAKE_COMMANDS:-0}"
schema_path="prisma/schema.prisma"
migrations_dir="prisma/migrations"
baseline_migration="20260520000000_initial_route_ops_baseline"
cutoff_migration="20260723013000_g010_import_row_resource_tenant_fks"
stale_source_expected_migration="20260722150000_add_dsv_dispatch_and_resources"
prod_like_expected_migration="20260722223000_drop_legacy_single_tenant_fks"
db_push_source_fingerprint_sql="prisma/rehearsal-fingerprints/db-push-source-before-20260722233000.sql"

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

fail() {
  echo "G007 rehearsal guard: $*" >&2
  exit 64
}

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

parse_postgres_url() {
  local database_url="$1"
  node -e '
const { URL } = require("url");
const raw = process.argv[1];
function die(message) {
  console.error(message);
  process.exit(1);
}
function parseNumericPart(part) {
  if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part, 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8);
  if (/^[0-9]+$/.test(part)) return Number.parseInt(part, 10);
  return Number.NaN;
}
function isIpv4Loopback(host) {
  if (/^[0-9]+$|^0x[0-9a-f]+$/i.test(host)) {
    const value = parseNumericPart(host);
    return Number.isFinite(value) && value >= 0x7f000000 && value <= 0x7fffffff;
  }
  const parts = host.split(".");
  if (parts.length >= 1 && parts.length <= 4 && parts.every((part) => /^[0-9]+$|^0x[0-9a-f]+$/i.test(part))) {
    return parseNumericPart(parts[0]) === 127;
  }
  return false;
}
function isLoopbackHost(host) {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    return isIpv4Loopback(mapped) || mapped.startsWith("7f");
  }
  return isIpv4Loopback(host);
}
try {
  const url = new URL(raw);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    die("DATABASE_URL must use postgresql:// or postgres://");
  }
  if (!url.hostname) {
    die("DATABASE_URL must include a host");
  }
  const rawPath = url.pathname || "";
  if (!rawPath.startsWith("/") || rawPath === "/") {
    die("DATABASE_URL must include a database name");
  }
  const databaseName = decodeURIComponent(rawPath.slice(1));
  if (!databaseName || databaseName.includes("/") || databaseName.includes("\\") || databaseName.includes("\0")) {
    die("DATABASE_URL database name is unsafe");
  }
  let host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (host === "0:0:0:0:0:0:0:1") {
    host = "::1";
  }
  process.stdout.write(JSON.stringify({
    host,
    port: url.port || "",
    databaseName,
    isLoopback: isLoopbackHost(host)
  }));
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
' "$database_url"
}

url_database_name() {
  node -e 'const parsed = JSON.parse(process.argv[1]); process.stdout.write(parsed.databaseName);' "$1"
}

url_host() {
  node -e 'const parsed = JSON.parse(process.argv[1]); process.stdout.write(parsed.host);' "$1"
}

url_port() {
  node -e 'const parsed = JSON.parse(process.argv[1]); process.stdout.write(parsed.port);' "$1"
}

url_is_loopback() {
  node -e 'const parsed = JSON.parse(process.argv[1]); process.stdout.write(parsed.isLoopback ? "1" : "0");' "$1"
}

require_target_class() {
  case "$target_class" in
    empty|stale-clone|prod-like-clone|restore|recovery)
      ;;
    *)
      fail "G007_DATABASE_TARGET_CLASS must be empty, stale-clone, prod-like-clone, restore, or recovery"
      ;;
  esac
}

require_disposable_target() {
  local database_url="$1"
  local parsed database_name host port is_loopback
  if [ "$database_url" = "" ]; then
    fail "G007_REHEARSAL_DATABASE_URL or DATABASE_URL is required"
  fi
  parsed="$(parse_postgres_url "$database_url")" || fail "database URL must be a valid PostgreSQL URL"
  database_name="$(url_database_name "$parsed")"
  host="$(url_host "$parsed")"
  port="$(url_port "$parsed")"
  is_loopback="$(url_is_loopback "$parsed")"

  case "$database_name" in
    clever_g007_empty_*|clever_g007_stale_clone_*|clever_g007_prod_like_clone_*|clever_g007_restore_*|clever_g007_recovery_*)
      ;;
    *)
      fail "rehearsal target must be a disposable clever_g007_* database; got $database_name"
      ;;
  esac

  case "$target_class:$database_name" in
    empty:clever_g007_empty_*|stale-clone:clever_g007_stale_clone_*|prod-like-clone:clever_g007_prod_like_clone_*|restore:clever_g007_restore_*|recovery:clever_g007_recovery_*)
      ;;
    *)
      fail "target class $target_class does not match database $database_name"
      ;;
  esac

  if [ "$is_loopback" = "1" ] && { [ "$database_name" = "clever_route" ] || [ "$database_name" = "clever_route_recovery_20260722" ] || [ "$port" = "5433" ]; }; then
    fail "refusing protected target $host:$port/$database_name"
  fi

  case "$host:$port/$database_name" in
    *:*/clever_route_recovery_20260722|*:55444/*|*:55455/*)
      fail "refusing protected target $host:$port/$database_name"
      ;;
  esac

  printf '%s\n' "$database_name"
}

require_stale_source_if_needed() {
  local parsed host port database_name
  if [ "$target_class" != "stale-clone" ]; then
    return 0
  fi
  if [ "$source_url" = "" ]; then
    fail "G007_STALE_SOURCE_DATABASE_URL is required for stale-clone rehearsals"
  fi
  parsed="$(parse_postgres_url "$source_url")" || fail "G007_STALE_SOURCE_DATABASE_URL must be a valid PostgreSQL URL"
  database_name="$(url_database_name "$parsed")"
  host="$(url_host "$parsed")"
  port="$(url_port "$parsed")"
  case "$host:$port/$database_name" in
    127.0.0.1:5433/*|localhost:5433/*)
      ;;
    *)
      fail "stale source must be the explicit read-only 5433 source; got $host:$port/$database_name"
      ;;
  esac
  case "$database_name" in
    clever_route_recovery_20260722)
      fail "refusing protected recovery source $database_name"
      ;;
  esac
}

is_existing_schema_target() {
  case "$target_class" in
    stale-clone|prod-like-clone|restore|recovery)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

require_existing_schema_bootstrap_inputs() {
  local parsed database_name host port is_loopback
  if ! is_existing_schema_target; then
    return 0
  fi
  if [ "$expected_applied_through" = "" ]; then
    fail "G007_EXPECTED_APPLIED_THROUGH is required for non-empty targets"
  fi
  if [ ! -f "$migrations_dir/$expected_applied_through/migration.sql" ]; then
    fail "G007_EXPECTED_APPLIED_THROUGH must name a checked-in migration directory"
  fi
  if [[ "$expected_applied_through" < "$baseline_migration" || "$cutoff_migration" < "$expected_applied_through" ]]; then
    fail "G007_EXPECTED_APPLIED_THROUGH must be between $baseline_migration and $cutoff_migration"
  fi
  if [ "$target_class" = "stale-clone" ]; then
    if [ "$expected_applied_through" != "$stale_source_expected_migration" ]; then
      fail "stale-clone requires G007_EXPECTED_APPLIED_THROUGH=$stale_source_expected_migration"
    fi
    if [ ! -f "$db_push_source_fingerprint_sql" ]; then
      fail "db-push source fingerprint SQL is missing: $db_push_source_fingerprint_sql"
    fi
  fi
  if [ "$target_class" = "prod-like-clone" ]; then
    if [ "$expected_applied_through" != "$prod_like_expected_migration" ]; then
      fail "prod-like-clone requires G007_EXPECTED_APPLIED_THROUGH=$prod_like_expected_migration"
    fi
    if [ ! -f "$db_push_source_fingerprint_sql" ]; then
      fail "db-push source fingerprint SQL is missing: $db_push_source_fingerprint_sql"
    fi
  fi
  if [ "$fingerprint_url" = "" ]; then
    fail "G007_FINGERPRINT_DATABASE_URL is required for non-empty targets"
  fi
  parsed="$(parse_postgres_url "$fingerprint_url")" || fail "G007_FINGERPRINT_DATABASE_URL must be a valid PostgreSQL URL"
  database_name="$(url_database_name "$parsed")"
  host="$(url_host "$parsed")"
  port="$(url_port "$parsed")"
  is_loopback="$(url_is_loopback "$parsed")"
  case "$target_class:$database_name" in
    stale-clone:clever_g007_stale_fingerprint_*|prod-like-clone:clever_g007_prod_like_fingerprint_*|restore:clever_g007_fingerprint_*|recovery:clever_g007_fingerprint_*)
      ;;
    *)
      fail "fingerprint scratch database name does not match target class $target_class; got $database_name"
      ;;
  esac
  if [ "$is_loopback" = "1" ] && { [ "$database_name" = "clever_route" ] || [ "$database_name" = "clever_route_recovery_20260722" ] || [ "$port" = "5433" ]; }; then
    fail "refusing protected fingerprint target $host:$port/$database_name"
  fi
  case "$host:$port/$database_name" in
    *:*/clever_route_recovery_20260722|*:55444/*|*:55455/*)
      fail "refusing protected fingerprint target $host:$port/$database_name"
      ;;
  esac
}

run_or_echo() {
  if [ "$fake_commands" = "1" ]; then
    printf 'would_run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

run_capture_or_echo() {
  local output_path="$1"
  shift
  if [ "$fake_commands" = "1" ]; then
    run_or_echo "$@" > "$output_path"
  else
    "$@" > "$output_path"
  fi
}

migrations_through_expected() {
  local migration_path migration_name
  for migration_path in "$migrations_dir"/*/migration.sql; do
    migration_name="$(basename "$(dirname "$migration_path")")"
    if [[ "$migration_name" < "$baseline_migration" ]]; then
      continue
    fi
    if [[ "$expected_applied_through" < "$migration_name" ]]; then
      break
    fi
    printf '%s\n' "$migration_name"
  done
}

assert_known_migration_history() {
  local migration_name checksum history_table_exists
  : > "$evidence_dir/expected-migration-checksums.tsv"
  while IFS= read -r migration_name; do
    checksum="$(shasum -a 256 "$migrations_dir/$migration_name/migration.sql" | awk '{print $1}')"
    printf '%s\t%s\n' "$migration_name" "$checksum" >> "$evidence_dir/expected-migration-checksums.tsv"
  done < <(migrations_through_expected)

  if [ "$fake_commands" = "1" ]; then
    run_or_echo psql "$target_url" -AtX -F "$'\t'" -v ON_ERROR_STOP=1 -c "SELECT migration_name, checksum, finished_at IS NOT NULL, rolled_back_at IS NULL, logs IS NULL OR logs = '' FROM _prisma_migrations WHERE migration_name <= '$cutoff_migration' ORDER BY migration_name;"
    : > "$evidence_dir/target-prisma-migrations.tsv"
    return 0
  fi

  history_table_exists="$(psql "$target_url" -AtX -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL;")"
  if [ "$history_table_exists" != "t" ]; then
    : > "$evidence_dir/target-prisma-migrations.tsv"
    return 0
  fi

  psql "$target_url" -AtX -F $'\t' -v ON_ERROR_STOP=1 > "$evidence_dir/target-prisma-migrations.tsv" <<SQL
SELECT migration_name,
       checksum,
       finished_at IS NOT NULL AS finished,
       rolled_back_at IS NULL AS not_rolled_back,
       logs IS NULL OR logs = '' AS no_failure_logs
  FROM _prisma_migrations
 WHERE migration_name <= '$cutoff_migration'
 ORDER BY migration_name;
SQL

  node -e '
const fs = require("fs");
const expected = new Map(fs.readFileSync(process.argv[1], "utf8").trim().split(/\n/).filter(Boolean).map((line) => line.split("\t")));
const rows = fs.existsSync(process.argv[2])
  ? fs.readFileSync(process.argv[2], "utf8").trim().split(/\n/).filter(Boolean).map((line) => line.split("\t"))
  : [];
for (const [name, checksum, finished, notRolledBack, noFailureLogs] of rows) {
  if (!expected.has(name)) throw new Error(`target has unknown migration row through cutoff: ${name}`);
  if (checksum !== expected.get(name)) throw new Error(`checksum mismatch for ${name}`);
  if (finished !== "t" || notRolledBack !== "t" || noFailureLogs !== "t") throw new Error(`failed or incomplete migration row for ${name}`);
}
' "$evidence_dir/expected-migration-checksums.tsv" "$evidence_dir/target-prisma-migrations.tsv" \
    || fail "target _prisma_migrations history is not safe to resolve"
}

assert_empty_fingerprint_database() {
  local table_count
  if [ "$fake_commands" = "1" ]; then
    run_or_echo psql "$fingerprint_url" -AtX -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';"
    return 0
  fi
  table_count="$(psql "$fingerprint_url" -AtX -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")"
  if [ "$table_count" != "0" ]; then
    fail "fingerprint scratch database must start empty; public table count=$table_count"
  fi
}

build_expected_schema_on_fingerprint_db() {
  local migration_name migration_sql
  : > "$evidence_dir/fingerprint-bootstrap.log"
  while IFS= read -r migration_name; do
    migration_sql="$migrations_dir/$migration_name/migration.sql"
    run_or_echo psql "$fingerprint_url" -v ON_ERROR_STOP=1 -f "$migration_sql" >> "$evidence_dir/fingerprint-bootstrap.log"
  done < <(migrations_through_expected)
  if [ "$target_class" = "stale-clone" ] || [ "$target_class" = "prod-like-clone" ]; then
    run_or_echo psql "$fingerprint_url" -v ON_ERROR_STOP=1 -f "$db_push_source_fingerprint_sql" >> "$evidence_dir/fingerprint-bootstrap.log"
  fi
}

prove_existing_schema_matches_expected() {
  if [ "$fake_commands" = "1" ] && [ "${G007_FAKE_EXISTING_SCHEMA_DIFF_EXIT_CODE:-0}" != "0" ]; then
    run_capture_or_echo "$evidence_dir/existing-schema-drift.diff" \
      npx prisma migrate diff \
        --from-url "$target_url" \
        --to-url "$fingerprint_url" \
        --exit-code
    return "${G007_FAKE_EXISTING_SCHEMA_DIFF_EXIT_CODE:-1}"
  fi
  run_capture_or_echo "$evidence_dir/existing-schema-drift.diff" \
    npx prisma migrate diff \
      --from-url "$target_url" \
      --to-url "$fingerprint_url" \
      --exit-code
}

resolve_missing_history_through_expected() {
  local migration_name
  : > "$evidence_dir/resolve-applied.log"
  while IFS= read -r migration_name; do
    if [ -f "$evidence_dir/target-prisma-migrations.tsv" ] && awk -F '\t' -v name="$migration_name" '$1 == name { found = 1 } END { exit found ? 0 : 1 }' "$evidence_dir/target-prisma-migrations.tsv"; then
      printf 'already_applied:%s\n' "$migration_name" >> "$evidence_dir/resolve-applied.log"
      continue
    fi
    run_or_echo env DATABASE_URL="$target_url" npx prisma migrate resolve --applied "$migration_name" >> "$evidence_dir/resolve-applied.log"
  done < <(migrations_through_expected)
}

bootstrap_existing_schema_target() {
  assert_known_migration_history
  assert_empty_fingerprint_database
  build_expected_schema_on_fingerprint_db
  if ! prove_existing_schema_matches_expected; then
    echo "Existing target schema does not exactly match $expected_applied_through; see $evidence_dir/existing-schema-drift.diff." >&2
    exit 67
  fi
  resolve_missing_history_through_expected
}

assert_post_deploy_zero_drift() {
  if [ "$fake_commands" = "1" ] && [ "${G007_FAKE_POST_DEPLOY_DIFF_EXIT_CODE:-0}" != "0" ]; then
    run_capture_or_echo "$evidence_dir/post-deploy-drift.diff" \
      npx prisma migrate diff \
        --from-url "$target_url" \
        --to-schema-datamodel "$schema_path" \
        --exit-code
    echo "Post-deploy drift is nonzero; see $evidence_dir/post-deploy-drift.diff." >&2
    exit 68
  fi
  if ! run_capture_or_echo "$evidence_dir/post-deploy-drift.diff" \
    npx prisma migrate diff \
      --from-url "$target_url" \
      --to-schema-datamodel "$schema_path" \
      --exit-code; then
    echo "Post-deploy drift is nonzero; see $evidence_dir/post-deploy-drift.diff." >&2
    exit 68
  fi
}

fingerprint_stale_source() {
  local stage="$1"
  local output_path="$evidence_dir/stale-source-$stage.fingerprint"
  if [ "$fake_commands" = "1" ]; then
    run_or_echo psql "$source_url" -AtX -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'; ROLLBACK;"
    printf 'fake-source-fingerprint\n' > "$output_path"
  else
    psql "$source_url" -AtX -v ON_ERROR_STOP=1 > "$output_path" <<'SQL'
BEGIN READ ONLY;
SELECT 'public_table_count=' || COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';
SELECT 'public_enum_count=' || COUNT(*)
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = 'public'
   AND t.typtype = 'e';
ROLLBACK;
SQL
  fi
}

require_backup_file() {
  if [ "$backup_file" = "" ]; then
    fail "G007_REHEARSAL_BACKUP_FILE is required for $target_class rehearsals"
  fi
  if [ ! -f "$backup_file" ]; then
    echo "G007_REHEARSAL_BACKUP_FILE not found: $backup_file" >&2
    exit 66
  fi
  backup_sha256="$(shasum -a 256 "$backup_file" | awk '{print $1}')"
}

write_json_report() {
  local report_path="$1"
  local target_name="$2"
  local backup_sha="$3"
  cat > "$report_path" <<JSON
{
  "goal": "G007",
  "targetClass": "$target_class",
  "targetDatabase": "$target_name",
  "backupSha256": "$backup_sha",
  "expectedAppliedThrough": "$expected_applied_through",
  "fingerprintDatabase": "$fingerprint_name",
  "guards": {
    "protectedTargetRejectedBeforePgTool": true,
    "restoreEntryPoint": "apps/delivery-api/scripts/dsv-g007-restore.sh",
    "staleSourceFingerprintMatched": "$source_fingerprint_matched",
    "existingSchemaBootstrap": "$existing_schema_bootstrap"
  },
  "requiredOutcomes": [
    "backup checksum recorded",
    "restore completed on disposable clone",
    "migrate deploy completed",
    "second migrate deploy idempotent",
    "post-apply drift zero"
  ]
}
JSON
}

require_target_class
target_name="$(require_disposable_target "$target_url")"
require_stale_source_if_needed
cd "$api_root"
require_existing_schema_bootstrap_inputs

evidence_dir="$(resolve_invocation_path "$evidence_dir")"
mkdir -p "$evidence_dir"
backup_sha256=""
source_fingerprint_matched="not-applicable"
existing_schema_bootstrap="not-applicable"
fingerprint_name="not-applicable"

if is_existing_schema_target; then
  fingerprint_name="$(url_database_name "$(parse_postgres_url "$fingerprint_url")")"
fi

if [ "$target_class" = "stale-clone" ]; then
  fingerprint_stale_source "before"
  if [ "$backup_file" = "" ]; then
    if [ "$fake_commands" = "1" ]; then
      backup_file="$backup_dir/fake-stale-source.dump"
      backup_sha256="fake"
      run_or_echo "$script_dir/postgres-backup.sh"
    else
      backup_output="$(DATABASE_URL="$source_url" BACKUP_DIR="$backup_dir" "$script_dir/postgres-backup.sh")"
      backup_file="${backup_output#backup=}"
      backup_sha256="$(shasum -a 256 "$backup_file" | awk '{print $1}')"
    fi
  else
    require_backup_file
  fi
  run_or_echo env DATABASE_URL="$target_url" BACKUP_FILE="$backup_file" "$script_dir/dsv-g007-restore.sh"
elif [ "$target_class" = "restore" ] || [ "$target_class" = "recovery" ]; then
  require_backup_file
  run_or_echo env DATABASE_URL="$target_url" BACKUP_FILE="$backup_file" "$script_dir/dsv-g007-restore.sh"
fi

if is_existing_schema_target; then
  bootstrap_existing_schema_target
  existing_schema_bootstrap="proved"
fi

run_or_echo env DSV_MIGRATION_MODE=rehearsal G007_DATABASE_TARGET_CLASS="$target_class" DATABASE_URL="$target_url" "$script_dir/dsv-g007-migrate-deploy.sh"
run_or_echo env DSV_MIGRATION_MODE=rehearsal G007_DATABASE_TARGET_CLASS="$target_class" DATABASE_URL="$target_url" "$script_dir/dsv-g007-migrate-deploy.sh"
assert_post_deploy_zero_drift

if [ "$target_class" = "stale-clone" ]; then
  fingerprint_stale_source "after"
  if cmp -s "$evidence_dir/stale-source-before.fingerprint" "$evidence_dir/stale-source-after.fingerprint"; then
    source_fingerprint_matched="true"
  else
    echo "Stale source fingerprint changed during rehearsal." >&2
    exit 67
  fi
fi

write_json_report "$evidence_dir/rehearsal.json" "$target_name" "$backup_sha256"
printf 'g007_rehearsal_report=%s\n' "$evidence_dir/rehearsal.json"
