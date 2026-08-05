import { describe, expect, test, vi } from 'vitest';

import {
  DriverEventScopeError,
  PrismaDriverEventRepository,
} from '../src/modules/driver/driver-event.repository.js';

const input = {
  clientEventId: 'destination-1:delivered:1',
  deliveryStopIds: ['stop-1', 'stop-2'],
  destinationId: 'destination-1',
  driverId: 'driver-1',
  occurredAt: new Date('2026-08-05T03:00:00.000Z'),
  payload: { deliveryStopIds: ['stop-1', 'stop-2'] },
  routePlanId: 'route-1',
  shopDomain: 'dsv.example.test',
  shopId: 'shop-1',
};

describe('Driver destination completion repository', () => {
  test('records one idempotent STOP_DELIVERED event for every validated order stop', async () => {
    const prisma = {
      deliveryStop: { findMany: vi.fn().mockResolvedValue([{ id: 'stop-1' }, { id: 'stop-2' }]) },
    };
    const repository = new PrismaDriverEventRepository(prisma as never);
    const recordDriverEvent = vi.spyOn(repository, 'recordDriverEvent')
      .mockResolvedValueOnce({ duplicate: false, eventId: 'event-1' })
      .mockResolvedValueOnce({ duplicate: false, eventId: 'event-2' });

    await expect(repository.completeDeliveryDestination(input)).resolves.toHaveLength(2);
    expect(recordDriverEvent).toHaveBeenCalledTimes(2);
    expect(recordDriverEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      clientEventId: 'destination-1:delivered:1:stop-1',
      deliveryStopId: 'stop-1',
      eventType: 'STOP_DELIVERED',
    }));
    expect(recordDriverEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      clientEventId: 'destination-1:delivered:1:stop-2',
      deliveryStopId: 'stop-2',
      eventType: 'STOP_DELIVERED',
    }));
  });

  test('rejects the whole request before recording when a stop is outside the destination', async () => {
    const repository = new PrismaDriverEventRepository({
      deliveryStop: { findMany: vi.fn().mockResolvedValue([{ id: 'stop-1' }]) },
    } as never);
    const recordDriverEvent = vi.spyOn(repository, 'recordDriverEvent');

    await expect(repository.completeDeliveryDestination(input))
      .rejects.toBeInstanceOf(DriverEventScopeError);
    expect(recordDriverEvent).not.toHaveBeenCalled();
  });
});
