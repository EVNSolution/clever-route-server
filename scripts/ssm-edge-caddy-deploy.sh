#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
APP_DIR="${APP_DIR:-/srv/clever-route-server}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/docker-compose.prod.yml}"
CADDYFILE="${CADDYFILE:-infra/caddy/Caddyfile}"
COMPOSE_PROJECT="${ROUTE_OPS_COMPOSE_PROJECT_NAME:-clever-route}"
SERVICE_TAG_KEY="${EDGE_CADDY_SSM_TAG_KEY:-${ROUTE_OPS_SSM_TAG_KEY:-Service}}"
SERVICE_TAG_VALUE="${EDGE_CADDY_SSM_TAG_VALUE:-${ROUTE_OPS_SSM_TAG_VALUE:-clever-delivery-server}}"
COMMIT_SHA="$(git rev-parse --short=40 HEAD)"
ROUTE_HEALTH_URL="${EDGE_CADDY_ROUTE_HEALTH_URL:-https://clever-route-api.cleversystem.ai/healthz}"
LEGACY_ROUTE_HEALTH_URL="${EDGE_CADDY_LEGACY_ROUTE_HEALTH_URL:-https://clever-route.cleversystem.ai/healthz}"
DSV_URL="${EDGE_CADDY_DSV_URL:-https://dsv.cleversystem.ai/}"
SHOPIFY_DEV_URL="${EDGE_CADDY_SHOPIFY_DEV_URL:-https://clever-route-app-dev.cleversystem.ai/auth/login}"
SHOPIFY_PROD_URL="${EDGE_CADDY_SHOPIFY_PROD_URL:-https://clever-route-app.cleversystem.ai/auth/login}"
SHOPIFY_LEGACY_ADMIN_URL="${EDGE_CADDY_SHOPIFY_LEGACY_ADMIN_URL:-https://clever-admin.cleversystem.ai/auth/login}"
SHOPIFY_KFOOD_URL="${EDGE_CADDY_SHOPIFY_KFOOD_URL:-https://clever-kfood-app.cleversystem.ai/auth/login}"
SKIP_SMOKE="${EDGE_CADDY_SKIP_SMOKE:-0}"
DRY_RUN=0
SEND_COMMAND=1

usage() {
  cat <<USAGE
Usage: $0 [--dry-run] [--no-send]

Edge Caddy SSM deploy lane: owns public ingress/Caddyfile changes only. It does
not build images, run migrations, stage Route Ops static assets, recreate
\`clever-route-api\`, or deploy Shopify app containers. Use this lane before Route
Ops/Shopify runtime deploys when host/domain routing changes.

Env:
  AWS_REGION                  default: ap-northeast-2
  EDGE_CADDY_SSM_TAG_KEY      default: ROUTE_OPS_SSM_TAG_KEY or Service
  EDGE_CADDY_SSM_TAG_VALUE    default: ROUTE_OPS_SSM_TAG_VALUE or clever-delivery-server
  APP_DIR                     default: /srv/clever-route-server
  COMPOSE_FILE                default: infra/compose/docker-compose.prod.yml
  CADDYFILE                   default: infra/caddy/Caddyfile
  EDGE_CADDY_DSV_URL          default: https://dsv.cleversystem.ai/
  EDGE_CADDY_SKIP_SMOKE       set to 1 to skip public smoke checks after reload
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-send) SEND_COMMAND=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

fail() { echo "ssm-edge-caddy-deploy: $*" >&2; exit 65; }

resolve_instance() {
  read -r count instance_id ping_status <<EOF_RESOLVE
$(aws ssm describe-instance-information \
  --region "$AWS_REGION" \
  --filters "Key=tag:${SERVICE_TAG_KEY},Values=${SERVICE_TAG_VALUE}" \
  --query '[length(InstanceInformationList), InstanceInformationList[0].InstanceId, InstanceInformationList[0].PingStatus]' \
  --output text)
EOF_RESOLVE
  test "$count" = "1" || fail "expected exactly one SSM target for ${SERVICE_TAG_KEY}=${SERVICE_TAG_VALUE}; got ${count}"
  test "$ping_status" = "Online" || fail "SSM target ${instance_id} is not Online: ${ping_status}"
  printf '%s' "$instance_id"
}

write_parameters() {
  local path="$1"
  local inner_path
  inner_path="$(mktemp /tmp/edge-caddy-host.XXXXXX)"
  cat > "$inner_path" <<'HOST_SCRIPT'
set -euo pipefail
APP_DIR=__APP_DIR__
COMPOSE_FILE=__COMPOSE_FILE__
CADDYFILE=__CADDYFILE__
COMPOSE_PROJECT=__COMPOSE_PROJECT__
COMMIT_SHA=__COMMIT_SHA__
DRY_RUN=__DRY_RUN__
SKIP_SMOKE=__SKIP_SMOKE__
ROUTE_HEALTH_URL=__ROUTE_HEALTH_URL__
LEGACY_ROUTE_HEALTH_URL=__LEGACY_ROUTE_HEALTH_URL__
DSV_URL=__DSV_URL__
SHOPIFY_DEV_URL=__SHOPIFY_DEV_URL__
SHOPIFY_PROD_URL=__SHOPIFY_PROD_URL__
SHOPIFY_LEGACY_ADMIN_URL=__SHOPIFY_LEGACY_ADMIN_URL__
SHOPIFY_KFOOD_URL=__SHOPIFY_KFOOD_URL__
CADDYFILE_B64=__CADDYFILE_B64__
cd "$APP_DIR"
mkdir -p .deploy "$(dirname "$CADDYFILE")"
lock_dir=.deploy/edge-caddy-deploy.lock.d
if ! mkdir "$lock_dir" 2>/dev/null; then echo 'another edge caddy deploy is running' >&2; exit 65; fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT
printf 'edge caddy deploy preflight: commit=%s caddyfile=%s dryRun=%s skipSmoke=%s\n' "$COMMIT_SHA" "$CADDYFILE" "$DRY_RUN" "$SKIP_SMOKE"
command -v docker >/dev/null
command -v base64 >/dev/null
command -v curl >/dev/null
candidate=".deploy/Caddyfile.candidate.$(date -u +%Y%m%dT%H%M%SZ)"
printf '%s' "$CADDYFILE_B64" | base64 -d > "$candidate"
candidate_abs="$PWD/$candidate"
docker run --rm -v "$candidate_abs:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
if [ "$DRY_RUN" = "1" ]; then
  printf 'edge caddy dry-run complete; no ingress mutation performed.\n'
  exit 0
fi
[ -f "$CADDYFILE" ] || { echo "missing host Caddyfile: $CADDYFILE" >&2; exit 65; }
backup=".deploy/Caddyfile.before-edge-$(date -u +%Y%m%dT%H%M%SZ)"
cp "$CADDYFILE" "$backup"
restore_caddy() {
  local reason="$1"
  echo "edge caddy deploy failed; restoring previous Caddyfile: $reason" >&2
  cp "$backup" "$CADDYFILE"
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T caddy caddy reload --config /etc/caddy/Caddyfile || true
}
cat "$candidate" > "$CADDYFILE"
chmod 0644 "$CADDYFILE"
if ! docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T caddy caddy validate --config /etc/caddy/Caddyfile; then
  restore_caddy 'container validate failed'
  exit 1
fi
if ! docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
  restore_caddy 'reload failed'
  exit 1
fi
smoke_status() {
  local name="$1" url="$2" min_status="$3" max_status="$4" status
  status="$(curl -sS -o "/tmp/edge-caddy-smoke-${name}.body" -w '%{http_code}' "$url" || true)"
  if ! printf '%s' "$status" | grep -Eq '^[0-9]{3}$'; then
    echo "edge caddy smoke failed: $name $url returned non-http status [$status]" >&2
    return 1
  fi
  if [ "$status" -lt "$min_status" ] || [ "$status" -gt "$max_status" ]; then
    echo "edge caddy smoke failed: $name $url status=$status expected=${min_status}-${max_status}" >&2
    return 1
  fi
  printf 'edge caddy smoke ok: %s %s status=%s\n' "$name" "$url" "$status"
}
smoke_dsv_security_headers() {
  local headers=/tmp/edge-caddy-smoke-dsv.headers csp script_src frame_ancestors
  if ! smoke_status dsv "$DSV_URL" 200 299; then return 1; fi
  curl -fsS -D "$headers" -o /dev/null "$DSV_URL"
  csp="$(grep -i '^content-security-policy:' "$headers" | head -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^[[:space:]]*//' || true)"
  script_src="$(printf '%s' "$csp" | tr ';' '\n' | sed 's/^[[:space:]]*//' | grep '^script-src ' || true)"
  frame_ancestors="$(printf '%s' "$csp" | tr ';' '\n' | sed 's/^[[:space:]]*//' | grep '^frame-ancestors ' || true)"
  [ "$script_src" = "script-src 'self'" ] || { echo 'edge caddy smoke failed: dsv Content-Security-Policy allows an unexpected script source' >&2; return 1; }
  [ "$frame_ancestors" = "frame-ancestors 'none'" ] || { echo 'edge caddy smoke failed: dsv Content-Security-Policy does not block framing' >&2; return 1; }
  grep -Eqi '^permissions-policy:[[:space:]]*camera=\(\), geolocation=\(\), microphone=\(\), payment=\(\), usb=\(\)[[:space:]]*$' "$headers" || { echo 'edge caddy smoke failed: dsv Permissions-Policy is incomplete' >&2; return 1; }
  grep -Eqi '^x-frame-options:[[:space:]]*DENY[[:space:]]*$' "$headers" || { echo 'edge caddy smoke failed: dsv X-Frame-Options is not DENY' >&2; return 1; }
  grep -Eqi '^referrer-policy:[[:space:]]*no-referrer[[:space:]]*$' "$headers" || { echo 'edge caddy smoke failed: dsv Referrer-Policy is not no-referrer' >&2; return 1; }
  grep -Eqi '^x-content-type-options:[[:space:]]*nosniff[[:space:]]*$' "$headers" || { echo 'edge caddy smoke failed: dsv X-Content-Type-Options is not nosniff' >&2; return 1; }
}
if [ "$SKIP_SMOKE" != "1" ]; then
  if ! smoke_status route-api "$ROUTE_HEALTH_URL" 200 299; then restore_caddy 'route-api smoke failed'; exit 1; fi
  if ! smoke_status route-legacy "$LEGACY_ROUTE_HEALTH_URL" 200 299; then restore_caddy 'route-legacy smoke failed'; exit 1; fi
  if ! smoke_dsv_security_headers; then restore_caddy 'dsv security header smoke failed'; exit 1; fi
  if ! smoke_status shopify-dev "$SHOPIFY_DEV_URL" 200 499; then restore_caddy 'shopify-dev smoke failed'; exit 1; fi
  if ! smoke_status shopify-prod "$SHOPIFY_PROD_URL" 200 499; then restore_caddy 'shopify-prod smoke failed'; exit 1; fi
  if ! smoke_status shopify-legacy-admin "$SHOPIFY_LEGACY_ADMIN_URL" 200 499; then restore_caddy 'shopify-legacy-admin smoke failed'; exit 1; fi
  if ! smoke_status shopify-kfood "$SHOPIFY_KFOOD_URL" 200 499; then restore_caddy 'shopify-kfood smoke failed'; exit 1; fi
fi
printf '{"ts":"%s","commitSha":"%s","lane":"edge-caddy","caddyfile":"%s","backup":"%s","smokeSkipped":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COMMIT_SHA" "$CADDYFILE" "$backup" "$SKIP_SMOKE" >> .deploy/deploy-history.jsonl
printf 'edge caddy deploy completed: commit=%s caddyfile=%s\n' "$COMMIT_SHA" "$CADDYFILE"
HOST_SCRIPT
  python3 - "$path" "$inner_path" <<'PY'
import json
import os
import shlex
import sys

path, inner_path = sys.argv[1], sys.argv[2]
with open(inner_path, 'r', encoding='utf-8') as handle:
    script = handle.read()
replacements = {
    '__APP_DIR__': shlex.quote(os.environ['APP_DIR']),
    '__COMPOSE_FILE__': shlex.quote(os.environ['COMPOSE_FILE']),
    '__CADDYFILE__': shlex.quote(os.environ['CADDYFILE']),
    '__COMPOSE_PROJECT__': shlex.quote(os.environ['COMPOSE_PROJECT']),
    '__COMMIT_SHA__': shlex.quote(os.environ['COMMIT_SHA']),
    '__DRY_RUN__': shlex.quote(os.environ['DRY_RUN']),
    '__SKIP_SMOKE__': shlex.quote(os.environ['SKIP_SMOKE']),
    '__ROUTE_HEALTH_URL__': shlex.quote(os.environ['ROUTE_HEALTH_URL']),
    '__LEGACY_ROUTE_HEALTH_URL__': shlex.quote(os.environ['LEGACY_ROUTE_HEALTH_URL']),
    '__DSV_URL__': shlex.quote(os.environ['DSV_URL']),
    '__SHOPIFY_DEV_URL__': shlex.quote(os.environ['SHOPIFY_DEV_URL']),
    '__SHOPIFY_PROD_URL__': shlex.quote(os.environ['SHOPIFY_PROD_URL']),
    '__SHOPIFY_LEGACY_ADMIN_URL__': shlex.quote(os.environ['SHOPIFY_LEGACY_ADMIN_URL']),
    '__SHOPIFY_KFOOD_URL__': shlex.quote(os.environ['SHOPIFY_KFOOD_URL']),
    '__CADDYFILE_B64__': shlex.quote(os.environ['CADDYFILE_B64']),
}
for key, value in replacements.items():
    script = script.replace(key, value)
with open(path, 'w', encoding='utf-8') as handle:
    json.dump({'commands': ['bash -lc ' + shlex.quote(script)]}, handle)
PY
  rm -f "$inner_path"
}

[ -f "$CADDYFILE" ] || fail "missing Caddyfile: $CADDYFILE"
CADDYFILE_B64="$(base64 < "$CADDYFILE" | tr -d '\n')"
export APP_DIR COMPOSE_FILE CADDYFILE COMPOSE_PROJECT COMMIT_SHA DRY_RUN SKIP_SMOKE ROUTE_HEALTH_URL LEGACY_ROUTE_HEALTH_URL DSV_URL SHOPIFY_DEV_URL SHOPIFY_PROD_URL SHOPIFY_LEGACY_ADMIN_URL SHOPIFY_KFOOD_URL CADDYFILE_B64
parameters_path="$(mktemp /tmp/edge-caddy-ssm.XXXXXX)"
write_parameters "$parameters_path"
if [ "$SEND_COMMAND" = "0" ]; then
  echo "$parameters_path"
  exit 0
fi
INSTANCE_ID="$(resolve_instance)"
COMMAND_ID="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Edge Caddy deploy ${COMMIT_SHA}" \
  --timeout-seconds 900 \
  --parameters "file://${parameters_path}" \
  --query Command.CommandId \
  --output text)"
printf 'SSM_EDGE_CADDY_COMMAND_ID=%s\nSSM_EDGE_CADDY_INSTANCE_ID=%s\n' "$COMMAND_ID" "$INSTANCE_ID"
set +e
aws ssm wait command-executed --region "$AWS_REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID"
wait_status=$?
set -e
aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
exit "$wait_status"
