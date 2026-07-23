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

The JSON status follows this exit policy:

| Status | Exit | Meaning |
| --- | ---: | --- |
| `ok` | 0 | Health, readiness, migrations, invariants, and legacy usage are within policy. |
| `unknown` | 1 | A check could not be read and no critical finding was observed. |
| `critical` | 2 | Health/readiness failed, migration history has pending, missing, failed, or rolled-back rows, an invariant failed, or legacy read/write usage was observed. |

Migration status compares successful applied migration names in `_prisma_migrations`
to the checked-in `apps/delivery-api/prisma/migrations` directory, with that
directory-derived chain remaining authoritative for expected/applied counts. It
also requires latest migration
`20260723013000_g010_import_row_resource_tenant_fks`, so the current expected chain is
44 migrations. The status reports `expectedCount`, `appliedCount`,
`pendingCount`, `failedCount`, `latestMigration`, `actualLatestMigration`,
`pendingMigrations`, `unexpectedCount`, and `unexpectedMigrations`; any pending,
missing, failed, or unexpected history entry is `critical`.

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
