#!/usr/bin/env bash
set -euo pipefail

mode="${ROUTE_COMPLETION_TARGET_MODE:-}"
case "$mode" in OBSERVE) echo 'ROUTE_COMPLETION_ALARM=NOT_REQUIRED'; exit 0 ;; GUARDED|FULL) ;; *) echo 'invalid target mode' >&2; exit 65 ;; esac
: "${ROUTE_COMPLETION_OBSERVE_ALARM_NAME:?ROUTE_COMPLETION_OBSERVE_ALARM_NAME is required}"
: "${ROUTE_COMPLETION_REJECT_ALARM_NAME:?ROUTE_COMPLETION_REJECT_ALARM_NAME is required}"
: "${ROUTE_COMPLETION_ALARM_TOPIC_ARN:?ROUTE_COMPLETION_ALARM_TOPIC_ARN is required}"
: "${ROUTE_COMPLETION_ALARM_RECEIPT_PATH:?ROUTE_COMPLETION_ALARM_RECEIPT_PATH is required}"
: "${ROUTE_COMPLETION_SOURCE_SHA:?ROUTE_COMPLETION_SOURCE_SHA is required}"
[[ "$ROUTE_COMPLETION_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'source SHA must be exact' >&2; exit 65; }
region="${AWS_REGION:-ap-northeast-2}"
verify_alarm() {
  local alarm_name="$1" metric_name="$2" alarm
  alarm="$(aws cloudwatch describe-alarms --region "$region" --alarm-names "$alarm_name" --query 'MetricAlarms[0]' --output json)"
  jq -e --arg alarm "$alarm_name" --arg metric "$metric_name" --arg topic "$ROUTE_COMPLETION_ALARM_TOPIC_ARN" '
    .AlarmName == $alarm and .ActionsEnabled == true
    and .Namespace == "CLEVER/DriverEvents" and .MetricName == $metric
    and .Statistic == "Sum" and .Period == 300 and .EvaluationPeriods == 1
    and .DatapointsToAlarm == 1 and .Threshold == 1
    and .ComparisonOperator == "GreaterThanOrEqualToThreshold"
    and .TreatMissingData == "notBreaching"
    and ((.Dimensions // []) | length) == 0
    and (.AlarmActions == [$topic])
  ' <<<"$alarm" >/dev/null || { echo "alarm contract mismatch: $alarm_name" >&2; exit 65; }
}
verify_alarm "$ROUTE_COMPLETION_OBSERVE_ALARM_NAME" DriverRouteCompletionWouldReject
verify_alarm "$ROUTE_COMPLETION_REJECT_ALARM_NAME" DriverRouteCompletionRejected
# Backticks below are JMESPath literals, not shell substitutions.
# shellcheck disable=SC2016
confirmed="$(aws sns list-subscriptions-by-topic --region "$region" --topic-arn "$ROUTE_COMPLETION_ALARM_TOPIC_ARN" --query 'length(Subscriptions[?SubscriptionArn != `PendingConfirmation` && SubscriptionArn != `Deleted`])' --output text)"
[[ "$confirmed" =~ ^[1-9][0-9]*$ ]] || { echo 'SNS topic has no confirmed subscription' >&2; exit 65; }
jq -e --arg observe "$ROUTE_COMPLETION_OBSERVE_ALARM_NAME" --arg reject "$ROUTE_COMPLETION_REJECT_ALARM_NAME" \
  --arg sha "$ROUTE_COMPLETION_SOURCE_SHA" --arg topic "$ROUTE_COMPLETION_ALARM_TOPIC_ARN" --argjson now "$(date -u +%s)" '
  .schemaVersion == 1 and .sourceSha == $sha and .topicArn == $topic
  and (.generatedAt | fromdateiso8601) <= $now
  and (.generatedAt | fromdateiso8601) >= ($now - 3600)
  and ([.deliveries[] | select(.alarmName == $observe and .metricName == "DriverRouteCompletionWouldReject" and .deliveryStatus == "DELIVERED" and (.correlationToken | startswith($sha + ":")) and (.receivedAt | fromdateiso8601) >= ($now - 3600) and (.receivedAt | fromdateiso8601) <= $now)] | length) == 1
  and ([.deliveries[] | select(.alarmName == $reject and .metricName == "DriverRouteCompletionRejected" and .deliveryStatus == "DELIVERED" and (.correlationToken | startswith($sha + ":")) and (.receivedAt | fromdateiso8601) >= ($now - 3600) and (.receivedAt | fromdateiso8601) <= $now)] | length) == 1
' "$ROUTE_COMPLETION_ALARM_RECEIPT_PATH" >/dev/null || { echo 'exact-SHA alarm canary delivery receipt is missing, stale, or invalid' >&2; exit 65; }
echo 'ROUTE_COMPLETION_ALARM=VERIFIED'
