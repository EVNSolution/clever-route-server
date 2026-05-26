import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('package scripts', () => {
  test('exposes proof media operational commands for scheduled operations and evidence handoff', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['driver:proof-media:cleanup']).toBe('tsx src/scripts/cleanup-driver-proof-media.ts');
    expect(packageJson.scripts?.['driver:proof-media:evidence:seed']).toBe('tsx src/scripts/proof-media-evidence-seed.ts');
    expect(packageJson.scripts?.['woocommerce:connection:bootstrap']).toBe(
      'tsx src/scripts/bootstrap-woocommerce-connection.ts'
    );
    expect(packageJson.scripts?.['wordpress-plugin:pairing-code:create']).toBe(
      'tsx src/scripts/create-wordpress-plugin-pairing-code.ts'
    );
    expect(packageJson.scripts?.['prisma:migrate:deploy']).toContain('prisma migrate deploy');
  });
});
