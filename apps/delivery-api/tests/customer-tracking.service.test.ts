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

function harness(stop: unknown, driverEvent: unknown = null) {
  const prisma = {
    deliveryStop: { findUnique: vi.fn().mockResolvedValue(stop) },
    driverEvent: { findFirst: vi.fn().mockResolvedValue(driverEvent) },
  };
  return { prisma, service: new CustomerTrackingService(prisma) };
}

describe('CustomerTrackingService', () => {
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
    });
    expect(prisma.driverEvent.findFirst).not.toHaveBeenCalled();
  });

  test('shows the latest driver location only within the nearby-stops threshold', async () => {
    const location = { latitude: '37.51', longitude: '127.01', occurredAt: new Date('2026-10-14T02:58:00.000Z') };
    const near = harness(stopRow({ otherStops: [{ sequence: 1, status: 'DELIVERED' }], routeStatus: 'IN_PROGRESS' }), location);
    const far = harness(stopRow({ routeStatus: 'IN_PROGRESS', sequence: 9 }), location);

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
});
