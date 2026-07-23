#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

script="apps/delivery-api/scripts/dsv-g007-restore.sh"
tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT
backup_file="$tmp_dir/backup.dump"
touch "$backup_file"

bash -n "$script"

expect_reject() {
  local url="$1"
  if DATABASE_URL="$url" BACKUP_FILE="$backup_file" G007_FAKE_COMMANDS=1 "$script" > "$tmp_dir/reject.out" 2> "$tmp_dir/reject.err"; then
    echo "expected restore guard to reject $url" >&2
    exit 1
  fi
  if rg -q 'pg_restore|would_run' "$tmp_dir/reject.out" "$tmp_dir/reject.err"; then
    echo "restore guard reached restore command for rejected URL $url" >&2
    exit 1
  fi
}

expect_accept() {
  local url="$1"
  DATABASE_URL="$url" BACKUP_FILE="$backup_file" G007_FAKE_COMMANDS=1 "$script" > "$tmp_dir/accept.out"
  rg -q 'g007_restore_guard=passed' "$tmp_dir/accept.out"
  rg -q 'would_run=' "$tmp_dir/accept.out"
}

expect_container_accept() {
  local url="$1"
  DATABASE_URL="$url" \
    BACKUP_FILE="$backup_file" \
    G007_PG_CLIENT_CONTAINER='clever-g007-postgres-16' \
    G007_FAKE_COMMANDS=1 \
    "$script" > "$tmp_dir/container-accept.out"
  rg -q 'g007_restore_guard=passed' "$tmp_dir/container-accept.out"
  rg -q 'restore_target=clever_g007_prod_like_clone_restore_guard' "$tmp_dir/container-accept.out"
  rg -q 'restore_user=clever_user' "$tmp_dir/container-accept.out"
  rg -q 'would_run: pg_restore --clean --if-exists --no-owner --no-acl --file=-' "$tmp_dir/container-accept.out"
  rg -q 'filter_newer_pg_restore_sql' "$tmp_dir/container-accept.out"
  rg -q 'docker exec -i clever-g007-postgres-16 psql -v ON_ERROR_STOP=1 -U clever_user -d clever_g007_prod_like_clone_restore_guard' "$tmp_dir/container-accept.out"
}

expect_reject 'postgresql://clever:clever@localhost:5432/clever_route'
expect_reject 'postgresql://clever:clever@localhost:5432/%63lever_route'
expect_reject 'postgresql://clever:clever@127.0.0.1:5432/clever_route'
expect_reject 'postgresql://clever:clever@127.42.0.9:5432/clever_route'
expect_reject 'postgresql://clever:clever@127.1:5432/clever_route'
expect_reject 'postgresql://clever:clever@2130706433:5432/clever_route'
expect_reject 'postgresql://clever:clever@0x7f000001:5432/clever_route'
expect_reject 'postgresql://clever:clever@[::1]:5432/clever_route'
expect_reject 'postgresql://clever:clever@[::ffff:127.0.0.1]:5432/clever_route'
expect_reject 'postgresql://clever:clever@127.0.0.1:5433/clever_route'
expect_reject 'postgresql://clever:clever@localhost:55444/clever_g007_restore_g004'
expect_reject 'postgresql://clever:clever@localhost:55455/clever_g007_restore_g005'
expect_reject 'postgresql://clever:clever@localhost:5432/clever_route_recovery_20260722'
expect_reject 'postgresql://clever:clever@localhost:5432/clever_g007_restore_%2e%2e%2fclever_route'
expect_reject 'postgresql://clever:clever@localhost:5432/not_g007'

if DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_restore_container_guard' \
  BACKUP_FILE="$backup_file" \
  G007_PG_CLIENT_CONTAINER='delivery-api-prod' \
  G007_FAKE_COMMANDS=1 \
  "$script" > "$tmp_dir/container-reject.out" 2> "$tmp_dir/container-reject.err"; then
  echo "unsafe restore client container should fail" >&2
  exit 1
fi
rg -q 'G007_PG_CLIENT_CONTAINER must start with clever-g007-' "$tmp_dir/container-reject.err"
if rg -q 'pg_restore|would_run' "$tmp_dir/container-reject.out" "$tmp_dir/container-reject.err"; then
  echo "restore guard reached docker restore command for unsafe container" >&2
  exit 1
fi

expect_accept 'postgresql://clever:clever@localhost:55456/clever_g007_stale_clone_restore_guard'
expect_accept 'postgresql://clever:clever@localhost:55456/clever_g007_prod_like_clone_restore_guard'
expect_accept 'postgresql://clever:clever@localhost:55456/clever_g007_restore_restore_guard'
expect_accept 'postgresql://clever:clever@localhost:55456/clever_g007_recovery_restore_guard'
expect_container_accept 'postgresql://clever%5Fuser:clever@localhost:55456/clever_g007_prod_like_clone_restore_guard'

python3 - <<'PY'
import pathlib

restore = pathlib.Path('apps/delivery-api/scripts/dsv-g007-restore.sh').read_text()
primitive = '"$script_dir/' + 'postgres-' + 'restore.sh"'
for needle in ['require_guarded_restore_target "$DATABASE_URL"', 'require_safe_pg_client_container "$pg_client_container"', 'filter_newer_pg_restore_sql', 'docker exec -i "$pg_client_container" psql', primitive]:
    if needle not in restore:
        raise SystemExit(f'missing restore guard contract: {needle}')
if restore.index('require_guarded_restore_target "$DATABASE_URL"') > restore.index(primitive):
    raise SystemExit('restore primitive can be reached before guard validation')
if restore.index('require_guarded_restore_target "$DATABASE_URL"') > restore.index('require_safe_pg_client_container "$pg_client_container"'):
    raise SystemExit('container validation must happen after target validation')
print('{"ok":true,"script":"apps/delivery-api/scripts/dsv-g007-restore.sh"}')
PY
