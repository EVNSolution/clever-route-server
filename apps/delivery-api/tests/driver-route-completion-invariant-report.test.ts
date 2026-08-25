import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { meetsRecoveryThreshold } from '../src/modules/driver/driver-route-completion-rollout-evidence.js';

describe('driver route completion invariant report', () => {
  test('uses read-only aggregates for active-session adoption, daily review continuity, and recovery', async () => {
    const source = await readFile(new URL('../src/scripts/report-driver-route-completion-invariant.ts', import.meta.url), 'utf8');
    expect(source).toContain('FROM driver_route_completion_reviews');
    expect(source).toContain('COUNT(*)');
    expect(source).toContain('FROM driver_sync_sessions');
    expect(source).toContain('"lastObservedAt" >= ${activeSince}');
    expect(source).toContain('sessions."expiresAt" > ${now}');
    expect(source).toContain('"driverContractVersion" IS NULL OR "driverContractVersion" < 2');
    expect(source).toContain("routes.status = 'IN_PROGRESS'");
    expect(source).toContain('SELECT DISTINCT ON (sessions."driverId", sessions."routePlanId")');
    expect(source).toContain('generate_series');
    expect(source).toContain('driver_route_completion_gate_history');
    expect(source).toContain('resolved_within_five_minutes_count');
    expect(source).toContain('prisma.$queryRaw');
    expect(source).not.toMatch(/\$executeRaw|\.create\(|\.delete|\.update\(/u);
    expect(source).not.toMatch(/recipient|address|phone|email|customer/u);
  });

  test('evaluates recovery against the raw fraction before formatting the display percent', () => {
    expect(meetsRecoveryThreshold(199, 200)).toBe(true);
    expect(meetsRecoveryThreshold(198, 199)).toBe(false);
  });
});
