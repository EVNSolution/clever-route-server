#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
SERVICE_TAG_KEY="${ROUTE_OPS_BACKUP_SSM_TAG_KEY:-Service}"
SERVICE_TAG_VALUE="${ROUTE_OPS_BACKUP_SSM_TAG_VALUE:-clever-delivery-server}"
BACKUP_ROOT="${ROUTE_OPS_BACKUP_ROOT:-/mnt/clever-delivery-postgres/backups}"
WORKER_SOURCE="${ROUTE_OPS_BACKUP_WORKER_SOURCE:-scripts/backup-route-ops-data.sh}"
WORKER_TARGET="${ROUTE_OPS_BACKUP_WORKER_TARGET:-/usr/local/sbin/clever-route-backup}"
DRY_RUN=0
RUN_BACKUP=0
SEND_COMMAND=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --run-backup) RUN_BACKUP=1 ;;
    --no-send) SEND_COMMAND=0 ;;
    -h|--help) echo "Usage: $0 [--dry-run] [--run-backup] [--no-send]"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done

fail() { echo "ssm-install-route-ops-backup: $*" >&2; exit 65; }
test -f "$WORKER_SOURCE" || fail "missing backup worker: $WORKER_SOURCE"
bash -n "$WORKER_SOURCE"

resolve_instance() {
  read -r count instance_id ping_status <<EOF_TARGET
$(aws ssm describe-instance-information --region "$AWS_REGION" \
  --filters "Key=tag:${SERVICE_TAG_KEY},Values=${SERVICE_TAG_VALUE}" \
  --query '[length(InstanceInformationList), InstanceInformationList[0].InstanceId, InstanceInformationList[0].PingStatus]' --output text)
EOF_TARGET
  test "$count" = 1 || fail "expected one SSM target; got $count"
  test "$ping_status" = Online || fail "SSM target is not Online: $ping_status"
  printf '%s' "$instance_id"
}

WORKER_B64="$(base64 < "$WORKER_SOURCE" | tr -d '\n')"
export BACKUP_ROOT WORKER_TARGET WORKER_B64 DRY_RUN RUN_BACKUP
parameters_path="$(mktemp /tmp/route-ops-backup-ssm.XXXXXX)"
python3 - "$parameters_path" <<'PY'
import json, os, shlex, sys
script = r'''set -euo pipefail
BACKUP_ROOT=__BACKUP_ROOT__
WORKER_TARGET=__WORKER_TARGET__
DRY_RUN=__DRY_RUN__
RUN_BACKUP=__RUN_BACKUP__
WORKER_B64=__WORKER_B64__
candidate="$(mktemp /tmp/clever-route-backup.XXXXXX)"
trap 'rm -f "$candidate"' EXIT
printf '%s' "$WORKER_B64" | base64 -d > "$candidate"
chmod 0750 "$candidate"
bash -n "$candidate"
ROUTE_OPS_BACKUP_ROOT="$BACKUP_ROOT" "$candidate" --preflight
if [ "$DRY_RUN" = "1" ]; then
  echo 'route ops backup install dry-run complete; no persistent mutation performed.'
  exit 0
fi
mkdir -p "$BACKUP_ROOT"
chmod 0700 "$BACKUP_ROOT"
install -m 0750 "$candidate" "$WORKER_TARGET"
cat > /etc/systemd/system/clever-route-backup.service <<EOF_SERVICE
[Unit]
Description=CLEVER Route PostgreSQL and Shopify SQLite backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=ROUTE_OPS_BACKUP_ROOT=$BACKUP_ROOT
Environment=ROUTE_OPS_BACKUP_MIN_FREE_GIB=20
Environment=ROUTE_OPS_BACKUP_MAX_GIB=10
ExecStart=$WORKER_TARGET
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
UMask=0077
EOF_SERVICE
cat > /etc/systemd/system/clever-route-backup.timer <<'EOF_TIMER'
[Unit]
Description=Run CLEVER Route backup daily at 03:00 KST

[Timer]
OnCalendar=*-*-* 18:00:00 UTC
RandomizedDelaySec=15m
Persistent=true
Unit=clever-route-backup.service

[Install]
WantedBy=timers.target
EOF_TIMER
systemctl daemon-reload
systemctl enable --now clever-route-backup.timer
systemctl is-enabled clever-route-backup.timer
systemctl is-active clever-route-backup.timer
systemctl list-timers clever-route-backup.timer --no-pager
if [ "$RUN_BACKUP" = "1" ]; then
  systemctl start clever-route-backup.service
  test "$(systemctl show clever-route-backup.service -p Result --value)" = success
  journalctl -u clever-route-backup.service -n 40 --no-pager
fi
'''
replacements = {
    '__BACKUP_ROOT__': shlex.quote(os.environ['BACKUP_ROOT']),
    '__WORKER_TARGET__': shlex.quote(os.environ['WORKER_TARGET']),
    '__DRY_RUN__': shlex.quote(os.environ['DRY_RUN']),
    '__RUN_BACKUP__': shlex.quote(os.environ['RUN_BACKUP']),
    '__WORKER_B64__': shlex.quote(os.environ['WORKER_B64']),
}
for key, value in replacements.items():
    script = script.replace(key, value)
with open(sys.argv[1], 'w', encoding='utf-8') as handle:
    json.dump({'commands': ['bash -lc ' + shlex.quote(script)]}, handle)
PY

if [ "$SEND_COMMAND" = 0 ]; then echo "$parameters_path"; exit 0; fi
instance_id="$(resolve_instance)"
command_id="$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript --comment 'Install Route Ops backup timer' --timeout-seconds 1800 \
  --parameters "file://$parameters_path" --query Command.CommandId --output text)"
printf 'SSM_ROUTE_OPS_BACKUP_COMMAND_ID=%s\nSSM_ROUTE_OPS_BACKUP_INSTANCE_ID=%s\n' "$command_id" "$instance_id"
set +e
aws ssm wait command-executed --region "$AWS_REGION" --command-id "$command_id" --instance-id "$instance_id"
wait_status=$?
set -e
aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$instance_id" \
  --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' --output json
exit "$wait_status"
