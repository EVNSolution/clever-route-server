import { describe, expect, test, vi } from 'vitest';

import { defaultCustomerEmailSettings } from '../src/modules/customer-email/customer-email-settings.js';
import { persistAutomaticCustomerEmailFacts } from '../src/modules/customer-email/customer-email-automatic-fact.js';

const occurredAt = new Date('2026-08-29T14:30:00.000Z');

type AutomaticFactRow = {
  deliveryStopId: string;
  idempotencyKey: string;
  [key: string]: unknown;
};

type AutomaticFactCreateManyInput = {
  data: AutomaticFactRow[];
  skipDuplicates: boolean;
};

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
        metadata: expect.objectContaining({ driverEventId: 'event-id', routeEmailSelected: true, signal: 'DELIVERED' }) as unknown,
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

  test('creates no fact for a route without a Dispatch email selection', async () => {
    const settings = defaultCustomerEmailSettings();
    settings.automatic.enabled = true;
    settings.senderEmail = 'dispatch@example.test';
    const prisma = harness(settings, 'customer@example.test', {});

    await expect(persistAutomaticCustomerEmailFacts(prisma as never, event())).resolves.toBe(0);
    expect(prisma.customerRouteNotificationFact.createMany).not.toHaveBeenCalled();
  });

  test('creates no fact when the stop or the signal was not selected at Dispatch', async () => {
    const settings = defaultCustomerEmailSettings();
    settings.automatic.enabled = true;
    settings.senderEmail = 'dispatch@example.test';

    const otherStop = harness(settings, 'customer@example.test', selectedConstraints({ deliveryStopIds: ['other-stop-id'] }));
    await expect(persistAutomaticCustomerEmailFacts(otherStop as never, event())).resolves.toBe(0);
    const otherSignal = harness(settings, 'customer@example.test', selectedConstraints({ signals: ['DELIVERY_SCHEDULED'] }));
    await expect(persistAutomaticCustomerEmailFacts(otherSignal as never, event())).resolves.toBe(0);

    expect(otherStop.customerRouteNotificationFact.createMany).not.toHaveBeenCalled();
    expect(otherSignal.customerRouteNotificationFact.createMany).not.toHaveBeenCalled();
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

  test('queues Nearby for every remaining stop within the configured threshold', async () => {
    const settings = enabledSettings();
    const prisma = harness(settings, 'customer@example.test', selectedConstraints({
      deliveryStopIds: ['stop-1', 'stop-2', 'stop-3', 'stop-4'],
      signals: ['DRIVER_NEARBY'],
    }), routeStops([
      ['stop-1', 'ARRIVED'],
      ['stop-2', 'PENDING'],
      ['stop-3', 'PENDING'],
      ['stop-4', 'PENDING'],
    ]));

    await expect(persistAutomaticCustomerEmailFacts(prisma as never, event({
      deliveryStopId: 'stop-1',
      eventType: 'STOP_ARRIVED',
    }))).resolves.toBe(3);

    expect(prisma.customerRouteNotificationFact.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ deliveryStopId: 'stop-2', idempotencyKey: 'route-progress:route-id:DRIVER_NEARBY:stop-2' }),
        expect.objectContaining({ deliveryStopId: 'stop-3', idempotencyKey: 'route-progress:route-id:DRIVER_NEARBY:stop-3' }),
        expect.objectContaining({
          deliveryStopId: 'stop-4',
          idempotencyKey: 'route-progress:route-id:DRIVER_NEARBY:stop-4',
          metadata: expect.objectContaining({ signal: 'DRIVER_NEARBY', sourceEventType: 'STOP_ARRIVED' }) as unknown,
          orderId: 'order-stop-4',
        }),
      ],
      skipDuplicates: true,
    });
  });

  test('queues Nearby for all route-start stops when fewer than the threshold remain', async () => {
    const settings = enabledSettings();
    const prisma = harness(settings, 'customer@example.test', selectedConstraints({
      deliveryStopIds: ['stop-1', 'stop-2'],
      signals: ['DRIVER_NEARBY'],
    }), routeStops([
      ['stop-1', 'PENDING'],
      ['stop-2', 'PENDING'],
    ]));

    await expect(persistAutomaticCustomerEmailFacts(prisma as never, event({
      deliveryStopId: null,
      eventType: 'ROUTE_STARTED',
    }))).resolves.toBe(2);

    expect(prisma.customerRouteNotificationFact.createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({ deliveryStopId: 'stop-1' }),
      expect.objectContaining({ deliveryStopId: 'stop-2' }),
    ]);
  });

  test('advances Nearby by pending route order and excludes terminal stops', async () => {
    const settings = enabledSettings();
    const prisma = harness(settings, 'customer@example.test', selectedConstraints({
      deliveryStopIds: ['stop-1', 'stop-2', 'stop-3', 'stop-4', 'stop-5'],
      signals: ['DRIVER_NEARBY', 'DELIVERED'],
    }), routeStops([
      ['stop-1', 'DELIVERED'],
      ['stop-2', 'FAILED'],
      ['stop-3', 'PENDING'],
      ['stop-4', 'PENDING'],
      ['stop-5', 'PENDING'],
    ]));

    await expect(persistAutomaticCustomerEmailFacts(prisma as never, event({
      deliveryStopId: 'stop-1',
      eventType: 'STOP_DELIVERED',
    }))).resolves.toBe(4);

    const rows = prisma.customerRouteNotificationFact.createMany.mock.calls[0]?.[0].data;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ deliveryStopId: 'stop-1', idempotencyKey: 'driver-event:event-id:DELIVERED:stop-1' }),
      expect.objectContaining({ deliveryStopId: 'stop-3', idempotencyKey: 'route-progress:route-id:DRIVER_NEARBY:stop-3' }),
      expect.objectContaining({ deliveryStopId: 'stop-4', idempotencyKey: 'route-progress:route-id:DRIVER_NEARBY:stop-4' }),
      expect.objectContaining({ deliveryStopId: 'stop-5', idempotencyKey: 'route-progress:route-id:DRIVER_NEARBY:stop-5' }),
    ]));
  });

  test('ignores pending stops behind progress and reuses the route-stop Nearby key', async () => {
    const settings = enabledSettings();
    const constraints = selectedConstraints({
      deliveryStopIds: ['stop-1', 'stop-2', 'stop-3', 'stop-4', 'stop-5'],
      signals: ['DRIVER_NEARBY'],
    });
    const arrived = harness(settings, 'customer@example.test', constraints, routeStops([
      ['stop-1', 'PENDING'],
      ['stop-2', 'ARRIVED'],
      ['stop-3', 'PENDING'],
      ['stop-4', 'PENDING'],
      ['stop-5', 'PENDING'],
    ]));
    const delivered = harness(settings, 'customer@example.test', constraints, routeStops([
      ['stop-1', 'PENDING'],
      ['stop-2', 'DELIVERED'],
      ['stop-3', 'PENDING'],
      ['stop-4', 'PENDING'],
      ['stop-5', 'PENDING'],
    ]));

    await persistAutomaticCustomerEmailFacts(arrived as never, event({ deliveryStopId: 'stop-2', eventType: 'STOP_ARRIVED' }));
    await persistAutomaticCustomerEmailFacts(delivered as never, event({ deliveryStopId: 'stop-2', eventType: 'STOP_DELIVERED' }));

    const arrivedRows = arrived.customerRouteNotificationFact.createMany.mock.calls[0]?.[0].data ?? [];
    const deliveredRows = delivered.customerRouteNotificationFact.createMany.mock.calls[0]?.[0].data ?? [];
    expect(arrivedRows.map((row: { idempotencyKey: string }) => row.idempotencyKey)).toEqual([
      'route-progress:route-id:DRIVER_NEARBY:stop-3',
      'route-progress:route-id:DRIVER_NEARBY:stop-4',
      'route-progress:route-id:DRIVER_NEARBY:stop-5',
    ]);
    expect(deliveredRows.map((row: { idempotencyKey: string }) => row.idempotencyKey)).toEqual(
      arrivedRows.map((row: { idempotencyKey: string }) => row.idempotencyKey),
    );
  });

  test('includes a late-added stop only for ALL_ELIGIBLE selection mode', async () => {
    const settings = enabledSettings();
    const lateStop = routeStops([['late-stop', 'DELIVERED']]);
    const allEligible = harness(settings, 'customer@example.test', selectedConstraints({
      deliveryStopIds: ['original-stop'],
      mode: 'ALL_ELIGIBLE',
      signals: ['DELIVERED'],
    }), lateStop);
    const legacyExplicit = harness(settings, 'customer@example.test', selectedConstraints({
      deliveryStopIds: ['original-stop'],
      signals: ['DELIVERED'],
    }), lateStop);
    const lateEvent = event({ deliveryStopId: 'late-stop', eventType: 'STOP_DELIVERED' });

    await expect(persistAutomaticCustomerEmailFacts(allEligible as never, lateEvent)).resolves.toBe(1);
    await expect(persistAutomaticCustomerEmailFacts(legacyExplicit as never, lateEvent)).resolves.toBe(0);

    expect(allEligible.customerRouteNotificationFact.createMany).toHaveBeenCalledOnce();
    expect(legacyExplicit.customerRouteNotificationFact.createMany).not.toHaveBeenCalled();
  });

  test('does not queue automatic Scheduled even when a legacy selection contains it', async () => {
    const settings = enabledSettings();
    const prisma = harness(settings, 'customer@example.test', selectedConstraints({ signals: ['DELIVERY_SCHEDULED'] }));

    await expect(persistAutomaticCustomerEmailFacts(prisma as never, event({ eventType: 'DELIVERY_SCHEDULED' }))).resolves.toBe(0);
    expect(prisma.customerRouteNotificationFact.createMany).not.toHaveBeenCalled();
  });
});

function event(overrides: { deliveryStopId?: string | null; eventType?: string } = {}) {
  return {
    deliveryStopId: overrides.deliveryStopId === undefined ? 'stop-id' : overrides.deliveryStopId,
    driverEventId: 'event-id',
    eventType: overrides.eventType ?? 'STOP_DELIVERED',
    occurredAt,
    routePlanId: 'route-id',
    shopId: 'shop-id'
  };
}

function harness(
  settings: unknown,
  email: string | null = 'customer@example.test',
  constraints: unknown = selectedConstraints(),
  routeStopsValue?: ReturnType<typeof routeStops>,
) {
  const selectedRouteStops = routeStopsValue ?? [{
    deliveryStop: { id: 'stop-id', order: { email, id: 'order-id' }, status: 'DELIVERED' },
    sequence: 1,
  }];
  return {
    routePlan: { findFirst: vi.fn().mockResolvedValue({ constraints, driverEvents: [{ id: 'route-start' }], routeStops: selectedRouteStops }) },
    customerRouteNotificationFact: {
      createMany: vi.fn<(input: AutomaticFactCreateManyInput) => Promise<{ count: number }>>()
        .mockImplementation(({ data }) => Promise.resolve({ count: data.length }))
    },
    deliveryStop: {
      findMany: vi.fn().mockResolvedValue([{ id: 'stop-id', order: { email, id: 'order-id' } }])
    },
    shop: { findUnique: vi.fn().mockResolvedValue({ customerEmailSettings: settings, routeOpsUiSettings: { nearbyStopsThreshold: 3, version: 1 } }) }
  };
}

function enabledSettings() {
  const settings = defaultCustomerEmailSettings();
  settings.automatic.enabled = true;
  settings.senderEmail = 'dispatch@example.test';
  return settings;
}

function routeStops(stops: Array<[string, string]>) {
  return stops.map(([id, status], index) => ({
    deliveryStop: { id, order: { email: `customer-${id}@example.test`, id: `order-${id}` }, status },
    sequence: index + 1,
  }));
}

function selectedConstraints(overrides: { deliveryStopIds?: string[]; mode?: 'ALL_ELIGIBLE' | 'EXPLICIT'; signals?: string[] } = {}) {
  return {
    customerEmailSelection: {
      deliveryStopIds: overrides.deliveryStopIds ?? ['stop-id'],
      ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
      signals: overrides.signals ?? ['DELIVERED'],
      updatedAt: '2026-08-29T14:00:00.000Z',
      updatedBy: 'office'
    }
  };
}
