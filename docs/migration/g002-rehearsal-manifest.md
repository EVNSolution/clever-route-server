# G002 Rehearsal Manifest

Status: verified on local disposable PostgreSQL
Last verified: 2026-07-22

This is the stable tracked contract for G002 database rehearsals. Generated SQL,
drift files, logs, and JSON evidence stay under ignored
`docs/evidence/g002/` and must not contain credentials. Rehearsal scripts
resolve caller-supplied relative evidence paths against `INIT_CWD` when npm
sets it, otherwise against the repository root, before changing directory into
`apps/delivery-api`.

## Schema Inputs

| Artifact | SHA-256 |
| --- | --- |
| `apps/delivery-api/prisma/schema.prisma` | `aaef0f51a5ec79dce481e3f6f6360a4b7d1941743120386531ce4780e7f66199` |
| `apps/delivery-api/prisma/migrations/20260722170000_dsv_customer_auth_foundation/migration.sql` | `f3a169f2a5b354d307ebb0fd20bf00afe56135a55addef3d11a5d70379c1066c` |
| `apps/delivery-api/prisma/migrations/20260722193000_repair_g002_tenant_integrity/migration.sql` | `4a946c4bd64c231ff3880935bccfe9cb0a62a8e7011920da181a10efb92b86c8` |
| `docs/evidence/g002/empty-baseline/full-schema-from-empty.sql` | `36e33f0d266375fd7cc0762cb01a3d881cbf20b5d73b0be82bfcc1fff80d0d12` |

## Required Rehearsals

| Rehearsal | Command | Target class | Required proof |
| --- | --- | --- | --- |
| Empty full-schema rehearsal | `G002_DATABASE_TARGET_CLASS=safe-local-empty-temp-cluster G002_EMPTY_DATABASE_URL=<local disposable url> npm run dsv:g002:baseline:empty` | Empty disposable local PostgreSQL database | Full SQL generated into ignored evidence, SQL applies cleanly, `postApplySchema.tableCount`, `postApplySchema.enumCount`, expected minima, and named-object checks are queried read-only after apply, cross-shop FK probes fail inside rollback, post-apply drift is zero. |
| Production-like expand rehearsal | `G002_DATABASE_TARGET_CLASS=safe-local-pre-g002-temp-cluster G002_PROD_LIKE_DATABASE_URL=<local disposable url> G002_PREPARE_CURRENT_SCHEMA_AS_PRE_G002=1 npm run dsv:g002:drift:prod-like` | Disposable clone or local pre-G002 schema | A disposable pre-G002 schema is prepared, merged G002 migration applies, repair migration applies, destructive drift classification is clean, cross-shop FK probes fail inside rollback, post-apply drift is zero. |
| Backfill report-only rehearsal | `G002_DATABASE_TARGET_CLASS=safe-local-current-schema-temp-cluster G002_PROD_LIKE_DATABASE_URL=<local disposable url> npm run dsv:g002:drift:prod-like -- --backfill-report-only` | Current-schema disposable local PostgreSQL database | Runs only the backfill dry-run, applies no migrations, runs no tenant probes, exits 0, and records `wroteDatabaseRows: false`, `appliedMigrations: false`, `ranTenantProbes: false`, and `backfillCounts` in metadata. |
| Backfill dry-run | `G002_DATABASE_TARGET_CLASS=safe-local-empty-temp-cluster DATABASE_URL=<local disposable url> npm run dsv:g002:backfill:dry-run` | Current-schema disposable local PostgreSQL database | Report completes on empty schema, includes explicit `domainCounts.customers`, `domainCounts.destinations`, `domainCounts.orders`, `domainCounts.customerLinkedOrders`, `domainCounts.destinationLinkedOrders`, and `domainCounts.customerAndDestinationLinkedOrders`, and records `wroteDatabaseRows: false`. |

## Repair Contract

- The original `20260722170000_dsv_customer_auth_foundation` migration is immutable.
- G002 tenant integrity repairs live in
  `20260722193000_repair_g002_tenant_integrity`.
- The repair migration's named `DROP CONSTRAINT` plus `ADD CONSTRAINT`
  operations are approved tenant-safety replacement DDL, not data/table destructive drift.
- The approved `DROP CONSTRAINT` names are exactly:
  `orders_currentRouteVersionId_fkey`,
  `route_grouping_child_versions_routePlanId_fkey`,
  `dsv_dispatch_import_rows_importId_fkey`,
  `dsv_command_receipts_importId_fkey`,
  `dsv_command_receipts_sellerOrderId_fkey`,
  `dsv_command_receipts_previousRoutePlanId_fkey`,
  `dsv_command_receipts_nextRoutePlanId_fkey`,
  `dsv_command_receipts_previousRouteVersionId_fkey`,
  `dsv_command_receipts_nextRouteVersionId_fkey`,
  `dsv_audit_events_sellerOrderId_fkey`,
  `dsv_audit_events_commandReceiptId_fkey`,
  `dsv_audit_events_importId_fkey`,
  `dsv_audit_events_previousRoutePlanId_fkey`,
  `dsv_audit_events_nextRoutePlanId_fkey`,
  `dsv_audit_events_previousRouteVersionId_fkey`, and
  `dsv_audit_events_nextRouteVersionId_fkey`.
- Do not broaden destructive drift allowlists beyond those exact named tenant
  FK replacement constraints.
- `Order`, `RoutePlan`, `RouteGroupingChildVersion`, `DsvDispatchImport`,
  and `DsvCommandReceipt` expose `@@unique([id, shopId])` for tenant-scoped
  composite references.
- `Order.currentRouteVersion` and DSV receipt/audit links to seller orders,
  imports, receipts, route plans, and route versions reference
  `[foreignId, shopId]`.
- Receipt/audit/history relations use restrictive deletion behavior where
  composite relations cannot preserve history with `SetNull`.
- `DsvDispatchImportRow @@unique([shopId, sellerOrderKey])` remains unchanged.
- Production compose remains on guarded `db push`; G007 owns any deployment
  cutover to `prisma migrate deploy`.

## Last Verified Evidence

Local disposable PostgreSQL on Docker, database names only:

| Evidence | Result |
| --- | --- |
| Empty full-schema rehearsal | `docs/evidence/g002/empty-baseline/rehearsal.json`, `postApplySchema.tableCount`, `postApplySchema.enumCount`, expected minima, named-object checks, exit code 0 |
| Empty full-schema post-apply drift | `docs/evidence/g002/empty-baseline/post-apply-drift.sql`, contains only Prisma empty migration marker |
| Production-like expand rehearsal | `docs/evidence/g002/prod-like-expand/rehearsal.json`, `backfillCounts.customerAndDestinationLinkedOrders`, exit code 0 |
| Production-like post-apply drift | `docs/evidence/g002/prod-like-expand/post-apply-drift.sql`, contains only Prisma empty migration marker |
| Backfill report-only rehearsal | `docs/evidence/g002/backfill-report-only/rehearsal.json`, `wroteDatabaseRows: false`, `appliedMigrations: false`, `ranTenantProbes: false`, `backfillCounts`, exit code 0 |
| Backfill dry-run report | `docs/evidence/g002/prod-like-expand/backfill-dry-run-report.json`, `wroteDatabaseRows: false`, explicit zero `domainCounts` on empty target |
| Direct empty current-schema backfill dry-run | `docs/evidence/g002/backfill-empty-current-schema-report.json`, `wroteDatabaseRows: false`, explicit zero `domainCounts` |
