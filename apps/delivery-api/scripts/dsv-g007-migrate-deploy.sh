#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api_root="$(cd "$script_dir/.." && pwd)"
prisma_bin="$api_root/node_modules/.bin/prisma"
production_baseline_manifest="$api_root/prisma/production-baselines/dsv-production-20260723.json"

fail() {
  echo "dsv-g007-migrate-deploy: $*" >&2
  exit 1
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "$name is required"
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

require_env DSV_MIGRATION_MODE
require_env DATABASE_URL

production_baseline_history() {
  (
    cd "$api_root"
    node <<'NODE'
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const exists = await client.query(
      "SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists",
    );
    if (!exists.rows[0].exists) {
      process.stdout.write('__ABSENT__\n');
      return;
    }
    const result = await client.query(`
      SELECT migration_name,
             checksum,
             finished_at IS NOT NULL AS finished,
             rolled_back_at IS NULL AS not_rolled_back,
             COALESCE(logs, '') = '' AS no_failure_logs
        FROM public._prisma_migrations
       ORDER BY migration_name
    `);
    for (const row of result.rows) {
      process.stdout.write([
        row.migration_name,
        row.checksum,
        row.finished,
        row.not_rolled_back,
        row.no_failure_logs,
      ].join('\t') + '\n');
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
NODE
  )
}

run_production_baseline_if_approved() {
  local manifest_sha expected_manifest_sha expected_through expected_schema_sha
  local history_file expected_file all_expected_file migration_path migration_name checksum
  local has_post_baseline_history=0

  if [[ "${DSV_PRODUCTION_BASELINE_APPROVED:-}" != "1" ]]; then
    return 0
  fi
  [[ -x "$prisma_bin" ]] || fail "production baseline requires Prisma CLI at $prisma_bin"
  [[ -f "$production_baseline_manifest" ]] || fail "production baseline manifest is missing"
  require_env DSV_PRODUCTION_BASELINE_MANIFEST_SHA256
  [[ "$DSV_PRODUCTION_BASELINE_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    || fail "DSV_PRODUCTION_BASELINE_MANIFEST_SHA256 must be 64 lowercase hex characters"

  manifest_sha="$(sha256_file "$production_baseline_manifest")"
  [[ "$manifest_sha" == "$DSV_PRODUCTION_BASELINE_MANIFEST_SHA256" ]] \
    || fail "production baseline manifest SHA mismatch"

  read -r expected_through expected_schema_sha < <(
    node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!/^20[0-9]{12}_[a-z0-9_]+$/.test(manifest.expectedAppliedThrough || "")) process.exit(1);
if (!/^[0-9a-f]{64}$/.test(manifest.schemaSha256 || "")) process.exit(1);
process.stdout.write(`${manifest.expectedAppliedThrough} ${manifest.schemaSha256}\n`);
' "$production_baseline_manifest"
  ) || fail "production baseline manifest is invalid"
  [[ -f "$api_root/prisma/migrations/$expected_through/migration.sql" ]] \
    || fail "production baseline boundary is not a checked-in migration"

  history_file="$(mktemp "${TMPDIR:-/tmp}/dsv-production-baseline-history.XXXXXX")"
  expected_file="$(mktemp "${TMPDIR:-/tmp}/dsv-production-baseline-expected.XXXXXX")"
  all_expected_file="$(mktemp "${TMPDIR:-/tmp}/dsv-production-baseline-all-expected.XXXXXX")"
  trap 'rm -f "$history_file" "$expected_file" "$all_expected_file"' RETURN
  production_baseline_history > "$history_file" \
    || fail "could not read production migration history"

  : > "$expected_file"
  : > "$all_expected_file"
  for migration_path in "$api_root"/prisma/migrations/*/migration.sql; do
    migration_name="$(basename "$(dirname "$migration_path")")"
    checksum="$(sha256_file "$migration_path")"
    printf '%s\t%s\n' "$migration_name" "$checksum" >> "$all_expected_file"
    if [[ "$migration_name" < "$expected_through" || "$migration_name" == "$expected_through" ]]; then
      printf '%s\t%s\n' "$migration_name" "$checksum" >> "$expected_file"
    fi
  done

  if ! grep -Fxq '__ABSENT__' "$history_file"; then
    while IFS=$'\t' read -r migration_name checksum finished not_rolled_back no_failure_logs; do
      [[ -z "$migration_name" ]] && continue
      expected_manifest_sha="$(awk -F '\t' -v name="$migration_name" '$1 == name { print $2 }' "$all_expected_file")"
      [[ -n "$expected_manifest_sha" ]] \
        || fail "production migration history contains unknown migration $migration_name"
      [[ "$checksum" == "$expected_manifest_sha" ]] \
        || fail "production migration checksum mismatch for $migration_name"
      [[ "$finished" == "true" && "$not_rolled_back" == "true" && "$no_failure_logs" == "true" ]] \
        || fail "production migration history contains failed migration $migration_name"
      if [[ "$migration_name" > "$expected_through" ]]; then
        has_post_baseline_history=1
      fi
    done < "$history_file"
  fi

  if [[ "$has_post_baseline_history" == "1" ]]; then
    while IFS=$'\t' read -r migration_name checksum; do
      if ! awk -F '\t' -v name="$migration_name" '$1 == name { found = 1 } END { exit found ? 0 : 1 }' "$history_file"; then
        fail "production migration history advanced past baseline with missing prefix $migration_name"
      fi
    done < "$expected_file"
    echo "dsv-g007-migrate-deploy: production baseline already advanced beyond $expected_through"
    return 0
  fi

  local actual_schema_sha
  actual_schema_sha="$(
    "$prisma_bin" migrate diff \
      --from-empty \
      --to-url "$DATABASE_URL" \
      --script \
      | sha256_stream
  )" || fail "could not fingerprint production schema"
  [[ "$actual_schema_sha" == "$expected_schema_sha" ]] \
    || fail "production schema fingerprint does not match the approved baseline"

  while IFS=$'\t' read -r migration_name checksum; do
    if awk -F '\t' -v name="$migration_name" '$1 == name { found = 1 } END { exit found ? 0 : 1 }' "$history_file"; then
      continue
    fi
    echo "dsv-g007-migrate-deploy: resolving approved production baseline $migration_name"
    DATABASE_URL="$DATABASE_URL" "$prisma_bin" migrate resolve --applied "$migration_name"
  done < "$expected_file"
}

case "$DSV_MIGRATION_MODE" in
  rehearsal|compose-dev|production) ;;
  *) fail "DSV_MIGRATION_MODE must be one of: rehearsal, compose-dev, production" ;;
esac

parsed="$(
  node -e '
const { URL } = require("url");
const raw = process.env.DATABASE_URL;
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
    databaseName,
    port: url.port || "",
    isLoopback: isLoopbackHost(host)
  }));
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
'
)" || fail "DATABASE_URL must be a valid PostgreSQL URL"

database_host="$(node -e 'const parsed = JSON.parse(process.argv[1]); process.stdout.write(parsed.host);' "$parsed")"
database_name="$(node -e 'const parsed = JSON.parse(process.argv[1]); process.stdout.write(parsed.databaseName);' "$parsed")"
database_port="$(node -e 'const parsed = JSON.parse(process.argv[1]); process.stdout.write(parsed.port);' "$parsed")"
database_is_loopback="$(node -e 'const parsed = JSON.parse(process.argv[1]); process.stdout.write(parsed.isLoopback ? "1" : "0");' "$parsed")"

case "$database_name" in
  clever_route_recovery_20260722)
    fail "refusing protected recovery database clever_route_recovery_20260722"
    ;;
esac

if [[ "$database_is_loopback" == "1" && "$database_name" == "clever_route" ]]; then
  fail "refusing protected local clever_route target"
fi

if [[ "$database_is_loopback" == "1" && "$database_port" == "5433" ]]; then
  fail "refusing stale local PostgreSQL 5433 migration target"
fi

case "$DSV_MIGRATION_MODE" in
  rehearsal)
    require_env G007_DATABASE_TARGET_CLASS
    case "$G007_DATABASE_TARGET_CLASS" in
      empty|stale-clone|prod-like-clone|restore|recovery) ;;
      *) fail "G007_DATABASE_TARGET_CLASS must be one of: empty, stale-clone, prod-like-clone, restore, recovery" ;;
    esac
    case "$database_name" in
      clever_g007_empty_*|clever_g007_stale_clone_*|clever_g007_prod_like_clone_*|clever_g007_restore_*|clever_g007_recovery_*) ;;
      *) fail "rehearsal mode requires a disposable clever_g007_* database" ;;
    esac
    case "$G007_DATABASE_TARGET_CLASS:$database_name" in
      empty:clever_g007_empty_*|stale-clone:clever_g007_stale_clone_*|prod-like-clone:clever_g007_prod_like_clone_*|restore:clever_g007_restore_*|recovery:clever_g007_recovery_*) ;;
      *) fail "G007_DATABASE_TARGET_CLASS does not match DATABASE_URL database name" ;;
    esac
    ;;
  compose-dev)
    if [[ "$database_host" != "postgres" || "$database_name" != "clever_route" ]]; then
      fail "compose-dev mode requires postgres/clever_route"
    fi
    if [[ "${DSV_DEV_FRESH_VOLUME:-}" != "1" ]]; then
      fail "compose-dev mode requires DSV_DEV_FRESH_VOLUME=1"
    fi
    require_env DSV_DEV_VOLUME_NAME
    if [[ "${DSV_DEV_VOLUME_NAME:-}" == "dsv-postgres" ]]; then
      fail "compose-dev mode refuses old dsv-postgres volume"
    fi
    ;;
  production)
    if [[ "$database_is_loopback" == "1" || "$database_host" == "0.0.0.0" ]]; then
      fail "production mode refuses local database hosts"
    fi
    if [[ "$database_name" != "clever_route" ]]; then
      fail "production mode requires clever_route database"
    fi
    if [[ "${DSV_MIGRATION_APPROVED:-}" != "1" ]]; then
      fail "production mode requires DSV_MIGRATION_APPROVED=1"
    fi
    if [[ ! "${DSV_MIGRATION_MANIFEST_SHA256:-}" =~ ^[0-9a-f]{64}$ ]]; then
      fail "production mode requires DSV_MIGRATION_MANIFEST_SHA256 as 64 lowercase hex characters"
    fi
    if [[ ! "${DSV_RESTORE_REHEARSAL_SHA256:-}" =~ ^[0-9a-f]{64}$ ]]; then
      fail "production mode requires DSV_RESTORE_REHEARSAL_SHA256 as 64 lowercase hex characters"
    fi
    if [[ -n "${DSV_PRODUCTION_BASELINE_APPROVED:-}" && "${DSV_PRODUCTION_BASELINE_APPROVED:-}" != "1" ]]; then
      fail "DSV_PRODUCTION_BASELINE_APPROVED must be empty or 1"
    fi
    ;;
esac

echo "dsv-g007-migrate-deploy: validated $DSV_MIGRATION_MODE target $database_host/$database_name"
if [[ "$DSV_MIGRATION_MODE" == "production" ]]; then
  run_production_baseline_if_approved
fi
exec npm --prefix "$api_root" run prisma:migrate:deploy
