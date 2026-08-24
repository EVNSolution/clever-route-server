# Driver event contract CloudWatch runbook

The production Compose definition ships delivery API stdout/stderr through Docker's `awslogs` driver to `/clever/route-ops/delivery-api`. The log group is stable while container stream tags change (`route-ops-api/<container-id>`), so a container replacement does not split the searchable evidence boundary.

G009 owns applying these controls to production. Before that deployment, review the dry-run plan:

```bash
AWS_REGION=ap-northeast-2 scripts/configure-driver-event-cloudwatch.sh --dry-run
```

The apply lane requires AWS permissions for CloudWatch Logs and alarms:

```bash
AWS_REGION=ap-northeast-2 \
DRIVER_EVENT_CLOUDWATCH_ALARM_SNS_TOPIC_ARN=arn:aws:sns:... \
scripts/configure-driver-event-cloudwatch.sh
```

The script creates the stable log group, enforces 90-day retention, installs outcome metrics for `accepted`, `applied`, `duplicate`, `rejected`, and `failed`, installs a failure-stage metric, and alarms on `failed >= 1` in five minutes. Do not lower retention or add raw payload fields.

Search across container replacements by log group, not stream name:

```bash
aws logs filter-log-events \
  --region ap-northeast-2 \
  --log-group-name /clever/route-ops/delivery-api \
  --filter-pattern '{ $.event = "driver_event_contract_metric" }' \
  --start-time <epoch-ms>
```

Reconciliation queries should correlate only the allowlisted `requestId`, `driverId`, `routePlanId`, `attemptNumber`, outcome, and failure stage. Logs and `DriverEventAttempt` rows intentionally exclude tokens, payloads, customer names, addresses, notes, proof media, coordinates, and free-form error strings.

Expired evidence cleanup is separate from CloudWatch retention:

```bash
cd apps/delivery-api
npm run driver:event-attempts:cleanup
```

Production hosts schedule this repository-owned command with
`infra/systemd/clever-driver-event-attempt-retention.timer`. Install the service
and timer into `/etc/systemd/system`, then enable the timer during the G009
production rollout. Each run first records
`driver_event_attempt_retention_schedule_health`, followed by the cleanup's
`driver_event_attempt_retention_cleanup` result in journald. The wrapper always
uses the deployed `.deploy/current-image.env` and stable Compose project
`clever-route`, so it works under systemd's clean environment and targets the
same containers as the production deploy. Verify with:

```bash
systemctl status clever-driver-event-attempt-retention.timer
journalctl -u clever-driver-event-attempt-retention.service --since '2 days ago'
```

The same scheduled execution also emits `route_operational_evidence_retention_cleanup`.
It removes expired 30-day sync history only outside the current unrevoked lease,
resolved 365-day alert cycles only, and 180-day email attempts only after their
automatic fact or manual recipient reached `SENT`. Unresolved alerts and failed or
pending email reconciliation evidence are preserved.

The same daily wrapper runs Shopify webhook terminal cleanup and proof-media cleanup. Shopify retains terminal inbox tombstones for at least 30 days while preserving every retryable, leased, failed, and dead-letter event. Proof media reserves `PENDING_UPLOAD` metadata before object write; reservations older than 24 hours are reconciled, while `READY` referenced proof is excluded from orphan cleanup.

`DRIVER_EVENT_ATTEMPT_RETENTION_DAYS` rejects values below 90. Expired
`REJECTED` evidence remains until an account-scoped reconciliation marks it
resolved; only resolved rejections are eligible for cleanup.

Cleanup deletes terminal `APPLIED` and `DUPLICATE` evidence after 90 days, and
deletes `REJECTED` evidence only after explicit reconciliation. `ACCEPTED`,
`FAILED`, and unresolved `REJECTED` rows remain preserved.
