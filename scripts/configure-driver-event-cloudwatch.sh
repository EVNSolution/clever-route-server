#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-northeast-2}"
LOG_GROUP="${DRIVER_EVENT_CLOUDWATCH_LOG_GROUP:-/clever/route-ops/delivery-api}"
METRIC_NAMESPACE="${DRIVER_EVENT_CLOUDWATCH_NAMESPACE:-CLEVER/DriverEvents}"
ALARM_NAME="${DRIVER_EVENT_CLOUDWATCH_ALARM_NAME:-clever-driver-event-failures}"
COMPLETION_ALARM_NAME="${DRIVER_ROUTE_COMPLETION_CLOUDWATCH_ALARM_NAME:-clever-driver-route-completion-would-reject}"
RETENTION_DAYS="${DRIVER_EVENT_CLOUDWATCH_RETENTION_DAYS:-90}"
ALARM_SNS_TOPIC_ARN="${DRIVER_EVENT_CLOUDWATCH_ALARM_SNS_TOPIC_ARN:-}"
DRY_RUN=0

if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; shift; fi
if [[ "$#" -ne 0 ]]; then echo "usage: $0 [--dry-run]" >&2; exit 64; fi
[[ "$RETENTION_DAYS" == "90" ]] || { echo "driver event CloudWatch retention must remain 90 days" >&2; exit 65; }

run() {
  if [[ "$DRY_RUN" == "1" ]]; then printf 'DRY-RUN'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

if [[ "$DRY_RUN" == "1" ]]; then
  run aws logs create-log-group --region "$AWS_REGION" --log-group-name "$LOG_GROUP"
elif ! aws logs describe-log-groups --region "$AWS_REGION" --log-group-name-prefix "$LOG_GROUP" \
  --query 'logGroups[?logGroupName==`'"$LOG_GROUP"'`].logGroupName' --output text | tr '\t' '\n' | grep -Fx "$LOG_GROUP" >/dev/null; then
  aws logs create-log-group --region "$AWS_REGION" --log-group-name "$LOG_GROUP"
fi
run aws logs put-retention-policy --region "$AWS_REGION" --log-group-name "$LOG_GROUP" --retention-in-days 90

for outcome in accepted applied duplicate rejected failed; do
  metric_name="DriverEvent$(tr '[:lower:]' '[:upper:]' <<< "${outcome:0:1}")${outcome:1}"
  run aws logs put-metric-filter \
    --region "$AWS_REGION" \
    --log-group-name "$LOG_GROUP" \
    --filter-name "driver-event-${outcome}" \
    --filter-pattern "{ $.event = \"driver_event_contract_metric\" && $.outcome = \"$outcome\" }" \
    --metric-transformations "metricName=${metric_name},metricNamespace=${METRIC_NAMESPACE},metricValue=1"
done

failure_stage_transformation="[{\"metricName\":\"DriverEventByFailureStage\",\"metricNamespace\":\"${METRIC_NAMESPACE}\",\"metricValue\":\"1\",\"dimensions\":{\"FailureStage\":\"$.failureStage\",\"Outcome\":\"$.outcome\"}}]"
run aws logs put-metric-filter \
  --region "$AWS_REGION" \
  --log-group-name "$LOG_GROUP" \
  --filter-name driver-event-failure-stage \
  --filter-pattern '{ $.event = "driver_event_contract_metric" && $.failureStage = * }' \
  --metric-transformations "$failure_stage_transformation"

run aws logs put-metric-filter \
  --region "$AWS_REGION" \
  --log-group-name "$LOG_GROUP" \
  --filter-name driver-route-completion-would-reject \
  --filter-pattern '{ $.event = "driver_route_completion_invariant" && $.mode = "OBSERVE" && $.wouldReject = true }' \
  --metric-transformations "metricName=DriverRouteCompletionWouldReject,metricNamespace=${METRIC_NAMESPACE},metricValue=1"

alarm_args=(aws cloudwatch put-metric-alarm --region "$AWS_REGION" --alarm-name "$ALARM_NAME"
  --namespace "$METRIC_NAMESPACE" --metric-name DriverEventFailed --statistic Sum --period 300
  --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold
  --treat-missing-data notBreaching)
if [[ -n "$ALARM_SNS_TOPIC_ARN" ]]; then alarm_args+=(--alarm-actions "$ALARM_SNS_TOPIC_ARN"); fi
run "${alarm_args[@]}"

completion_alarm_args=(aws cloudwatch put-metric-alarm --region "$AWS_REGION" --alarm-name "$COMPLETION_ALARM_NAME"
  --namespace "$METRIC_NAMESPACE" --metric-name DriverRouteCompletionWouldReject --statistic Sum --period 300
  --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold
  --treat-missing-data notBreaching)
if [[ -n "$ALARM_SNS_TOPIC_ARN" ]]; then completion_alarm_args+=(--alarm-actions "$ALARM_SNS_TOPIC_ARN"); fi
run "${completion_alarm_args[@]}"

printf 'driver event CloudWatch configuration ready: group=%s retentionDays=90 namespace=%s alarm=%s completionAlarm=%s\n' \
  "$LOG_GROUP" "$METRIC_NAMESPACE" "$ALARM_NAME" "$COMPLETION_ALARM_NAME"
