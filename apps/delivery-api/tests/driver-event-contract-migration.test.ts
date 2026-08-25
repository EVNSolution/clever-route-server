import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const migrationPath = new URL('../prisma/migrations/20260824133000_driver_event_contract_v2/migration.sql', import.meta.url);
const hardeningMigrationPath = new URL('../prisma/migrations/20260824170000_harden_driver_event_attempt_evidence/migration.sql', import.meta.url);

describe('driver event contract v2 migration', () => {
  test('is additive, bigint-safe, indexed, and redaction-scoped', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const hardening = await readFile(hardeningMigrationPath, 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "assignmentGeneration" BIGINT NOT NULL DEFAULT 1');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "driver_event_attempts"');
    expect(sql).toContain('CHECK ("assignmentGeneration" BETWEEN 1 AND 9223372036854775807)');
    expect(sql).toContain('"driver_event_attempts_driverId_clientEventId_createdAt_idx"');
    expect(sql).toContain('"driver_event_attempts_retainedUntil_idx"');
    expect(sql).not.toMatch(/"(?:accessToken|refreshToken|address|recipient|proof|payload|errorMessage)"/iu);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/iu);
    expect(hardening).toContain('ADD COLUMN IF NOT EXISTS "attemptNumber" INTEGER');
    expect(hardening).toContain('ROW_NUMBER() OVER');
    expect(hardening).toContain('"driver_event_attempts_driverId_clientEventId_attemptNumber_key"');
    expect(hardening).toContain("'ACCEPTED', 'APPLIED', 'DUPLICATE', 'REJECTED', 'FAILED'");
  });

  test('locks every direct assignment mutation before generation increment', async () => {
    const routePlanRepository = await readFile(new URL('../src/modules/route-plans/route-plan.repository.ts', import.meta.url), 'utf8');
    const groupingService = await readFile(new URL('../src/modules/route-grouping/route-grouping.service.ts', import.meta.url), 'utf8');
    expect(routePlanRepository.match(/FOR UPDATE/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(routePlanRepository.match(/assignmentGeneration: \{ increment: 1 \}/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(groupingService.match(/lockRoutePlanMembership\(/gu)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(groupingService.match(/lockReadyRoutePlanMembership\(/gu)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(groupingService.match(/assignmentGeneration: \{ increment: 1 \}/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
