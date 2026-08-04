import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

import { redactTelemetry } from '../security/safe-telemetry-redaction.js';
import type { ShopifyOrderWebhookProcessor } from './order-webhook.processor.js';

type ShopifyOrderWebhookWorkerOptions = {
  enabled?: boolean;
  intervalMs?: number;
  leaseMs?: number;
  logger?: Pick<FastifyBaseLogger, 'error' | 'info'>;
  processor: Pick<ShopifyOrderWebhookProcessor, 'processNextDue'>;
  workerId?: string;
};

export class ShopifyOrderWebhookWorker {
  private closing = false;
  private inFlightTick: Promise<void> | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly workerId: string;

  constructor(private readonly options: ShopifyOrderWebhookWorkerOptions) {
    this.enabled = options.enabled ?? true;
    this.intervalMs = options.intervalMs ?? 2_000;
    this.leaseMs = options.leaseMs ?? 120_000;
    this.workerId = options.workerId ?? `order-webhook-${process.pid}-${randomUUID()}`;
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
      let processed = 0;
      for (let index = 0; index < 10; index += 1) {
        const result = await this.options.processor.processNextDue({
          leaseMs: this.leaseMs,
          workerId: this.workerId
        });
        if (!result.processed) break;
        processed += 1;
      }
      if (processed > 0) {
        this.options.logger?.info({ event: 'shopify_order_webhook_worker_tick', processed }, 'processed Shopify order webhooks');
      }
    } catch (error) {
      this.options.logger?.error({ error: redactTelemetry(error), event: 'shopify_order_webhook_worker_error' }, 'Shopify order webhook worker failed');
    } finally {
      this.running = false;
      if (!this.closing) this.schedule(this.intervalMs);
    }
  }
}
