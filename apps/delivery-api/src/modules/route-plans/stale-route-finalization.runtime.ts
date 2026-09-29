import { safeErrorTelemetry } from '../security/safe-telemetry-redaction.js';

import type { StaleRouteFinalizationResult } from './stale-route-finalization.service.js';

type StaleRouteFinalizationWorkerService = {
  processDue(): Promise<StaleRouteFinalizationResult>;
};

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  info?(bindings: unknown, message?: string): void;
};

export class StaleRouteFinalizationRuntime {
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly service: StaleRouteFinalizationWorkerService,
    private readonly enabled: boolean,
    private readonly logger?: LoggerLike,
    private readonly intervalMs = 15 * 60_000
  ) {}

  start(): void {
    if (!this.enabled) {
      this.logger?.info?.({ event: 'kfood_stale_route_finalization_disabled' }, 'K-food stale route finalization disabled');
      return;
    }
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }

  async runOnce(): Promise<void> {
    if (!this.enabled || this.pending !== null) return;
    this.pending = this.processDue();
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async processDue(): Promise<void> {
    try {
      const result = await this.service.processDue();
      this.logger?.info?.({ event: 'kfood_stale_route_finalization_scan', ...result }, 'K-food stale route finalization scan completed');
    } catch (error) {
      this.logger?.error?.({
        ...safeErrorTelemetry(error),
        errorCode: 'KFOOD_STALE_ROUTE_FINALIZATION_FAILED',
        event: 'kfood_stale_route_finalization_failed'
      }, 'K-food stale route finalization scan failed');
    }
  }
}
