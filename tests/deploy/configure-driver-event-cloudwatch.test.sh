#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
output="$(AWS_REGION=ap-northeast-2 "$repo_root/scripts/configure-driver-event-cloudwatch.sh" --dry-run)"

grep -F 'put-retention-policy' <<< "$output" >/dev/null
grep -F 'retention-in-days 90' <<< "$output" >/dev/null
for outcome in accepted applied duplicate rejected failed; do grep -F "driver-event-${outcome}" <<< "$output" >/dev/null; done
grep -F 'driver-event-failure-stage' <<< "$output" >/dev/null
grep -F 'driver-route-completion-would-reject' <<< "$output" >/dev/null
grep -F 'DriverRouteCompletionWouldReject' <<< "$output" >/dev/null
grep -F 'clever-driver-route-completion-would-reject' <<< "$output" >/dev/null
grep -F 'put-metric-alarm' <<< "$output" >/dev/null
grep -F '/clever/route-ops/delivery-api' <<< "$output" >/dev/null

echo 'driver event CloudWatch dry-run contract passed'
