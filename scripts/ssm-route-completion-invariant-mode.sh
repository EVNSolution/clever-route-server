#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
APP_DIR="${APP_DIR:-/srv/clever-route-server}"
SERVICE_TAG_KEY="${ROUTE_OPS_SSM_TAG_KEY:-Service}"
SERVICE_TAG_VALUE="${ROUTE_OPS_SSM_TAG_VALUE:-clever-delivery-server}"
SOURCE_SHA="${ROUTE_COMPLETION_SOURCE_SHA:-}"
TARGET_MODE="${ROUTE_COMPLETION_TARGET_MODE:-}"
EXPECTED_CURRENT_MODE="${ROUTE_COMPLETION_EXPECTED_CURRENT_MODE:-}"

fail() { echo "ssm-route-completion-invariant-mode: $*" >&2; exit 65; }
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'ROUTE_COMPLETION_SOURCE_SHA must be an exact 40-character SHA'
case "$TARGET_MODE" in OBSERVE|GUARDED|FULL) ;; *) fail 'ROUTE_COMPLETION_TARGET_MODE must be OBSERVE, GUARDED, or FULL' ;; esac
case "$EXPECTED_CURRENT_MODE" in OBSERVE|GUARDED|FULL) ;; *) fail 'ROUTE_COMPLETION_EXPECTED_CURRENT_MODE must be OBSERVE, GUARDED, or FULL' ;; esac

render_host_script() {
  cat <<EOF_HOST
set -euo pipefail
APP_DIR='$APP_DIR'
COMMIT_SHA=$SOURCE_SHA
TARGET_MODE=$TARGET_MODE
EXPECTED_CURRENT_MODE=$EXPECTED_CURRENT_MODE
cd "\$APP_DIR"
test "\$(sed -n 's/^COMMIT_SHA=//p' .deploy/current-image.env)" = "\$COMMIT_SHA"
lock_dir=.deploy/route-ops-simple-deploy.lock.d
if ! mkdir "\$lock_dir" 2>/dev/null; then echo 'shared route-ops deploy lock is held' >&2; exit 65; fi
cleanup() { rmdir "\$lock_dir" 2>/dev/null || true; }
trap cleanup EXIT
runtime_env=apps/delivery-api/.env
backup=".deploy/runtime-env.before-route-completion-mode-\$(date -u +%Y%m%dT%H%M%SZ)"
cp "\$runtime_env" "\$backup"
current_mode="\$(sed -n 's/^DRIVER_ROUTE_COMPLETION_INVARIANT_MODE=//p' "\$runtime_env" | tail -1)"
current_mode="\${current_mode:-OBSERVE}"
test "\$current_mode" = "\$EXPECTED_CURRENT_MODE"
wait_health() {
  for attempt in \$(seq 1 12); do
    if docker compose -p clever-route --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml exec -T clever-route-api node -e "const http=require('node:http');http.get('http://127.0.0.1:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"; then return 0; fi
    test "\$attempt" -lt 12 || return 1
    sleep 5
  done
}
rollback() {
  trap - ERR
  cp "\$backup" "\$runtime_env"
  docker compose -p clever-route --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml up -d --no-build --no-deps --force-recreate clever-route-api
  wait_health || { echo 'rollback failed to restore healthy service' >&2; exit 70; }
  restored_mode="\$(docker compose -p clever-route --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml exec -T clever-route-api printenv DRIVER_ROUTE_COMPLETION_INVARIANT_MODE || true)"
  test "\${restored_mode:-OBSERVE}" = "\$EXPECTED_CURRENT_MODE"
}
trap 'rollback' ERR
if grep -q '^DRIVER_ROUTE_COMPLETION_INVARIANT_MODE=' "\$runtime_env"; then
  sed -i.bak "s/^DRIVER_ROUTE_COMPLETION_INVARIANT_MODE=.*/DRIVER_ROUTE_COMPLETION_INVARIANT_MODE=\$TARGET_MODE/" "\$runtime_env"
  rm -f "\$runtime_env.bak"
else
  printf '\nDRIVER_ROUTE_COMPLETION_INVARIANT_MODE=%s\n' "\$TARGET_MODE" >> "\$runtime_env"
fi
docker compose -p clever-route --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml up -d --no-build --no-deps --force-recreate clever-route-api
wait_health
test "\$(docker compose -p clever-route --env-file .deploy/current-image.env -f infra/compose/docker-compose.prod.yml exec -T clever-route-api printenv DRIVER_ROUTE_COMPLETION_INVARIANT_MODE)" = "\$TARGET_MODE"
trap - ERR
printf 'ROUTE_COMPLETION_MODE=%s\nROUTE_COMPLETION_SOURCE_SHA=%s\n' "\$TARGET_MODE" "\$COMMIT_SHA"
EOF_HOST
}

if [ "${1:-}" = '--render-host-script' ]; then render_host_script; exit 0; fi
[ "$#" -eq 0 ] || fail "unknown argument: $1"

read -r count instance_id ping_status <<EOF_TARGET
$(aws ssm describe-instance-information --region "$AWS_REGION" --filters "Key=tag:${SERVICE_TAG_KEY},Values=${SERVICE_TAG_VALUE}" --query '[length(InstanceInformationList), InstanceInformationList[0].InstanceId, InstanceInformationList[0].PingStatus]' --output text)
EOF_TARGET
[ "$count" = 1 ] || fail "expected one SSM target; got $count"
[ "$ping_status" = Online ] || fail "SSM target is not online: $instance_id"

payload="$(render_host_script)"
parameters_path="$(mktemp /tmp/route-completion-mode-ssm.XXXXXX)"
trap 'rm -f "$parameters_path"' EXIT
export payload
python3 - "$parameters_path" <<'PY'
import json, os, shlex, sys
with open(sys.argv[1], 'w', encoding='utf-8') as handle:
    json.dump({'commands': ['bash -lc ' + shlex.quote(os.environ['payload'])]}, handle)
PY
command_id="$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$instance_id" --document-name AWS-RunShellScript --comment "Route completion invariant mode $TARGET_MODE at $SOURCE_SHA" --timeout-seconds 900 --parameters "file://${parameters_path}" --query Command.CommandId --output text)"
printf 'SSM_ROUTE_COMPLETION_COMMAND_ID=%s\nSSM_ROUTE_COMPLETION_INSTANCE_ID=%s\n' "$command_id" "$instance_id"
set +e
aws ssm wait command-executed --region "$AWS_REGION" --command-id "$command_id" --instance-id "$instance_id"
wait_status=$?
set -e
aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$instance_id" --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' --output json
exit "$wait_status"
