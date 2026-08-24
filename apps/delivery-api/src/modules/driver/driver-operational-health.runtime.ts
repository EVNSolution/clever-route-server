import type { PrismaDriverSyncHealthService } from './driver-sync-health.service.js';
import { safeErrorTelemetry } from '../security/safe-telemetry-redaction.js';

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  info?(bindings: unknown, message?: string): void;
};

export class DriverOperationalHealthRuntime {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly service: Pick<PrismaDriverSyncHealthService, 'detectOperationalHealth'>,
    private readonly logger?: LoggerLike,
    private readonly intervalMs = 60_000
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    return Promise.resolve();
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.service.detectOperationalHealth();
      this.logger?.info?.({ event: 'driver_operational_health_scan', ...result }, 'driver operational health scan completed');
    } catch (error) {
      this.logger?.error?.({
        ...safeErrorTelemetry(error),
        errorCode: 'DRIVER_OPERATIONAL_HEALTH_SCAN_FAILED',
        event: 'driver_operational_health_scan_failed'
      }, 'driver operational health scan failed');
    } finally {
      this.running = false;
    }
  }
}
