import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const packageRoot = new URL('../', import.meta.url);

describe('disposable DB integration runner', () => {
  test('exposes a guarded command for every otherwise skipped DB suite', async () => {
    const [packageJsonText, script] = await Promise.all([
      readFile(new URL('package.json', packageRoot), 'utf8'),
      readFile(new URL('scripts/test-disposable-db-integrations.sh', packageRoot), 'utf8')
    ]);
    const packageJson = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['test:db:disposable']).toBe('bash scripts/test-disposable-db-integrations.sh');
    expect(script).toContain('CLEVER_RUN_DISPOSABLE_DB_TESTS');
    expect(script).toContain('safe-local-g003-temp-cluster');
    expect(script).toContain('safe-local-g010-disposable');
    expect(script).toContain('safe-local-g005-temp-cluster');
    expect(script).toContain('safe-local-g006-disposable');
    expect(script).toContain('dsv-dispatch-import-g003-integration.test.ts');
    expect(script).toContain('dsv-assignment-command.integration.test.ts');
    expect(script).toContain('dsv-g009-tenant-composite-fks.integration.test.ts');
    expect(script).toContain('dsv-v1-read-query.integration.test.ts');
    expect(script).toContain('shopify-webhook-durability.integration.test.ts');
    expect(script).toContain('customer-email-reconciliation.integration.test.ts');
    expect(script).toContain('trap cleanup EXIT');
    expect(script).not.toContain(':55444');
    expect(script).not.toContain(':55455');
  });
});
