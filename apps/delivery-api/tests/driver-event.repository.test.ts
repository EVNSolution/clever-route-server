import { describe, expect, test, vi } from 'vitest';

import { PrismaDriverEventRepository } from '../src/modules/driver/driver-event.repository.js';

const occurredAt = new Date('2026-06-01T05:54:16.000Z');

describe('PrismaDriverEventRepository', () => {
  test('records driver events for Woo customer-domain shops', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverEventRepository(prisma as never);

    await expect(repository.recordDriverEvent({
      clientEventId: 'client-event-id',
      deliveryStopId: 'stop-id',
      driverId: 'driver-id',
      eventType: 'LOCATION_UPDATED',
      latitude: '43.6532',
      longitude: '-79.3832',
      occurredAt,
      payload: { source: 'driver-app' },
      routePlanId: 'route-plan-id',
      shopDomain: 'https://Dev1.TomatonoFood.com/admin'
    })).resolves.toEqual({ duplicate: false, eventId: 'driver-event-id' });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { shopDomain: 'dev1.tomatonofood.com' } });
    expect(prisma.driverEvent.create).toHaveBeenCalledWith({
      data: {
        clientEventId: 'client-event-id',
        deliveryStopId: 'stop-id',
        driverId: 'driver-id',
        eventType: 'LOCATION_UPDATED',
        latitude: '43.6532',
        longitude: '-79.3832',
        occurredAt,
        payload: { source: 'driver-app' },
        routePlanId: 'route-plan-id',
        shopId: 'shop-id'
      }
    });
  });
});

function createPrismaHarness() {
  return {
    prisma: {
      driver: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'driver-id', shopId: 'shop-id' }))
      },
      driverEvent: {
        create: vi.fn(() => Promise.resolve({ id: 'driver-event-id' }))
      },
      shop: {
        findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
      }
    }
  };
}
