import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

const sourceRoot = new URL('../src/', import.meta.url);

describe('shop privacy write inventory', () => {
  test('keeps every production Shop creation path behind the shared privacy fence', async () => {
    const files = await typeScriptFiles(sourceRoot.pathname);
    const writers: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/\.shop\.(?:create|upsert)\(/u.test(source)) writers.push(relative(sourceRoot.pathname, file));
    }
    expect(writers.sort()).toEqual([
      'modules/commerce/admin-store-settings.service.ts',
      'modules/commerce/commerce-connection.repository.ts',
      'modules/driver/admin-driver.repository.ts',
      'modules/route-plans/route-plan.repository.ts',
      'modules/shopify/order-sync.repository.ts',
      'modules/shopify/webhook-event.repository.ts',
      'scripts/orders-performance-cohorts.ts',
      'scripts/seed-dsv-dispatch-demo.ts',
      'scripts/smoke-dsv-driver-auth.ts'
    ]);
    for (const writer of writers.filter((path) => !path.endsWith('webhook-event.repository.ts'))) {
      expect(await readFile(join(sourceRoot.pathname, writer), 'utf8')).toContain('assertShopifyShopPrivacyWriteAllowed');
    }
    const migration = await readFile(new URL(
      '../prisma/migrations/20260824240000_preserve_shop_redaction_receipts/migration.sql',
      import.meta.url
    ), 'utf8');
    expect(migration).not.toContain('CREATE TRIGGER');
    expect(migration).not.toContain('reject_active_redacted_shop_write');
  });
});

async function typeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}
