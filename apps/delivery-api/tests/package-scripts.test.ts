import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('package scripts', () => {
  test('exposes proof media operational commands for scheduled operations and evidence handoff', async () => {
    const [packageText, emptyRehearsal, prodLikeRehearsal] = await Promise.all([
      readFile('package.json', 'utf8'),
      readFile('scripts/dsv-g002-empty-baseline-rehearsal.sh', 'utf8'),
      readFile('scripts/dsv-g002-prod-like-expand-rehearsal.sh', 'utf8')
    ]);
    const packageJson = JSON.parse(packageText) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['driver:event-attempts:cleanup']).toBe(
      'node dist/scripts/cleanup-driver-event-attempts.js'
    );
    expect(packageJson.scripts?.['driver:proof-media:cleanup']).toBe(
      'node dist/scripts/cleanup-driver-proof-media.js'
    );
    expect(packageJson.scripts?.['shopify:webhook-events:cleanup']).toBe(
      'node dist/scripts/cleanup-shopify-webhook-events.js'
    );
    expect(packageJson.scripts?.['driver:proof-media:evidence:seed']).toBe('tsx src/scripts/proof-media-evidence-seed.ts');
    expect(packageJson.scripts?.['woocommerce:connection:bootstrap']).toBe(
      'tsx src/scripts/bootstrap-woocommerce-connection.ts'
    );
    expect(packageJson.scripts?.['wordpress-plugin:pairing-code:create']).toBe(
      'tsx src/scripts/create-wordpress-plugin-pairing-code.ts'
    );
    expect(packageJson.scripts?.['prisma:migrate:deploy']).toBe('prisma migrate deploy');
    expect(packageJson.scripts?.['prisma:migrate:deploy']).not.toContain('DATABASE_URL');
    expect(packageJson.scripts?.['dsv:g002:baseline:empty']).toBe('bash scripts/dsv-g002-empty-baseline-rehearsal.sh');
    expect(packageJson.scripts?.['dsv:g002:drift:prod-like']).toBe(
      'bash scripts/dsv-g002-prod-like-expand-rehearsal.sh'
    );
    expect(packageJson.scripts?.['dsv:g002:backfill:dry-run']).toBe(
      'tsx src/scripts/dsv-g002-backfill-dry-run.ts'
    );
    expect(emptyRehearsal).toContain('evidence_dir="$(resolve_invocation_path "$evidence_dir")"');
    expect(prodLikeRehearsal).toContain('evidence_dir="$(resolve_invocation_path "$evidence_dir")"');
    expect(emptyRehearsal).toContain('"postApplySchema"');
    expect(prodLikeRehearsal).toContain('"backfillCounts"');
  });
});
