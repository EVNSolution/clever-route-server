#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api_root="$(cd "$script_dir/.." && pwd)"

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

require_env DSV_MIGRATION_MODE
require_env DATABASE_URL

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
    ;;
esac

echo "dsv-g007-migrate-deploy: validated $DSV_MIGRATION_MODE target $database_host/$database_name"
exec npm --prefix "$api_root" run prisma:migrate:deploy
