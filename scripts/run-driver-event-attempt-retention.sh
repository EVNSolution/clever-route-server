#!/usr/bin/env bash
set -euo pipefail

deploy_root="${CLEVER_ROUTE_DEPLOY_ROOT:-/srv/clever-route-server}"
compose_file="${deploy_root}/infra/compose/docker-compose.prod.yml"
image_env="${CLEVER_ROUTE_IMAGE_ENV:-${deploy_root}/.deploy/current-image.env}"

[[ -f "$compose_file" ]] || { echo "missing compose file: ${compose_file}" >&2; exit 1; }
[[ -f "$image_env" ]] || { echo "missing deployed image env: ${image_env}" >&2; exit 1; }
compose=(docker compose -p clever-route --env-file "$image_env" -f "$compose_file")

if [[ "${1:-}" == "--verify" ]]; then
  "${compose[@]}" config --quiet
  printf '%s\n' '{"event":"driver_event_attempt_retention_schedule_verified"}'
  exit 0
fi

cd "$deploy_root"
"${compose[@]}" exec -T clever-route-api node -e \
  "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)throw new Error(String(r.status));console.log(JSON.stringify({event:'driver_event_attempt_retention_schedule_health',status:'healthy'}))})"
cleanup_failed=0
continuation_required=0
retention_deadline_epoch_ms=$(( $(date +%s) * 1000 + 10 * 60 * 1000 ))
commands=( \
  driver:event-attempts:cleanup \
  shopify:webhook-events:cleanup \
  driver:proof-media:cleanup \
)
driver_complete=0
webhook_complete=0
proof_complete=0
for round in {1..10}; do
  round_complete=1
  for command in "${commands[@]}"; do
    case "$command" in
      driver:event-attempts:cleanup) current_complete="$driver_complete" ;;
      shopify:webhook-events:cleanup) current_complete="$webhook_complete" ;;
      driver:proof-media:cleanup) current_complete="$proof_complete" ;;
    esac
    if [[ "$current_complete" == "1" ]]; then continue; fi
    set +e
    "${compose[@]}" exec -T -e "RETENTION_DEADLINE_EPOCH_MS=${retention_deadline_epoch_ms}" clever-route-api npm run "$command"
    command_status=$?
    set -e
    if [[ "$command_status" == "0" ]]; then
      case "$command" in
        driver:event-attempts:cleanup) driver_complete=1 ;;
        shopify:webhook-events:cleanup) webhook_complete=1 ;;
        driver:proof-media:cleanup) proof_complete=1 ;;
      esac
    elif [[ "$command_status" == "75" ]]; then
      round_complete=0
      printf '{"attempt":%d,"command":"%s","event":"route_retention_immediate_continuation"}\n' "$round" "$command"
    else
      cleanup_failed=1
      case "$command" in
        driver:event-attempts:cleanup) driver_complete=1 ;;
        shopify:webhook-events:cleanup) webhook_complete=1 ;;
        driver:proof-media:cleanup) proof_complete=1 ;;
      esac
    fi
  done
  if [[ "$round_complete" == "1" ]]; then break; fi
done
if [[ "$driver_complete" != "1" || "$webhook_complete" != "1" || "$proof_complete" != "1" ]]; then continuation_required=1; fi
if [[ "$cleanup_failed" == "1" ]]; then
  printf '%s\n' '{"event":"route_retention_failure","status":"failed"}' >&2
  exit 1
fi
if [[ "$continuation_required" == "1" ]]; then
  printf '%s\n' '{"event":"route_retention_continuation_or_failure","status":"retry_required"}' >&2
  exit 75
fi
