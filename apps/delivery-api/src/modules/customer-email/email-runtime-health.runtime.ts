import type { PrismaClient } from '@prisma/client';

import type { PrismaEmailRuntimeHealthService } from './email-runtime-health.service.js';
import { safeErrorTelemetry } from '../security/safe-telemetry-redaction.js';

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  info?(bindings: unknown, message?: string): void;
};

export class EmailRuntimeHealthRuntime {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: Pick<PrismaClient, 'shop'>,
    private readonly service: Pick<PrismaEmailRuntimeHealthService, 'get'>,
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
      const shops = await this.prisma.shop.findMany({ select: { appId: true, shopDomain: true } });
      const states = await Promise.all(shops.map(({ appId, shopDomain }) => this.service.get({ appId, shopDomain })));
      this.logger?.info?.({
        event: 'email_runtime_health_scan',
        scanned: states.length,
        unhealthy: states.filter(({ email }) => email.state === 'DEGRADED' || email.state === 'DISABLED').length
      }, 'customer email runtime health scan completed');
    } catch (error) {
      this.logger?.error?.({
        ...safeErrorTelemetry(error),
        errorCode: 'EMAIL_RUNTIME_HEALTH_SCAN_FAILED',
        event: 'email_runtime_health_scan_failed'
      }, 'customer email runtime health scan failed');
    } finally {
      this.running = false;
    }
  }
}
