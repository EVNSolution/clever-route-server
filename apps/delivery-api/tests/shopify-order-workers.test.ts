import { describe, expect, test, vi } from 'vitest';

import { ShopifyOrderReconciliationWorker } from '../src/modules/shopify/order-reconciliation.worker.js';
import { ShopifyOrderWebhookWorker } from '../src/modules/shopify/order-webhook.worker.js';

describe('Shopify order workers', () => {
  test('webhook worker close waits for in-flight tick and prevents reschedule', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const processNextDue = vi.fn(
        () =>
          new Promise<{ processed: boolean; webhookId: string | null }>((resolve) => {
            release = () => resolve({ processed: false, webhookId: null });
          })
      );
      const worker = new ShopifyOrderWebhookWorker({
        intervalMs: 10,
        processor: { processNextDue },
        workerId: 'worker-1'
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      const closing = worker.close();
      await vi.advanceTimersByTimeAsync(100);
      expect(processNextDue).toHaveBeenCalledOnce();
      release();
      await closing;
      await vi.advanceTimersByTimeAsync(100);
      expect(processNextDue).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test('reconciliation worker close waits for in-flight tick and prevents reschedule', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const processNextDue = vi.fn(
        () =>
          new Promise<{ jobId: string | null; processed: boolean }>((resolve) => {
            release = () => resolve({ jobId: null, processed: false });
          })
      );
      const worker = new ShopifyOrderReconciliationWorker({
        intervalMs: 10,
        service: { processNextDue },
        workerId: 'worker-1'
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      const closing = worker.close();
      await vi.advanceTimersByTimeAsync(100);
      expect(processNextDue).toHaveBeenCalledOnce();
      release();
      await closing;
      await vi.advanceTimersByTimeAsync(100);
      expect(processNextDue).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
