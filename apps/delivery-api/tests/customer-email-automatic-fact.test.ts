import { describe, expect, test, vi } from 'vitest';

import { defaultCustomerEmailSettings } from '../src/modules/customer-email/customer-email-settings.js';
import { persistAutomaticCustomerEmailFacts } from '../src/modules/customer-email/customer-email-automatic-fact.js';

const occurredAt = new Date('2026-08-29T14:30:00.000Z');

describe('persistAutomaticCustomerEmailFacts', () => {
  test('does not create facts while tenant automatic delivery is inactive', async () => {
    const prisma = harness(defaultCustomerEmailSettings());

    await expect(persistAutomaticCustomerEmailFacts(prisma as never, event())).resolves.toBe(0);

    expect(prisma.deliveryStop.findMany).not.toHaveBeenCalled();
    expect(prisma.customerRouteNotificationFact.createMany).not.toHaveBeenCalled();
  });

  test('creates one idempotent queued fact from an authoritative delivered event', async () => {
    const settings = defaultCustomerEmailSettings();
    settings.automatic.enabled = true;
    settings.senderEmail = 'dispatch@example.test';
    const prisma = harness(settings);

    await expect(persistAutomaticCustomerEmailFacts(prisma as never, event())).resolves.toBe(1);

    expect(prisma.customerRouteNotificationFact.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        deliveryStopId: 'stop-id',
        idempotencyKey: 'driver-event:event-id:DELIVERED:stop-id',
        metadata: expect.objectContaining({ driverEventId: 'event-id', signal: 'DELIVERED' }) as unknown,
        nextAttemptAt: occurredAt,
        orderId: 'order-id',
        recipientEmailSnapshot: 'customer@example.test',
        routePlanId: 'route-id',
        source: 'DRIVER_EVENT',
        status: 'QUEUED'
      })],
      skipDuplicates: true
    });
  });

  test('persists an explicit skipped outcome instead of queueing an invalid recipient', async () => {
    const settings = defaultCustomerEmailSettings();
    settings.automatic.enabled = true;
    settings.senderEmail = 'dispatch@example.test';
    const prisma = harness(settings, null);

    await persistAutomaticCustomerEmailFacts(prisma as never, event());

    expect(prisma.customerRouteNotificationFact.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        errorCode: 'CUSTOMER_EMAIL_MISSING',
        nextAttemptAt: null,
        recipientEmailSnapshot: null,
        status: 'SKIPPED'
      })],
      skipDuplicates: true
    });
  });
});

function event() {
  return {
    deliveryStopId: 'stop-id',
    driverEventId: 'event-id',
    eventType: 'STOP_DELIVERED',
    occurredAt,
    routePlanId: 'route-id',
    shopId: 'shop-id'
  };
}

function harness(settings: unknown, email: string | null = 'customer@example.test') {
  return {
    customerRouteNotificationFact: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    deliveryStop: {
      findMany: vi.fn().mockResolvedValue([{ id: 'stop-id', order: { email, id: 'order-id' } }])
    },
    shop: { findUnique: vi.fn().mockResolvedValue({ customerEmailSettings: settings }) }
  };
}
