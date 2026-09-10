import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);
const migrationPath = new URL(
  '../prisma/migrations/20260910170000_link_driver_proof_media_delivery_stops/migration.sql',
  import.meta.url
);

describe('driver proof media delivery stop links', () => {
  test('keeps the compatibility anchor and adds the many-to-many relation', async () => {
    const schema = await readFile(schemaPath, 'utf8');

    expect(schema).toMatch(/model DriverProofMedia \{[\s\S]*?deliveryStopId\s+String\s+@db\.Uuid/u);
    expect(schema).toContain('model DriverProofMediaDeliveryStop');
    expect(schema).toContain('proofMedia     DriverProofMedia @relation(fields: [proofMediaId, shopId], references: [id, shopId], onDelete: Cascade)');
    expect(schema).toContain('deliveryStop   DeliveryStop     @relation(fields: [deliveryStopId, shopId], references: [id, shopId], onDelete: NoAction)');
    expect(schema).toContain('routePlan        RoutePlan              @relation(fields: [routePlanId, shopId], references: [id, shopId], onDelete: NoAction)');
    expect(schema).toContain('driver           Driver?                @relation(fields: [driverId], references: [id], onDelete: SetNull)');
    expect(schema).toContain('@@id([proofMediaId, deliveryStopId])');
    expect(schema).toContain('@@map("driver_proof_media_delivery_stops")');
  });

  test('backfills each existing proof object to its compatibility delivery stop', async () => {
    const migration = await readFile(migrationPath, 'utf8');

    expect(migration.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/u);
    expect(migration.indexOf('DO $$')).toBeLessThan(migration.indexOf('CREATE TABLE'));
    expect(migration).toContain('INSERT INTO "driver_proof_media_delivery_stops"');
    expect(migration).toContain('SELECT media."id", media."shopId", media."deliveryStopId", media."createdAt"');
    expect(migration).toContain('ON CONFLICT ("proofMediaId", "deliveryStopId") DO NOTHING');
    expect(migration).toContain('sibling_order."destinationId" = anchor_order."destinationId"');
    expect(migration).toContain('sibling_route_stop."routePlanId" = media."routePlanId"');
    expect(migration).toContain('ON DELETE NO ACTION ON UPDATE CASCADE');
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/gu)).toHaveLength(3);
    expect(migration).toContain('driver_proof_media contains cross-tenant parent references');
    expect(migration).not.toContain('DROP CONSTRAINT "driver_proof_media_driverId_fkey"');
    expect(migration).toContain('REFERENCES "driver_proof_media"("id", "shopId") ON DELETE CASCADE');
    expect(migration).toContain('REFERENCES "delivery_stops"("id", "shopId") ON DELETE NO ACTION');
  });
});
