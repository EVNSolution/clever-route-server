import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

describe('driver event attempt retention script', () => {
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
