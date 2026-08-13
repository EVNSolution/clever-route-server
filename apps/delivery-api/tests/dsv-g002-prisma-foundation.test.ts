import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);
const migrationPath = new URL(
  '../prisma/migrations/20260722170000_dsv_customer_auth_foundation/migration.sql',
  import.meta.url
);
const repairMigrationPath = new URL(
  '../prisma/migrations/20260722193000_repair_g002_tenant_integrity/migration.sql',
  import.meta.url
);
const serviceDateIdentityMigrationPath = new URL(
  '../prisma/migrations/20260731120000_dsv_order_service_date_identity/migration.sql',
  import.meta.url
);
const emptyRehearsalScriptPath = new URL('../scripts/dsv-g002-empty-baseline-rehearsal.sh', import.meta.url);
const prodLikeRehearsalScriptPath = new URL('../scripts/dsv-g002-prod-like-expand-rehearsal.sh', import.meta.url);
const backfillDryRunScriptPath = new URL('../src/scripts/dsv-g002-backfill-dry-run.ts', import.meta.url);
const packageJsonPath = new URL('../package.json', import.meta.url);
const rehearsalManifestPath = new URL('../../../docs/migration/g002-rehearsal-manifest.md', import.meta.url);

describe('G002 DSV Prisma foundation', () => {
  test('adds shop-scoped Customer and CustomerAccount distinct from destinations', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const customer = modelBody(schema, 'Customer');
    const account = modelBody(schema, 'CustomerAccount');
    const destination = modelBody(schema, 'DeliveryCustomerProfile');

    expect(customer).toContain('shopId');
    expect(customer).toContain('sourceKind');
    expect(customer).toContain('externalCustomerCode');
    expect(customer).toMatch(/\bstatus\s+CustomerStatus\s+@default\(ACTIVE\)/u);
    expect(customer).toContain('@@unique([shopId, sourceKind, externalCustomerCode])');
    expect(customer).toContain('@@map("customers")');

    expect(account).toContain('customerId');
    expect(account).toContain('issuer');
    expect(account).toContain('subject');
    expect(account).toMatch(/\bstatus\s+CustomerAccountStatus\s+@default\(ACTIVE\)/u);
    expect(account).toContain('@@unique([shopId, issuer, subject])');
    expect(account).toContain('@relation(fields: [customerId, shopId], references: [id, shopId]');

    expect(destination).toContain('addressFingerprint');
    expect(destination).toContain('currentOrders');
    expect(destination).not.toContain('externalCustomerCode');
  });

  test('adds nullable tenant-indexed Order seller-order, customer, destination, and route-version references', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const order = modelBody(schema, 'Order');

    expect(order).toContain('sellerOrderSourceKind         String?');
    expect(order).toContain('sellerOrderKey                String?');
    expect(order).toContain('sellerOrderVersion            Int?');
    expect(order).toContain('serviceDate                   DateTime?');
    expect(order).toContain('customerId                    String?');
    expect(order).toContain('destinationId                 String?');
    expect(order).toContain('currentRouteVersionId         String?');
    expect(order).toContain('@@unique([id, shopId])');
    expect(order).toContain('@@unique([shopId, sellerOrderSourceKind, sellerOrderKey, serviceDate])');
    expect(order).toContain('@@index([shopId, customerId, deliveryStatus])');
    expect(order).toContain('@@index([shopId, destinationId])');
    expect(order).toContain('@@index([shopId, currentRouteVersionId])');
    expect(order).toContain('fields: [currentRouteVersionId, shopId], references: [id, shopId], onDelete: NoAction');
  });

  test('ships DSV order service-date identity migration with delivery-stop backfill', async () => {
    const migration = await readFile(serviceDateIdentityMigrationPath, 'utf8');

    expect(migration).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "serviceDate" DATE');
    expect(migration).toContain('FROM "delivery_stops" AS stop');
    expect(migration).toContain('WHERE order_row."sellerOrderSourceKind" = \'DSV_DISPATCH_IMPORT\'');
    expect(migration).toContain('RAISE EXCEPTION \'DSV order serviceDate backfill failed: serviceDate is still null\'');
    expect(migration).toContain('ADD CONSTRAINT "orders_dsv_serviceDate_not_null_chk"');
    expect(migration).toContain('CHECK ("sellerOrderSourceKind" <> \'DSV_DISPATCH_IMPORT\' OR "serviceDate" IS NOT NULL)');
    expect(migration).toContain('ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_dsv_serviceDate_not_null_chk"');
    expect(migration).toContain('DROP INDEX IF EXISTS "orders_shopId_sellerOrderSourceKind_sellerOrderKey_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "orders_shopId_sellerOrderSourceKind_sellerOrderKey_serviceDate_key"');
  });

  test('adds DSV transport condition lifecycle while preserving G002 and G003 import-row safety', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const condition = modelBody(schema, 'DsvTransportCondition');
    const importRow = modelBody(schema, 'DsvDispatchImportRow');

    expect(schema).toContain('enum DsvTransportConditionStatus');
    expect(condition).toContain('rawValue');
    expect(condition).toContain('comparisonKey           String?                      @db.Text');
    expect(condition).toContain('status                  DsvTransportConditionStatus? @default(CANDIDATE)');
    expect(condition).toContain('temperatureAlertEnabled Boolean                      @default(false)');
    expect(condition).toContain('temperatureMinC         Decimal?                     @db.Decimal(6, 2)');
    expect(condition).toContain('temperatureMaxC         Decimal?                     @db.Decimal(6, 2)');
    expect(condition).toContain('activatedAt');
    expect(condition).toContain('deactivatedAt');
    expect(condition).toContain('@@unique([shopId, comparisonKey])');
    expect(condition).toContain('@@index([shopId, status, updatedAt])');

    expect(importRow).toContain('@@unique([importId, sellerOrderKey])');
    expect(importRow).toContain('@@index([shopId, sellerOrderKey, createdAt])');
    expect(importRow).not.toContain('@@unique([shopId, sellerOrderKey])');
    expect(importRow).not.toContain('@@unique([shopId, importId, sellerOrderKey])');
  });

  test('adds command receipt and audit persistence with tenant-composite relations and indexes', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const routePlan = modelBody(schema, 'RoutePlan');
    const routeVersion = modelBody(schema, 'RouteGroupingChildVersion');
    const dispatchImport = modelBody(schema, 'DsvDispatchImport');
    const receipt = modelBody(schema, 'DsvCommandReceipt');
    const audit = modelBody(schema, 'DsvAuditEvent');

    expect(routePlan).toContain('@@unique([id, shopId])');
    expect(routeVersion).toContain('@@unique([id, shopId])');
    expect(dispatchImport).toContain('@@unique([id, shopId])');
    expect(schema).toContain('enum DsvCommandReceiptStatus');
    expect(schema).toContain('enum DsvPrincipalType');
    expect(schema).toMatch(/enum DsvPrincipalType \{[\s\S]*IMPORT_WORKER[\s\S]*DEVICE[\s\S]*SYSTEM_WORKER[\s\S]*\}/u);
    expect(schema).toContain('enum DsvAuditRedactionClass');
    expect(receipt).toContain('payloadHash');
    expect(receipt).toContain('principalType          DsvPrincipalType');
    expect(receipt).toContain('status                 DsvCommandReceiptStatus    @default(STARTED)');
    expect(receipt).toContain('responseBodyRef');
    expect(receipt).toContain('previousRoutePlanId');
    expect(receipt).toContain('nextRouteVersionId');
    expect(receipt).toContain('retainedUntil');
    expect(receipt).toContain('@@unique([id, shopId])');
    expect(receipt).toContain('@@unique([shopId, commandName, commandId])');
    expect(receipt).toContain('@@index([shopId, requestId])');
    expect(receipt).toContain('fields: [importId, shopId], references: [id, shopId], onDelete: NoAction');
    expect(receipt).toContain('fields: [sellerOrderId, shopId], references: [id, shopId], onDelete: NoAction');
    expect(receipt).toContain('fields: [previousRoutePlanId, shopId], references: [id, shopId], onDelete: NoAction');
    expect(receipt).toContain('fields: [nextRouteVersionId, shopId], references: [id, shopId], onDelete: NoAction');

    expect(audit).toContain('eventType');
    expect(audit).toContain('entityType');
    expect(audit).toContain('sellerOrderId');
    expect(audit).toContain('customerId');
    expect(audit).toContain('destinationId');
    expect(audit).toContain('commandReceiptId');
    expect(audit).toContain('redactedDiff');
    expect(audit).toContain('beforeSnapshotRef');
    expect(audit).toContain('afterSnapshotRef');
    expect(audit).toContain('retainedUntil');
    expect(audit).toContain('redactionClass         DsvAuditRedactionClass');
    expect(audit).toContain('@@index([shopId, customerId, occurredAt])');
    expect(audit).toContain('@@index([shopId, commandReceiptId])');
    expect(audit).toContain('fields: [sellerOrderId, shopId], references: [id, shopId], onDelete: NoAction');
    expect(audit).toContain('fields: [commandReceiptId, shopId], references: [id, shopId], onDelete: NoAction');
    expect(audit).toContain('fields: [importId, shopId], references: [id, shopId], onDelete: NoAction');
    expect(audit).toContain('fields: [previousRoutePlanId, shopId], references: [id, shopId], onDelete: NoAction');
    expect(audit).toContain('fields: [nextRouteVersionId, shopId], references: [id, shopId], onDelete: NoAction');
  });

  test('ships an additive non-destructive G002 migration', async () => {
    const migration = await readFile(migrationPath, 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "customers"');
    expect(migration).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customerId" UUID');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "dsv_command_receipts"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "dsv_audit_events"');
    expect(migration).toContain("'IMPORT_WORKER', 'DEVICE', 'SYSTEM_WORKER'");
    expect(migration).not.toContain('dsv_dispatch_import_rows_shopId_sellerOrderKey_key');
    expect(migration).not.toMatch(/^\s*(DROP|DELETE|TRUNCATE)\b/imu);
    expect(migration).not.toMatch(/ALTER\s+COLUMN\s+"[^"]+"\s+SET\s+NOT\s+NULL/iu);
  });

  test('ships a deterministic G002 repair migration for tenant composite receipt and audit references', async () => {
    const migration = await readFile(repairMigrationPath, 'utf8');

    for (const uniqueIndex of [
      'CREATE UNIQUE INDEX "orders_id_shopId_key"',
      'CREATE UNIQUE INDEX "route_plans_id_shopId_key"',
      'CREATE UNIQUE INDEX "route_grouping_child_versions_id_shopId_key"',
      'CREATE UNIQUE INDEX "dsv_dispatch_imports_id_shopId_key"',
      'CREATE UNIQUE INDEX "dsv_command_receipts_id_shopId_key"'
    ]) {
      expect(migration).toContain(uniqueIndex);
    }

    expect(migration).toContain('DROP CONSTRAINT "orders_currentRouteVersionId_fkey"');
    expect(migration).toContain('ADD CONSTRAINT "orders_currentRouteVersionId_shopId_fkey"');
    expect(migration).toContain('ADD CONSTRAINT "dsv_command_receipts_sellerOrderId_shopId_fkey"');
    expect(migration).toContain('ADD CONSTRAINT "dsv_command_receipts_importId_shopId_fkey"');
    expect(migration).toContain('ADD CONSTRAINT "dsv_command_receipts_nextRouteVersionId_shopId_fkey"');
    expect(migration).toContain('ADD CONSTRAINT "dsv_audit_events_commandReceiptId_shopId_fkey"');
    expect(migration).toContain('ADD CONSTRAINT "dsv_audit_events_importId_shopId_fkey"');
    expect(migration).toContain('REFERENCES "orders"("id", "shopId")');
    expect(migration).toContain('REFERENCES "route_plans"("id", "shopId")');
    expect(migration).toContain('REFERENCES "route_grouping_child_versions"("id", "shopId")');
    expect(migration).not.toContain('IF NOT EXISTS');
    expect(migration).not.toContain('duplicate_object');
    expect(migration).not.toContain('ON DELETE SET NULL');
    expect(migration).not.toMatch(/^\s*(DROP\s+TABLE|DELETE|TRUNCATE)\b/imu);
    expect(migration).not.toMatch(/ALTER\s+COLUMN\s+"[^"]+"\s+SET\s+NOT\s+NULL/iu);
  });

  test('documents repair constraint replacements as the only approved tenant-safety DDL', async () => {
    const [prodLikeRehearsal, manifest] = await Promise.all([
      readFile(prodLikeRehearsalScriptPath, 'utf8'),
      readFile(rehearsalManifestPath, 'utf8')
    ]);

    for (const constraintName of [
      'orders_currentRouteVersionId_fkey',
      'route_grouping_child_versions_routePlanId_fkey',
      'dsv_dispatch_import_rows_importId_fkey',
      'dsv_command_receipts_importId_fkey',
      'dsv_command_receipts_sellerOrderId_fkey',
      'dsv_command_receipts_previousRoutePlanId_fkey',
      'dsv_command_receipts_nextRoutePlanId_fkey',
      'dsv_command_receipts_previousRouteVersionId_fkey',
      'dsv_command_receipts_nextRouteVersionId_fkey',
      'dsv_audit_events_sellerOrderId_fkey',
      'dsv_audit_events_commandReceiptId_fkey',
      'dsv_audit_events_importId_fkey',
      'dsv_audit_events_previousRoutePlanId_fkey',
      'dsv_audit_events_nextRoutePlanId_fkey',
      'dsv_audit_events_previousRouteVersionId_fkey',
      'dsv_audit_events_nextRouteVersionId_fkey'
    ]) {
      expect(prodLikeRehearsal).toContain(constraintName);
      expect(manifest).toContain(constraintName);
    }

    expect(prodLikeRehearsal).toContain('approved_repair_constraint_pattern');
    expect(prodLikeRehearsal).toContain('Unexpected DROP CONSTRAINT drift detected');
    expect(manifest).toContain('approved tenant-safety replacement DDL');
    expect(manifest).toContain('not data/table destructive drift');
  });

  test('exposes read-only rehearsal helpers and a stable dry-run report contract', async () => {
    const [emptyRehearsal, prodLikeRehearsal, backfillDryRun, packageText] = await Promise.all([
      readFile(emptyRehearsalScriptPath, 'utf8'),
      readFile(prodLikeRehearsalScriptPath, 'utf8'),
      readFile(backfillDryRunScriptPath, 'utf8'),
      readFile(packageJsonPath, 'utf8')
    ]);
    const packageJson = JSON.parse(packageText) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['dsv:g002:baseline:empty']).toBe('bash scripts/dsv-g002-empty-baseline-rehearsal.sh');
    expect(packageJson.scripts?.['dsv:g002:drift:prod-like']).toBe('bash scripts/dsv-g002-prod-like-expand-rehearsal.sh');
    expect(packageJson.scripts?.['dsv:g002:backfill:dry-run']).toBe('tsx src/scripts/dsv-g002-backfill-dry-run.ts');
    expect(emptyRehearsal).toContain('prisma migrate diff');
    expect(emptyRehearsal).toContain('invocation_root="${INIT_CWD:-$repo_root}"');
    expect(emptyRehearsal).toContain('resolve_invocation_path');
    expect(emptyRehearsal).toContain('assert_manifest_hash "docs/evidence/g002/empty-baseline/full-schema-from-empty.sql"');
    expect(emptyRehearsal).toContain('--from-empty');
    expect(emptyRehearsal).toContain('G002_EMPTY_DATABASE_URL');
    expect(emptyRehearsal).toContain('cross-shop-tenant-integrity.sql');
    expect(emptyRehearsal).toContain('Post-apply drift is not zero');
    expect(emptyRehearsal).toContain('collect_post_apply_schema_evidence');
    expect(emptyRehearsal).toContain('BEGIN READ ONLY; SELECT COUNT(*) FROM information_schema.tables');
    expect(emptyRehearsal).toContain('"postApplySchema"');
    expect(emptyRehearsal).toContain('"tableCount"');
    expect(emptyRehearsal).toContain('"expectedMinimumTableCount"');
    expect(emptyRehearsal).toContain('"enumCount"');
    expect(emptyRehearsal).toContain('"expectedMinimumEnumCount"');
    expect(emptyRehearsal).toContain('"namedObjectCount"');
    expect(emptyRehearsal).toContain('"expectedNamedObjectCount"');
    expect(emptyRehearsal).not.toContain('db push');
    expect(emptyRehearsal).not.toContain('migrate deploy');
    expect(prodLikeRehearsal).toContain('G002_PROD_LIKE_DATABASE_URL');
    expect(prodLikeRehearsal).toContain('invocation_root="${INIT_CWD:-$repo_root}"');
    expect(prodLikeRehearsal).toContain('resolve_invocation_path');
    expect(prodLikeRehearsal).toContain('assert_manifest_hash "apps/delivery-api/prisma/schema.prisma"');
    expect(prodLikeRehearsal).toContain('G002_PREPARE_PRE_G002_FROM_MIGRATIONS');
    expect(prodLikeRehearsal).toContain('G002_PREPARE_CURRENT_SCHEMA_AS_PRE_G002');
    expect(prodLikeRehearsal).toContain('safe-local-current-schema-temp-cluster');
    expect(prodLikeRehearsal).toContain('20260722193000_repair_g002_tenant_integrity');
    expect(prodLikeRehearsal).toContain('destructive-drift.log');
    expect(prodLikeRehearsal).toContain('cross-shop-tenant-integrity.sql');
    expect(prodLikeRehearsal).toContain('prisma migrate diff');
    expect(prodLikeRehearsal).toContain('npm run dsv:g002:backfill:dry-run');
    expect(prodLikeRehearsal).toContain('--backfill-report-only target must already have current G002 schema');
    expect(prodLikeRehearsal).toContain('"mode": "backfill-report-only"');
    expect(prodLikeRehearsal).toContain('"wroteDatabaseRows": false');
    expect(prodLikeRehearsal).toContain('"appliedMigrations": false');
    expect(prodLikeRehearsal).toContain('"ranTenantProbes": false');
    expect(prodLikeRehearsal).toContain('read_backfill_domain_counts');
    expect(prodLikeRehearsal).toContain('"backfillCounts"');
    expect(prodLikeRehearsal.indexOf('if [ "$backfill_report_only" = "1" ]; then')).toBeLessThan(
      prodLikeRehearsal.indexOf('if [ "$prepare_current_schema_as_pre_g002" = "1" ]; then')
    );
    expect(prodLikeRehearsal.indexOf('assert_current_schema_for_backfill_report')).toBeLessThan(
      prodLikeRehearsal.indexOf('npm run dsv:g002:backfill:dry-run')
    );
    expect(prodLikeRehearsal).not.toContain('db push');
    expect(prodLikeRehearsal).not.toContain('migrate deploy');
    expect(backfillDryRun).toContain('BEGIN READ ONLY');
    expect(backfillDryRun).toContain('hasOrders');
    expect(backfillDryRun).not.toMatch(/client\.query\(\s*['`](INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
    expect(backfillDryRun).toContain('wroteDatabaseRows: false');
    expect(backfillDryRun).toContain('domainCounts:');
    expect(backfillDryRun).toContain('customers: 0');
    expect(backfillDryRun).toContain('destinations: 0');
    expect(backfillDryRun).toContain('orders: 0');
    expect(backfillDryRun).toContain('customerLinkedOrders');
    expect(backfillDryRun).toContain('destinationLinkedOrders');
    expect(backfillDryRun).toContain('customerAndDestinationLinkedOrders');
    expect(backfillDryRun).toContain('SELECT COUNT(*)::text AS count FROM "customers"');
    expect(backfillDryRun).toContain('SELECT COUNT(*)::text AS count FROM "delivery_customer_profiles"');
    expect(backfillDryRun).toContain('ambiguity:');
    expect(backfillDryRun).toContain('missingLinkage:');
  });

  test('tracks the stable G002 rehearsal manifest outside ignored generated evidence', async () => {
    const manifest = await readFile(rehearsalManifestPath, 'utf8');

    expect(manifest).toContain('G002 Rehearsal Manifest');
    expect(manifest).toContain('docs/evidence/g002/empty-baseline/full-schema-from-empty.sql');
    expect(manifest).toContain('36e33f0d266375fd7cc0762cb01a3d881cbf20b5d73b0be82bfcc1fff80d0d12');
    expect(manifest).toContain('postApplySchema.tableCount');
    expect(manifest).toContain('domainCounts.customers');
    expect(manifest).toContain('backfillCounts.customerAndDestinationLinkedOrders');
    expect(manifest).toContain('20260722193000_repair_g002_tenant_integrity');
    expect(manifest).toContain('@@unique([id, shopId])');
    expect(manifest).toContain('G002 Rehearsal Manifest');
    expect(manifest).toContain('approved tenant-safety replacement DDL');
    expect(manifest).toContain('Production compose remains on guarded `db push`');
    expect(manifest).not.toMatch(/postgresql:\/\/[^<\s]+/u);
  });

  test('preserves the recorded G002 deterministic baseline hash after later G003 schema expansion', async () => {
    const manifest = await readFile(rehearsalManifestPath, 'utf8');
    const schema = await readFile(schemaPath, 'utf8');

    expect(manifest).toContain('36e33f0d266375fd7cc0762cb01a3d881cbf20b5d73b0be82bfcc1fff80d0d12');
    expect(manifest).toContain('docs/evidence/g002/empty-baseline/full-schema-from-empty.sql');
    expect(schema).toContain('@@unique([importId, sellerOrderKey])');
  });
});

function modelBody(schema: string, modelName: string): string {
  return new RegExp(`model ${modelName} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'u').exec(schema)?.groups?.body ?? '';
}
