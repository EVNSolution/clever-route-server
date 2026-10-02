import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const migrationUrl = new URL('../prisma/migrations/20261002120000_driver_runtime_diagnostics/migration.sql', import.meta.url);

describe('driver runtime diagnostics migration', () => {
  test('keeps DDL bounded and permits truthful legacy GPS attempt contract version', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '60s'");
    expect(sql).toContain('CHECK ("driverContractVersion" >= 1)');
    expect(sql).toContain('"snapshotTimeValid" BOOLEAN NOT NULL DEFAULT true');
    expect(sql).toContain('"discardedRecordCount" INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('COMMIT;');
  });
});
