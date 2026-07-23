# G007 Baseline Manifest

Status: operator-maintained manifest template. Do not run against production until every placeholder is replaced with captured evidence from disposable rehearsals.

## Scope

G007 uses the single Prisma migration directory at `apps/delivery-api/prisma/migrations`. Existing migration SQL remains immutable. The deployable baseline is `apps/delivery-api/prisma/migrations/20260520000000_initial_route_ops_baseline/migration.sql`, with `apps/delivery-api/prisma/migrations/migration_lock.toml`.

The server import root is `1dbcb548fc577b6fbee0fe2a45f256c49f55f0d6`. The baseline represents only schema state immediately before `20260521074000_add_commerce_connections`; it must exclude every object, column, enum value, index, constraint, and data effect introduced by that migration or any later migration.

## SHA Workflow

1. Record the exact checked-out commit SHA.
2. List migration directories in lexical order through `20260723013000_g010_import_row_resource_tenant_fks`.
3. Record a SHA-256 for each `migration.sql`.
4. Record the SHA-256 for `20260520000000_initial_route_ops_baseline/migration.sql`.
5. For every non-empty target class, record the exact `G007_EXPECTED_APPLIED_THROUGH` migration name.
6. Record the scratch fingerprint database name. For stale clones it must be a separate empty `clever_g007_stale_fingerprint_*` database; for production-like clones it must be `clever_g007_prod_like_fingerprint_*`. Restore and recovery rehearsals may use the generic `clever_g007_fingerprint_*` form.
7. Record the real drift proof: checked-in `migration.sql` files are psql-applied to the fingerprint DB from `20260520000000_initial_route_ops_baseline` through `G007_EXPECTED_APPLIED_THROUGH`, then the target is compared to the fingerprint DB with `prisma migrate diff --exit-code`.
8. Record backup artifact path and SHA-256 for every restore rehearsal.

Checked-in historical migration SQL and checksums are not edited. The compatibility bridge pair remains checked in as `20260618022400_create_mapped_table_compatibility_bridges` and `20260628170100_apply_mapped_table_compatibility`.

Use this shape for each migration entry:

| Migration | `migration.sql` SHA-256 | Evidence |
| --- | --- | --- |
| `20260520000000_initial_route_ops_baseline` | `<sha256>` | baseline DDL fingerprint matched before resolve |
| `20260521074000_add_commerce_connections` | `<sha256>` | checked-in SQL effect proof or normal deploy |
| `...` | `<sha256>` | `<proof>` |
| `20260618022400_create_mapped_table_compatibility_bridges` | `<sha256>` | bridge creates only marked transient quoted compatibility tables when absent |
| `20260618022500_add_route_ops_ui_settings` | `a379b48bd023a08f659325ae3b96020b79c2a5fc44598f90172aaff28bbf5343` | historical checksum preserved; executes against transient `"Shop"` bridge |
| `...` | `<sha256>` | `<proof>` |
| `20260628170000_collapse_route_lifecycle_statuses` | `17d3fa1f569b3166980629314232100992038354860b17e171d0ded9884db7cc` | historical checksum preserved; executes against transient quoted status bridges |
| `20260628170100_apply_mapped_table_compatibility` | `<sha256>` | applies route ops settings and lifecycle collapse to lowercase mapped tables, then drops only marked transient quoted tables |
| `...` | `<sha256>` | `<proof>` |
| `20260722213000_dsv_assignment_eta_state` | `<sha256>` | checked-in SQL effect proof or normal deploy |
| `20260722223000_drop_legacy_single_tenant_fks` | `<sha256>` | drops only legacy single-column FKs after tenant-composite replacements exist |
| `20260722233000_align_migration_history_to_schema` | `<sha256>` | final drift repair: idempotent enum value add, name-only index/constraint repairs, route plan stop shop FK add after orphan preflight, and preserved DB defaults |
| `20260723003000_g009_tenant_composite_dsv_fks` | `<sha256>` | replaces final DSV/order resource single-column FKs with tenant-composite FKs after explicit mismatch preflights |
| `20260723013000_g010_import_row_resource_tenant_fks` | `<sha256>` | replaces dispatch import-row driver/vehicle single-column FKs with tenant-composite fail-closed FKs after explicit null/missing/cross-shop preflights |

## Target Evidence

| Field | Value |
| --- | --- |
| Target class | `empty`, `stale-clone`, `prod-like-clone`, `restore`, or `recovery` |
| Disposable DB name | `clever_g007_empty_*`, `clever_g007_stale_clone_*`, `clever_g007_prod_like_clone_*`, `clever_g007_restore_*`, or `clever_g007_recovery_*` |
| Source DB | backup/read-only source only, never a restore or migrate target |
| Expected applied-through migration | exact migration directory name, or none for empty targets |
| Fingerprint scratch DB | separate empty `clever_g007_stale_fingerprint_*` for stale clones, `clever_g007_prod_like_fingerprint_*` for production-like clones, or generic `clever_g007_fingerprint_*` for restore/recovery |
| Backup SHA-256 | `<sha256>` |
| Protected-target preflight | wrapper rejected `clever_route`, `clever_route_recovery_20260722`, stale 5433 targets, G004 `55444`, and G005 `55455` before any pg tool |
| Existing-schema proof | `prisma migrate diff --from-url <target> --to-url <fingerprint> --exit-code` returned zero before resolve |
| Resolve commands | exact `prisma migrate resolve --applied <migration>` commands, or none |
| Deploy result | `prisma migrate deploy` exit code and log artifact |
| Idempotence | second deploy exit code |
| Post-apply drift | `prisma migrate diff --from-url <target> --to-schema-datamodel prisma/schema.prisma --exit-code` returned zero and diff output was persisted |
| Restore rehearsal | guarded restore result and selected table count comparison |

## Resolve Rules

Never resolve the baseline or a historical migration because it is convenient. Resolve only when the checked-in migration name and checksum are present locally and the disposable clone proves that migration's SQL effects already exist exactly. The proof is a zero-exit `prisma migrate diff --exit-code` comparison against a separately bootstrapped fingerprint scratch DB named for the target class. Stop on missing DDL, partial or nonzero diff, failed `_prisma_migrations` rows, checksum mismatch, or missing local migration directory.

Empty `clever_g007_empty_*` rehearsals run normal `prisma migrate deploy` from the baseline through `20260723013000_g010_import_row_resource_tenant_fks`; they do not use `migrate resolve`.

Existing or production-like clones never execute the baseline. They must set `G007_EXPECTED_APPLIED_THROUGH` to the exact migration already present in schema, validate existing `_prisma_migrations` rows/checksums/failures, build that expected schema on the fingerprint DB from checked-in SQL, refuse any nonzero diff, resolve only missing history through that migration, and then deploy remaining migrations normally.

Final rehearsals used these exact existing-schema cutoffs:

| Target class | Exact expected-through migration |
| --- | --- |
| `stale-clone` | `20260722150000_add_dsv_dispatch_and_resources` |
| `prod-like-clone` | `20260722223000_drop_legacy_single_tenant_fks` |
| `restore` | `20260722233000_align_migration_history_to_schema` |
| `recovery` | `20260722233000_align_migration_history_to_schema` |

`apps/delivery-api/prisma/rehearsal-fingerprints/db-push-source-before-20260722233000.sql.template` is a checked-in fingerprint adjustment for empty fingerprint scratch DBs only. It is never applied to a source DB, restore target, migration target, or production target.

For clones whose schema already includes the lowercase mapped-table effects but lacks `_prisma_migrations` history for the broken quoted-table migrations, the grouped resolve proof must include the bridge pair as a single compatibility window: `20260618022400_create_mapped_table_compatibility_bridges` before `20260618022500_add_route_ops_ui_settings`, and `20260628170100_apply_mapped_table_compatibility` immediately after `20260628170000_collapse_route_lifecycle_statuses`. The fingerprint DB must prove the resulting lowercase `shops`, `route_plans`, and `route_groupings` schema/data effects match before any resolve. The bridge cleanup must also prove the marked transient quoted `"Shop"`, `"RoutePlan"`, and `"RouteGrouping"` tables are gone before the G002 repair cutoff and that `20260723013000_g010_import_row_resource_tenant_fks` remains the latest migration.

## Final Drift Repairs

The checked-in chain now contains 44 migrations. The latest migration is `20260723013000_g010_import_row_resource_tenant_fks`.

The final migration repairs exactly these historical-to-schema object names when the old name exists and the target name does not:

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

The final migration also adds `RoutePlanStatus.PUBLISHED` with `IF NOT EXISTS`, reasserts 22 `gen_random_uuid()` ID defaults, 10 `CURRENT_TIMESTAMP` `updatedAt` defaults, and `commerce_sync_runs.warnings DEFAULT '[]'::jsonb`, and conditionally adds `route_plan_stops_shopId_fkey` with `ON DELETE CASCADE ON UPDATE CASCADE` only after proving there are no orphan `route_plan_stops.shopId` values. It must not delete table data, drop tables, drop indexes, drop constraints, or drop DB defaults. Prisma represents the observed warnings default as `@default("[]")`, which is the zero-drift representation.

## G009 Tenant-Composite FK Repair

`20260723003000_g009_tenant_composite_dsv_fks` advances the post-G007 chain by replacing the remaining single-column parent references for `delivery_stops.orderId`, `dsv_driver_profiles.driverId`, `dsv_vehicle_profiles.vehicleId`, and both `dsv_vehicle_driver_assignments` resource links. It preflights each relation for missing or cross-shop parent rows before dropping old FKs, adds only the missing parent uniqueness for `drivers(id, shopId)` and `vehicles(id, shopId)`, adds the profile-side composite uniqueness Prisma requires to preserve existing one-to-one relation shape, and adds deterministic composite FK names with the existing cascade behavior.

## G010 Import-Row Resource FK Repair

`20260723013000_g010_import_row_resource_tenant_fks` is the current latest migration. It replaces the two remaining dispatch import-row resource references, `dsv_dispatch_import_rows.driverId` and `dsv_dispatch_import_rows.vehicleId`, with tenant-composite FKs to `drivers(id, shopId)` and `vehicles(id, shopId)`. The migration preflights non-null import-row resource IDs for missing parents and cross-shop parents before dropping the old single-column FKs. Because `shopId` is non-null, composite `SET NULL` would be unsafe; the replacement deliberately uses `ON DELETE NO ACTION ON UPDATE CASCADE` so deletes fail closed until rows are explicitly unlinked or removed.

## Final Live Evidence

Historical live evidence root before the G010 latest migration: `/tmp/g007-live-final-20260723_070636`.

| Path | Result |
| --- | --- |
| Empty | 42 migrations applied, second deploy had no pending migrations, drift zero. |
| Stale clone | Exact fingerprint through `20260722150000_add_dsv_dispatch_and_resources`; protected source unchanged; resolved through `20260722150000`; remaining six migrations applied; second deploy had no pending migrations; drift zero. |
| Prod-like clone | Exact G005 fingerprint through `20260722223000_drop_legacy_single_tenant_fks`; final migration applied; second deploy had no pending migrations; drift zero. |
| Restore | Exact fingerprint through `20260722233000_align_migration_history_to_schema`; second deploy had no pending migrations; drift zero. |
| Recovery | Exact fingerprint through `20260722233000_align_migration_history_to_schema`; second deploy had no pending migrations; drift zero. |

Selected counts were preserved on all paths: `shops=1`, `drivers=13`, `vehicles=13`, `orders=0`, and `delivery_stops=0`. Protected fingerprints stayed unchanged: stale source `tables=54`, `enums=33`, `shops=1`, `orders=0`; G005 source `tables=58`, `enums=40`, `shops=1`, `orders=0`.
