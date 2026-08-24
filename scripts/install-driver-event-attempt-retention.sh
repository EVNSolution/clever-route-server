#!/usr/bin/env bash
set -euo pipefail

deploy_root="${CLEVER_ROUTE_DEPLOY_ROOT:-/srv/clever-route-server}"
unit_source_dir="${CLEVER_ROUTE_RETENTION_UNIT_SOURCE_DIR:-${deploy_root}/infra/systemd}"
runner_source="${CLEVER_ROUTE_RETENTION_RUNNER_SOURCE:-${deploy_root}/scripts/run-driver-event-attempt-retention.sh}"
runner_target="${deploy_root}/scripts/run-driver-event-attempt-retention.sh"
unit_target_dir="${CLEVER_ROUTE_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
systemctl_bin="${SYSTEMCTL_BIN:-systemctl}"
journalctl_bin="${JOURNALCTL_BIN:-journalctl}"
service_name='clever-driver-event-attempt-retention.service'
timer_name='clever-driver-event-attempt-retention.timer'

for required in \
  "$runner_source" \
  "${unit_source_dir}/${service_name}" \
  "${unit_source_dir}/${timer_name}"; do
  test -f "$required" || { echo "retention installer missing required file: $required" >&2; exit 65; }
done

bash -n "$runner_source"
install -d -m 0755 "$(dirname "$runner_target")"
if [[ "$runner_source" != "$runner_target" ]]; then
  install -m 0750 "$runner_source" "$runner_target"
else
  chmod 0750 "$runner_target"
fi
install -d -m 0755 "$unit_target_dir"
install -m 0644 "${unit_source_dir}/${service_name}" "${unit_target_dir}/${service_name}"
install -m 0644 "${unit_source_dir}/${timer_name}" "${unit_target_dir}/${timer_name}"

"$systemctl_bin" daemon-reload
"$systemctl_bin" enable --now "$timer_name"
test "$("$systemctl_bin" is-enabled "$timer_name")" = 'enabled'
test "$("$systemctl_bin" is-active "$timer_name")" = 'active'
"$systemctl_bin" list-timers "$timer_name" --no-pager

# A fresh host must prove the installed worker can complete, rather than waiting
# until the first daily trigger to discover a broken compose/env contract.
"$systemctl_bin" start "$service_name"
test "$("$systemctl_bin" show "$service_name" -p Result --value)" = 'success'
last_exit_at="$("$systemctl_bin" show "$service_name" -p ExecMainExitTimestamp --value)"
test -n "$last_exit_at"
"$journalctl_bin" -u "$service_name" -n 40 --no-pager
printf 'driver event attempt retention installed: timer=%s lastExit=%s\n' "$timer_name" "$last_exit_at"
