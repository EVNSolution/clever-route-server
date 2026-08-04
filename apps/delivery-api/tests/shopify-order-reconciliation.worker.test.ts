import { describe, expect, test, vi } from 'vitest';

import { ShopifyOrderReconciliationWorker } from '../src/modules/shopify/order-reconciliation.worker.js';

describe('ShopifyOrderReconciliationWorker', () => {
  test('enqueues stale installed shops before consuming due jobs', async () => {
    const enqueueDueInstalledShops = vi.fn(() => Promise.resolve({ enqueued: 1, failed: 0, skipped: 0 }));
    const processNextDue = vi.fn(() => Promise.resolve({ jobId: 'job-1', processed: true }));
    const worker = new ShopifyOrderReconciliationWorker({
      intervalMs: 5,
      reconciliationIntervalMs: 60_000,
      service: { enqueueDueInstalledShops, processNextDue }
    });

    worker.start();
    await waitFor(() => processNextDue.mock.calls.length === 1);
    await worker.close();

    expect(enqueueDueInstalledShops).toHaveBeenCalledOnce();
    expect(enqueueDueInstalledShops).toHaveBeenCalledBefore(processNextDue);
    expect(enqueueDueInstalledShops).toHaveBeenCalledWith({
      limit: 100,
      requestedBy: 'system:periodic-reconciliation',
      staleBefore: expect.any(Date) as Date
    });
  });

  test('does not repeat the stale-shop sweep on every five-second worker poll', async () => {
    const enqueueDueInstalledShops = vi.fn(() => Promise.resolve({ enqueued: 0, failed: 0, skipped: 0 }));
    const processNextDue = vi.fn(() => Promise.resolve({ jobId: null, processed: false }));
    const worker = new ShopifyOrderReconciliationWorker({
      intervalMs: 5,
      reconciliationIntervalMs: 60_000,
      service: { enqueueDueInstalledShops, processNextDue }
    });

    worker.start();
    await waitFor(() => processNextDue.mock.calls.length >= 2);
    await worker.close();

    expect(enqueueDueInstalledShops).toHaveBeenCalledOnce();
    expect(processNextDue.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for worker tick');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
