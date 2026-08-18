import { describe, expect, test, vi } from 'vitest';

import {
  driverDestinationNotesSelect,
  DriverDestinationNotesScopeError,
  PrismaDriverDestinationNotesRepository
} from '../src/modules/driver/driver-destination-notes.repository.js';

const now = new Date('2026-08-18T03:20:00.000Z');
const existing = {
  driverLunchEntryStatus: null,
  driverLunchEntryStatusUpdatedAt: null,
  driverLunchTimeRange: '12:00~13:00',
  driverLunchTimeRangeUpdatedAt: new Date('2026-08-17T01:00:00.000Z'),
  driverMemo: '후문으로 입장',
  driverMemoUpdatedAt: new Date('2026-08-17T02:00:00.000Z'),
  driverRequiredArrivalTime: null,
  driverRequiredArrivalTimeUpdatedAt: null,
  id: 'destination-id'
};

describe('PrismaDriverDestinationNotesRepository', () => {
  test('updates only changed fields and advances only their timestamps', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverDestinationNotesRepository(prisma as never, () => now);

    const result = await repository.update({
      destinationId: 'destination-id',
      driverId: 'driver-id',
      patch: {
        lunchEntryStatus: 'AVAILABLE',
        lunchTimeRange: '12:00~13:00',
        memo: '정문 경비실 호출'
      },
      routePlanId: 'route-plan-id',
      shopId: 'shop-id'
    });

    expect(prisma.routePlanStop.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        deliveryStop: { order: { destinationId: 'destination-id', shopId: 'shop-id' } },
        routePlan: { driverId: 'driver-id', shopId: 'shop-id' },
        routePlanId: 'route-plan-id',
        shopId: 'shop-id'
      }
    }));
    expect(prisma.deliveryCustomerProfile.update).toHaveBeenCalledWith({
      data: {
        driverLunchEntryStatus: 'AVAILABLE',
        driverLunchEntryStatusUpdatedAt: now,
        driverMemo: '정문 경비실 호출',
        driverMemoUpdatedAt: now
      },
      select: driverDestinationNotesSelect,
      where: { id_shopId: { id: 'destination-id', shopId: 'shop-id' } }
    });
    expect(result).toEqual({
      lunchEntryStatus: 'AVAILABLE',
      lunchEntryStatusUpdatedAt: now.toISOString(),
      lunchTimeRange: '12:00~13:00',
      lunchTimeRangeUpdatedAt: '2026-08-17T01:00:00.000Z',
      memo: '정문 경비실 호출',
      memoUpdatedAt: now.toISOString(),
      requiredArrivalTime: null,
      requiredArrivalTimeUpdatedAt: null
    });
  });

  test('returns the current value without writing when the patch is unchanged', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverDestinationNotesRepository(prisma as never, () => now);

    await repository.update({
      destinationId: 'destination-id',
      driverId: 'driver-id',
      patch: { lunchTimeRange: '12:00~13:00', memo: '후문으로 입장' },
      routePlanId: 'route-plan-id',
      shopId: 'shop-id'
    });

    expect(prisma.deliveryCustomerProfile.update).not.toHaveBeenCalled();
  });

  test('rejects destinations outside the authenticated route', async () => {
    const { prisma } = createPrismaHarness({ accessibleDestination: null });
    const repository = new PrismaDriverDestinationNotesRepository(prisma as never, () => now);

    await expect(repository.update({
      destinationId: 'other-destination-id',
      driverId: 'driver-id',
      patch: { memo: '변조 시도' },
      routePlanId: 'route-plan-id',
      shopId: 'shop-id'
    })).rejects.toBeInstanceOf(DriverDestinationNotesScopeError);
    expect(prisma.deliveryCustomerProfile.update).not.toHaveBeenCalled();
  });
});

function createPrismaHarness(input: { accessibleDestination?: typeof existing | null } = {}) {
  const accessibleDestination = input.accessibleDestination === undefined ? existing : input.accessibleDestination;
  const updated = {
    ...existing,
    driverLunchEntryStatus: 'AVAILABLE',
    driverLunchEntryStatusUpdatedAt: now,
    driverMemo: '정문 경비실 호출',
    driverMemoUpdatedAt: now
  };
  return {
    prisma: {
      deliveryCustomerProfile: {
        update: vi.fn(() => Promise.resolve(updated))
      },
      routePlanStop: {
        findFirst: vi.fn(() => Promise.resolve(
          accessibleDestination === null
            ? null
            : { deliveryStop: { order: { destination: accessibleDestination } } }
        ))
      }
    }
  };
}
