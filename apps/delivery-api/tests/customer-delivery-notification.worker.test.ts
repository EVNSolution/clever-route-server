import { describe, expect, test, vi } from 'vitest';

import { createCustomerDeliveryNotificationRuntime } from '../src/modules/route-plans/customer-delivery-notification.runtime.js';
import type { CustomerDeliveryNotificationJob } from '../src/modules/route-plans/customer-delivery-notification.outbox.js';
import { CustomerDeliveryNotificationWorker } from '../src/modules/route-plans/customer-delivery-notification.worker.js';

const now = new Date('2026-07-23T08:00:00.000Z');

describe('CustomerDeliveryNotificationWorker', () => {
  test('sends a claimed notification and marks it sent', async () => {
    const { outbox, sender } = createHarness();
    sender.send.mockResolvedValue({
      provider: 'http',
      providerMessageId: 'provider-id',
      status: 'SENT'
    });
    const worker = new CustomerDeliveryNotificationWorker(outbox as never, sender, { batchSize: 1 });

    await expect(worker.runDueBatch(now)).resolves.toBe(1);

    expect(sender.send).toHaveBeenCalledWith({
      deliveryStopId: 'stop-id',
      idempotencyKey: 'notification-key',
      orderId: 'order-id',
      recipientEmail: 'customer@example.com',
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com',
      status: 'COMPLETED'
    });
    expect(outbox.markSent).toHaveBeenCalledWith({
      factId: 'fact-id',
      leaseToken: 'lease-token',
      now,
      provider: 'http',
      providerMessageId: 'provider-id'
    });
  });

  test('sends customer memo notifications from durable metadata without route payload', async () => {
    const { outbox, sender } = createHarness({
      deliveryStopId: null,
      metadata: { body: 'Customer-visible memo', orderMessageId: 'message-id' },
      requestedUiStatus: null,
      routePlanId: null
    });
    sender.send.mockResolvedValue({
      provider: 'http',
      providerMessageId: 'provider-id',
      status: 'SENT'
    });
    const worker = new CustomerDeliveryNotificationWorker(outbox as never, sender, { batchSize: 1 });

    await expect(worker.runDueBatch(now)).resolves.toBe(1);

    expect(sender.send).toHaveBeenCalledWith({
      body: 'Customer-visible memo',
      idempotencyKey: 'notification-key',
      kind: 'CUSTOMER_MESSAGE',
      orderId: 'order-id',
      orderMessageId: 'message-id',
      recipientEmail: 'customer@example.com',
      shopDomain: 'example.myshopify.com'
    });
    expect(outbox.markSent).toHaveBeenCalledWith({
      factId: 'fact-id',
      leaseToken: 'lease-token',
      now,
      provider: 'http',
      providerMessageId: 'provider-id'
    });
  });

  test('releases retryable failures with exponential backoff', async () => {
    const { outbox, sender } = createHarness();
    sender.send.mockResolvedValue({
      errorCode: 'HTTP_CUSTOMER_NOTIFICATION_FAILED',
      errorMessage: 'upstream unavailable',
      provider: 'http',
      retryable: true,
      status: 'FAILED'
    });
    const worker = new CustomerDeliveryNotificationWorker(
      outbox as never,
      sender,
      { batchSize: 1, retryBaseDelayMs: 30_000, retryMaxDelayMs: 60_000 }
    );

    await worker.runDueBatch(now);

    expect(outbox.releaseForRetry).toHaveBeenCalledWith({
      errorCode: 'HTTP_CUSTOMER_NOTIFICATION_FAILED',
      errorMessage: 'upstream unavailable',
      factId: 'fact-id',
      leaseToken: 'lease-token',
      nextAttemptAt: new Date('2026-07-23T08:00:30.000Z'),
      provider: 'http'
    });
    expect(outbox.markDead).not.toHaveBeenCalled();
  });

  test('marks permanent failures and exhausted retries dead', async () => {
    const permanent = createHarness();
    permanent.sender.send.mockResolvedValue({
      errorCode: 'HTTP_CUSTOMER_NOTIFICATION_FAILED',
      errorMessage: 'bad request',
      provider: 'http',
      retryable: false,
      status: 'FAILED'
    });
    await new CustomerDeliveryNotificationWorker(
      permanent.outbox as never,
      permanent.sender,
      { batchSize: 1 }
    ).runDueBatch(now);

    const exhausted = createHarness({ attemptCount: 8 });
    exhausted.sender.send.mockResolvedValue({
      errorCode: 'HTTP_CUSTOMER_NOTIFICATION_FAILED',
      errorMessage: 'still unavailable',
      provider: 'http',
      retryable: true,
      status: 'FAILED'
    });
    await new CustomerDeliveryNotificationWorker(
      exhausted.outbox as never,
      exhausted.sender,
      { batchSize: 1, maxAttempts: 8 }
    ).runDueBatch(now);

    expect(permanent.outbox.markDead).toHaveBeenCalledOnce();
    expect(exhausted.outbox.markDead).toHaveBeenCalledOnce();
    expect(exhausted.outbox.releaseForRetry).not.toHaveBeenCalled();
  });

  test('marks missing durable payload and expired notifications dead without sending', async () => {
    const missingEmail = createHarness({ recipientEmail: null });
    await new CustomerDeliveryNotificationWorker(
      missingEmail.outbox as never,
      missingEmail.sender,
      { batchSize: 1 }
    ).runDueBatch(now);

    const expired = createHarness({
      occurredAt: new Date('2026-07-21T08:00:00.000Z')
    });
    await new CustomerDeliveryNotificationWorker(
      expired.outbox as never,
      expired.sender,
      { batchSize: 1, maxAgeMs: 24 * 60 * 60 * 1000 }
    ).runDueBatch(now);

    expect(missingEmail.sender.send).not.toHaveBeenCalled();
    expect(missingEmail.outbox.markDead).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'CUSTOMER_EMAIL_MISSING'
    }));
    expect(expired.sender.send).not.toHaveBeenCalled();
    expect(expired.outbox.markDead).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'CUSTOMER_NOTIFICATION_EXPIRED'
    }));
  });

  test('keeps the runtime disabled when no sender URL is configured', async () => {
    const runtime = createCustomerDeliveryNotificationRuntime({
      env: {},
      prisma: {} as never
    });

    expect(runtime.enabled).toBe(false);
    await expect(runtime.start()).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});

function createHarness(overrides: Partial<CustomerDeliveryNotificationJob> = {}) {
  const job: CustomerDeliveryNotificationJob = {
    attemptCount: 1,
    deliveryStopId: 'stop-id',
    factId: 'fact-id',
    idempotencyKey: 'notification-key',
    metadata: null,
    leaseToken: 'lease-token',
    occurredAt: new Date('2026-07-23T07:55:00.000Z'),
    orderId: 'order-id',
    recipientEmail: 'customer@example.com',
    requestedUiStatus: 'COMPLETED',
    routePlanId: 'route-id',
    shopDomain: 'example.myshopify.com',
    ...overrides
  };
  const outbox = {
    claimNext: vi.fn()
      .mockResolvedValueOnce(job)
      .mockResolvedValue(null),
    markDead: vi.fn().mockResolvedValue(true),
    markSent: vi.fn().mockResolvedValue(true),
    releaseForRetry: vi.fn().mockResolvedValue(true)
  };
  const sender = {
    providerName: 'http',
    send: vi.fn()
  };
  return { job, outbox, sender };
}
