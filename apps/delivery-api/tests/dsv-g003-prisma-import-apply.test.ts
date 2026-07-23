import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);
const migrationPath = new URL(
  '../prisma/migrations/20260722203000_dsv_import_stage_apply/migration.sql',
  import.meta.url
);

describe('G003 DSV Prisma import staging and apply schema', () => {
  test('adds staging and apply lifecycle states without replacing legacy ready states', async () => {
    const schema = await readFile(schemaPath, 'utf8');

    expect(enumBody(schema, 'DsvDispatchImportStatus')).toMatch(
      /STAGED[\s\S]*READY[\s\S]*NEEDS_REVIEW[\s\S]*APPLYING[\s\S]*APPLIED[\s\S]*FAILED/u
    );
    expect(enumBody(schema, 'DsvDispatchImportRowStatus')).toMatch(
      /READY[\s\S]*NEEDS_REVIEW[\s\S]*APPLYING[\s\S]*APPLIED[\s\S]*BLOCKED/u
    );
  });

  test('stores immutable import source, preview hashes, apply receipt, result, and failure evidence', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const batch = modelBody(schema, 'DsvDispatchImport');

    expect(batch).toContain('sourceKind');
    expect(batch).toContain('@default("DSV_DISPATCH_IMPORT") @db.Text');
    expect(batch).toContain('sourceHash');
    expect(batch).toContain('previewHash');
    expect(batch).toContain('appliedAt');
    expect(batch).toContain('appliedBy');
    expect(batch).toContain('applyReceiptId');
    expect(batch).toContain('@relation("DsvDispatchImportApplyReceipt", fields: [applyReceiptId, shopId], references: [id, shopId]');
    expect(batch).toContain('applyResult');
    expect(batch).toContain('failureCode');
    expect(batch).toContain('failureMessage');
    expect(batch).toContain('@@index([shopId, sourceHash])');
    expect(batch).toContain('@@index([shopId, status, createdAt])');
    expect(batch).toContain('@@index([shopId, previewHash])');
  });

  test('allows same seller order key in different import batches', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const row = modelBody(schema, 'DsvDispatchImportRow');
    const migration = await readFile(migrationPath, 'utf8');

    expect(row).toContain('@@unique([importId, sellerOrderKey])');
    expect(row).not.toContain('@@unique([shopId, sellerOrderKey])');
    expect(migration).toContain('GROUP BY "importId", "sellerOrderKey"');
    expect(migration).toContain('HAVING COUNT(*) > 1');
    expect(migration).toContain('RAISE EXCEPTION');
    expect(migration.indexOf('RAISE EXCEPTION')).toBeLessThan(
      migration.indexOf('DROP INDEX "dsv_dispatch_import_rows_shopId_sellerOrderKey_key"')
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "dsv_dispatch_import_rows_importId_sellerOrderKey_key"');
  });

  test('adds row snapshots, diff state, canonical links, and tenant-safe apply result relations', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const row = modelBody(schema, 'DsvDispatchImportRow');

    for (const field of [
      'sourceKind',
      'normalized',
      'diffKind',
      'sourceHash',
      'previewHash',
      'customerId',
      'destinationId',
      'conditionId',
      'sellerOrderId',
      'deliveryStopId',
      'applyReceiptId',
      'appliedAt',
      'canonicalLink',
      'candidateDiff'
    ]) {
      expect(row).toContain(field);
    }

    expect(row).toContain('@default("DSV_DISPATCH_IMPORT") @db.Text');
    expect(row).toContain('fields: [customerId, shopId], references: [id, shopId]');
    expect(row).toContain('fields: [destinationId, shopId], references: [id, shopId]');
    expect(row).toContain('fields: [conditionId, shopId], references: [id, shopId]');
    expect(row).toContain('fields: [sellerOrderId, shopId], references: [id, shopId]');
    expect(row).toContain('fields: [deliveryStopId, shopId], references: [id, shopId]');
    expect(row).toContain('@relation("DsvDispatchImportRowApplyReceipt", fields: [applyReceiptId, shopId], references: [id, shopId]');
    expect(row).toContain('@@index([shopId, sellerOrderKey, createdAt])');
    expect(row).toContain('@@index([shopId, sellerOrderId])');
    expect(row).toContain('@@index([shopId, deliveryStopId])');
    expect(row).toContain('@@index([importId, diffKind, rowNumber])');
  });

  test('keeps canonical order identity and adds required delivery stop composite identity', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const order = modelBody(schema, 'Order');
    const deliveryStop = modelBody(schema, 'DeliveryStop');
    const condition = modelBody(schema, 'DsvTransportCondition');
    const receipt = modelBody(schema, 'DsvCommandReceipt');

    expect(order).toContain('@@unique([shopId, sellerOrderSourceKind, sellerOrderKey])');
    expect(deliveryStop).toContain('@@unique([shopId, orderId])');
    expect(deliveryStop).toContain('@@unique([id, shopId])');
    expect(condition).toContain('@@unique([id, shopId])');
    expect(receipt).toContain('@@unique([id, shopId])');
    expect(receipt).toContain('appliedImports');
    expect(receipt).toContain('appliedImportRows');
  });

  test('ships a deterministic migration that preserves history and drops only the old global staging unique', async () => {
    const migration = await readFile(migrationPath, 'utf8');

    expect(migration).toContain('legacy-g003-source:');
    expect(migration).toContain('legacy-g003-preview:');
    expect(migration).toContain('jsonb_build_object');
    expect(migration.match(/DROP INDEX/g)).toHaveLength(1);
    expect(migration).toContain('DROP INDEX "dsv_dispatch_import_rows_shopId_sellerOrderKey_key"');
    expect(migration).not.toMatch(/^\s*(DROP\s+TABLE|DROP\s+COLUMN|DELETE|TRUNCATE)\b/imu);
    expect(migration).not.toContain('dsv_dispatch_import_rows_shopId_importId_sellerOrderKey_key');
  });

  test('does not add G004 assignment fields or DSV shadow canonical tables', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    const row = modelBody(schema, 'DsvDispatchImportRow');

    expect(schema).not.toMatch(/enum\s+DsvDispatchImportSourceKind/u);
    expect(schema).not.toMatch(/model\s+Dsv(SellerOrder|DeliveryStop|RoutePlan|Driver|Vehicle|RouteAssignment)\b/u);
    expect(row).not.toMatch(/\b(routePlanId|routePlanStopId|routeGroupingId|routeGroupingOrderId|assignedDriverId|assignedVehicleId)\b/u);
  });
});

function enumBody(schema: string, enumName: string): string {
  return new RegExp(`enum ${enumName} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'u').exec(schema)?.groups?.body ?? '';
}

function modelBody(schema: string, modelName: string): string {
  return new RegExp(`model ${modelName} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'u').exec(schema)?.groups?.body ?? '';
}
