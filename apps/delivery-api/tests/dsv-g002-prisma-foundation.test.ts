import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);
const migrationPath = new URL(
  '../prisma/migrations/20260722170000_dsv_customer_auth_foundation/migration.sql',
  import.meta.url
);
const baselinePath = new URL('../prisma/baseline/g002-full-schema-baseline.sql', import.meta.url);
const emptyRehearsalScriptPath = new URL('../scripts/dsv-g002-empty-baseline-rehearsal.sh', import.meta.url);
const prodLikeRehearsalScriptPath = new URL('../scripts/dsv-g002-prod-like-expand-rehearsal.sh', import.meta.url);
const backfillDryRunScriptPath = new URL('../src/scripts/dsv-g002-backfill-dry-run.ts', import.meta.url);
const packageJsonPath = new URL('../package.json', import.meta.url);

describe('G002 DSV Prisma foundation', () => {
  test('adds shop-scoped Customer and CustomerAccount distinct from destinations', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const customer = modelBody(schema, 'Customer');
    const account = modelBody(schema, 'CustomerAccount');
    const destination = modelBody(schema, 'DeliveryCustomerProfile');

    expect(customer).toContain('shopId');
    expect(customer).toContain('sourceKind');
    expect(customer).toContain('externalCustomerCode');
    expect(customer).toContain('status               CustomerStatus');
    expect(customer).toContain('@@unique([shopId, sourceKind, externalCustomerCode])');
    expect(customer).toContain('@@map("customers")');

    expect(account).toContain('customerId');
    expect(account).toContain('issuer');
    expect(account).toContain('subject');
    expect(account).toContain('status              CustomerAccountStatus');
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
    expect(order).toContain('customerId                    String?');
    expect(order).toContain('destinationId                 String?');
    expect(order).toContain('currentRouteVersionId         String?');
    expect(order).toContain('@@unique([shopId, sellerOrderSourceKind, sellerOrderKey])');
    expect(order).toContain('@@index([shopId, customerId, deliveryStatus])');
    expect(order).toContain('@@index([shopId, destinationId])');
    expect(order).toContain('@@index([shopId, currentRouteVersionId])');
  });

  test('adds DSV transport condition lifecycle without changing dispatch row uniqueness', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const condition = modelBody(schema, 'DsvTransportCondition');
    const importRow = modelBody(schema, 'DsvDispatchImportRow');

    expect(schema).toContain('enum DsvTransportConditionStatus');
    expect(condition).toContain('rawValue');
    expect(condition).toContain('comparisonKey String?');
    expect(condition).toContain('status        DsvTransportConditionStatus? @default(CANDIDATE)');
    expect(condition).toContain('activatedAt');
    expect(condition).toContain('deactivatedAt');
    expect(condition).toContain('@@unique([shopId, comparisonKey])');
    expect(condition).toContain('@@index([shopId, status, updatedAt])');

    expect(importRow).toContain('@@unique([shopId, sellerOrderKey])');
    expect(importRow).not.toContain('@@unique([shopId, importId, sellerOrderKey])');
  });

  test('adds command receipt and audit persistence with required relations and indexes', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const receipt = modelBody(schema, 'DsvCommandReceipt');
    const audit = modelBody(schema, 'DsvAuditEvent');

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
    expect(receipt).toContain('@@unique([shopId, commandName, commandId])');
    expect(receipt).toContain('@@index([shopId, requestId])');

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
  });

  test('ships additive non-destructive G002 migration and generated baseline artifact', async () => {
    const migration = await readFile(migrationPath, 'utf8');
    const baseline = await readFile(baselinePath, 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "customers"');
    expect(migration).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customerId" UUID');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "dsv_command_receipts"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "dsv_audit_events"');
    expect(migration).toContain("'IMPORT_WORKER', 'DEVICE', 'SYSTEM_WORKER'");
    expect(migration).not.toContain('dsv_dispatch_import_rows_shopId_sellerOrderKey_key');
    expect(migration).not.toMatch(/^\s*(DROP|DELETE|TRUNCATE)\b/imu);
    expect(migration).not.toMatch(/ALTER\s+COLUMN\s+"[^"]+"\s+SET\s+NOT\s+NULL/iu);

    expect(baseline).toContain('CREATE TABLE "customers"');
    expect(baseline).toContain('CREATE TABLE "dsv_command_receipts"');
    expect(baseline).toContain('CREATE TABLE "dsv_audit_events"');
    expect(baseline).toContain("'IMPORT_WORKER', 'DEVICE', 'SYSTEM_WORKER'");
    expect(baseline).not.toContain('20260722170000_dsv_customer_auth_foundation');
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
    expect(emptyRehearsal).toContain('--from-empty');
    expect(emptyRehearsal).not.toContain('db push');
    expect(emptyRehearsal).not.toContain('migrate deploy');
    expect(prodLikeRehearsal).toContain('G002_PROD_LIKE_DATABASE_URL');
    expect(prodLikeRehearsal).toContain('prisma migrate diff');
    expect(prodLikeRehearsal).not.toContain('db push');
    expect(prodLikeRehearsal).not.toContain('migrate deploy');
    expect(backfillDryRun).toContain('BEGIN READ ONLY');
    expect(backfillDryRun).not.toMatch(/client\.query\(\s*['`](INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
    expect(backfillDryRun).toContain('wroteDatabaseRows: false');
    expect(backfillDryRun).toContain('ambiguity:');
    expect(backfillDryRun).toContain('missingLinkage:');
  });
});

function modelBody(schema: string, modelName: string): string {
  return new RegExp(`model ${modelName} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'u').exec(schema)?.groups?.body ?? '';
}
