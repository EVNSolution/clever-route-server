#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

worker="scripts/backup-route-ops-data.sh"
installer="scripts/ssm-install-route-ops-backup.sh"
workflow=".github/workflows/route-ops-backup.yml"

for path in "$worker" "$installer" "$workflow"; do
  test -f "$path" || { echo "missing backup artifact: $path" >&2; exit 1; }
done

bash -n "$worker" "$installer"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/route-ops-backup-test.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

mkdir -p "$tmp/bin" "$tmp/sqlite" "$tmp/backups"
cat > "$tmp/bin/docker" <<'EOF_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *pg_dumpall*--globals-only*) printf '%s\n' 'CREATE ROLE clever;' ;;
  *'pg_dump '*'-Fc'*) printf '%s\n' 'fake-custom-dump' ;;
  *'pg_restore --list'*) cat >/dev/null; printf '%s\n' 'TABLE public orders' ;;
  inspect*) exit 0 ;;
  *) echo "unexpected docker command: $*" >&2; exit 1 ;;
esac
EOF_DOCKER
chmod +x "$tmp/bin/docker"
cat > "$tmp/bin/flock" <<'EOF_FLOCK'
#!/usr/bin/env sh
exit 0
EOF_FLOCK
chmod +x "$tmp/bin/flock"

python3 - "$tmp/sqlite" <<'PY'
import pathlib, sqlite3, sys
root = pathlib.Path(sys.argv[1])
for name in ('store', 'dev', 'kfood'):
    path = root / f'{name}.sqlite'
    with sqlite3.connect(path) as db:
        db.execute('create table sessions (id text primary key)')
        db.execute('insert into sessions values (?)', (name,))
PY

run_backup() {
  env \
    PATH="$tmp/bin:$PATH" \
    ROUTE_OPS_BACKUP_ROOT="$tmp/backups" \
    ROUTE_OPS_BACKUP_REQUIRE_SEPARATE_FS=0 \
    ROUTE_OPS_BACKUP_MIN_FREE_GIB=0 \
    ROUTE_OPS_BACKUP_MAX_GIB=10 \
    ROUTE_OPS_BACKUP_NOW="$1" \
    SHOPIFY_STORE_SQLITE_PATH="$tmp/sqlite/store.sqlite" \
    SHOPIFY_DEV_SQLITE_PATH="$tmp/sqlite/dev.sqlite" \
    SHOPIFY_KFOOD_SQLITE_PATH="$tmp/sqlite/kfood.sqlite" \
    "$worker"
}

run_backup 2026-08-01T18:00:00Z
snapshot="$(find "$tmp/backups/daily" -mindepth 1 -maxdepth 1 -type d | head -1)"
test -s "$snapshot/postgres/clever_route.dump"
test -s "$snapshot/postgres/globals.sql.gz"
test -s "$snapshot/shopify-sqlite/store.sqlite"
test -s "$snapshot/shopify-sqlite/dev.sqlite"
test -s "$snapshot/shopify-sqlite/kfood.sqlite"
test -s "$snapshot/manifest.sha256"
test "$(find "$tmp/backups/monthly" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = 1

for day in 02 03 04 05 06 07 08 09 10; do
  run_backup "2026-08-${day}T18:00:00Z" >/dev/null
done
test "$(find "$tmp/backups/daily" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = 7
test "$(find "$tmp/backups/weekly" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -le 4
test "$(find "$tmp/backups/monthly" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -le 3

params_path="$("$installer" --dry-run --no-send)"
trap 'rm -rf "$tmp"; rm -f "$params_path"' EXIT
python3 - "$params_path" <<'PY'
import json, pathlib, sys
command = json.loads(pathlib.Path(sys.argv[1]).read_text())['commands'][0]
checks = {
    'worker_embedded': 'WORKER_B64=' in command and 'base64 -d > "$candidate"' in command,
    'data_ebs_path': '/mnt/clever-delivery-postgres/backups' in command,
    'timer_03_kst': 'OnCalendar=*-*-* 18:00:00 UTC' in command,
    'persistent_timer': 'Persistent=true' in command,
    'dry_run_before_mutation': command.index('if [ "$DRY_RUN" = "1" ]') < command.index('install -m 0750 "$candidate"'),
    'installs_service_timer': 'clever-route-backup.service' in command and 'clever-route-backup.timer' in command,
    'does_not_restart_runtime': 'docker compose' not in command and 'restart clever-route-api' not in command,
}
missing = [name for name, ok in checks.items() if not ok]
if missing:
    raise SystemExit(f'missing backup installer guard(s): {missing}')
PY

grep -Fq 'id-token: write' "$workflow"
grep -Fq 'dry_run:' "$workflow"
grep -Fq 'run_backup:' "$workflow"
grep -Fq 'scripts/ssm-install-route-ops-backup.sh' "$workflow"

printf '{"ok":true,"backup":"%s"}\n' "$worker"
