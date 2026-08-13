#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

rendered="$(ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP=true ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED=true scripts/monitor-route-ops-production.sh --render-host-script)"

case "$rendered" in
  *"SECTION=host_disk"*"SECTION=production_smoke"*) ;;
  *) echo "monitor host script must include status and smoke sections" >&2; exit 1 ;;
esac
case "$rendered" in
  *"export ROUTE_OPS_MONITOR_STATUS_ONLY=false"*"export ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP=true"*"export ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED=true"*) ;;
  *) echo "monitor host script must render self-contained production defaults for SSM" >&2; exit 1 ;;
esac
case "$rendered" in
  *"ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP"*"ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED"*) ;;
  *) echo "monitor host script must pass production smoke expectation env" >&2; exit 1 ;;
esac
case "$rendered" in
  *"docker', 'run', '--rm'"*"/tmp/route-ops-smoke.mjs"*) ;;
  *) echo "monitor smoke must run through the deployed runtime image instead of host node" >&2; exit 1 ;;
esac
case "$rendered" in
  *"clever_admin_ui=<redacted>"*|*"clever_admin_ui=[^"*) ;;
  *) echo "monitor output must redact admin cookies" >&2; exit 1 ;;
esac

status_only="$(scripts/monitor-route-ops-production.sh --render-host-script --status-only)"
case "$status_only" in
  *"export ROUTE_OPS_MONITOR_STATUS_ONLY=true"* ) ;;
  *) echo "monitor host script must support status-only mode" >&2; exit 1 ;;
esac

g007_status="$(scripts/monitor-route-ops-production.sh --render-host-script --status-only --g007-json-status)"
case "$g007_status" in
  *"export ROUTE_OPS_MONITOR_G007_JSON_STATUS=true"*"SECTION=g007_json_status"*) ;;
  *) echo "monitor host script must support opt-in G007 JSON status mode" >&2; exit 1 ;;
esac
case "$g007_status" in
  *"export ROUTE_OPS_G007_STATUS_BASE_URL=''"*) ;;
  *) echo "G007 JSON status must default to no external status URL" >&2; exit 1 ;;
esac
case "$g007_status" in
  *"urlopen(f'http://127.0.0.1:3000{path}'"*) echo "G007 JSON status must not probe host-local 127.0.0.1:3000" >&2; exit 1 ;;
esac
case "$g007_status" in
  *"'docker', 'exec', api_container, 'node', '-e'"*"fetch('http://127.0.0.1:3000'+path)"*) ;;
  *) echo "G007 JSON status must use the API container for default health/readiness probes" >&2; exit 1 ;;
esac
case "$g007_status" in
  *"ROUTE_OPS_G007_OBSERVATION_REPORT_B64"*"ROUTE_OPS_G007_OBSERVATION_REPORT_PATH"*"deployed_migration_names"*) ;;
  *) echo "G007 JSON status must embed legacy observation and inspect migrations from the deployed image" >&2; exit 1 ;;
esac
case "$rendered" in
  *"export ROUTE_OPS_MONITOR_G007_JSON_STATUS=false"*) ;;
  *) echo "default monitor must render G007 JSON status as disabled" >&2; exit 1 ;;
esac
case "$g007_status" in *"legacyUsage"*) ;; *) echo "G007 JSON status must include legacy usage output" >&2; exit 1 ;; esac
case "$g007_status" in *"invariantFailures"*) ;; *) echo "G007 JSON status must include invariant output" >&2; exit 1 ;; esac
case "$g007_status" in *"latestMigration"*) ;; *) echo "G007 JSON status must include migration output" >&2; exit 1 ;; esac
case "$g007_status" in *"20260731140000_account_scope_driver_push_tokens"*) ;; *) echo "G007 JSON status must require the latest migration" >&2; exit 1 ;; esac
case "$g007_status" in *"eta_input_route_version_mismatches"*"route_plan.status NOT IN ('CANCELLED', 'COMPLETED')"*) ;;
  *) echo "G007 invariant must compare active route-plan ETA input versions to the current child version regardless of etaStatus" >&2; exit 1 ;;
esac
case "$g007_status" in *"\"etaStatus\" = 'STALE'"*) echo "G007 invariant must not only count stale ETA statuses" >&2; exit 1 ;; esac
case "$g007_status" in *"expectedCount"*"appliedCount"*"pendingCount"*"failedCount"*"pendingMigrations"*) ;;
  *) echo "G007 JSON status must report expected, applied, pending, failed counts and pending names" >&2; exit 1 ;;
esac

configured_status="$(ROUTE_OPS_G007_STATUS_BASE_URL=https://route.example.invalid scripts/monitor-route-ops-production.sh --render-host-script --status-only --g007-json-status)"
case "$configured_status" in
  *"export ROUTE_OPS_G007_STATUS_BASE_URL=https://route.example.invalid"*"urlopen(f'{configured_status_base_url}{path}'"*) ;;
  *) echo "G007 JSON status must support an explicit configured external URL" >&2; exit 1 ;;
esac

python3 - <<'PY'
import re
import tempfile
from pathlib import Path

script = Path('scripts/monitor-route-ops-production.sh').read_text()

http_match = re.search(r"# BEGIN G007_HTTP_STATUS_POLICY\n(?P<body>.*?)\n# END G007_HTTP_STATUS_POLICY", script, re.S)
if not http_match:
    raise SystemExit('missing G007 HTTP status policy block')

http_namespace = {}
exec(http_match.group('body'), http_namespace)
status_from_http_fixture = http_namespace['status_from_http_fixture']

ok = status_from_http_fixture(200, '{"ok":true}', duration_ms=12)
assert ok == {
    'status': 'ok',
    'httpStatus': 200,
    'durationMs': 12,
    'sample': '{"ok":true}',
}, ok

unready = status_from_http_fixture(503, '{"ready":false}', duration_ms=7)
assert unready['status'] == 'critical', unready
assert unready['httpStatus'] == 503, unready
assert unready['sample'] == '{"ready":false}', unready

failed_probe = status_from_http_fixture(error='connection refused')
assert failed_probe == {'status': 'critical', 'error': 'connection refused'}, failed_probe

match = re.search(r"# BEGIN G007_MIGRATION_POLICY\n(?P<body>.*?)\n# END G007_MIGRATION_POLICY", script, re.S)
if not match:
    raise SystemExit('missing G007 migration policy block')

namespace = {
    'Path': Path,
    'migration_dir': Path('/definitely-missing-clever-route-migrations'),
    'required_latest_migration': '20260731140000_account_scope_driver_push_tokens',
}
exec(match.group('body'), namespace)
status_from_history = namespace['migration_status_from_history']
expected_migration_names = namespace['expected_migration_names']
expected = [
    '20260722203000_dsv_import_stage_apply',
    '20260722213000_dsv_assignment_eta_state',
    '20260722223000_drop_legacy_single_tenant_fks',
    '20260722233000_align_migration_history_to_schema',
    '20260723003000_g009_tenant_composite_dsv_fks',
    '20260723013000_g010_import_row_resource_tenant_fks',
    '20260723023000_g011_production_baseline_drift_repair',
    '20260723120000_add_admin_route_stop_actions',
    '20260723170000_add_customer_notification_outbox_worker',
    '20260727150000_add_dsv_operational_settings',
    '20260727161000_enforce_dsv_vehicle_driver_one_to_one',
    '20260727180000_scope_deletion_request_to_driver_account',
    '20260727190000_add_dsv_admin_accounts',
    '20260728090000_add_dsv_vehicle_telematics_devices',
    '20260728120000_add_pickup_completed_driver_event',
    '20260728124500_add_pickup_completed_unique_index',
    '20260729170000_backfill_assigned_dsv_driver_profiles',
    '20260730170000_backfill_dsv_dispatch_groupings',
    '20260731140000_account_scope_driver_push_tokens',
]

with tempfile.TemporaryDirectory() as tmp:
    migrations = Path(tmp)
    for name in expected[:-1]:
        migration = migrations / name
        migration.mkdir()
        (migration / 'migration.sql').write_text('-- fixture\n')
    assert expected_migration_names(migrations) == expected

repo_expected = expected_migration_names(Path('apps/delivery-api/prisma/migrations'))
assert repo_expected.count('20260723170000_add_customer_notification_outbox_worker') == 1, repo_expected
assert repo_expected.count('20260803090000_orders_async_sync') == 1, repo_expected
assert repo_expected.count('20260804020000_orders_pagination_selection') == 1, repo_expected
assert repo_expected.count('20260806150000_add_routes_app_release_registry') == 1, repo_expected
assert repo_expected.count('20260813130000_add_dsv_password_history') == 1, repo_expected
assert repo_expected.count('20260813140000_require_dsv_admin_password_change') == 1, repo_expected
assert len(repo_expected) == 78, repo_expected
assert repo_expected[-1] == '20260813140000_require_dsv_admin_password_change', repo_expected[-1]
assert repo_expected.count('20260722233000_align_migration_history_to_schema') == 1, repo_expected

empty = status_from_history([], expected)
assert empty['status'] == 'critical', empty
assert empty['expectedCount'] == len(expected), empty
assert empty['appliedCount'] == 0, empty
assert empty['pendingCount'] == len(expected), empty
assert empty['failedCount'] == 0, empty
assert empty['pendingMigrations'] == expected, empty
assert empty['actualLatestMigration'] == '', empty
assert empty['unexpectedMigrations'] == [], empty

missing_latest = status_from_history([
    {'migrationName': name, 'finishedAt': True, 'rolledBackAt': False}
    for name in expected[:-1]
], expected)
assert missing_latest['status'] == 'critical', missing_latest
assert missing_latest['appliedCount'] == len(expected) - 1, missing_latest
assert missing_latest['pendingCount'] == 1, missing_latest
assert missing_latest['pendingMigrations'] == [expected[-1]], missing_latest
assert missing_latest['latestMigration'] == expected[-1], missing_latest
assert missing_latest['actualLatestMigration'] == expected[-2], missing_latest

complete = status_from_history([
    {'migrationName': name, 'finishedAt': True, 'rolledBackAt': False}
    for name in expected
], expected)
assert complete['status'] == 'ok', complete
assert complete['expectedCount'] == len(expected), complete
assert complete['appliedCount'] == len(expected), complete
assert complete['pendingCount'] == 0, complete
assert complete['failedCount'] == 0, complete
assert complete['pendingMigrations'] == [], complete
assert complete['actualLatestMigration'] == expected[-1], complete
assert complete['unexpectedCount'] == 0, complete

complete_with_unexpected_history_row = status_from_history([
    *[
        {'migrationName': name, 'finishedAt': True, 'rolledBackAt': False}
        for name in expected
    ],
    {'migrationName': '99999999999999_unchecked_history_row', 'finishedAt': True, 'rolledBackAt': False},
], expected)
assert complete_with_unexpected_history_row['status'] == 'critical', complete_with_unexpected_history_row
assert complete_with_unexpected_history_row['expectedCount'] == len(expected), complete_with_unexpected_history_row
assert complete_with_unexpected_history_row['appliedCount'] == len(expected), complete_with_unexpected_history_row
assert complete_with_unexpected_history_row['unexpectedCount'] == 1, complete_with_unexpected_history_row
assert complete_with_unexpected_history_row['unexpectedMigrations'] == ['99999999999999_unchecked_history_row'], complete_with_unexpected_history_row
assert complete_with_unexpected_history_row['actualLatestMigration'] == '99999999999999_unchecked_history_row', complete_with_unexpected_history_row
PY

printf '{"ok":true,"monitor":"scripts/monitor-route-ops-production.sh"}\n'
