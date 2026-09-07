import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);
const migrationPath = new URL(
  '../prisma/migrations/20260907130000_add_driver_destination_open_time/migration.sql',
  import.meta.url,
);

describe('driver destination open time persistence', () => {
  test('adds nullable value and field-level timestamp without rewriting profile history', async () => {
    const [schema, migration] = await Promise.all([
      readFile(schemaPath, 'utf8'),
      readFile(migrationPath, 'utf8'),
    ]);

    expect(schema).toContain('driverOpenTime                     String?');
    expect(schema).toContain('driverOpenTimeUpdatedAt            DateTime?');
    expect(migration).toContain('ADD COLUMN "driverOpenTime" VARCHAR(5)');
    expect(migration).toContain('ADD COLUMN "driverOpenTimeUpdatedAt" TIMESTAMPTZ(6)');
    expect(migration).not.toContain('UPDATE ');
    expect(migration).not.toContain('DROP ');
  });
});
