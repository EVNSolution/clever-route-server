import { spawnSync } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';

const cleanupMocks = vi.hoisted(() => ({
  cleanupOperational: vi.fn(),
  cleanupResolvedAttempts: vi.fn(),
  cleanupRouteCompletion: vi.fn(),
  disconnect: vi.fn()
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    $disconnect = cleanupMocks.disconnect;
  }
}));

vi.mock('../src/modules/driver/driver-event-attempt-retention.js', () => ({
  cleanupResolvedDriverEventAttempts: cleanupMocks.cleanupResolvedAttempts,
  parseRetentionDeadline: vi.fn(() => undefined)
}));

vi.mock('../src/modules/driver/driver-route-completion-review-retention.js', () => ({
  cleanupReviewedRouteCompletionEvidence: cleanupMocks.cleanupRouteCompletion
}));

vi.mock('../src/modules/operations/route-operational-evidence-retention.js', () => ({
  cleanupRouteOperationalEvidence: cleanupMocks.cleanupOperational
}));

describe('driver event attempt retention script', () => {
  test('requests immediate continuation when email reconciliation audit cleanup has more work', async () => {
    cleanupMocks.cleanupResolvedAttempts.mockResolvedValue({ continuationRequired: false, deletedCount: 0 });
    cleanupMocks.cleanupRouteCompletion.mockResolvedValue({ continuationRequired: false, deletedCount: 0 });
    cleanupMocks.cleanupOperational.mockResolvedValue({
      alertCycles: 0,
      alertCyclesContinuationRequired: false,
      emailReconciliationAudits: 10_000,
      emailReconciliationAuditsContinuationRequired: true,
      locationContinuationRequired: false,
      locationEvents: 0,
      notificationAttemptReconciliationContinuationRequired: false,
      notificationAttempts: 0,
      notificationAttemptsContinuationRequired: false,
      notificationAttemptsReconciled: 0,
      routeTrackingGeometries: 0,
      syncContinuationRequired: false,
      syncHeartbeats: 0,
      syncSessions: 0
    });
    const previousExitCode = process.exitCode;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.exitCode = undefined;
      await import('../src/scripts/cleanup-driver-event-attempts.js');
      expect(process.exitCode).toBe(75);
      expect(cleanupMocks.disconnect).toHaveBeenCalledOnce();
    } finally {
      stdout.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  test('fails with stable redacted telemetry when the database is unavailable', () => {
    const hostileEmail = ['retention.customer', 'invalid.test'].join('@');
    const hostileToken = ['token', 'super-secret-value'].join('=');
    const unavailableHost = ['private-db', 'invalid'].join('.');
    const databaseUrl = `postgresql://${encodeURIComponent(hostileEmail)}:${encodeURIComponent(hostileToken)}@${unavailableHost}:5432/retention`;
    const result = spawnSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'src/scripts/cleanup-driver-event-attempts.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DRIVER_EVENT_ATTEMPT_RETENTION_DAYS: '90'
        },
        timeout: 10_000
      }
    );

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('');
    const telemetry = JSON.parse(result.stderr.trim()) as Record<string, unknown>;
    expect(telemetry).toEqual({
      code: 'PRISMACLIENTINITIALIZATIONERROR',
      event: 'driver_event_attempt_retention_cleanup_failed',
      message: 'Driver event attempt retention cleanup failed'
    });
    expect(result.stderr).not.toContain(hostileEmail);
    expect(result.stderr).not.toContain(hostileToken);
    expect(result.stderr).not.toContain(unavailableHost);
    expect(result.stderr).not.toContain('    at ');
    expect(result.stderr).not.toContain(databaseUrl);
  });
});
