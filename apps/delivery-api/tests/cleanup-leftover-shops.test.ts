import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { assertBackupFile, KEEP_SHOPS, LEFTOVER_SHOPS, runLeftoverShopCleanup } from '../src/scripts/cleanup-leftover-shops.js';

describe('leftover shop cleanup guards', () => {
  test('no kept shop is ever a deletion target', () => {
    for (const keep of KEEP_SHOPS) {
      expect(LEFTOVER_SHOPS.some((target) => target.appId === keep.appId && target.shopDomain === keep.shopDomain)).toBe(false);
    }
  });

  test('apply refuses without a fresh, non-empty backup file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shop-cleanup-'));
    const fresh = join(dir, 'fresh.dump');
    const empty = join(dir, 'empty.dump');
    const stale = join(dir, 'stale.dump');
    writeFileSync(fresh, 'x');
    writeFileSync(empty, '');
    writeFileSync(stale, 'x');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, twoDaysAgo, twoDaysAgo);

    expect(() => assertBackupFile(null)).toThrow('needs --backup');
    expect(() => assertBackupFile(join(dir, 'missing.dump'))).toThrow('missing or empty');
    expect(() => assertBackupFile(empty)).toThrow('missing or empty');
    expect(() => assertBackupFile(stale)).toThrow('older than 24 hours');
    expect(() => assertBackupFile(fresh)).not.toThrow();
  });

  test('refuses to run when a kept shop is missing, without deleting anything', async () => {
    const remove = () => Promise.reject(new Error('must not delete'));
    const prisma = {
      $queryRaw: () => Promise.resolve([]),
      $transaction: remove,
      shop: { findUnique: () => Promise.resolve(null) }
    };
    await expect(runLeftoverShopCleanup(prisma as never, { apply: false, backupFile: null }, () => undefined))
      .rejects.toThrow('kept shop');
  });
});
