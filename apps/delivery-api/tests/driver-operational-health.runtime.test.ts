import { describe, expect, test, vi } from 'vitest';
import { DriverOperationalHealthRuntime } from '../src/modules/driver/driver-operational-health.runtime.js';

describe('driver operational health runtime', () => {
  test('runs the independent detector and records scheduler failures without escaping', async () => {
    const detectOperationalHealth = vi.fn()
      .mockResolvedValueOnce({ heartbeatAbsent: 1, routesChecked: 2 })
      .mockRejectedValueOnce(new Error('token=secret customer@example.invalid at 99 Private Street'));
    const logger = { error: vi.fn(), info: vi.fn() };
    const runtime = new DriverOperationalHealthRuntime({ detectOperationalHealth }, logger);

    await runtime.runOnce();
    await runtime.runOnce();

    expect(logger.info).toHaveBeenCalledWith(
      { event: 'driver_operational_health_scan', heartbeatAbsent: 1, routesChecked: 2 },
      'driver operational health scan completed'
    );
    expect(logger.error).toHaveBeenCalledWith(
      {
        errorCode: 'DRIVER_OPERATIONAL_HEALTH_SCAN_FAILED',
        errorMessage: '[redacted-secret] [redacted-email] at [redacted-address]',
        event: 'driver_operational_health_scan_failed'
      },
      'driver operational health scan failed'
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('token=secret');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('customer@example.invalid');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('99 Private Street');
  });
});
