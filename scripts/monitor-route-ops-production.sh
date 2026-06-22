#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-${ROUTE_OPS_AWS_REGION:-ap-northeast-2}}"
INSTANCE_ID="${ROUTE_OPS_MONITOR_INSTANCE_ID:-}"
TARGET_TAG_KEY="${SSM_ROUTE_OPS_TARGET_TAG_KEY:-Service}"
TARGET_TAG_VALUE="${SSM_ROUTE_OPS_TARGET_TAG_VALUE:-clever-delivery-server}"
BASE_URL="${ROUTE_OPS_SMOKE_BASE_URL:-https://clever-route.cleversystem.ai}"
SHOP_DOMAIN="${ROUTE_OPS_SMOKE_SHOP_DOMAIN:-tomatonofood.com}"
EXPECT_PUBLIC_OPENFREEMAP="${ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP:-true}"
EXPECT_PUBLIC_OPENFREEMAP_HOSTS="${ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOSTS:-${ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOST:-tiles.openfreemap.org}}"
EXPECT_GEOCODER_CONFIGURED="${ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED:-true}"
LOG_SINCE="${ROUTE_OPS_MONITOR_LOG_SINCE:-45m}"
POLL_SECONDS="${ROUTE_OPS_MONITOR_POLL_SECONDS:-2}"
POLL_ATTEMPTS="${ROUTE_OPS_MONITOR_POLL_ATTEMPTS:-90}"
RENDER_HOST_SCRIPT="false"
STATUS_ONLY="false"

usage() {
  cat <<'USAGE'
Usage: scripts/monitor-route-ops-production.sh [--render-host-script] [--status-only]

Runs a read-only production monitor through AWS SSM. The host script checks disk,
Docker/compose container health, recent error signals, and by default executes the
Route Ops production smoke through the deployed delivery-api runtime image.

Environment knobs:
  AWS_REGION / ROUTE_OPS_AWS_REGION                 default: ap-northeast-2
  ROUTE_OPS_MONITOR_INSTANCE_ID                     exact SSM instance id override
  SSM_ROUTE_OPS_TARGET_TAG_KEY/VALUE                default: Service/clever-delivery-server
  ROUTE_OPS_SMOKE_BASE_URL                          default: https://clever-route.cleversystem.ai
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
  cat <<HOST
#!/usr/bin/env bash
set -euo pipefail
export ROUTE_OPS_MONITOR_LOG_SINCE=$(shell_quote "$LOG_SINCE")
export ROUTE_OPS_MONITOR_STATUS_ONLY=$(shell_quote "$STATUS_ONLY")
export ROUTE_OPS_SMOKE_BASE_URL=$(shell_quote "$BASE_URL")
export ROUTE_OPS_SMOKE_SHOP_DOMAIN=$(shell_quote "$SHOP_DOMAIN")
export ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP=$(shell_quote "$EXPECT_PUBLIC_OPENFREEMAP")
export ROUTE_OPS_EXPECT_PUBLIC_OPENFREEMAP_HOSTS=$(shell_quote "$EXPECT_PUBLIC_OPENFREEMAP_HOSTS")
export ROUTE_OPS_EXPECT_GEOCODER_CONFIGURED=$(shell_quote "$EXPECT_GEOCODER_CONFIGURED")
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
docker exec clever-route-delivery-api-1 node -e "fetch('http://127.0.0.1:3000/healthz').then(async r=>{console.log(r.status, await r.text())}).catch(e=>{console.error(e.message); process.exit(1)})"

echo "SECTION=recent_error_signals"
for c in clever-route-delivery-api-1 clever-route-caddy-1 clever-route-postgres-1 clever-route-osrm-ontario-1; do
  if docker inspect "$c" >/dev/null 2>&1; then
    echo "--- $c"
    docker logs --since "${ROUTE_OPS_MONITOR_LOG_SINCE}" --tail 250 "$c" 2>&1 \
      | redact \
      | grep -Ei 'error|warn|exception|failed|unhealthy|timeout|panic|fatal|traceback' \
      | tail -n 60 || true
  fi
done

if [ "${ROUTE_OPS_MONITOR_STATUS_ONLY}" = "true" ]; then
  exit 0
fi

echo "SECTION=production_smoke"
python3 - <<'PY'
from pathlib import Path
import os, re, subprocess, sys

line = ''
for raw in Path('infra/env/delivery-api.env').read_text().splitlines():
    if raw.startswith('CLEVER_ADMIN_WEB_LOGIN_SECRET='):
        line = raw
        break
if not line:
    print('missing smoke secret line', file=sys.stderr)
    sys.exit(2)
secret = line.split('=', 1)[1].strip()
if (secret.startswith('"') and secret.endswith('"')) or (secret.startswith("'") and secret.endswith("'")):
    secret = secret[1:-1]
image = subprocess.check_output(['docker', 'inspect', '--format', '{{.Config.Image}}', 'clever-route-delivery-api-1'], text=True).strip()
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
  ROUTE_OPS_SMOKE_BASE_URL="$BASE_URL" \
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
