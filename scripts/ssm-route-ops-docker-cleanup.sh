#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
APP_DIR="${APP_DIR:-/srv/clever-route-server}"
SERVICE_TAG_KEY="${ROUTE_OPS_SSM_TAG_KEY:-Service}"
SERVICE_TAG_VALUE="${ROUTE_OPS_SSM_TAG_VALUE:-clever-delivery-server}"
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) echo "Usage: $0 [--dry-run]"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done

fail() { echo "ssm-route-ops-docker-cleanup: $*" >&2; exit 65; }
read -r count instance_id ping_status <<EOF_TARGET
$(aws ssm describe-instance-information \
  --region "$AWS_REGION" \
  --filters "Key=tag:${SERVICE_TAG_KEY},Values=${SERVICE_TAG_VALUE}" \
  --query '[length(InstanceInformationList), InstanceInformationList[0].InstanceId, InstanceInformationList[0].PingStatus]' \
  --output text)
EOF_TARGET
[ "$count" = "1" ] || fail "expected one SSM target; got $count"
[ "$ping_status" = "Online" ] || fail "SSM target is not online: $instance_id"

DOCKER_CLEANUP_SCRIPT_B64="$(base64 < scripts/route-ops-docker-cleanup.sh | tr -d '\n')"
export APP_DIR DRY_RUN DOCKER_CLEANUP_SCRIPT_B64
parameters_path="$(mktemp /tmp/route-ops-docker-cleanup-ssm.XXXXXX)"
trap 'rm -f "$parameters_path"' EXIT
python3 - "$parameters_path" <<'PY'
import json
import os
import shlex
import sys

path = sys.argv[1]
app_dir = shlex.quote(os.environ['APP_DIR'])
payload = shlex.quote(os.environ['DOCKER_CLEANUP_SCRIPT_B64'])
args = '--dry-run --enforce' if os.environ['DRY_RUN'] == '1' else '--enforce'
script = f'''set -euo pipefail
APP_DIR={app_dir}
mkdir -p "$APP_DIR/.deploy"
printf %s {payload} | base64 -d > "$APP_DIR/.deploy/route-ops-docker-cleanup.sh"
chmod 750 "$APP_DIR/.deploy/route-ops-docker-cleanup.sh"
"$APP_DIR/.deploy/route-ops-docker-cleanup.sh" {args}
'''
with open(path, 'w', encoding='utf-8') as handle:
    json.dump({'commands': ['bash -lc ' + shlex.quote(script)]}, handle)
PY

command_id="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --comment "Route Ops safe Docker cleanup dryRun=${DRY_RUN}" \
  --timeout-seconds 1800 \
  --parameters "file://${parameters_path}" \
  --query Command.CommandId \
  --output text)"
printf 'SSM_DOCKER_CLEANUP_COMMAND_ID=%s\nSSM_DOCKER_CLEANUP_INSTANCE_ID=%s\n' "$command_id" "$instance_id"
set +e
aws ssm wait command-executed --region "$AWS_REGION" --command-id "$command_id" --instance-id "$instance_id"
wait_status=$?
set -e
aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$command_id" \
  --instance-id "$instance_id" \
  --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
exit "$wait_status"
