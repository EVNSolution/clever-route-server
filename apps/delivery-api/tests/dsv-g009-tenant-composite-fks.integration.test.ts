import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { describe, expect, test } from 'vitest';

const g009MigrationName = '20260723003000_g009_tenant_composite_dsv_fks';
const g010MigrationName = '20260723013000_g010_import_row_resource_tenant_fks';
const g009MigrationPath = new URL(`../prisma/migrations/${g009MigrationName}/migration.sql`, import.meta.url);
const g010MigrationPath = new URL(`../prisma/migrations/${g010MigrationName}/migration.sql`, import.meta.url);
const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);
const liveDatabaseUrl = process.env.DSV_G010_DATABASE_URL ?? '';

describe('G009/G010 tenant-composite DSV foreign keys', () => {
  test('migration replaces the five legacy single-column links after explicit preflights', async () => {
    const migration = await readFile(g009MigrationPath, 'utf8');

    for (const message of [
      'Cannot replace delivery_stops_orderId_fkey',
      'Cannot replace dsv_driver_profiles_driverId_fkey',
      'Cannot replace dsv_vehicle_profiles_vehicleId_fkey',
      'Cannot replace dsv_vehicle_driver_assignments_vehicleId_fkey',
      'Cannot replace dsv_vehicle_driver_assignments_driverId_fkey'
    ]) {
      expect(migration).toContain(message);
    }

    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "drivers_id_shopId_key" ON "drivers"("id", "shopId")');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "vehicles_id_shopId_key" ON "vehicles"("id", "shopId")');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "dsv_driver_profiles_driverId_shopId_key" ON "dsv_driver_profiles"("driverId", "shopId")'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "dsv_vehicle_profiles_vehicleId_shopId_key" ON "dsv_vehicle_profiles"("vehicleId", "shopId")'
    );

    for (const constraintName of [
      'delivery_stops_orderId_fkey',
      'dsv_driver_profiles_driverId_fkey',
      'dsv_vehicle_profiles_vehicleId_fkey',
      'dsv_vehicle_driver_assignments_vehicleId_fkey',
      'dsv_vehicle_driver_assignments_driverId_fkey'
    ]) {
      expect(migration).toContain(`DROP CONSTRAINT IF EXISTS "${constraintName}"`);
    }

    for (const fragment of [
      'CONSTRAINT "delivery_stops_orderId_shopId_fkey"',
      'FOREIGN KEY ("orderId", "shopId") REFERENCES "orders"("id", "shopId")',
      'CONSTRAINT "dsv_driver_profiles_driverId_shopId_fkey"',
      'FOREIGN KEY ("driverId", "shopId") REFERENCES "drivers"("id", "shopId")',
      'CONSTRAINT "dsv_vehicle_profiles_vehicleId_shopId_fkey"',
      'FOREIGN KEY ("vehicleId", "shopId") REFERENCES "vehicles"("id", "shopId")',
      'CONSTRAINT "dsv_vehicle_driver_assignments_vehicleId_shopId_fkey"',
      'CONSTRAINT "dsv_vehicle_driver_assignments_driverId_shopId_fkey"'
    ]) {
      expect(migration).toContain(fragment);
    }

    expect(migration.match(/ON DELETE CASCADE ON UPDATE CASCADE/gu)).toHaveLength(5);
  });

  test('G010 migration replaces import-row resource links with fail-closed tenant-composite FKs', async () => {
    const migration = await readFile(g010MigrationPath, 'utf8');

    for (const message of [
      'Cannot replace dsv_dispatch_import_rows_driverId_fkey',
      'Cannot replace dsv_dispatch_import_rows_vehicleId_fkey'
    ]) {
      expect(migration).toContain(message);
    }

    expect(migration).toContain('child."driverId" IS NOT NULL');
    expect(migration).toContain('child."vehicleId" IS NOT NULL');
    expect(migration).toContain('parent."shopId" <> child."shopId"');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS "dsv_dispatch_import_rows_driverId_fkey"');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS "dsv_dispatch_import_rows_vehicleId_fkey"');

    for (const fragment of [
      'CONSTRAINT "dsv_dispatch_import_rows_driverId_shopId_fkey"',
      'FOREIGN KEY ("driverId", "shopId") REFERENCES "drivers"("id", "shopId")',
      'CONSTRAINT "dsv_dispatch_import_rows_vehicleId_shopId_fkey"',
      'FOREIGN KEY ("vehicleId", "shopId") REFERENCES "vehicles"("id", "shopId")'
    ]) {
      expect(migration).toContain(fragment);
    }

    expect(migration.match(/ON DELETE NO ACTION ON UPDATE CASCADE/gu)).toHaveLength(2);
    expect(migration).not.toMatch(/ON DELETE SET NULL/iu);
  });

  test('schema models the seven links as tenant-composite relations', async () => {
    const schema = await readFile(schemaPath, 'utf8');

    expect(schema).toContain('order                         Order                          @relation(fields: [orderId, shopId], references: [id, shopId], onDelete: Cascade)');
    expect(schema).toContain('driver     Driver   @relation(fields: [driverId, shopId], references: [id, shopId], onDelete: Cascade)');
    expect(schema).toContain('vehicle   Vehicle  @relation(fields: [vehicleId, shopId], references: [id, shopId], onDelete: Cascade)');
    expect(schema).toContain('vehicle   Vehicle  @relation(fields: [vehicleId, shopId], references: [id, shopId], onDelete: Cascade)');
    expect(schema).toContain('driver    Driver   @relation(fields: [driverId, shopId], references: [id, shopId], onDelete: Cascade)');
    expect(schema).toContain('driver          Driver?                    @relation(fields: [driverId, shopId], references: [id, shopId], onDelete: NoAction)');
    expect(schema).toContain('vehicle         Vehicle?                   @relation(fields: [vehicleId, shopId], references: [id, shopId], onDelete: NoAction)');
    expect(schema).toContain('model Driver {');
    expect(schema).toContain('@@unique([id, shopId])');
    expect(schema).toContain('model Vehicle {');
  });

  const live = liveDatabaseUrl ? test : test.skip;

  live('rejects cross-shop writes for all seven repaired relations in PostgreSQL', async () => {
    assertDisposableG010Url(liveDatabaseUrl);

    const client = new pg.Client({ connectionString: liveDatabaseUrl });
    await client.connect();
    try {
      await seedParents(client);

      await expectForeignKeyRejection(
        client,
        `INSERT INTO "delivery_stops" ("id", "shopId", "orderId", "createdAt", "updatedAt")
         VALUES ('a0000000-0000-4000-8000-000000000001', $1, $2, now(), now())`,
        ['20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001']
      );

      await expectForeignKeyRejection(
        client,
        `INSERT INTO "dsv_driver_profiles" ("driverId", "shopId", "lookupName", "age", "gender", "career", "zone", "score", "createdAt", "updatedAt")
         VALUES ($1, $2, 'Cross Driver', 1, 'n/a', 'n/a', 'n/a', '0', now(), now())`,
        ['40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002']
      );

      await expectForeignKeyRejection(
        client,
        `INSERT INTO "dsv_vehicle_profiles" ("vehicleId", "shopId", "typeLabel", "note", "createdAt", "updatedAt")
         VALUES ($1, $2, 'Cross Vehicle', '', now(), now())`,
        ['50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002']
      );

      await expectForeignKeyRejection(
        client,
        `INSERT INTO "dsv_vehicle_driver_assignments" ("id", "shopId", "vehicleId", "driverId", "createdAt")
         VALUES ('a0000000-0000-4000-8000-000000000004', $1, $2, $3, now())`,
        [
          '20000000-0000-4000-8000-000000000002',
          '50000000-0000-4000-8000-000000000001',
          '40000000-0000-4000-8000-000000000002'
        ]
      );

      await expectForeignKeyRejection(
        client,
        `INSERT INTO "dsv_vehicle_driver_assignments" ("id", "shopId", "vehicleId", "driverId", "createdAt")
         VALUES ('a0000000-0000-4000-8000-000000000005', $1, $2, $3, now())`,
        [
          '20000000-0000-4000-8000-000000000002',
          '50000000-0000-4000-8000-000000000002',
          '40000000-0000-4000-8000-000000000001'
        ]
      );

      await expectForeignKeyRejection(
        client,
        `INSERT INTO "dsv_dispatch_import_rows" (
           "id", "shopId", "importId", "rowNumber", "driverId", "sourceKind", "driverName", "vehiclePlate",
           "destinationName", "conditionCode", "shippedBoxes", "address", "customerCode", "sellerOrderKey",
           "status", "issues", "normalized", "diffKind", "sourceHash", "previewHash", "createdAt", "updatedAt"
         )
         VALUES (
           'a0000000-0000-4000-8000-000000000006', $1, '60000000-0000-4000-8000-000000000002', 1, $2,
           'DSV_DISPATCH_IMPORT', 'Cross Driver', 'VAN-B', 'Destination', 'COND', 1, 'Address',
           'CUSTOMER', 'ROW-DRIVER-CROSS', 'READY', '[]'::jsonb, '{}'::jsonb, 'NEW', 'hash-driver', 'preview-driver', now(), now()
         )`,
        ['20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001']
      );

      await expectForeignKeyRejection(
        client,
        `INSERT INTO "dsv_dispatch_import_rows" (
           "id", "shopId", "importId", "rowNumber", "vehicleId", "sourceKind", "driverName", "vehiclePlate",
           "destinationName", "conditionCode", "shippedBoxes", "address", "customerCode", "sellerOrderKey",
           "status", "issues", "normalized", "diffKind", "sourceHash", "previewHash", "createdAt", "updatedAt"
         )
         VALUES (
           'a0000000-0000-4000-8000-000000000007', $1, '60000000-0000-4000-8000-000000000002', 2, $2,
           'DSV_DISPATCH_IMPORT', 'Driver B', 'Cross Vehicle', 'Destination', 'COND', 1, 'Address',
           'CUSTOMER', 'ROW-VEHICLE-CROSS', 'READY', '[]'::jsonb, '{}'::jsonb, 'NEW', 'hash-vehicle', 'preview-vehicle', now(), now()
         )`,
        ['20000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001']
      );
    } finally {
      await client.end();
    }
  });
});

function assertDisposableG010Url(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55477' ||
    !url.pathname.slice(1).startsWith('clever_g007_g010_')
  ) {
    throw new Error('DSV_G010_DATABASE_URL must be postgresql://...@127.0.0.1:55477/clever_g007_g010_*');
  }
}

async function seedParents(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO "shops" ("id", "shopDomain", "updatedAt")
    VALUES
      ('20000000-0000-4000-8000-000000000001', 'g009-a.example.test', now()),
      ('20000000-0000-4000-8000-000000000002', 'g009-b.example.test', now())
    ON CONFLICT ("id") DO NOTHING
  `);
  await client.query(`
    INSERT INTO "orders" ("id", "shopId", "shopifyOrderGid", "name", "rawPayload", "createdAt", "updatedAt")
    VALUES ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'gid://shopify/Order/G009A', '#G009A', '{}'::jsonb, now(), now())
    ON CONFLICT ("id") DO NOTHING
  `);
  await client.query(`
    INSERT INTO "drivers" ("id", "shopId", "displayName", "createdAt", "updatedAt")
    VALUES
      ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'G009 Driver A', now(), now()),
      ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'G009 Driver B', now(), now())
    ON CONFLICT ("id") DO NOTHING
  `);
  await client.query(`
    INSERT INTO "vehicles" ("id", "shopId", "label", "createdAt", "updatedAt")
    VALUES
      ('50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'G009 Vehicle A', now(), now()),
      ('50000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'G009 Vehicle B', now(), now())
    ON CONFLICT ("id") DO NOTHING
  `);
  await client.query(`
    INSERT INTO "dsv_dispatch_imports" (
      "id", "shopId", "sourceKind", "fileName", "planDate", "status", "rowCount",
      "sourceHash", "previewHash", "createdAt", "updatedAt"
    )
    VALUES (
      '60000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002',
      'DSV_DISPATCH_IMPORT', 'g010.csv', DATE '2026-07-23', 'READY', 2,
      'source-g010', 'preview-g010', now(), now()
    )
    ON CONFLICT ("id") DO NOTHING
  `);
}

async function expectForeignKeyRejection(client: pg.Client, sql: string, values: string[]): Promise<void> {
  await expect(client.query(sql, values)).rejects.toMatchObject({ code: '23503' });
}
