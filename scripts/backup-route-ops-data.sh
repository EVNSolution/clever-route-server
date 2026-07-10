#!/usr/bin/env bash
set -euo pipefail

BACKUP_ROOT="${ROUTE_OPS_BACKUP_ROOT:-/mnt/clever-delivery-postgres/backups}"
MIN_FREE_GIB="${ROUTE_OPS_BACKUP_MIN_FREE_GIB:-20}"
MAX_BACKUP_GIB="${ROUTE_OPS_BACKUP_MAX_GIB:-10}"
REQUIRE_SEPARATE_FS="${ROUTE_OPS_BACKUP_REQUIRE_SEPARATE_FS:-1}"
POSTGRES_CONTAINER="${ROUTE_OPS_POSTGRES_CONTAINER:-clever-route-postgres-1}"
STORE_SQLITE="${SHOPIFY_STORE_SQLITE_PATH:-/srv/shopify-clever/data/shopify/dev.sqlite}"
DEV_SQLITE="${SHOPIFY_DEV_SQLITE_PATH:-/srv/shopify-clever-dev/data/shopify/dev.sqlite}"
KFOOD_SQLITE="${SHOPIFY_KFOOD_SQLITE_PATH:-/srv/shopify-clever-kfood/data/shopify/dev.sqlite}"
DAILY_KEEP="${ROUTE_OPS_BACKUP_DAILY_KEEP:-7}"
WEEKLY_KEEP="${ROUTE_OPS_BACKUP_WEEKLY_KEEP:-4}"
MONTHLY_KEEP="${ROUTE_OPS_BACKUP_MONTHLY_KEEP:-3}"
PRECHECK_ONLY=0

usage() {
  echo "Usage: $0 [--preflight]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --preflight) PRECHECK_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
  shift
done

fail() { echo "route-ops-backup: $*" >&2; exit 65; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }
is_nonnegative_integer() { [[ "$1" =~ ^[0-9]+$ ]]; }

for value in "$MIN_FREE_GIB" "$MAX_BACKUP_GIB" "$DAILY_KEEP" "$WEEKLY_KEEP" "$MONTHLY_KEEP"; do
  is_nonnegative_integer "$value" || fail "retention and capacity values must be non-negative integers"
done
test "$DAILY_KEEP" -gt 0 || fail "daily retention must be positive"
test "$WEEKLY_KEEP" -gt 0 || fail "weekly retention must be positive"
test "$MONTHLY_KEEP" -gt 0 || fail "monthly retention must be positive"

for command_name in docker python3 gzip sha256sum flock df du cp; do require_cmd "$command_name"; done
for sqlite_path in "$STORE_SQLITE" "$DEV_SQLITE" "$KFOOD_SQLITE"; do
  test -f "$sqlite_path" || fail "missing Shopify SQLite database: $sqlite_path"
done
docker inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1 || fail "missing PostgreSQL container: $POSTGRES_CONTAINER"

backup_parent="$(dirname "$BACKUP_ROOT")"
test -d "$backup_parent" || fail "backup parent mount is missing: $backup_parent"
if [ "$REQUIRE_SEPARATE_FS" = "1" ]; then
  root_device="$(df -P / | awk 'NR==2 {print $1}')"
  backup_device="$(df -P "$backup_parent" | awk 'NR==2 {print $1}')"
  test "$root_device" != "$backup_device" || fail "backup root must use a filesystem separate from /"
fi

free_kib="$(df -Pk "$backup_parent" | awk 'NR==2 {print $4}')"
min_free_kib=$((MIN_FREE_GIB * 1024 * 1024))
test "$free_kib" -ge "$min_free_kib" || fail "backup filesystem has less than ${MIN_FREE_GIB}GiB free"

if [ "$PRECHECK_ONLY" = "1" ]; then
  printf 'route-ops-backup preflight ok: root=%s freeKiB=%s minFreeGiB=%s maxBackupGiB=%s\n' "$BACKUP_ROOT" "$free_kib" "$MIN_FREE_GIB" "$MAX_BACKUP_GIB"
  exit 0
fi

mkdir -p "$BACKUP_ROOT"/{daily,weekly,monthly}
chmod 0700 "$BACKUP_ROOT" "$BACKUP_ROOT"/{daily,weekly,monthly}
exec 9>"$BACKUP_ROOT/.backup.lock"
flock -n 9 || fail "another backup is already running"

current_kib="$(du -sk "$BACKUP_ROOT" | awk '{print $1}')"
max_backup_kib=$((MAX_BACKUP_GIB * 1024 * 1024))
test "$current_kib" -le "$max_backup_kib" || fail "existing backups already exceed ${MAX_BACKUP_GIB}GiB"

read -r stamp iso_weekday day_of_month <<EOF_TIME
$(python3 - "${ROUTE_OPS_BACKUP_NOW:-}" <<'PY'
from datetime import datetime, timezone
import sys
raw = sys.argv[1].strip()
now = datetime.now(timezone.utc) if not raw else datetime.fromisoformat(raw.replace('Z', '+00:00')).astimezone(timezone.utc)
print(now.strftime('%Y%m%dT%H%M%SZ'), now.isoweekday(), now.strftime('%d'))
PY
)
EOF_TIME

staging="$BACKUP_ROOT/daily/.tmp-$stamp-$$"
daily="$BACKUP_ROOT/daily/$stamp"
weekly="$BACKUP_ROOT/weekly/$stamp"
monthly="$BACKUP_ROOT/monthly/$stamp"
test ! -e "$daily" || fail "backup already exists: $daily"
mkdir -p "$staging/postgres" "$staging/shopify-sqlite"
chmod 0700 "$staging" "$staging/postgres" "$staging/shopify-sqlite"
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT

docker exec "$POSTGRES_CONTAINER" sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z9 --no-owner --no-privileges' > "$staging/postgres/clever_route.dump"
docker exec -i "$POSTGRES_CONTAINER" sh -lc 'pg_restore --list >/dev/null' < "$staging/postgres/clever_route.dump"
docker exec "$POSTGRES_CONTAINER" sh -lc 'pg_dumpall -U "$POSTGRES_USER" --globals-only' | gzip -9 > "$staging/postgres/globals.sql.gz"

python3 - "$STORE_SQLITE" "$staging/shopify-sqlite/store.sqlite" \
          "$DEV_SQLITE" "$staging/shopify-sqlite/dev.sqlite" \
          "$KFOOD_SQLITE" "$staging/shopify-sqlite/kfood.sqlite" <<'PY'
import pathlib, sqlite3, sys
for source, destination in zip(sys.argv[1::2], sys.argv[2::2]):
    target = pathlib.Path(destination)
    with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
        result = dst.execute('pragma integrity_check').fetchone()
        if result is None or result[0] != 'ok':
            raise SystemExit(f'SQLite integrity check failed: {source}')
    target.chmod(0o600)
PY

(
  cd "$staging"
  find postgres shopify-sqlite -type f -print0 | sort -z | xargs -0 sha256sum > manifest.sha256
  sha256sum -c manifest.sha256 >/dev/null
)
cat > "$staging/metadata.json" <<EOF_METADATA
{"createdAt":"$stamp","dailyRetention":$DAILY_KEEP,"weeklyRetention":$WEEKLY_KEEP,"monthlyRetention":$MONTHLY_KEEP,"minFreeGiB":$MIN_FREE_GIB,"maxBackupGiB":$MAX_BACKUP_GIB}
EOF_METADATA
chmod -R go-rwx "$staging"
mv "$staging" "$daily"
trap - EXIT

if [ "$iso_weekday" = "7" ]; then cp -al "$daily" "$weekly"; fi
if [ "$day_of_month" = "01" ]; then cp -al "$daily" "$monthly"; fi

python3 - "$BACKUP_ROOT" "$DAILY_KEEP" "$WEEKLY_KEEP" "$MONTHLY_KEEP" <<'PY'
import pathlib, shutil, sys
root = pathlib.Path(sys.argv[1])
for tier, keep in zip(('daily', 'weekly', 'monthly'), map(int, sys.argv[2:])):
    entries = sorted(path for path in (root / tier).iterdir() if path.is_dir() and not path.name.startswith('.tmp-'))
    for expired in entries[:-keep]:
        shutil.rmtree(expired)
PY

final_kib="$(du -sk "$BACKUP_ROOT" | awk '{print $1}')"
if [ "$final_kib" -gt "$max_backup_kib" ]; then
  rm -rf "$daily" "$weekly" "$monthly"
  fail "backup set would exceed ${MAX_BACKUP_GIB}GiB"
fi

printf 'route-ops-backup completed: snapshot=%s sizeKiB=%s freeKiB=%s\n' "$daily" "$final_kib" "$(df -Pk "$backup_parent" | awk 'NR==2 {print $4}')"
