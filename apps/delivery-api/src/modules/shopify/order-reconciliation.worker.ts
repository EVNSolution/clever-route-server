import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

import { redactTelemetry } from '../security/safe-telemetry-redaction.js';
import type { ShopifyOrderReconciliationService } from './order-reconciliation.service.js';

export class ShopifyOrderReconciliationWorker {
  private closing = false;
  private inFlightTick: Promise<void> | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly workerId: string;

  constructor(
    private readonly options: {
      enabled?: boolean;
      intervalMs?: number;
      leaseMs?: number;
      logger?: Pick<FastifyBaseLogger, 'error' | 'info'>;
      service: Pick<ShopifyOrderReconciliationService, 'processNextDue'>;
      workerId?: string;
    }
  ) {
    this.enabled = options.enabled ?? true;
    this.intervalMs = options.intervalMs ?? 5_000;
    this.leaseMs = options.leaseMs ?? 5 * 60 * 1000;
    this.workerId = options.workerId ?? `order-reconciliation-${process.pid}-${randomUUID()}`;
  }

  start(): void {
    if (this.closing) return;
    if (!this.enabled || this.timer !== undefined) return;
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.inFlightTick;
  }

  private schedule(delayMs: number): void {
    if (this.closing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlightTick = this.tick().finally(() => {
        this.inFlightTick = null;
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.closing) return;
    if (this.running) {
      this.schedule(this.intervalMs);
      return;
    }
    this.running = true;
    try {
      const result = await this.options.service.processNextDue({
        leaseMs: this.leaseMs,
        workerId: this.workerId
      });
      if (result.processed) {
        this.options.logger?.info({ event: 'shopify_order_reconciliation_worker_tick', jobId: result.jobId }, 'processed Shopify order reconciliation job');
      }
    } catch (error) {
      this.options.logger?.error({ error: redactTelemetry(error), event: 'shopify_order_reconciliation_worker_error' }, 'Shopify order reconciliation worker failed');
    } finally {
      this.running = false;
      if (!this.closing) this.schedule(this.intervalMs);
    }
  }
}
