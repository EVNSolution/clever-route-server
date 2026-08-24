#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
fixture_env="$(mktemp)"
fixture_root="$(mktemp -d)"
fake_bin="$(mktemp -d)"
created_app_env=0
cleanup() {
  rm -f "$fixture_env"
  rm -rf "$fixture_root" "$fake_bin"
  if [[ "$created_app_env" == "1" ]]; then rm -f "${repo_root}/apps/delivery-api/.env"; fi
}
trap cleanup EXIT

cat > "$fixture_env" <<'ENV'
DELIVERY_API_IMAGE=fixture/delivery-api:test
ROUTE_OPS_WEB_STATIC_IMAGE=fixture/route-ops-web-static:test
ROUTE_OPS_WEB_STATIC_VOLUME=fixture-route-ops-web-static
ENV
if [[ ! -f "${repo_root}/apps/delivery-api/.env" ]]; then
  cp "${repo_root}/apps/delivery-api/.env.example" "${repo_root}/apps/delivery-api/.env"
  created_app_env=1
fi

bash -n "${repo_root}/scripts/run-driver-event-attempt-retention.sh"
bash -n "${repo_root}/scripts/install-driver-event-attempt-retention.sh"
grep -q 'OnCalendar=hourly' "${repo_root}/infra/systemd/clever-driver-event-attempt-retention.timer"
grep -q 'Persistent=true' "${repo_root}/infra/systemd/clever-driver-event-attempt-retention.timer"
grep -q 'ConditionPathExists=/srv/clever-route-server/.deploy/current-image.env' "${repo_root}/infra/systemd/clever-driver-event-attempt-retention.service"
grep -q -- '-p clever-route --env-file' "${repo_root}/scripts/run-driver-event-attempt-retention.sh"
grep -q 'driver_event_attempt_retention_schedule_health' "${repo_root}/scripts/run-driver-event-attempt-retention.sh"
grep -q 'driver:event-attempts:cleanup' "${repo_root}/scripts/run-driver-event-attempt-retention.sh"
grep -q 'shopify:webhook-events:cleanup' "${repo_root}/scripts/run-driver-event-attempt-retention.sh"
grep -q 'driver:proof-media:cleanup' "${repo_root}/scripts/run-driver-event-attempt-retention.sh"
grep -q 'route_retention_continuation_or_failure' "${repo_root}/scripts/run-driver-event-attempt-retention.sh"
grep -q 'route_retention_failure' "${repo_root}/scripts/run-driver-event-attempt-retention.sh"
grep -q 'RETENTION_INSTALLER_B64' "${repo_root}/scripts/ssm-simple-route-ops-deploy.sh"
grep -q '\.deploy/install-driver-event-attempt-retention.sh' "${repo_root}/scripts/ssm-simple-route-ops-deploy.sh"
env -i PATH="$PATH" CLEVER_ROUTE_DEPLOY_ROOT="$repo_root" CLEVER_ROUTE_IMAGE_ENV="$fixture_env" \
  "${repo_root}/scripts/run-driver-event-attempt-retention.sh" --verify \
  | grep -q 'driver_event_attempt_retention_schedule_verified'

cat > "${fake_bin}/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${DOCKER_LOG:?}"
if [[ "$*" == *'npm run driver:event-attempts:cleanup'* ]]; then
  count=0
  [[ -f "${DRIVER_COUNT_FILE:?}" ]] && count="$(cat "$DRIVER_COUNT_FILE")"
  count=$((count + 1)); printf '%s' "$count" > "$DRIVER_COUNT_FILE"
  if [[ "$count" == "1" ]]; then exit 75; fi
fi
exit 0
SH
chmod +x "${fake_bin}/docker"
docker_log="${fixture_root}/docker.log"
driver_count_file="${fixture_root}/driver-count"
PATH="${fake_bin}:$PATH" DOCKER_LOG="$docker_log" DRIVER_COUNT_FILE="$driver_count_file" \
  CLEVER_ROUTE_DEPLOY_ROOT="$repo_root" CLEVER_ROUTE_IMAGE_ENV="$fixture_env" \
  "${repo_root}/scripts/run-driver-event-attempt-retention.sh" >/dev/null
driver_first="$(grep -n 'npm run driver:event-attempts:cleanup' "$docker_log" | sed -n '1s/:.*//p')"
webhook_first="$(grep -n 'npm run shopify:webhook-events:cleanup' "$docker_log" | sed -n '1s/:.*//p')"
proof_first="$(grep -n 'npm run driver:proof-media:cleanup' "$docker_log" | sed -n '1s/:.*//p')"
driver_second="$(grep -n 'npm run driver:event-attempts:cleanup' "$docker_log" | sed -n '2s/:.*//p')"
test "$driver_first" -lt "$webhook_first"
test "$webhook_first" -lt "$proof_first"
test "$proof_first" -lt "$driver_second"
grep -q 'RETENTION_DEADLINE_EPOCH_MS=' "$docker_log"

cat > "${fake_bin}/docker-fail" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${DOCKER_LOG:?}"
if [[ "$*" == *'npm run driver:event-attempts:cleanup'* ]]; then exit 2; fi
exit 0
SH
chmod +x "${fake_bin}/docker-fail"
ln -sf "${fake_bin}/docker-fail" "${fake_bin}/docker"
: > "$docker_log"
if PATH="${fake_bin}:$PATH" DOCKER_LOG="$docker_log" \
  CLEVER_ROUTE_DEPLOY_ROOT="$repo_root" CLEVER_ROUTE_IMAGE_ENV="$fixture_env" \
  "${repo_root}/scripts/run-driver-event-attempt-retention.sh" >/dev/null 2>&1; then
  echo 'hard child failure must not be converted to a successful continuation' >&2
  exit 1
fi
grep -q 'npm run driver:event-attempts:cleanup' "$docker_log"
grep -q 'npm run shopify:webhook-events:cleanup' "$docker_log"
grep -q 'npm run driver:proof-media:cleanup' "$docker_log"

mkdir -p "$fixture_root/scripts" "$fixture_root/infra/systemd" "$fixture_root/systemd"
cp "${repo_root}/scripts/run-driver-event-attempt-retention.sh" "$fixture_root/scripts/"
cp "${repo_root}/infra/systemd/clever-driver-event-attempt-retention.service" "$fixture_root/infra/systemd/"
cp "${repo_root}/infra/systemd/clever-driver-event-attempt-retention.timer" "$fixture_root/infra/systemd/"
cat > "${fake_bin}/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${SYSTEMCTL_LOG:?}"
case "$1" in
  is-enabled) echo enabled ;;
  is-active) echo active ;;
  list-timers) echo 'fixture timer listed' ;;
  show)
    case "$*" in
      *Result*) echo success ;;
      *ExecMainExitTimestamp*) echo 'Mon 2026-08-25 00:00:00 UTC' ;;
    esac
    ;;
esac
SH
cat > "${fake_bin}/journalctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${JOURNALCTL_LOG:?}"
echo 'fixture retention run evidence'
SH
chmod +x "${fake_bin}/systemctl" "${fake_bin}/journalctl"
systemctl_log="${fixture_root}/systemctl.log"
journalctl_log="${fixture_root}/journalctl.log"
SYSTEMCTL_LOG="$systemctl_log" JOURNALCTL_LOG="$journalctl_log" \
  CLEVER_ROUTE_DEPLOY_ROOT="$fixture_root" CLEVER_ROUTE_SYSTEMD_UNIT_DIR="$fixture_root/systemd" \
  SYSTEMCTL_BIN="${fake_bin}/systemctl" JOURNALCTL_BIN="${fake_bin}/journalctl" \
  "${repo_root}/scripts/install-driver-event-attempt-retention.sh" \
  | grep -q 'driver event attempt retention installed'
cmp "$fixture_root/infra/systemd/clever-driver-event-attempt-retention.service" \
  "$fixture_root/systemd/clever-driver-event-attempt-retention.service"
grep -qx 'daemon-reload' "$systemctl_log"
grep -qx 'enable --now clever-driver-event-attempt-retention.timer' "$systemctl_log"
grep -qx 'is-enabled clever-driver-event-attempt-retention.timer' "$systemctl_log"
grep -qx 'is-active clever-driver-event-attempt-retention.timer' "$systemctl_log"
grep -qx 'list-timers clever-driver-event-attempt-retention.timer --no-pager' "$systemctl_log"
grep -qx 'start clever-driver-event-attempt-retention.service' "$systemctl_log"
grep -qx -- '-u clever-driver-event-attempt-retention.service -n 40 --no-pager' "$journalctl_log"

cat > "${fake_bin}/systemctl-fail" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == 'is-active' ]]; then echo inactive; exit 0; fi
if [[ "$1" == 'is-enabled' ]]; then echo enabled; exit 0; fi
exit 0
SH
chmod +x "${fake_bin}/systemctl-fail"
if CLEVER_ROUTE_DEPLOY_ROOT="$fixture_root" CLEVER_ROUTE_SYSTEMD_UNIT_DIR="$fixture_root/systemd" \
  SYSTEMCTL_BIN="${fake_bin}/systemctl-fail" JOURNALCTL_BIN="${fake_bin}/journalctl" \
  JOURNALCTL_LOG="$journalctl_log" "${repo_root}/scripts/install-driver-event-attempt-retention.sh" >/dev/null 2>&1; then
  echo 'retention installer must fail closed when timer is inactive' >&2
  exit 1
fi
