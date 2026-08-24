# G007 Migrate Deploy Runbook

Status: rehearsal and production-change-control runbook. Do not run production steps without operator approval and completed manifest evidence.

## Guardrails

- All restore and migrate targets must be disposable `clever_g007_*` databases during rehearsal.
- Protected targets are rejected before any `pg_*`, `psql`, or Prisma command: local `clever_route`, `clever_route_recovery_20260722`, stale 5433 targets, G004 `55444`, and G005 `55455`.
- The stale 5433 database is source evidence only: backup and read fingerprints before and after rehearsal. It is never a restore or migration target.
- The protected G005 database at port `55455` is also source/fingerprint evidence only. It is never a restore or migration target.
- Do not use delete/reset paths: no volume removal, no compose volume teardown, no migration reset, no forced reset, and no data-loss acceptance flag.
- G007 restore commands use `apps/delivery-api/scripts/dsv-g007-restore.sh`.
- Empty `clever_g007_empty_*` targets run `prisma migrate deploy` directly. They must not use `prisma migrate resolve`.
- Non-empty targets (`stale-clone`, `prod-like-clone`, `restore`, `recovery`) never execute the baseline before proof. They require `G007_EXPECTED_APPLIED_THROUGH=<exact migration directory>` and a separate empty `G007_FINGERPRINT_DATABASE_URL`. Use `clever_g007_stale_fingerprint_*` for stale clones, `clever_g007_prod_like_fingerprint_*` for production-like clones, and the generic `clever_g007_fingerprint_*` form only for restore/recovery rehearsals.
- Restore targets may be `clever_g007_stale_clone_*`, `clever_g007_prod_like_clone_*`, `clever_g007_restore_*`, or `clever_g007_recovery_*`.
- If the backup archive was produced by a newer PostgreSQL client than the target container supports, set `G007_PG_CLIENT_CONTAINER=clever-g007-<name>` on `dsv-g007-restore.sh`. The wrapper validates the target first, rejects unsafe container names, parses the normalized username and database name from `DATABASE_URL`, expands the archive with the archive-compatible local `pg_restore`, removes only PostgreSQL 17's exact `\\restrict`, `\\unrestrict`, and `SET transaction_timeout = 0` compatibility lines, and streams the remaining SQL to `psql` inside the target PostgreSQL container.
- Existing-schema proof is exact: the wrapper applies checked-in `migration.sql` files to the fingerprint DB from `20260520000000_initial_route_ops_baseline` through `G007_EXPECTED_APPLIED_THROUGH`, compares target to fingerprint with `prisma migrate diff --exit-code`, refuses any nonzero diff, validates existing `_prisma_migrations` rows/checksums/failures, resolves only missing history through that migration, then deploys remaining migrations. The rehearsal cutoff is derived from the latest checked-in migration; the chain currently includes 47 migrations through `20260723170000_add_customer_notification_outbox_worker`.
- `apps/delivery-api/prisma/rehearsal-fingerprints/db-push-source-before-20260722233000.sql.template` may be applied only while building an empty fingerprint scratch DB. It must never run against the source, target, restore, recovery, or production database.
- The compatibility bridge window is grouped proof, not a license to edit old SQL: `20260618022400_create_mapped_table_compatibility_bridges` creates marked transient quoted placeholders before `20260618022500_add_route_ops_ui_settings`; `20260628170100_apply_mapped_table_compatibility` applies the same intended effects to lowercase `shops`, `route_plans`, and `route_groupings` immediately after `20260628170000_collapse_route_lifecycle_statuses`, then drops only marked transient quoted tables before the G002 repair cutoff.
- The final drift repair is `20260722233000_align_migration_history_to_schema`. It adds `RoutePlanStatus.PUBLISHED` with `IF NOT EXISTS`; reasserts 22 `gen_random_uuid()` ID defaults, 10 `CURRENT_TIMESTAMP` `updatedAt` defaults, and `commerce_sync_runs.warnings DEFAULT '[]'::jsonb`; conditionally renames exactly 8 indexes and 2 FK constraints when the old name exists and target name does not; preflights for orphan `route_plan_stops.shopId` rows before conditionally adding `route_plan_stops_shopId_fkey` with `ON DELETE CASCADE ON UPDATE CASCADE`; and does not drop DB defaults, delete data, or drop schema objects.
- The G009 FK repair is `20260723003000_g009_tenant_composite_dsv_fks`. It preflights remaining DSV/order resource links for missing or cross-shop parents, adds missing parent uniqueness for `drivers(id, shopId)` and `vehicles(id, shopId)`, replaces the five old single-column FKs with tenant-composite FKs, and preserves `ON DELETE CASCADE ON UPDATE CASCADE`.
- The G010 FK repair is `20260723013000_g010_import_row_resource_tenant_fks`. It preflights non-null dispatch import-row driver/vehicle IDs for missing or cross-shop parents, replaces the two old single-column FKs with tenant-composite FKs, and deliberately uses `ON DELETE NO ACTION ON UPDATE CASCADE` because composite `SET NULL` is unsafe while `shopId` is non-null.
- The G011 baseline drift repair is `20260723023000_g011_production_baseline_drift_repair`. It was derived from a restored production backup with 1,250 orders and delivery stops, restores four UUID defaults, and replaces four tenant-composite FKs only after missing/cross-shop preflights.
- The admin stop-action migration is `20260723120000_add_admin_route_stop_actions`.
- The customer notification outbox migration is `20260723170000_add_customer_notification_outbox_worker` and is currently the latest checked-in migration.
- Post-deploy drift must be proven with `prisma migrate diff --exit-code`; the diff output is persisted and a pass report is emitted only when the command returns zero.

## Empty DB Rehearsal

Use a fresh target named `clever_g007_empty_<date>_<purpose>`.

```bash
G007_DATABASE_TARGET_CLASS=empty \
G007_REHEARSAL_DATABASE_URL='postgresql://<user>:<pass>@<host>:<port>/clever_g007_empty_<id>' \
apps/delivery-api/scripts/dsv-g007-rehearsal.sh --evidence docs/evidence/g007/empty-<id>
```

Expected evidence:

- protected-target preflight passed;
- baseline and every checked-in migration through the dynamically resolved latest migration deployed;
- second deploy is idempotent;
- post-apply drift is zero;
- `docs/evidence/g007/empty-<id>/rehearsal.json` exists.

## Stale Source Clone Rehearsal

Use the stale 5433 database only as backup/read fingerprint source. Restore the backup into a new `clever_g007_stale_clone_<id>` database.

```bash
G007_DATABASE_TARGET_CLASS=stale-clone \
G007_STALE_SOURCE_DATABASE_URL='postgresql://<user>:<pass>@127.0.0.1:5433/<source_db>' \
G007_REHEARSAL_DATABASE_URL='postgresql://<user>:<pass>@<host>:<port>/clever_g007_stale_clone_<id>' \
G007_FINGERPRINT_DATABASE_URL='postgresql://<user>:<pass>@<host>:<port>/clever_g007_stale_fingerprint_<id>' \
G007_EXPECTED_APPLIED_THROUGH='<exact_migration_directory>' \
apps/delivery-api/scripts/dsv-g007-rehearsal.sh --evidence docs/evidence/g007/stale-clone-<id>
```

Expected evidence:

- source fingerprint captured before backup;
- backup SHA-256 recorded;
- guarded restore completed only on the clone;
- fingerprint DB started empty and was built by applying checked-in migration SQL through the expected migration;
- target-to-fingerprint `prisma migrate diff --exit-code` returned zero before any resolve;
- migration resolve decisions, if any, are listed in `docs/migration/g007-baseline-manifest.md`;
- deploy, second deploy, and zero-drift checks passed;
- source fingerprint captured again and matched the pre-rehearsal source fingerprint.

Historical stale-clone evidence used `G007_EXPECTED_APPLIED_THROUGH=20260722150000_add_dsv_dispatch_and_resources`. The live root `/tmp/g007-live-final-20260723_070636` records exact fingerprint proof, source unchanged, resolve through `20260722150000`, the then-remaining migrations applied, second deploy with no pending migrations, and zero drift.

## Production-Like Clone Rehearsal

Production-like G005 clones use the G005 source only as read-only source/fingerprint evidence and restore into `clever_g007_prod_like_clone_<id>`.

```bash
G007_DATABASE_TARGET_CLASS=prod-like-clone \
G007_REHEARSAL_DATABASE_URL='postgresql://<user>:<pass>@<host>:<port>/clever_g007_prod_like_clone_<id>' \
G007_FINGERPRINT_DATABASE_URL='postgresql://<user>:<pass>@<host>:<port>/clever_g007_prod_like_fingerprint_<id>' \
G007_EXPECTED_APPLIED_THROUGH='20260722223000_drop_legacy_single_tenant_fks' \
apps/delivery-api/scripts/dsv-g007-rehearsal.sh --evidence docs/evidence/g007/prod-like-<id>
```

Final prod-like evidence in `/tmp/g007-live-final-20260723_070636` records exact fingerprint through `20260722223000_drop_legacy_single_tenant_fks`, final migration apply, second deploy with no pending migrations, and zero drift.

## Final Drift Repair Inventory

The final migration conditionally renames these objects only:

| Kind | Historical name | Schema name |
| --- | --- | --- |
| Index | `commerce_raw_order_ingests_connection_order_receivedAt_idx` | `commerce_raw_order_ingests_commerceConnectionId_sourceOrder_idx` |
| Index | `commerce_raw_order_ingests_connection_order_hash_key` | `commerce_raw_order_ingests_commerceConnectionId_sourceOrder_key` |
| Index | `commerce_raw_order_ingests_run_chunk_order_hash_key` | `commerce_raw_order_ingests_syncRunId_chunkId_sourceOrderId__key` |
| Index | `commerce_connection_audit_logs_commerceConnectionId_createdAt_idx` | `commerce_connection_audit_logs_commerceConnectionId_created_idx` |
| Index | `wordpress_plugin_pairing_codes_commerceConnectionId_expiresAt_idx` | `wordpress_plugin_pairing_codes_commerceConnectionId_expires_idx` |
| Index | `orders_shopId_sourcePlatform_sourceSiteUrl_sourceOrderNumber_idx` | `orders_shopId_sourcePlatform_sourceSiteUrl_sourceOrderNumbe_idx` |
| Index | `order_delivery_facts_shopId_sourcePlatform_sourceSiteUrl_sourceOrderId_idx` | `order_delivery_facts_shopId_sourcePlatform_sourceSiteUrl_so_idx` |
| Index | `driver_route_notification_attempts_groupingId_groupingVersion_idx` | `driver_route_notification_attempts_groupingId_groupingVersi_idx` |
| FK constraint | `route_plan_stops_etaInputRouteVersionId_fkey` | `route_plan_stops_etaInputRouteVersionId_shopId_routePlanId_fkey` |
| FK constraint | `driver_events_routeVersionId_shopId_fkey` | `driver_events_routeVersionId_shopId_routePlanId_fkey` |

Schema default alignment preserves observed DB defaults rather than dropping them. Prisma represents the observed `commerce_sync_runs.warnings DEFAULT '[]'::jsonb` as `@default("[]")`; this is the representation that produces zero drift against PostgreSQL.

## G009/G010 Tenant-Composite FK Inventory

The G009 and G010 migrations replace these remaining single-column FKs after explicit preflight checks:

| Table | Old FK | New FK |
| --- | --- | --- |
| `delivery_stops` | `delivery_stops_orderId_fkey` | `delivery_stops_orderId_shopId_fkey` |
| `dsv_driver_profiles` | `dsv_driver_profiles_driverId_fkey` | `dsv_driver_profiles_driverId_shopId_fkey` |
| `dsv_vehicle_profiles` | `dsv_vehicle_profiles_vehicleId_fkey` | `dsv_vehicle_profiles_vehicleId_shopId_fkey` |
| `dsv_vehicle_driver_assignments` | `dsv_vehicle_driver_assignments_vehicleId_fkey` | `dsv_vehicle_driver_assignments_vehicleId_shopId_fkey` |
| `dsv_vehicle_driver_assignments` | `dsv_vehicle_driver_assignments_driverId_fkey` | `dsv_vehicle_driver_assignments_driverId_shopId_fkey` |
| `dsv_dispatch_import_rows` | `dsv_dispatch_import_rows_driverId_fkey` | `dsv_dispatch_import_rows_driverId_shopId_fkey` |
| `dsv_dispatch_import_rows` | `dsv_dispatch_import_rows_vehicleId_fkey` | `dsv_dispatch_import_rows_vehicleId_shopId_fkey` |

Parent composite uniqueness is added only where previously missing: `drivers_id_shopId_key` and `vehicles_id_shopId_key`. `orders(id, shopId)` already exists. The migration also adds `dsv_driver_profiles_driverId_shopId_key` and `dsv_vehicle_profiles_vehicleId_shopId_key` so Prisma can keep those profile relations one-to-one after switching to composite fields.

G010 preserves import-row resource history with fail-closed delete semantics: `driverId` and `vehicleId` remain nullable, but `shopId` is non-null, so the migration uses `ON DELETE NO ACTION ON UPDATE CASCADE` rather than composite `SET NULL`. Operators must explicitly unlink or remove import rows before deleting a referenced driver or vehicle.

## Restore And Recovery Rehearsal

Use `clever_g007_restore_*` for restore-only checks and `clever_g007_recovery_*` for recovery simulation.

```bash
DATABASE_URL='postgresql://<user>:<pass>@<host>:<port>/clever_g007_restore_<id>' \
BACKUP_FILE='docs/evidence/g007/<backup>.dump' \
apps/delivery-api/scripts/dsv-g007-restore.sh
```

For a PostgreSQL archive/server version mismatch during rehearsal, use the guarded compatibility stream through the target PostgreSQL container:

```bash
DATABASE_URL='postgresql://<user>:<pass>@<host>:<port>/clever_g007_restore_<id>' \
BACKUP_FILE='docs/evidence/g007/<backup>.dump' \
G007_PG_CLIENT_CONTAINER='clever-g007-postgres-16' \
apps/delivery-api/scripts/dsv-g007-restore.sh
```

After restore, run the rehearsal wrapper with `G007_DATABASE_TARGET_CLASS=restore` or `recovery` against the same disposable database to prove migrate deploy idempotence and zero drift.

```bash
G007_DATABASE_TARGET_CLASS=restore \
G007_REHEARSAL_DATABASE_URL='postgresql://<user>:<pass>@<host>:<port>/clever_g007_restore_<id>' \
G007_REHEARSAL_BACKUP_FILE='docs/evidence/g007/<backup>.dump' \
G007_FINGERPRINT_DATABASE_URL='postgresql://<user>:<pass>@<host>:<port>/clever_g007_fingerprint_<id>' \
G007_EXPECTED_APPLIED_THROUGH='<exact_migration_directory>' \
apps/delivery-api/scripts/dsv-g007-rehearsal.sh --evidence docs/evidence/g007/restore-<id>
```

## Production Readiness Gate

Production migration uses the G007 migration entrypoint from the deployment image. It requires:

- `DSV_MIGRATION_MODE=production`;
- `DATABASE_URL` with no fallback, a non-local host, and the deployed database name `clever_route`;
- `DSV_MIGRATION_APPROVED=1`;
- `DSV_MIGRATION_MANIFEST_SHA256=<64 lowercase hex>`;
- `DSV_RESTORE_REHEARSAL_SHA256=<64 lowercase hex>`;
- attached baseline manifest and restore rehearsal evidence.

Do not run production mode from this runbook until the operator approves the production change window. Rollback planning must assume image rollback is not database rollback; recovery is a guarded restore to an approved target followed by forward verification.

The production monitor does not delete or rewrite Prisma recovery history. A
historical rolled-back row is healthy recovered evidence only when the deployed
image still expects that migration and `_prisma_migrations` contains a successful
row with the deployed checksum for the same name. Missing successful rows,
incomplete rows, unexpected names, and current successful-row checksum mismatches
remain critical and require investigation rather than `migrate resolve` or row
deletion for convenience. A deployed-image migration manifest that is empty,
not an array, or contains invalid names, invalid checksums, or duplicate names is
also critical and exits 2; an unreadable runtime check remains unknown and exits 1.

## Historical Final Rehearsal Evidence

Historical live evidence root before the G009/G010 latest FK repairs: `/tmp/g007-live-final-20260723_070636`.

- Empty DB: 42 migrations applied; second deploy had no pending migrations; drift zero.
- Stale clone: exact fingerprint through `20260722150000_add_dsv_dispatch_and_resources`; source unchanged; remaining six migrations applied; second deploy had no pending migrations; drift zero.
- Prod-like G005 clone: exact fingerprint through `20260722223000_drop_legacy_single_tenant_fks`; final migration applied; second deploy had no pending migrations; drift zero.
- Restore and recovery: exact fingerprint through `20260722233000_align_migration_history_to_schema`; second deploy had no pending migrations; drift zero.
- PG17 archive to PG16 target compatibility used archive-compatible local `pg_restore` to emit SQL, filtered only exact PostgreSQL 17 `\\restrict`, `\\unrestrict`, and `SET transaction_timeout = 0` lines, then applied the SQL through guarded target-container `psql`.
- Preserved counts on all paths: `shops=1`, `drivers=13`, `vehicles=13`, `orders=0`, `delivery_stops=0`.
- Recovery status: `appliedCount=42`, `failedCount=0`, latest `20260722233000_align_migration_history_to_schema`.

Production was not deployed. Live production and SSM remain operator-gated.
