import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const migrationPath = new URL(
  '../prisma/migrations/20260825120000_enforce_shop_privacy_tombstone/migration.sql',
  import.meta.url
);

describe('shop privacy database invariant migration', () => {
  test('serializes canonical Shop and tombstone identities across migration and writes', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('LOCK TABLE "shops" IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('LOCK TABLE "shopify_shop_redaction_tombstones" IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "canonical_shop_privacy_domain"');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "lock_shop_privacy_identity"');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('INNER JOIN "shopify_shop_redaction_tombstones" AS tombstone');
    expect(sql).toContain('Cannot enforce Shop privacy invariant while an active tombstone has a Shop row');
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON "shops"');
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON "shopify_shop_redaction_tombstones"');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('tombstone."reinstalledAt" IS NULL');
    expect(sql).toContain("ERRCODE = '23514'");
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/iu);
  });
});
