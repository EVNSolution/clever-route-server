import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { DEFAULT_SHOPIFY_ADMIN_API_VERSION } from '../src/modules/shopify/shopify-api-version.js';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const packageRoot = new URL('../', import.meta.url);

describe('Shopify Admin API version authority', () => {
  test('targets the current stable Shopify Admin API version', () => {
    expect(DEFAULT_SHOPIFY_ADMIN_API_VERSION).toBe('2026-07');
  });

  test('keeps runtime defaults centralized instead of duplicating dated literals', async () => {
    const runtimeFiles = [
      'modules/shopify/auth.dependencies.ts',
      'modules/shopify/order-sync.dependencies.ts',
      'modules/shopify/webhook.dependencies.ts',
      'modules/route-plans/route-plan.repository.ts'
    ];

    for (const relativePath of runtimeFiles) {
      const source = await readFile(new URL(relativePath, `file://${sourceRoot}/`), 'utf8');
      expect(source, relativePath).toContain('DEFAULT_SHOPIFY_ADMIN_API_VERSION');
      expect(source, relativePath).not.toMatch(/const DEFAULT_(?:SHOPIFY_)?API_VERSION = '\d{4}-\d{2}'/u);
    }
  });

  test('keeps configuration and newly persisted shops on the same default', async () => {
    const [envExample, schema, openApi] = await Promise.all([
      readFile(new URL('.env.example', packageRoot), 'utf8'),
      readFile(new URL('prisma/schema.prisma', packageRoot), 'utf8'),
      readFile(new URL('docs/api/openapi.yaml', packageRoot), 'utf8')
    ]);
    const migration = await readFile(
      new URL('prisma/migrations/20260819020000_align_shopify_api_version_default/migration.sql', packageRoot),
      'utf8'
    );

    expect(envExample).toContain(`SHOPIFY_API_VERSION=${DEFAULT_SHOPIFY_ADMIN_API_VERSION}`);
    expect(schema).toMatch(new RegExp(`apiVersion\\s+String\\s+@default\\("${DEFAULT_SHOPIFY_ADMIN_API_VERSION}"\\)`));
    expect(migration).toContain(`ALTER COLUMN "apiVersion" SET DEFAULT '${DEFAULT_SHOPIFY_ADMIN_API_VERSION}'`);
    expect(openApi).toContain('ShopifyApiVersionHeader:');
    expect(openApi).toContain(`example: ${DEFAULT_SHOPIFY_ADMIN_API_VERSION}`);
    expect(openApi).not.toContain('example: 2026-04');
  });
});
