import { describe, expect, test, vi } from 'vitest';

import {
  buildCanonicalDestinationProjection,
  driverDestinationNotesSelect,
  DriverDestinationNotesScopeError,
  PrismaDriverDestinationNotesRepository
} from '../src/modules/driver/driver-destination-notes.repository.js';

const now = new Date('2026-08-18T03:20:00.000Z');
const existing = {
  canonicalName: '거래처 A',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  driverLunchEntryStatus: null,
  driverLunchEntryStatusUpdatedAt: null,
  driverLunchTimeRange: '12:00~13:00',
  driverLunchTimeRangeUpdatedAt: new Date('2026-08-17T01:00:00.000Z'),
  driverMemo: '후문으로 입장',
  driverMemoUpdatedAt: new Date('2026-08-17T02:00:00.000Z'),
  driverOpenTime: null,
  driverOpenTimeUpdatedAt: null,
  driverRequiredArrivalTime: null,
  driverRequiredArrivalTimeUpdatedAt: null,
  id: 'destination-id'
  ,isStoreReviewData: false,
  mergedIntoProfileId: null,
  normalizedAddress: { address: '서울시 강남구 1', detailAddress: '101호', name: '거래처 A' }
};

describe('PrismaDriverDestinationNotesRepository', () => {
  test('updates the oldest canonical profile through a legacy duplicate id and preserves the value for future reuse', async () => {
    const legacy = {
      ...existing,
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      driverMemo: 'legacy memo',
      driverMemoUpdatedAt: new Date('2026-08-18T00:00:00.000Z'),
      id: 'legacy-id'
    };
    const { prisma } = createPrismaHarness({ profiles: [existing, legacy] });
    const repository = new PrismaDriverDestinationNotesRepository(prisma as never, () => now);
    const result = await repository.update({
      destinationId: 'legacy-id', driverId: 'driver-id', patch: { memo: 'future memo' },
      routePlanId: 'route-plan-id', shopId: 'shop-id'
    });

    expect(prisma.deliveryCustomerProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id_shopId: { id: 'destination-id', shopId: 'shop-id' } }
    }));
    expect(result.memo).toBe('future memo');
  });

  test('keeps a canonical null tombstone from reviving an older duplicate value', async () => {
    const legacy = { ...existing, createdAt: new Date('2026-08-02T00:00:00.000Z'), id: 'legacy-id' };
    const { prisma } = createPrismaHarness({ profiles: [existing, legacy] });
    const repository = new PrismaDriverDestinationNotesRepository(prisma as never, () => now);
    const result = await repository.update({
      destinationId: 'legacy-id', driverId: 'driver-id', patch: { memo: null },
      routePlanId: 'route-plan-id', shopId: 'shop-id'
    });
    expect(result.memo).toBeNull();
    expect(result.memoUpdatedAt).toBe(now.toISOString());
  });

  test('does not collapse same-name/different-address or same-address/different-name profiles', () => {
    const projections = buildCanonicalDestinationProjection([
      existing,
      { ...existing, id: 'different-address', normalizedAddress: { ...existing.normalizedAddress, address: '서울시 강남구 2' } },
      { ...existing, canonicalName: '거래처 B', id: 'different-name' }
    ]);
    expect(projections.get('destination-id')?.memberIds).toEqual(['destination-id']);
    expect(projections.get('different-address')?.destinationId).toBe('different-address');
    expect(projections.get('different-name')?.destinationId).toBe('different-name');
  });

  test('updates only changed fields and advances only their timestamps', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaDriverDestinationNotesRepository(prisma as never, () => now);

    const result = await repository.update({
      destinationId: 'destination-id',
      driverId: 'driver-id',
      patch: {
        lunchEntryStatus: 'AVAILABLE',
        lunchTimeRange: '12:00~13:00',
        memo: '정문 경비실 호출',
        openTime: '08:30'
      },
      routePlanId: 'route-plan-id',
      shopId: 'shop-id'
    });

    expect(prisma.routePlanStop.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        deliveryStop: { order: { destinationId: { in: ['destination-id'] }, shopId: 'shop-id' } },
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
        driverMemoUpdatedAt: now,
        driverOpenTime: '08:30',
        driverOpenTimeUpdatedAt: now
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
      openTime: '08:30',
      openTimeUpdatedAt: now.toISOString(),
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

function createPrismaHarness(input: {
  accessibleDestination?: typeof existing | null;
  profiles?: typeof existing[];
} = {}) {
  const accessibleDestination = input.accessibleDestination === undefined ? existing : input.accessibleDestination;
  const updated = {
    ...existing,
    driverLunchEntryStatus: 'AVAILABLE',
    driverLunchEntryStatusUpdatedAt: now,
    driverMemo: '정문 경비실 호출',
    driverMemoUpdatedAt: now,
    driverOpenTime: '08:30',
    driverOpenTimeUpdatedAt: now
  };
  return {
    prisma: {
      deliveryCustomerProfile: {
        findMany: vi.fn(() => Promise.resolve(input.profiles ?? [existing])),
        update: vi.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...updated, ...data }))
      },
      routePlanStop: {
        findFirst: vi.fn(() => Promise.resolve(
          accessibleDestination === null
            ? null
            : { deliveryStop: { order: { destinationId: accessibleDestination.id } } }
        ))
      }
    }
  };
}
