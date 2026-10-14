import { describe, expect, test, vi } from 'vitest';

import { defaultCustomerEmailSettings } from '../src/modules/customer-email/customer-email-settings.js';
import { CustomerTrackingService } from '../src/modules/customer-tracking/customer-tracking.service.js';

const NOW = new Date('2026-10-14T03:00:00.000Z');

function stopRow(input: {
  deliveryDate?: Date | null;
  otherStops?: Array<{ sequence: number; status: string }>;
  routeStatus?: string | null;
  sequence?: number;
  status?: string;
} = {}) {
  const sequence = input.sequence ?? 3;
  return {
    address1: '1 Market St',
    address2: null,
    city: 'Seoul',
    deliveryDate: input.deliveryDate ?? new Date('2026-10-14T00:00:00.000Z'),
    latitude: '37.5',
    longitude: '127.0',
    order: { name: '#2368', orderItems: [{ name: 'Kimchi', quantity: 2 }] },
    postalCode: '04524',
    province: null,
    recipientName: ' Mina Park ',
    routePlanStops: input.routeStatus === null ? [] : [{
      createdAt: new Date('2026-10-13T22:00:00.000Z'),
      estimatedArrivalAt: new Date('2026-10-14T05:00:00.000Z'),
      routePlan: {
        constraints: { timezone: 'Asia/Seoul' },
        id: 'route-1',
        planDate: new Date('2026-10-14T00:00:00.000Z'),
        routeStops: [
          ...(input.otherStops ?? []).map((stop) => ({ deliveryStop: { status: stop.status }, sequence: stop.sequence })),
          { deliveryStop: { status: input.status ?? 'PENDING' }, sequence },
        ],
        status: input.routeStatus ?? 'READY',
      },
      sequence,
    }],
    shop: {
      commerceConnections: [],
      customerEmailSettings: { ...defaultCustomerEmailSettings(), etaWindow: { direction: 'AFTER', minutes: 60 }, senderName: 'K-Food' },
      routeOpsUiSettings: null,
    },
    shopId: 'shop-1',
    status: input.status ?? 'PENDING',
  };
}

function harness(stop: unknown, driverEvent: unknown = null, timelineEvents: unknown[] = [], nearbyFact: unknown = null) {
  const prisma = {
    customerRouteNotificationFact: { findFirst: vi.fn().mockResolvedValue(nearbyFact) },
    deliveryStop: { findUnique: vi.fn().mockResolvedValue(stop) },
    driverEvent: { findFirst: vi.fn().mockResolvedValue(driverEvent), findMany: vi.fn().mockResolvedValue(timelineEvents) },
  };
  return { prisma, service: new CustomerTrackingService(prisma) };
}

describe('CustomerTrackingService', () => {
  test('returns a timestamped delivery timeline without depending on a map or email delivery', async () => {
    const { prisma, service } = harness(stopRow({ routeStatus: 'COMPLETED', status: 'DELIVERED' }), null, [
      { eventType: 'ROUTE_STARTED', occurredAt: new Date('2026-10-14T00:00:00.000Z') },
      { eventType: 'STOP_DELIVERED', occurredAt: new Date('2026-10-14T02:00:00.000Z') },
    ], { occurredAt: new Date('2026-10-14T01:00:00.000Z') });

    await expect(service.getStatus('stop-1', NOW)).resolves.toMatchObject({
      driver: null,
      timeline: [
        { kind: 'SCHEDULED', occurredAt: '2026-10-13T22:00:00.000Z', state: 'COMPLETED' },
        { kind: 'OUT_FOR_DELIVERY', occurredAt: '2026-10-14T00:00:00.000Z', state: 'COMPLETED' },
        { kind: 'DRIVER_NEARBY', occurredAt: '2026-10-14T01:00:00.000Z', state: 'COMPLETED' },
        { kind: 'DELIVERED', occurredAt: '2026-10-14T02:00:00.000Z', state: 'CURRENT' },
      ],
    });
    expect(prisma.driverEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ routePlanId: 'route-1', shopId: 'shop-1' }) as unknown,
    }));
    expect(prisma.customerRouteNotificationFact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ idempotencyKey: 'route-progress:route-1:DRIVER_NEARBY:stop-1' }) as unknown,
    }));
  });

  test('keeps missed delivery separate and never manufactures a delivered event or timestamp', async () => {
    const { service } = harness(stopRow({ routeStatus: 'IN_PROGRESS', status: 'FAILED' }), null, [
      { eventType: 'STOP_FAILED', occurredAt: new Date('2026-10-14T02:30:00.000Z') },
    ]);
    const status = await service.getStatus('stop-1', NOW);
    expect(status).toMatchObject({ stage: 'MISSED', timeline: expect.arrayContaining([
      { kind: 'OUT_FOR_DELIVERY', occurredAt: null, state: 'NOT_RECORDED' },
      { kind: 'DRIVER_NEARBY', occurredAt: null, state: 'NOT_RECORDED' },
      { kind: 'MISSED', occurredAt: '2026-10-14T02:30:00.000Z', state: 'CURRENT' },
    ]) as unknown });
    expect(status?.timeline.some((entry) => entry.kind === 'DELIVERED')).toBe(false);
  });

  test('shows current Nearby without inventing its time when automatic email is off', async () => {
    const { service } = harness(stopRow({ routeStatus: 'IN_PROGRESS', sequence: 3 }));
    await expect(service.getStatus('stop-1', NOW)).resolves.toMatchObject({ timeline: expect.arrayContaining([
      { kind: 'DRIVER_NEARBY', occurredAt: null, state: 'CURRENT' },
      { kind: 'DELIVERED', occurredAt: null, state: 'UPCOMING' },
    ]) as unknown });
  });

  test('counts remaining stops instead of sequence gaps and ignores cancelled or skipped stops for Nearby', async () => {
    const { prisma, service } = harness(stopRow({
      otherStops: [
        { sequence: 2, status: 'ARRIVED' },
        { sequence: 4, status: 'CANCELLED' },
        { sequence: 8, status: 'PENDING' },
        { sequence: 10, status: 'SKIPPED' },
        { sequence: 15, status: 'PENDING' },
      ],
      routeStatus: 'IN_PROGRESS',
      sequence: 20,
    }));

    await expect(service.getStatus('stop-1', NOW)).resolves.toMatchObject({
      stopsAway: 3,
      timeline: expect.arrayContaining([{ kind: 'DRIVER_NEARBY', occurredAt: null, state: 'CURRENT' }]) as unknown,
    });
    expect(prisma.deliveryStop.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        routePlanStops: expect.objectContaining({
          select: expect.objectContaining({
            routePlan: expect.objectContaining({
              select: expect.objectContaining({
                routeStops: expect.objectContaining({ orderBy: { sequence: 'asc' } }) as unknown,
              }) as unknown,
            }) as unknown,
          }) as unknown,
        }) as unknown,
      }) as unknown,
    }));
  });
  test('shows a preparing stop with the configured ETA window and items, without the driver', async () => {
    const { prisma, service } = harness(stopRow());

    await expect(service.getStatus('stop-1', NOW)).resolves.toEqual({
      address: '1 Market St, Seoul, 04524',
      destination: { latitude: 37.5, longitude: 127 },
      driver: null,
      etaWindow: { end: '2026-10-14T06:00:00.000Z', start: '2026-10-14T05:00:00.000Z' },
      items: [{ name: 'Kimchi', quantity: 2 }],
      orderName: '#2368',
      recipientName: 'Mina Park',
      stage: 'PREPARING',
      stopsAway: null,
      storeName: 'K-Food',
      timezone: 'Asia/Seoul',
      timeline: [
        { kind: 'SCHEDULED', occurredAt: '2026-10-13T22:00:00.000Z', state: 'CURRENT' },
        { kind: 'OUT_FOR_DELIVERY', occurredAt: null, state: 'UPCOMING' },
        { kind: 'DRIVER_NEARBY', occurredAt: null, state: 'UPCOMING' },
        { kind: 'DELIVERED', occurredAt: null, state: 'UPCOMING' },
      ],
    });
    expect(prisma.driverEvent.findFirst).not.toHaveBeenCalled();
  });

  test('shows the latest driver location only within the nearby-stops threshold', async () => {
    const location = { latitude: '37.51', longitude: '127.01', occurredAt: new Date('2026-10-14T02:58:00.000Z') };
    const near = harness(stopRow({ otherStops: [{ sequence: 1, status: 'DELIVERED' }, { sequence: 2, status: 'PENDING' }], routeStatus: 'IN_PROGRESS' }), location);
    const far = harness(stopRow({
      otherStops: Array.from({ length: 8 }, (_, index) => ({ sequence: index + 1, status: 'PENDING' })),
      routeStatus: 'IN_PROGRESS', sequence: 9,
    }), location);

    await expect(near.service.getStatus('stop-1', NOW)).resolves.toMatchObject({
      driver: { latitude: 37.51, longitude: 127.01, updatedAt: '2026-10-14T02:58:00.000Z' },
      stage: 'ON_THE_WAY',
      stopsAway: 2,
    });
    expect(near.prisma.driverEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ occurredAt: { gte: new Date('2026-10-14T02:50:00.000Z') }, routePlanId: 'route-1', shopId: 'shop-1' }) as unknown,
    }));
    await expect(far.service.getStatus('stop-1', NOW)).resolves.toMatchObject({ driver: null, stage: 'ON_THE_WAY', stopsAway: 9 });
    expect(far.prisma.driverEvent.findFirst).not.toHaveBeenCalled();
  });

  test.each([
    ['DELIVERED', 'DELIVERED'],
    ['FAILED', 'MISSED'],
    ['SKIPPED', 'MISSED'],
    ['CANCELLED', 'CANCELLED'],
  ] as const)('maps a %s stop to %s without an ETA window', async (status, stage) => {
    const { service } = harness(stopRow({ routeStatus: 'IN_PROGRESS', status }));

    await expect(service.getStatus('stop-1', NOW)).resolves.toMatchObject({ driver: null, etaWindow: null, stage });
  });

  test('expires links 14 days after the service date and hides unknown stops', async () => {
    const old = harness(stopRow({ deliveryDate: new Date('2026-09-01T00:00:00.000Z'), routeStatus: null }));

    await expect(old.service.getStatus('stop-1', NOW)).resolves.toBeNull();
    await expect(harness(null).service.getStatus('missing', NOW)).resolves.toBeNull();
  });

  test('retains a recorded missed attempt before a later successful delivery', async () => {
    const { service } = harness(stopRow({ routeStatus: 'COMPLETED', status: 'DELIVERED' }), null, [
      { eventType: 'STOP_FAILED', occurredAt: new Date('2026-10-14T01:00:00.000Z') },
      { eventType: 'STOP_DELIVERED', occurredAt: new Date('2026-10-14T02:30:00.000Z') },
    ]);
    const status = await service.getStatus('stop-1', NOW);
    expect(status?.timeline.slice(-2)).toEqual([
      { kind: 'MISSED', occurredAt: '2026-10-14T01:00:00.000Z', state: 'COMPLETED' },
      { kind: 'DELIVERED', occurredAt: '2026-10-14T02:30:00.000Z', state: 'CURRENT' },
    ]);
  });

  test('does not use an estimated arrival or a row update as a missing completion timestamp', async () => {
    const { service } = harness(stopRow({ status: 'DELIVERED' }));
    const status = await service.getStatus('stop-1', NOW);
    expect(status?.timeline.at(-1)).toEqual({ kind: 'DELIVERED', occurredAt: null, state: 'CURRENT' });
  });
});
