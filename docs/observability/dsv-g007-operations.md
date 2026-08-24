# DSV G007 Observation Operations

G007 uses repo-owned scripts and structured logs instead of hosted dashboard
infrastructure. The policy is checked in at
`docs/observability/dsv-g007-monitor-policy.json`.

## Observation Report

Aggregate a remote fixture or live E2E log window:

```bash
scripts/dsv-g007-observation-report.sh \
  --input evidence/g007-request-window.jsonl \
  --started-at 2026-07-23T00:00:00.000Z \
  --ended-at 2026-07-23T00:10:00.000Z
```

The report includes `windowSeconds`, per route/method category counts,
sampled request IDs, caller surfaces, and zero-evidence booleans for
`legacy_read` and `legacy_write`. The supported categories are exactly:
`v1_read`, `canonical_assignment_command_alias`, `legacy_read`, and
`legacy_write`.

The canonical SellerOrder command aliases are reported as
`canonical_assignment_command_alias` and do not count as `legacy_write`.

## Production Monitor

The existing production monitor remains text-first by default. Enable the G007
machine-readable status explicitly:

```bash
AWS_REGION=ap-northeast-2 scripts/monitor-route-ops-production.sh --g007-json-status
```

For static review without SSM or production access:

```bash
scripts/monitor-route-ops-production.sh --render-host-script --status-only --g007-json-status
```

By default, G007 health/readiness probes execute inside
`clever-route-clever-route-api-1` with `docker exec`, so the current production
compose file does not need to publish API port `3000` on the host. To probe a
separately exposed endpoint instead, set `ROUTE_OPS_G007_STATUS_BASE_URL` to the
external base URL.

The JSON status schema is version 2 and follows this exit policy:

| Status | Exit | Meaning |
| --- | ---: | --- |
| `ok` | 0 | Health, readiness, migrations, invariants, legacy usage, and customer-email outbox state are within policy. |
| `warning` | 0 | The automatic customer-email runtime is disabled while queued or retryable work remains. This is operator-visible backlog, not evidence that the deployment or API is unavailable. |
| `unknown` | 1 | A check could not be read and no critical finding was observed. |
| `critical` | 2 | Health/readiness failed, the deployed migration manifest is malformed, migration history is pending, incomplete, unresolved, unexpected, or has a current successful-row checksum mismatch, an invariant failed, legacy read/write usage was observed, email work is stranded/dead, or an enabled email runtime has overdue work. |

The `customerEmailOutbox` check reads every `(app, shop)` database scope, including
non-default app scopes, but emits anonymous scope ordinals and a `defaultApp`
boolean only. It never emits app/shop identifiers, recipient data, email content,
order/customer identifiers, provider messages, or provider error payload text. Counts are split into
fresh and overdue queued work, retry waits, processing/stale processing, and dead
letters. The query is read-only and does not update facts or delivery-attempt rows.

When automatic customer delivery email is intentionally paused in an operating
environment, declare that intent with the exact runtime key:

```dotenv
CUSTOMER_DELIVERY_NOTIFICATION_WORKER_ENABLED=false
```

Do not use `CUSTOMER_NOTIFICATION_WORKER_ENABLED`; the runtime does not read that
shorter name. A missing `CUSTOMER_DELIVERY_NOTIFICATION_URL` already disables the
sender implicitly, but the explicit worker flag distinguishes deliberate policy
from an accidentally incomplete sender configuration. This runbook declaration
does not change the committed example default and does not authorize sending or
re-sending queued facts.

Migration status reads the authoritative migration names and SHA-256 checksums
from the deployed API image, then compares them with successful applied rows in
`_prisma_migrations`. The expected count and latest migration therefore advance
with the deployed image instead of a hard-coded historical checkpoint.

A rolled-back history row is classified as recovered only when the same migration
is in the deployed expected chain and also has a successful row whose checksum
matches the deployed migration. The historical rolled-back row may retain its old
checksum; it does not describe the currently applied SQL. Recovered history keeps
overall `status=ok` while setting `historyStatus=recovered` and reporting
`recoveredCount` and `recoveredMigrations`. A rolled-back row without that matching
successful row remains unresolved and `critical`.

The status also reports `expectedCount`, `appliedCount`, `pendingCount`,
`failedCount`, `checksumMismatchCount`, `checksumMismatchMigrations`,
`latestMigration`, `actualLatestMigration`, `pendingMigrations`,
`unexpectedCount`, and `unexpectedMigrations`. A migration check that cannot be
read remains `unknown`, but an empty, non-array, invalid-name, invalid-checksum,
or duplicate-name manifest from the deployed image is an artifact integrity
failure and therefore `critical`. Pending or incomplete rows, unexpected names,
unresolved rolled-back rows, and successful-row checksum mismatches also remain
`critical`.

G007 does not remove legacy paths. Production removal requires a later
operator-selected observation window with zero `legacy_read` and `legacy_write`.

## Final Local Evidence

Final live evidence root: `/tmp/g007-live-final-20260723_070636`.

These values preserve the G007 checkpoint facts before the G009 and G010 FK
repairs were added.

- Recovery DB migration status: `appliedCount=42`, `failedCount=0`, latest `20260722233000_align_migration_history_to_schema`.
- Invariant monitor status: `ok`; the historical five invariant failures were zero (`duplicate_active_assignments`, `failed_command_receipts`, `audit_rows_missing_request_ids`, `import_partial_apply_indicators`, `stale_eta_route_versions`). Current monitor policy replaces the stale-only ETA check with `eta_input_route_version_mismatches`, which flags active route-plan stops whose non-null ETA input version differs from the route plan's current child version regardless of `etaStatus`.
- Local API smoke against the recovery DB returned `/healthz` 200 and `/readyz` 200.
- Deduped observation saw one v1 request and one canonical alias request; `legacy_read` and `legacy_write` had zero sampled request IDs.
- Production was not deployed. Live production and SSM access remain operator-gated.
