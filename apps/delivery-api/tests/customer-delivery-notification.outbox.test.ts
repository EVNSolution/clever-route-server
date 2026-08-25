import { describe, expect, test, vi } from 'vitest';

import { PrismaCustomerDeliveryNotificationOutbox } from '../src/modules/route-plans/customer-delivery-notification.outbox.js';

const now = new Date('2026-07-23T08:00:00.000Z');
type UpdateManyInput = {
  data: Record<string, unknown>;
  where: Record<string, unknown>;
};

describe('PrismaCustomerDeliveryNotificationOutbox', () => {
  test('claims one due fact with a lease and reconstructs its immutable payload', async () => {
    const customerRouteNotificationFact = {
      findFirst: vi.fn().mockResolvedValue({
        attemptCount: 2,
        deliveryStopId: 'stop-id',
        id: 'fact-id',
        idempotencyKey: 'notification-key',
        occurredAt: new Date('2026-07-23T07:55:00.000Z'),
        orderId: 'order-id',
        recipientEmailSnapshot: 'customer@example.com',
        requestedUiStatus: 'COMPLETED',
        routePlanId: 'route-id',
        shop: { shopDomain: 'example.myshopify.com' }
      }),
      updateMany: vi.fn<(input: UpdateManyInput) => Promise<{ count: number }>>()
        .mockResolvedValue({ count: 1 })
    };
    const outbox = new PrismaCustomerDeliveryNotificationOutbox({
      customerRouteNotificationFact
    } as never);

    const claimed = await outbox.claimNext({ leaseMs: 60_000, now });

    expect(claimed).toMatchObject({
      attemptCount: 3,
      deliveryStopId: 'stop-id',
      factId: 'fact-id',
      idempotencyKey: 'notification-key',
      orderId: 'order-id',
      recipientEmail: 'customer@example.com',
      requestedUiStatus: 'COMPLETED',
      routePlanId: 'route-id',
      shopDomain: 'example.myshopify.com'
    });
    expect(claimed?.leaseToken).toEqual(expect.any(String));
    expect(customerRouteNotificationFact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        reconciliationTombstones: { none: { disposition: 'DO_NOT_SEND' } },
        OR: [
          {
            nextAttemptAt: { lte: now },
            status: 'QUEUED'
          },
          {
            leaseExpiresAt: { lte: now },
            status: 'PROCESSING'
          }
        ]
      }
    }));
    const claimUpdate = customerRouteNotificationFact.updateMany.mock.calls[0]?.[0];
    expect(claimUpdate?.data).toMatchObject({
      attemptCount: { increment: 1 },
      leaseExpiresAt: new Date('2026-07-23T08:01:00.000Z'),
      leaseToken: claimed?.leaseToken,
      processingStartedAt: now,
      status: 'PROCESSING'
    });
    expect(claimUpdate?.where.id).toBe('fact-id');
    expect(Array.isArray(claimUpdate?.where.OR)).toBe(true);
    expect(claimUpdate?.where.reconciliationTombstones).toEqual({ none: { disposition: 'DO_NOT_SEND' } });
  });

  test('returns no job when another worker wins the compare-and-set claim', async () => {
    const customerRouteNotificationFact = {
      findFirst: vi.fn().mockResolvedValue({
        attemptCount: 0,
        deliveryStopId: 'stop-id',
        id: 'fact-id',
        idempotencyKey: 'notification-key',
        occurredAt: now,
        orderId: 'order-id',
        recipientEmailSnapshot: 'customer@example.com',
        requestedUiStatus: 'READY',
        routePlanId: 'route-id',
        shop: { shopDomain: 'example.myshopify.com' }
      }),
      updateMany: vi.fn<(input: UpdateManyInput) => Promise<{ count: number }>>()
        .mockResolvedValue({ count: 0 })
    };
    const outbox = new PrismaCustomerDeliveryNotificationOutbox({
      customerRouteNotificationFact
    } as never);

    await expect(outbox.claimNext({ leaseMs: 60_000, now })).resolves.toBeNull();
    expect(customerRouteNotificationFact.findFirst).toHaveBeenCalledTimes(5);
    expect(customerRouteNotificationFact.updateMany).toHaveBeenCalledTimes(5);
  });

  test('continues to another due fact after losing a compare-and-set claim', async () => {
    const baseFact = {
      attemptCount: 0,
      deliveryStopId: 'stop-id',
      idempotencyKey: 'notification-key',
      occurredAt: now,
      orderId: 'order-id',
      recipientEmailSnapshot: 'customer@example.com',
      requestedUiStatus: 'READY',
      routePlanId: 'route-id',
      shop: { shopDomain: 'example.myshopify.com' }
    };
    const customerRouteNotificationFact = {
      findFirst: vi.fn()
        .mockResolvedValueOnce({ ...baseFact, id: 'contended-fact-id' })
        .mockResolvedValueOnce({ ...baseFact, id: 'available-fact-id' }),
      updateMany: vi.fn<(input: UpdateManyInput) => Promise<{ count: number }>>()
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 })
    };
    const outbox = new PrismaCustomerDeliveryNotificationOutbox({
      customerRouteNotificationFact
    } as never);

    await expect(outbox.claimNext({ leaseMs: 60_000, now })).resolves.toMatchObject({
      factId: 'available-fact-id'
    });
    expect(customerRouteNotificationFact.updateMany).toHaveBeenCalledTimes(2);
  });

  test('settles a claimed fact only when its lease token still matches', async () => {
    const customerRouteNotificationFact = {
      findFirst: vi.fn(),
      updateMany: vi.fn<(input: UpdateManyInput) => Promise<{ count: number }>>()
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
    };
    const outbox = new PrismaCustomerDeliveryNotificationOutbox({
      customerRouteNotificationFact
    } as never);

    await expect(outbox.markSent({
      factId: 'sent-id',
      leaseToken: 'sent-lease',
      now,
      provider: 'http',
      providerMessageId: 'provider-id'
    })).resolves.toBe(true);
    await expect(outbox.releaseForRetry({
      errorCode: 'TEMPORARY',
      errorMessage: 'retry later',
      factId: 'retry-id',
      leaseToken: 'retry-lease',
      nextAttemptAt: new Date('2026-07-23T08:01:00.000Z'),
      provider: 'http'
    })).resolves.toBe(true);
    await expect(outbox.markDead({
      errorCode: 'PERMANENT',
      errorMessage: 'do not retry',
      factId: 'dead-id',
      leaseToken: 'dead-lease',
      now,
      provider: 'http'
    })).resolves.toBe(true);

    expect(customerRouteNotificationFact.updateMany.mock.calls.map(([input]) => input.where))
      .toEqual([
        { id: 'sent-id', leaseToken: 'sent-lease', status: 'PROCESSING' },
        { id: 'retry-id', leaseToken: 'retry-lease', status: 'PROCESSING' },
        { id: 'dead-id', leaseToken: 'dead-lease', status: 'PROCESSING' }
      ]);
    const [sentInput, , deadInput] = customerRouteNotificationFact.updateMany.mock.calls.map(([input]) => input);
    expect(sentInput?.data.recipientEmailSnapshot).toBeNull();
    expect(deadInput?.data.recipientEmailSnapshot).toBeNull();
  });
});
