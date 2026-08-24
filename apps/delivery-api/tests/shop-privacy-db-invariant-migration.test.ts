import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const migrationPath = new URL(
  '../prisma/migrations/20260825120000_enforce_shop_privacy_tombstone/migration.sql',
  import.meta.url
);

describe('shop privacy database invariant migration', () => {
  test('rejects Shop inserts and updates while a privacy tombstone is active', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('CREATE OR REPLACE FUNCTION "enforce_shop_privacy_tombstone"()');
    expect(sql).toContain('INNER JOIN "shopify_shop_redaction_tombstones" AS tombstone');
    expect(sql).toContain('Cannot enforce Shop privacy invariant while an active tombstone has a Shop row');
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON "shops"');
    expect(sql).toContain('tombstone."reinstalledAt" IS NULL');
    expect(sql).toContain("ERRCODE = '23514'");
    expect(sql).toContain('OLD."appId", OLD."shopDomain"');
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/iu);
  });
});
