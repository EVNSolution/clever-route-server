#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-${ROUTE_OPS_AWS_REGION:-ap-northeast-2}}"
INSTANCE_ID="${ROUTE_OPS_MONITOR_INSTANCE_ID:-}"
TARGET_TAG_KEY="${SSM_ROUTE_OPS_TARGET_TAG_KEY:-Service}"
TARGET_TAG_VALUE="${SSM_ROUTE_OPS_TARGET_TAG_VALUE:-clever-delivery-server}"
BASE_URL="${ROUTE_OPS_SMOKE_BASE_URL:-https://clever-route-api.cleversystem.ai}"
G007_STATUS_BASE_URL="${ROUTE_OPS_G007_STATUS_BASE_URL:-}"
SHOP_DOMAIN="${ROUTE_OPS_SMOKE_SHOP_DOMAIN:-tomatonofood.com}"
EXPECT_PUBLIC_OPENFREEMAP="${ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP:-true}"
EXPECT_PUBLIC_OPENFREEMAP_HOSTS="${ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOSTS:-${ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOST:-tiles.openfreemap.org}}"
EXPECT_GEOCODER_CONFIGURED="${ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED:-true}"
LOG_SINCE="${ROUTE_OPS_MONITOR_LOG_SINCE:-45m}"
POLL_SECONDS="${ROUTE_OPS_MONITOR_POLL_SECONDS:-2}"
POLL_ATTEMPTS="${ROUTE_OPS_MONITOR_POLL_ATTEMPTS:-90}"
RENDER_HOST_SCRIPT="false"
STATUS_ONLY="false"
G007_JSON_STATUS="false"

usage() {
  cat <<'USAGE'
Usage: scripts/monitor-route-ops-production.sh [--render-host-script] [--status-only] [--g007-json-status]

Runs a read-only production monitor through AWS SSM. The host script checks disk,
Docker/compose container health, recent error signals, and by default executes the
Route Ops production smoke through the deployed clever-route-api runtime image.
The optional G007 JSON status mode adds deterministic machine-readable health,
migration, invariant, and legacy-observation status without changing the default
text monitor behavior.

Environment knobs:
  AWS_REGION / ROUTE_OPS_AWS_REGION                 default: ap-northeast-2
  ROUTE_OPS_MONITOR_INSTANCE_ID                     exact SSM instance id override
  SSM_ROUTE_OPS_TARGET_TAG_KEY/VALUE                default: Service/clever-delivery-server
  ROUTE_OPS_SMOKE_BASE_URL                          default: https://clever-route-api.cleversystem.ai
  ROUTE_OPS_G007_STATUS_BASE_URL                    optional external URL for G007 health/readiness
  ROUTE_OPS_SMOKE_SHOP_DOMAIN                       default: tomatonofood.com
  ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP               default: true
  ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOSTS         default: tiles.openfreemap.org
  ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED              default: true
  ROUTE_OPS_MONITOR_LOG_SINCE                       default: 45m
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --render-host-script) RENDER_HOST_SCRIPT="true" ;;
    --status-only) STATUS_ONLY="true" ;;
    --g007-json-status) G007_JSON_STATUS="true" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "monitor-route-ops-production: unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "monitor-route-ops-production: $1 is required" >&2; exit 127; }
}

shell_quote() {
  printf '%q' "$1"
}

host_script() {
  local observation_report_b64
  observation_report_b64="$(base64 < scripts/dsv-g007-observation-report.sh | tr -d '\n')"
  cat <<HOST
#!/usr/bin/env bash
set -euo pipefail
export ROUTE_OPS_MONITOR_LOG_SINCE=$(shell_quote "$LOG_SINCE")
export ROUTE_OPS_MONITOR_STATUS_ONLY=$(shell_quote "$STATUS_ONLY")
export ROUTE_OPS_MONITOR_G007_JSON_STATUS=$(shell_quote "$G007_JSON_STATUS")
export ROUTE_OPS_SMOKE_BASE_URL=$(shell_quote "$BASE_URL")
export ROUTE_OPS_G007_STATUS_BASE_URL=$(shell_quote "$G007_STATUS_BASE_URL")
export ROUTE_OPS_SMOKE_SHOP_DOMAIN=$(shell_quote "$SHOP_DOMAIN")
export ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP=$(shell_quote "$EXPECT_PUBLIC_OPENFREEMAP")
export ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOSTS=$(shell_quote "$EXPECT_PUBLIC_OPENFREEMAP_HOSTS")
export ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED=$(shell_quote "$EXPECT_GEOCODER_CONFIGURED")
export ROUTE_OPS_G007_OBSERVATION_REPORT_B64=$(shell_quote "$observation_report_b64")
HOST
  cat <<'HOST'
cd /srv/clever-route-server

redact() {
  sed -E \
    -e 's/(clever_admin_ui=)[^;[:space:]]+/\1<redacted>/g' \
    -e 's/(token|secret|password|cookie|authorization)([=: ]+)[^[:space:]]+/\1\2<redacted>/Ig'
}

echo "MONITOR_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "SECTION=host_disk"
df -h / /srv/clever-route-server || true

echo "SECTION=docker_system_df"
docker system df || true

echo "SECTION=containers"
docker ps --filter label=com.docker.compose.project=clever-route --format '{{.Names}}	{{.Image}}	{{.Status}}	{{.Ports}}' || true

echo "SECTION=container_health"
for c in $(docker ps --filter label=com.docker.compose.project=clever-route --format '{{.Names}}'); do
  printf '%s\t' "$c"
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c"
done || true

echo "SECTION=local_delivery_health"
docker exec clever-route-clever-route-api-1 node -e "fetch('http://127.0.0.1:3000/healthz').then(async r=>{console.log(r.status, await r.text())}).catch(e=>{console.error(e.message); process.exit(1)})"

echo "SECTION=recent_error_signals"
for c in clever-route-clever-route-api-1 clever-route-caddy-1 clever-route-postgres-1 clever-route-osrm-ontario-1; do
  if docker inspect "$c" >/dev/null 2>&1; then
    echo "--- $c"
    docker logs --since "${ROUTE_OPS_MONITOR_LOG_SINCE}" --tail 250 "$c" 2>&1 \
      | redact \
      | grep -Ei 'error|warn|exception|failed|unhealthy|timeout|panic|fatal|traceback' \
      | tail -n 60 || true
  fi
done

if [ "${ROUTE_OPS_MONITOR_G007_JSON_STATUS}" = "true" ]; then
  echo "SECTION=g007_json_status"
  observation_report_path="$(mktemp /tmp/dsv-g007-observation-report.XXXXXX)"
  trap 'rm -f "$observation_report_path"' EXIT
  printf '%s' "$ROUTE_OPS_G007_OBSERVATION_REPORT_B64" | base64 -d > "$observation_report_path"
  chmod 700 "$observation_report_path"
  export ROUTE_OPS_G007_OBSERVATION_REPORT_PATH="$observation_report_path"
  python3 - <<'PY'
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

api_container = 'clever-route-clever-route-api-1'
postgres_container = 'clever-route-postgres-1'
migration_dir = Path('apps/delivery-api/prisma/migrations')
configured_status_base_url = os.environ.get('ROUTE_OPS_G007_STATUS_BASE_URL', '').strip().rstrip('/')
observation_report_path = os.environ.get('ROUTE_OPS_G007_OBSERVATION_REPORT_PATH', '').strip()


def run(command, timeout=15, input_text=None):
    return subprocess.run(command, text=True, input=input_text, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)


# BEGIN G007_HTTP_STATUS_POLICY
def status_from_http_fixture(http_status=None, body='', error='', duration_ms=0):
    if error:
        return {'status': 'critical', 'error': str(error)}
    if http_status is None:
        return {'status': 'critical', 'error': 'missing HTTP status'}
    return {
        'status': 'ok' if int(http_status) == 200 else 'critical',
        'httpStatus': int(http_status),
        'durationMs': int(duration_ms),
        'sample': str(body)[:500],
    }
# END G007_HTTP_STATUS_POLICY


def external_http_status(path):
    started = datetime.now(timezone.utc)
    try:
        with urlopen(f'{configured_status_base_url}{path}', timeout=5) as response:
            body = response.read(500).decode('utf-8', 'replace')
            duration_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
            return status_from_http_fixture(response.status, body, duration_ms=duration_ms)
    except Exception as exc:
        return status_from_http_fixture(error=exc)


def container_http_status(path):
    started = datetime.now(timezone.utc)
    proc = run([
        'docker', 'exec', api_container, 'node', '-e',
        "const path=process.argv[1];"
        "const started=Date.now();"
        "fetch('http://127.0.0.1:3000'+path)"
        ".then(async r=>{"
        "const body=(await r.text()).slice(0,500);"
        "console.log(JSON.stringify({httpStatus:r.status,durationMs:Date.now()-started,sample:body}));"
        "})"
        ".catch(e=>{console.error(e && e.message ? e.message : String(e)); process.exit(1);})",
        path,
    ])
    if proc.returncode != 0:
        return status_from_http_fixture(error=proc.stderr.strip() or proc.stdout.strip())
    try:
        payload = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        return status_from_http_fixture(error='non-json health probe result')
    duration_ms = payload.get('durationMs')
    if duration_ms is None:
        duration_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    return status_from_http_fixture(payload.get('httpStatus'), payload.get('sample', ''), duration_ms=duration_ms)


def http_status(path):
    if configured_status_base_url:
        return external_http_status(path)
    return container_http_status(path)


def psql_json(sql):
    proc = run([
        'docker', 'exec', postgres_container,
        'psql', '-U', 'clever', '-d', 'clever_route',
        '-v', 'ON_ERROR_STOP=1', '-Atc', sql,
    ])
    if proc.returncode != 0:
        return {'status': 'unknown', 'error': proc.stderr.strip() or proc.stdout.strip()}
    text = proc.stdout.strip()
    if not text:
        return {'status': 'unknown', 'error': 'empty query result'}
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return {'status': 'unknown', 'error': 'non-json query result'}
    if isinstance(payload, dict):
        return payload
    return {'status': 'ok', 'value': payload}


def customer_email_runtime_config():
    proc = run([
        'docker', 'exec', api_container, 'node', '-e',
        "const senderConfigured=Boolean((process.env.CUSTOMER_DELIVERY_NOTIFICATION_URL||'').trim());"
        "const raw=(process.env.CUSTOMER_DELIVERY_NOTIFICATION_WORKER_ENABLED||'').trim().toLowerCase();"
        "const workerFlag=raw===''||raw==='true'||raw==='1';"
        "console.log(JSON.stringify({senderConfigured,workerEnabled:senderConfigured&&workerFlag}));",
    ])
    if proc.returncode != 0:
        return {'status': 'unknown', 'error': 'customer email runtime configuration could not be read'}
    try:
        payload = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        return {'status': 'unknown', 'error': 'customer email runtime configuration returned non-json output'}
    if not isinstance(payload, dict):
        return {'status': 'unknown', 'error': 'customer email runtime configuration returned an invalid result'}
    return payload


# BEGIN G007_EMAIL_SCOPE_POLICY
def email_scope_status_from_fixture(runtime, rows):
    if not isinstance(runtime, dict) or not isinstance(rows, list):
        return {'status': 'unknown', 'error': 'customer email scope evidence is unavailable'}
    sender_configured = runtime.get('senderConfigured')
    worker_enabled = runtime.get('workerEnabled')
    if not isinstance(sender_configured, bool) or not isinstance(worker_enabled, bool):
        return {'status': 'unknown', 'error': 'customer email runtime evidence is invalid'}

    count_keys = (
        'pending',
        'overduePending',
        'processing',
        'staleProcessing',
        'retryWait',
        'overdueRetryWait',
        'deadLetter',
    )
    totals = {key: 0 for key in count_keys}
    scopes = []
    default_scope_count = 0
    for ordinal, row in enumerate(rows, start=1):
        if not isinstance(row, dict) or not isinstance(row.get('defaultApp'), bool):
            return {'status': 'unknown', 'error': 'customer email scope evidence is invalid'}
        scope = {'scopeOrdinal': ordinal, 'defaultApp': row['defaultApp']}
        if row['defaultApp']:
            default_scope_count += 1
        for key in count_keys:
            value = row.get(key)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                return {'status': 'unknown', 'error': 'customer email scope evidence is invalid'}
            scope[key] = value
            totals[key] += value
        scopes.append(scope)

    configured = sender_configured and worker_enabled
    stranded = totals['deadLetter'] > 0 or totals['staleProcessing'] > 0
    overdue_while_enabled = configured and (
        totals['overduePending'] > 0 or totals['overdueRetryWait'] > 0
    )
    disabled_with_outstanding = not configured and (
        totals['pending'] > 0 or totals['processing'] > 0 or totals['retryWait'] > 0
    )
    status = 'critical' if stranded or overdue_while_enabled else 'warning' if disabled_with_outstanding else 'ok'
    return {
        'status': status,
        'runtime': {
            'senderConfigured': sender_configured,
            'workerEnabled': worker_enabled,
        },
        'scopeCount': len(scopes),
        'defaultScopeCount': default_scope_count,
        'nonDefaultScopeCount': len(scopes) - default_scope_count,
        'totals': totals,
        'scopes': scopes,
    }
# END G007_EMAIL_SCOPE_POLICY


# BEGIN G007_EMAIL_SCOPE_SQL
email_scope_sql = """
WITH scope_counts AS (
  SELECT
    s.id AS "scopeSort",
    s."appId" = 'clever' AS "defaultApp",
    COUNT(fact.id) FILTER (
      WHERE fact.status = 'QUEUED' AND fact."attemptCount" = 0
    ) AS pending,
    COUNT(fact.id) FILTER (
      WHERE fact.status = 'QUEUED'
        AND fact."attemptCount" = 0
        AND fact."occurredAt" < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
    ) AS "overduePending",
    COUNT(fact.id) FILTER (
      WHERE fact.status = 'PROCESSING'
    ) AS processing,
    COUNT(fact.id) FILTER (
      WHERE fact.status = 'PROCESSING'
        AND fact."updatedAt" < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
    ) AS "staleProcessing",
    COUNT(fact.id) FILTER (
      WHERE fact.status = 'QUEUED' AND fact."attemptCount" > 0
    ) AS "retryWait",
    COUNT(fact.id) FILTER (
      WHERE fact.status = 'QUEUED'
        AND fact."attemptCount" > 0
        AND fact."occurredAt" < CURRENT_TIMESTAMP - INTERVAL '30 minutes'
    ) AS "overdueRetryWait",
    COUNT(fact.id) FILTER (
      WHERE fact.status = 'DEAD'
        AND fact."errorCode" IS DISTINCT FROM 'OPERATOR_DO_NOT_SEND'
    ) AS "deadLetter"
  FROM shops AS s
  LEFT JOIN customer_route_notification_facts AS fact ON fact."shopId" = s.id
  GROUP BY s.id, s."appId"
)
SELECT COALESCE(json_agg(json_build_object(
  'defaultApp', "defaultApp",
  'pending', pending,
  'overduePending', "overduePending",
  'processing', processing,
  'staleProcessing', "staleProcessing",
  'retryWait', "retryWait",
  'overdueRetryWait', "overdueRetryWait",
  'deadLetter', "deadLetter"
) ORDER BY "defaultApp" DESC, "scopeSort"), '[]'::json)
FROM scope_counts;
"""
# END G007_EMAIL_SCOPE_SQL


def customer_email_scope_status():
    runtime = customer_email_runtime_config()
    if runtime.get('status') == 'unknown':
        return runtime
    evidence = psql_json(email_scope_sql)
    if evidence.get('status') == 'unknown':
        return evidence
    return email_scope_status_from_fixture(runtime, evidence.get('value'))


def deployed_migration_names():
    proc = run([
        'docker', 'exec', api_container,
        'node', '-e',
        "const crypto=require('node:crypto');"
        "const fs=require('node:fs');"
        "const path=require('node:path');"
        "const root='prisma/migrations';"
        "const rows=fs.readdirSync(root,{withFileTypes:true})"
        ".filter(entry=>entry.isDirectory())"
        ".map(entry=>({name:entry.name,file:path.join(root,entry.name,'migration.sql')}))"
        ".filter(entry=>fs.existsSync(entry.file))"
        ".map(entry=>({name:entry.name,checksum:crypto.createHash('sha256').update(fs.readFileSync(entry.file)).digest('hex')}));"
        "console.log(JSON.stringify(rows));",
    ])
    if proc.returncode != 0:
        return {'status': 'unknown', 'error': proc.stderr.strip() or proc.stdout.strip()}
    try:
        entries = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        return {'status': 'critical', 'error': 'deployed image returned a non-json migration manifest'}
    return validated_migration_checksums(entries, source='deployed image')


# BEGIN G007_MIGRATION_POLICY
import re


def validated_migration_manifest(names, source='migration directory'):
    manifest = sorted(set(names))
    if not manifest:
        return {'status': 'unknown', 'error': f'{source} contains no migrations'}
    invalid = [name for name in manifest if not re.fullmatch(r'\d{14}_[a-z0-9_]+', name)]
    if invalid:
        return {'status': 'unknown', 'error': f'{source} contains invalid migration names'}
    return manifest


def validated_migration_checksums(entries, source='migration directory'):
    if not isinstance(entries, list):
        return {'status': 'critical', 'error': f'{source} migration manifest is not a JSON array'}
    if not entries:
        return {'status': 'critical', 'error': f'{source} contains no migrations'}
    manifest = {}
    for entry in entries:
        if not isinstance(entry, dict):
            return {'status': 'critical', 'error': f'{source} contains an invalid migration entry'}
        name = str(entry.get('name') or '')
        checksum = str(entry.get('checksum') or '')
        if not re.fullmatch(r'\d{14}_[a-z0-9_]+', name):
            return {'status': 'critical', 'error': f'{source} contains invalid migration names'}
        if not re.fullmatch(r'[0-9a-f]{64}', checksum):
            return {'status': 'critical', 'error': f'{source} contains invalid migration checksums'}
        if name in manifest:
            return {'status': 'critical', 'error': f'{source} contains duplicate migration names'}
        manifest[name] = checksum
    return dict(sorted(manifest.items()))


def monitor_status_from_checks(checks):
    statuses = [str(check.get('status', 'unknown')) for check in checks.values()]
    if 'critical' in statuses:
        return 'critical', 2
    if 'unknown' in statuses:
        return 'unknown', 1
    if 'warning' in statuses:
        return 'warning', 0
    return 'ok', 0


def expected_migration_names(path=migration_dir):
    if not path.is_dir():
        return {'status': 'unknown', 'error': 'migration directory is missing'}
    names = [
        child.name for child in path.iterdir()
        if child.is_dir() and (child / 'migration.sql').is_file()
    ]
    return validated_migration_manifest(names)


def migration_status_from_history(history, expected=None):
    if expected is None:
        expected = expected_migration_names()
    if isinstance(expected, dict) and expected.get('status') in {'critical', 'unknown'}:
        return expected
    if isinstance(history, dict) and history.get('status') == 'unknown':
        return history
    if isinstance(history, dict) and 'value' in history:
        history = history['value']
    if not isinstance(history, list):
        return {'status': 'unknown', 'error': 'migration history is not a JSON array'}

    expected_checksums = expected if isinstance(expected, dict) else {}
    expected_names = validated_migration_manifest(expected_checksums.keys() if expected_checksums else expected)
    if isinstance(expected_names, dict):
        return expected_names
    expected = expected_names
    expected_set = set(expected)
    successful = set()
    rolled_back = []
    failed = []
    checksum_mismatches = set()
    for row in history:
        if not isinstance(row, dict):
            failed.append('')
            continue
        name = str(row.get('migrationName') or row.get('migration_name') or '')
        is_finished = bool(row.get('finishedAt') or row.get('finished_at'))
        is_rolled_back = bool(row.get('rolledBackAt') or row.get('rolled_back_at'))
        if name and is_finished and not is_rolled_back:
            successful.add(name)
            if name in expected_checksums and str(row.get('checksum') or '') != expected_checksums[name]:
                checksum_mismatches.add(name)
        elif name and is_rolled_back:
            rolled_back.append(name)
        else:
            failed.append(name)

    recovered = []
    for name in rolled_back:
        if name in expected_set and name in successful and name not in checksum_mismatches:
            recovered.append(name)
        else:
            failed.append(name)

    expected_successful = [name for name in expected if name in successful]
    pending = [name for name in expected if name not in successful]
    unexpected = sorted(name for name in successful if name not in expected_set)
    actual_latest = max(successful) if successful else ''
    status = 'critical' if pending or failed or unexpected or checksum_mismatches else 'ok'
    history_status = 'critical' if status == 'critical' else ('recovered' if recovered else 'clean')
    return {
        'status': status,
        'historyStatus': history_status,
        'expectedCount': len(expected),
        'appliedCount': len(expected_successful),
        'pendingCount': len(pending),
        'failedCount': len(failed),
        'recoveredCount': len(recovered),
        'recoveredMigrations': sorted(set(recovered)),
        'checksumMismatchCount': len(checksum_mismatches),
        'checksumMismatchMigrations': sorted(checksum_mismatches),
        'latestMigration': expected[-1] if expected else '',
        'actualLatestMigration': actual_latest,
        'pendingMigrations': pending,
        'unexpectedCount': len(unexpected),
        'unexpectedMigrations': unexpected,
    }
# END G007_MIGRATION_POLICY


def migration_status():
    expected = deployed_migration_names()
    if isinstance(expected, dict) and expected.get('status') in {'critical', 'unknown'}:
        return expected
    return migration_status_from_history(psql_json(migration_history_sql), expected)


migration_history_sql = """
SELECT COALESCE(json_agg(json_build_object(
  'migrationName', migration_name,
  'checksum', checksum,
  'finishedAt', finished_at IS NOT NULL,
  'rolledBackAt', rolled_back_at IS NOT NULL
) ORDER BY migration_name), '[]'::json) FROM _prisma_migrations;
"""

invariant_sql = """
WITH critical_checks(name, failures) AS (
  VALUES
    ('canonical_duplicate_active_assignments', (
      SELECT COUNT(*) FROM (
        SELECT
          "shopId",
          "sellerOrderSourceKind",
          "sellerOrderKey",
          "serviceDate",
          COUNT(*)
        FROM orders
        WHERE "currentRouteVersionId" IS NOT NULL
          AND "sellerOrderKey" IS NOT NULL
        GROUP BY "shopId", "sellerOrderSourceKind", "sellerOrderKey", "serviceDate"
        HAVING COUNT(*) > 1
      ) duplicates
    )),
    ('failed_command_receipts', (
      SELECT COUNT(*) FROM dsv_command_receipts WHERE status = 'FAILED'
    )),
    ('audit_rows_missing_request_ids', (
      SELECT COUNT(*) FROM dsv_audit_events WHERE "requestId" IS NULL OR "requestId" = ''
    )),
    ('import_partial_apply_indicators', (
      SELECT COUNT(*) FROM dsv_dispatch_import_rows
      WHERE status IN ('APPLYING', 'BLOCKED') AND "applyReceiptId" IS NOT NULL
    )),
    ('eta_input_route_version_mismatches', (
      SELECT COUNT(*)
      FROM route_plan_stops stop
      JOIN route_plans route_plan
        ON route_plan.id = stop."routePlanId"
       AND route_plan."shopId" = stop."shopId"
      LEFT JOIN route_grouping_child_versions current_version
        ON current_version."routePlanId" = route_plan.id
       AND current_version."shopId" = route_plan."shopId"
       AND current_version.status = 'CURRENT'
      WHERE stop."etaInputRouteVersionId" IS NOT NULL
        AND route_plan.status NOT IN ('CANCELLED', 'COMPLETED')
        AND (
          current_version.id IS NULL
          OR stop."etaInputRouteVersionId" <> current_version.id
        )
    ))
),
informational_metrics(name, value) AS (
  VALUES
    ('recurring_active_seller_keys', (
      SELECT COUNT(*) FROM (
        SELECT "shopId", "sellerOrderKey"
        FROM orders
        WHERE "currentRouteVersionId" IS NOT NULL
          AND "sellerOrderKey" IS NOT NULL
        GROUP BY "shopId", "sellerOrderKey"
        HAVING COUNT(DISTINCT ROW("sellerOrderSourceKind", "serviceDate")) > 1
      ) recurring_keys
    ))
)
SELECT json_build_object(
  'status', CASE
    WHEN SUM(failures) > 0
      THEN 'critical'
    ELSE 'ok'
  END,
  'invariantFailures', COALESCE(
    (SELECT json_object_agg(name, failures) FROM critical_checks),
    '{}'::json
  ),
  'invariantInformation', COALESCE(
    (SELECT json_object_agg(name, value) FROM informational_metrics),
    '{}'::json
  ),
  'deprecatedNoncriticalMetrics', json_build_object(
    'duplicate_active_assignments',
    (SELECT value FROM informational_metrics WHERE name = 'recurring_active_seller_keys')
  ),
  'deprecatedMetricAliases', json_build_object(
    'duplicate_active_assignments', 'recurring_active_seller_keys'
  )
) FROM critical_checks LIMIT 1;
"""

legacy_logs = run([
    'docker', 'logs', '--since', os.environ.get('ROUTE_OPS_MONITOR_LOG_SINCE', '45m'), api_container,
], timeout=30)
if legacy_logs.returncode != 0:
    legacy = {'status': 'unknown', 'error': legacy_logs.stderr.strip() or legacy_logs.stdout.strip()}
elif not observation_report_path:
    legacy = {'status': 'unknown', 'error': 'missing embedded observation report path'}
else:
    legacy_proc = run([observation_report_path], timeout=30, input_text=legacy_logs.stdout)
    try:
        legacy = json.loads(legacy_proc.stdout) if legacy_proc.returncode == 0 else {
            'status': 'unknown',
            'error': legacy_proc.stderr.strip() or legacy_proc.stdout.strip(),
        }
    except json.JSONDecodeError:
        legacy = {'status': 'unknown', 'error': 'observation report returned non-json output'}

if legacy.get('status') != 'unknown':
    has_legacy = (
        not legacy.get('legacyZeroEvidence', {}).get('legacy_read', False)
        or not legacy.get('legacyZeroEvidence', {}).get('legacy_write', False)
    )
    legacy['status'] = 'critical' if has_legacy else 'ok'


report = {
    'schemaVersion': 2,
    'generatedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
    'checks': {
        'healthz': http_status('/healthz'),
        'readyz': http_status('/readyz'),
        'migrations': migration_status(),
        'invariants': psql_json(invariant_sql),
        'legacyUsage': legacy,
        'customerEmailOutbox': customer_email_scope_status(),
    },
}
report['status'], exit_code = monitor_status_from_checks(report['checks'])
print(json.dumps(report, indent=2, sort_keys=True))
sys.exit(exit_code)
PY
fi

if [ "${ROUTE_OPS_MONITOR_STATUS_ONLY}" = "true" ]; then
  exit 0
fi

echo "SECTION=production_smoke"
python3 - <<'PY'
from pathlib import Path
import os, re, subprocess, sys

line = ''
for raw in Path('apps/delivery-api/.env').read_text().splitlines():
    if raw.startswith('CLEVER_ADMIN_WEB_LOGIN_SECRET='):
        line = raw
        break
if not line:
    print('missing smoke secret line', file=sys.stderr)
    sys.exit(2)
secret = line.split('=', 1)[1].strip()
if (secret.startswith('"') and secret.endswith('"')) or (secret.startswith("'") and secret.endswith("'")):
    secret = secret[1:-1]
image = subprocess.check_output(['docker', 'inspect', '--format', '{{.Config.Image}}', 'clever-route-clever-route-api-1'], text=True).strip()
cmd = [
    'docker', 'run', '--rm',
    '-v', '/srv/clever-route-server/scripts/smoke-route-ops-production.mjs:/tmp/route-ops-smoke.mjs:ro',
    '-e', f"ROUTE_OPS_SMOKE_BASE_URL={os.environ['ROUTE_OPS_SMOKE_BASE_URL']}",
    '-e', f"ROUTE_OPS_SMOKE_SHOP_DOMAIN={os.environ['ROUTE_OPS_SMOKE_SHOP_DOMAIN']}",
    '-e', f'ROUTE_OPS_SMOKE_LOGIN_SECRET={secret}',
    '-e', f"ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP={os.environ['ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP']}",
    '-e', f"ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOSTS={os.environ['ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOSTS']}",
    '-e', f"ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED={os.environ['ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED']}",
    image,
    'node', '/tmp/route-ops-smoke.mjs',
]
proc = subprocess.run(cmd, cwd='/srv/clever-route-server', text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
def redact(value: str) -> str:
    value = value.replace(secret, '<redacted>')
    value = re.sub(r'clever_admin_ui=[^;\s]+', 'clever_admin_ui=<redacted>', value)
    return value
print(f'SMOKE_IMAGE={image}')
if proc.stdout:
    print(redact(proc.stdout), end='')
if proc.stderr:
    print(redact(proc.stderr), end='', file=sys.stderr)
sys.exit(proc.returncode)
PY
HOST
}

if [ "$RENDER_HOST_SCRIPT" = "true" ]; then
  ROUTE_OPS_MONITOR_LOG_SINCE="$LOG_SINCE" \
  ROUTE_OPS_MONITOR_STATUS_ONLY="$STATUS_ONLY" \
  ROUTE_OPS_MONITOR_G007_JSON_STATUS="$G007_JSON_STATUS" \
  ROUTE_OPS_SMOKE_BASE_URL="$BASE_URL" \
  ROUTE_OPS_G007_STATUS_BASE_URL="$G007_STATUS_BASE_URL" \
  ROUTE_OPS_SMOKE_SHOP_DOMAIN="$SHOP_DOMAIN" \
  ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP="$EXPECT_PUBLIC_OPENFREEMAP" \
  ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOSTS="$EXPECT_PUBLIC_OPENFREEMAP_HOSTS" \
  ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED="$EXPECT_GEOCODER_CONFIGURED" \
    host_script
  exit 0
fi

require_cmd aws
require_cmd python3
require_cmd base64

if [ -z "$INSTANCE_ID" ]; then
  target_query='[length(InstanceInformationList), InstanceInformationList[0].InstanceId, InstanceInformationList[0].PingStatus]'
  filter="Key=tag:${TARGET_TAG_KEY},Values=${TARGET_TAG_VALUE}"
  read -r total_count INSTANCE_ID ping_status <<< "$(aws ssm describe-instance-information --region "$AWS_REGION" --filters "$filter" --query "$target_query" --output text)"
  if [ "$total_count" != "1" ] || [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
    echo "monitor-route-ops-production: expected exactly one SSM target for ${TARGET_TAG_KEY}=${TARGET_TAG_VALUE}; got ${total_count}" >&2
    exit 65
  fi
  if [ "$ping_status" != "Online" ]; then
    echo "monitor-route-ops-production: target ${INSTANCE_ID} is not Online: ${ping_status}" >&2
    exit 65
  fi
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
HOST_SCRIPT_PATH="$tmp_dir/route-ops-monitor-host.sh"
host_script > "$HOST_SCRIPT_PATH"
encoded="$(base64 < "$HOST_SCRIPT_PATH" | tr -d '\n')"
python3 - "$tmp_dir/parameters.json" "$encoded" <<'PY'
import json, sys
path, encoded = sys.argv[1:3]
command = f"printf '%s' '{encoded}' | base64 -d | bash"
with open(path, 'w', encoding='utf-8') as fh:
    json.dump({'commands': [command]}, fh)
PY

command_id="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment 'Route Ops read-only production monitor' \
  --parameters "file://$tmp_dir/parameters.json" \
  --query 'Command.CommandId' --output text)"

echo "SSM_MONITOR_COMMAND_ID=$command_id"
echo "SSM_MONITOR_INSTANCE_ID=$INSTANCE_ID"

status="Pending"
for _ in $(seq 1 "$POLL_ATTEMPTS"); do
  status="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$INSTANCE_ID" --query 'Status' --output text 2>/dev/null || echo Pending)"
  case "$status" in Success|Cancelled|TimedOut|Failed|Cancelling) break ;; esac
  sleep "$POLL_SECONDS"
done

summary="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$INSTANCE_ID" --query '{Status:Status,StatusDetails:StatusDetails,ResponseCode:ResponseCode,StandardOutputContent:StandardOutputContent,StandardErrorContent:StandardErrorContent}' --output json)"
SUMMARY_JSON="$summary" python3 - <<'PY'
import json, os, re
payload = json.loads(os.environ['SUMMARY_JSON'])
for key in ('StandardOutputContent', 'StandardErrorContent'):
    value = str(payload.get(key) or '')
    value = re.sub(r'clever_admin_ui=[^;\s]+', 'clever_admin_ui=<redacted>', value)
    value = re.sub(r'(token|secret|password|cookie|authorization)([=: ]+)[^\s]+', r'\1\2<redacted>', value, flags=re.I)
    payload[key] = value
print(json.dumps(payload, indent=2))
PY

if [ "$status" != "Success" ]; then
  echo "monitor-route-ops-production: SSM monitor command did not succeed: $status" >&2
  exit 1
fi
