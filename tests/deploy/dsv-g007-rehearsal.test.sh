#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

script="apps/delivery-api/scripts/dsv-g007-rehearsal.sh"
tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

bash -n "$script"

rg -q "to_regclass\\('public\\._prisma_migrations'\\) IS NOT NULL" "$script"
rg -q 'db-push-source-before-20260722233000.sql.template' "$script"
rg -q 'stale-clone requires G007_EXPECTED_APPLIED_THROUGH=' "$script"

expect_reject() {
  local class="$1"
  local url="$2"
  if G007_DATABASE_TARGET_CLASS="$class" G007_REHEARSAL_DATABASE_URL="$url" G007_FAKE_COMMANDS=1 "$script" --evidence "$tmp_dir/evidence" > "$tmp_dir/reject.out" 2> "$tmp_dir/reject.err"; then
    echo "expected rehearsal guard to reject $class $url" >&2
    exit 1
  fi
  if rg -q 'would_run:.*(psql|postgres-backup|dsv-g007-restore|dsv-g007-migrate-deploy|prisma)' "$tmp_dir/reject.out" "$tmp_dir/reject.err"; then
    echo "rehearsal guard reached a DB or migration command for rejected URL $url" >&2
    exit 1
  fi
}

expect_reject empty 'postgresql://clever:clever@localhost:5432/clever_route'
expect_reject empty 'postgresql://clever:clever@localhost:5432/%63lever_route'
expect_reject empty 'postgresql://clever:clever@127.0.0.1:5433/clever_g007_empty_bad'
expect_reject empty 'postgresql://clever:clever@2130706433:5433/clever_g007_empty_bad'
expect_reject empty 'postgresql://clever:clever@[::1]:5433/clever_g007_empty_bad'
expect_reject empty 'postgresql://clever:clever@[::ffff:127.0.0.1]:5433/clever_g007_empty_bad'
expect_reject restore 'postgresql://clever:clever@localhost:55444/clever_g007_restore_g004'
expect_reject recovery 'postgresql://clever:clever@localhost:55455/clever_g007_recovery_g005'
expect_reject restore 'postgresql://clever:clever@localhost:55456/clever_g007_empty_wrong_class'

G007_DATABASE_TARGET_CLASS=empty \
G007_REHEARSAL_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_empty_rehearsal_test' \
G007_FAKE_COMMANDS=1 \
"$script" --evidence "$tmp_dir/empty-evidence" > "$tmp_dir/empty.out"
rg -q 'dsv-g007-migrate-deploy\.sh' "$tmp_dir/empty.out"
rg -q -- '--exit-code' "$tmp_dir/empty-evidence/post-deploy-drift.diff"
test -f "$tmp_dir/empty-evidence/rehearsal.json"

if rg -q 'migrate resolve --applied|fingerprint-bootstrap|existing-schema-drift' "$tmp_dir/empty.out" "$tmp_dir/empty-evidence" 2>/dev/null; then
  echo "empty target must go directly to migrate deploy without existing-schema bootstrap" >&2
  exit 1
fi

if G007_DATABASE_TARGET_CLASS=restore \
  G007_REHEARSAL_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_restore_missing_bootstrap' \
  G007_REHEARSAL_BACKUP_FILE="$tmp_dir/restore.dump" \
  G007_FAKE_COMMANDS=1 \
  "$script" --evidence "$tmp_dir/missing-bootstrap-evidence" > "$tmp_dir/missing-bootstrap.out" 2> "$tmp_dir/missing-bootstrap.err"; then
  echo "non-empty target without expected-applied-through and fingerprint DB should fail" >&2
  exit 1
fi
rg -q 'G007_EXPECTED_APPLIED_THROUGH is required' "$tmp_dir/missing-bootstrap.err"

if G007_DATABASE_TARGET_CLASS=stale-clone \
  G007_REHEARSAL_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_stale_clone_bad_fingerprint' \
  G007_STALE_SOURCE_DATABASE_URL='postgresql://clever:clever@127.0.0.1:5433/clever_route' \
  G007_FINGERPRINT_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_fingerprint_stale_old_name' \
  G007_EXPECTED_APPLIED_THROUGH='20260722150000_add_dsv_dispatch_and_resources' \
  G007_FAKE_COMMANDS=1 \
  "$script" --evidence "$tmp_dir/bad-fingerprint-evidence" > "$tmp_dir/bad-fingerprint.out" 2> "$tmp_dir/bad-fingerprint.err"; then
  echo "stale-clone target with generic fingerprint DB should fail" >&2
  exit 1
fi
rg -q 'fingerprint scratch database name does not match target class stale-clone' "$tmp_dir/bad-fingerprint.err"

G007_DATABASE_TARGET_CLASS=stale-clone \
G007_REHEARSAL_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_stale_clone_rehearsal_test' \
G007_STALE_SOURCE_DATABASE_URL='postgresql://clever:clever@127.0.0.1:5433/clever_route' \
G007_FINGERPRINT_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_stale_fingerprint_test' \
G007_EXPECTED_APPLIED_THROUGH='20260722150000_add_dsv_dispatch_and_resources' \
G007_FAKE_COMMANDS=1 \
"$script" --evidence "$tmp_dir/stale-evidence" > "$tmp_dir/stale.out"
rg -q 'postgres-backup\.sh' "$tmp_dir/stale.out"
rg -q 'dsv-g007-restore\.sh' "$tmp_dir/stale.out"
rg -q 'psql .*20260520000000_initial_route_ops_baseline/migration\.sql' "$tmp_dir/stale-evidence/fingerprint-bootstrap.log"
rg -q 'psql .*20260722150000_add_dsv_dispatch_and_resources/migration\.sql' "$tmp_dir/stale-evidence/fingerprint-bootstrap.log"
rg -q 'psql .*db-push-source-before-20260722233000\.sql' "$tmp_dir/stale-evidence/fingerprint-bootstrap.log"
rg -q 'prisma migrate resolve --applied 20260520000000_initial_route_ops_baseline' "$tmp_dir/stale-evidence/resolve-applied.log"
rg -q 'prisma migrate resolve --applied 20260722150000_add_dsv_dispatch_and_resources' "$tmp_dir/stale-evidence/resolve-applied.log"
rg -q -- '--to-url postgresql://clever:clever@localhost:55456/clever_g007_stale_fingerprint_test --exit-code' "$tmp_dir/stale-evidence/existing-schema-drift.diff"
rg -q 'dsv-g007-migrate-deploy\.sh' "$tmp_dir/stale.out"
test -f "$tmp_dir/stale-evidence/rehearsal.json"

G007_DATABASE_TARGET_CLASS=prod-like-clone \
G007_REHEARSAL_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_prod_like_clone_rehearsal_test' \
G007_FINGERPRINT_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_prod_like_fingerprint_test' \
G007_EXPECTED_APPLIED_THROUGH='20260722223000_drop_legacy_single_tenant_fks' \
G007_FAKE_COMMANDS=1 \
"$script" --evidence "$tmp_dir/prod-like-evidence" > "$tmp_dir/prod-like.out"
rg -q 'migrate resolve --applied' "$tmp_dir/prod-like-evidence/resolve-applied.log"
rg -q 'psql .*db-push-source-before-20260722233000\.sql' "$tmp_dir/prod-like-evidence/fingerprint-bootstrap.log"
rg -q -- '--to-url postgresql://clever:clever@localhost:55456/clever_g007_prod_like_fingerprint_test --exit-code' "$tmp_dir/prod-like-evidence/existing-schema-drift.diff"
rg -q 'dsv-g007-migrate-deploy\.sh' "$tmp_dir/prod-like.out"
test -f "$tmp_dir/prod-like-evidence/rehearsal.json"

touch "$tmp_dir/restore.dump"
G007_DATABASE_TARGET_CLASS=restore \
G007_REHEARSAL_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_restore_rehearsal_test' \
G007_REHEARSAL_BACKUP_FILE="$tmp_dir/restore.dump" \
G007_FINGERPRINT_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_fingerprint_restore_test' \
G007_EXPECTED_APPLIED_THROUGH='20260722213000_dsv_assignment_eta_state' \
G007_FAKE_COMMANDS=1 \
"$script" --evidence "$tmp_dir/restore-evidence" > "$tmp_dir/restore.out"
rg -q 'dsv-g007-restore\.sh' "$tmp_dir/restore.out"
rg -q 'migrate resolve --applied' "$tmp_dir/restore-evidence/resolve-applied.log"
rg -q 'dsv-g007-migrate-deploy\.sh' "$tmp_dir/restore.out"
test -f "$tmp_dir/restore-evidence/rehearsal.json"

if G007_DATABASE_TARGET_CLASS=restore \
  G007_REHEARSAL_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_restore_diff_fail' \
  G007_REHEARSAL_BACKUP_FILE="$tmp_dir/restore.dump" \
  G007_FINGERPRINT_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_fingerprint_diff_fail' \
  G007_EXPECTED_APPLIED_THROUGH='20260722213000_dsv_assignment_eta_state' \
  G007_FAKE_EXISTING_SCHEMA_DIFF_EXIT_CODE=2 \
  G007_FAKE_COMMANDS=1 \
  "$script" --evidence "$tmp_dir/diff-fail-evidence" > "$tmp_dir/diff-fail.out" 2> "$tmp_dir/diff-fail.err"; then
  echo "non-empty target with nonzero proof diff must fail" >&2
  exit 1
fi
rg -q 'Existing target schema does not exactly match' "$tmp_dir/diff-fail.err"
if rg -q 'migrate resolve --applied|dsv-g007-migrate-deploy\.sh' "$tmp_dir/diff-fail.out" "$tmp_dir/diff-fail-evidence/resolve-applied.log" 2>/dev/null; then
  echo "failed existing-schema proof must not resolve or deploy" >&2
  exit 1
fi

if G007_DATABASE_TARGET_CLASS=empty \
  G007_REHEARSAL_DATABASE_URL='postgresql://clever:clever@localhost:55456/clever_g007_empty_drift_fail' \
  G007_FAKE_POST_DEPLOY_DIFF_EXIT_CODE=2 \
  G007_FAKE_COMMANDS=1 \
  "$script" --evidence "$tmp_dir/post-drift-fail-evidence" > "$tmp_dir/post-drift-fail.out" 2> "$tmp_dir/post-drift-fail.err"; then
  echo "post-deploy nonzero drift must fail" >&2
  exit 1
fi
rg -q 'Post-deploy drift is nonzero' "$tmp_dir/post-drift-fail.err"

python3 - <<'PY'
import pathlib

script = pathlib.Path('apps/delivery-api/scripts/dsv-g007-rehearsal.sh').read_text()
for forbidden in ['docker volume rm', 'docker compose down -v', 'prisma migrate reset', '--force-reset', '--accept-data-loss']:
    if forbidden in script:
        raise SystemExit(f'forbidden destructive command appears in rehearsal script: {forbidden}')
for required in ['require_disposable_target "$target_url"', 'require_existing_schema_bootstrap_inputs', 'prisma migrate resolve --applied', '--exit-code', 'postgres-backup.sh', 'dsv-g007-restore.sh', 'dsv-g007-migrate-deploy.sh']:
    if required not in script:
        raise SystemExit(f'missing rehearsal contract: {required}')
if 'cutoff_migration="20260723013000_g010_import_row_resource_tenant_fks"' not in script:
    raise SystemExit('rehearsal cutoff must track the current G010 latest migration')
main = script.split('require_target_class\n', 1)[1]
if main.index('require_disposable_target "$target_url"') > main.index('run_or_echo'):
    raise SystemExit('rehearsal can run commands before target validation')
if main.index('bootstrap_existing_schema_target') > main.index('dsv-g007-migrate-deploy.sh'):
    raise SystemExit('non-empty existing schema bootstrap must happen before migrate deploy')
print('{"ok":true,"script":"apps/delivery-api/scripts/dsv-g007-rehearsal.sh"}')
PY
