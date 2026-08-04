import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('orders pagination completion evidence', () => {
  test('keeps completion evidence isolated, non-PII, and rollback-oriented', () => {
    const script = readFileSync(new URL('../src/scripts/orders-pagination-completion-evidence.ts', import.meta.url), 'utf8');
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const commonFilterSql = readFileSync(
      new URL('../scripts/orders-pagination-query-plan-common-filters.sql.example', import.meta.url),
      'utf8'
    );

    expect(packageJson.scripts?.['perf:orders:completion-evidence']).toBe(
      'tsx src/scripts/orders-pagination-completion-evidence.ts'
    );
    expect(script).toContain("const REQUIRED_SCHEMA = 'orders_perf_20260804'");
    expect(script).toContain('orders-server-performance-cohorts.json');
    expect(script).toContain('orders_shopId_displayOrderSequence_id_idx');
    expect(script).toContain('ROLLBACK');
    expect(script).toContain('rollbackPreservedChecksum');
    expect(script).toContain('privacyEvidence');
    expect(script).not.toMatch(/customer@example\.com|\+1-416|Evidence Street/u);
    expect(commonFilterSql).toContain('EXISTS');
    expect(commonFilterSql).toContain('"deliveryArea" =');
    expect(commonFilterSql).toContain('"readiness" =');
    expect(commonFilterSql).toContain('NOT EXISTS');
    expect(commonFilterSql).toContain('ORDER BY o."displayOrderSequence" DESC, o."id" DESC');
  });
});
