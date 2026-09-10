import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('driver proof media production read inventory', () => {
  const productionSources = readTypeScriptSources(new URL('../src/modules/', import.meta.url));

  test('keeps every DSV relation projection READY-only', () => {
    const source = readFileSync(new URL('../src/modules/dsv/dsv-v1-read-query.service.ts', import.meta.url), 'utf8');
    const customerRead = /driverProofMedia:\s*\{[\s\S]*?where:\s*\{([^}]+)\}/u.exec(source);
    const adminRead = /driverProofMediaLinks:\s*\{[\s\S]*?where:\s*\{\s*proofMedia:\s*\{([^}]+)\}/u.exec(source);
    expect(customerRead?.[1]).toContain("uploadStatus: 'READY'");
    expect(adminRead?.[1]).toContain("uploadStatus: 'READY'");
  });

  test('keeps direct driver access READY-only while cleanup reads remain explicitly status-scoped', () => {
    const directReadFiles = productionSources
      .filter(({ source }) => /driverProofMedia\.find(?:First|Many)/u.test(source))
      .map(({ path }) => path);
    expect(directReadFiles).toEqual(['driver/driver-proof-media.repository.ts']);
    const source = readFileSync(new URL('../src/modules/driver/driver-proof-media.repository.ts', import.meta.url), 'utf8');
    expect(source.match(/driverProofMedia\.find(?:First|Many)/gu)).toHaveLength(6);
    expect(source).toMatch(/createProofMediaReadAccess[\s\S]*?deletedAt:\s*null,[\s\S]*?uploadStatus:\s*'READY'/u);
    expect(source).toMatch(/createAdminProofMediaReadAccess[\s\S]*?deletedAt:\s*null,[\s\S]*?shopId:\s*input\.shopId,[\s\S]*?uploadStatus:\s*'READY'/u);
    expect(source).toContain("uploadStatus: 'PENDING_UPLOAD'");
    expect(source).toContain("uploadStatus: 'CLEANING'");
  });

  test('fails closed when a new relation projection appears outside the audited DSV selects', () => {
    const relationProjectionFiles = productionSources
      .filter(({ source }) => /driverProofMedia(?:Links)?:\s*\{/u.test(source))
      .map(({ path }) => path);
    expect(relationProjectionFiles).toEqual(['dsv/dsv-v1-read-query.service.ts']);
  });
});

function readTypeScriptSources(root: URL, relativePath = ''): Array<{ path: string; source: string }> {
  const normalizedRelativePath = relativePath.replace(/\/+$/u, '');
  const directoryUrl = new URL(normalizedRelativePath === '' ? './' : `${normalizedRelativePath}/`, root);
  return readdirSync(directoryUrl, { withFileTypes: true }).flatMap((entry) => {
    const path = normalizedRelativePath === '' ? entry.name : `${normalizedRelativePath}/${entry.name}`;
    if (entry.isDirectory()) return readTypeScriptSources(root, path);
    return entry.isFile() && entry.name.endsWith('.ts')
      ? [{ path, source: readFileSync(new URL(path, root), 'utf8') }]
      : [];
  });
}
