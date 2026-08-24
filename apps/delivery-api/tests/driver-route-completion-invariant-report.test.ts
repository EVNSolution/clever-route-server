import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('driver route completion invariant report', () => {
  test('uses one aggregate SELECT and emits no PII fields or database mutations', async () => {
    const source = await readFile(new URL('../src/scripts/report-driver-route-completion-invariant.ts', import.meta.url), 'utf8');
    expect(source).toContain('FROM driver_route_completion_reviews');
    expect(source).toContain('COUNT(*)');
    expect(source).toContain('prisma.$queryRaw');
    expect(source).not.toMatch(/\$executeRaw|\.create\(|\.delete|\.update\(/u);
    expect(source).not.toMatch(/recipient|address|phone|email|customer|driverId|routePlanId|shopId|clientEventId/u);
  });
});
