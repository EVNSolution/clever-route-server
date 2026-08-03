import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const schemaUrl = new URL('../prisma/schema.prisma', import.meta.url);
const migrationUrl = new URL(
  '../prisma/migrations/20260802120000_add_dsv_driver_app_auth/migration.sql',
  import.meta.url,
);

describe('DSV Driver app auth storage contract', () => {
  test('keeps legacy PIN auth compatible while adding nullable DSV credentials and keyed identity fingerprints', async () => {
    const [schema, migration] = await Promise.all([
      readFile(schemaUrl, 'utf8'),
      readFile(migrationUrl, 'utf8'),
    ]);

    expect(schema).toMatch(/loginId\s+String\?\s+@unique/u);
    expect(schema).toMatch(/passwordHash\s+String\?\s+@db\.Text/u);
    expect(schema).toMatch(/passwordSalt\s+String\?\s+@db\.Text/u);
    expect(schema.match(/residentNumberFrontFingerprint\s+String\?/gu)).toHaveLength(2);
    expect(schema).toMatch(/failedPasswordAttempts\s+Int\s+@default\(0\)/u);
    expect(schema).toMatch(/passwordLockedUntil\s+DateTime\?/u);
    expect(schema).toMatch(/pinHash\s+String\?\s+@db\.Text/u);
    expect(schema).toMatch(/pinSalt\s+String\?\s+@db\.Text/u);

    expect(migration).toContain('ALTER COLUMN "pinHash" DROP NOT NULL');
    expect(migration).toContain('ALTER COLUMN "pinSalt" DROP NOT NULL');
    expect(migration).toContain('CREATE UNIQUE INDEX "driver_accounts_loginId_key"');
    expect(migration).toContain('dsv_driver_profiles_shopId_residentNumberFrontFingerprint_idx');
    expect(migration).not.toContain('residentNumberFront"');
  });
});
