#!/usr/bin/env bash
set -euo pipefail

mode="${ROUTE_COMPLETION_TARGET_MODE:-}"
case "$mode" in OBSERVE) echo 'ROUTE_COMPLETION_ALARM=NOT_REQUIRED'; exit 0 ;; GUARDED|FULL) ;; *) echo 'invalid target mode' >&2; exit 65 ;; esac
: "${ROUTE_COMPLETION_OBSERVE_ALARM_NAME:?ROUTE_COMPLETION_OBSERVE_ALARM_NAME is required}"
: "${ROUTE_COMPLETION_REJECT_ALARM_NAME:?ROUTE_COMPLETION_REJECT_ALARM_NAME is required}"
: "${ROUTE_COMPLETION_ALARM_TOPIC_ARN:?ROUTE_COMPLETION_ALARM_TOPIC_ARN is required}"
region="${AWS_REGION:-ap-northeast-2}"
verify_alarm() {
  local alarm_name="$1" enabled actions
  enabled="$(aws cloudwatch describe-alarms --region "$region" --alarm-names "$alarm_name" --query 'MetricAlarms[0].ActionsEnabled' --output text)"
  actions="$(aws cloudwatch describe-alarms --region "$region" --alarm-names "$alarm_name" --query 'MetricAlarms[0].AlarmActions' --output text)"
  [[ "$enabled" = True || "$enabled" = true ]] || { echo "alarm actions are disabled: $alarm_name" >&2; exit 65; }
  printf '%s\n' "$actions" | tr '[:space:]' '\n' | grep -Fqx "$ROUTE_COMPLETION_ALARM_TOPIC_ARN" || { echo "approved SNS topic is not an alarm action: $alarm_name" >&2; exit 65; }
}
verify_alarm "$ROUTE_COMPLETION_OBSERVE_ALARM_NAME"
verify_alarm "$ROUTE_COMPLETION_REJECT_ALARM_NAME"
# Backticks below are JMESPath literals, not shell substitutions.
# shellcheck disable=SC2016
confirmed="$(aws sns list-subscriptions-by-topic --region "$region" --topic-arn "$ROUTE_COMPLETION_ALARM_TOPIC_ARN" --query 'length(Subscriptions[?SubscriptionArn != `PendingConfirmation` && SubscriptionArn != `Deleted`])' --output text)"
[[ "$confirmed" =~ ^[1-9][0-9]*$ ]] || { echo 'SNS topic has no confirmed subscription' >&2; exit 65; }
echo 'ROUTE_COMPLETION_ALARM=VERIFIED'
