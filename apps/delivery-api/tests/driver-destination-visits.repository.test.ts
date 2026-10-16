import { describe, expect, test, vi } from 'vitest';

import {
  DriverDestinationVisitsCursorError,
  DriverDestinationVisitsScopeError,
  PrismaDriverDestinationVisitsRepository,
} from '../src/modules/driver/driver-destination-visits.repository.js';

const profile = {
  canonicalName: '데모 부림약품',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  driverLunchEntryStatus: null, driverLunchEntryStatusUpdatedAt: null,
  driverLunchTimeRange: null, driverLunchTimeRangeUpdatedAt: null,
  driverMemo: null, driverMemoUpdatedAt: null,
  driverOpenTime: null, driverOpenTimeUpdatedAt: null,
  driverRequiredArrivalTime: null, driverRequiredArrivalTimeUpdatedAt: null,
  id: 'destination-id',
  isStoreReviewData: false,
  mergedIntoProfileId: null,
  normalizedAddress: { address: '경기 김포시 고촌읍 아라육로58번길 35-21', name: '데모 부림약품' },
};

const stop = (status: string, occurredAt: string | null, routePlanId: string, boxes: number, instructions: string | null) => ({
  deliveryStop: {
    driverEvents: occurredAt === null ? [] : [{ occurredAt: new Date(occurredAt), routePlanId }],
    instructions,
    order: { rawPayload: { dsv: { normalized: { shippedBoxes: boxes } } } },
    status,
  },
});

const routes = [
  {
    id: 'route-17', name: '#606', planDate: new Date('2026-10-17T00:00:00.000Z'),
    routeStops: [stop('DELIVERED', '2026-10-17T07:09:00.000Z', 'route-17', 3, '후문'), stop('DELIVERED', '2026-10-17T07:10:00.000Z', 'route-17', 4, '후문')],
  },
  {
    id: 'route-16', name: '#605', planDate: new Date('2026-10-16T00:00:00.000Z'),
    routeStops: [stop('DELIVERED', '2026-10-16T06:35:00.000Z', 'route-16', 2, null), stop('FAILED', null, 'route-16', 1, '부재')],
  },
];

const revisions = [
  { changedAt: new Date('2026-10-01T00:00:00.000Z'), driverId: null, field: 'memo', routePlanId: null, source: 'LEGACY', value: '정문 경비실' },
  { changedAt: new Date('2026-10-17T07:05:00.000Z'), driverId: 'driver-id', field: 'memo', routePlanId: 'route-17', source: 'DRIVER', value: '후문으로 변경' },
  { changedAt: new Date('2026-10-17T07:06:00.000Z'), driverId: 'driver-id', field: 'openTime', routePlanId: 'route-17', source: 'DRIVER', value: '08:30' },
];

function harness(input: { driver?: unknown; routePlans?: unknown[] } = {}) {
  const prisma = {
    deliveryCustomerProfile: {
      findMany: vi.fn((args: { where: { mergedIntoProfileId: unknown } }) => Promise.resolve(
        args.where.mergedIntoProfileId === null ? [profile] : [],
      )),
    },
    destinationNoteRevision: { findMany: vi.fn(() => Promise.resolve(revisions)) },
    driver: { findFirst: vi.fn(() => Promise.resolve(input.driver === undefined ? { isStoreReviewData: false } : input.driver)) },
    routePlan: { findMany: vi.fn(() => Promise.resolve(input.routePlans ?? routes)) },
  };
  return { prisma, repository: new PrismaDriverDestinationVisitsRepository(prisma as never) };
}

const listInput = { cursor: null, destinationId: 'destination-id', driverId: 'driver-id', shopId: 'shop-id' };

describe('PrismaDriverDestinationVisitsRepository', () => {
  test('lists the driver own visits newest first with the notes of each visit', async () => {
    const { prisma, repository } = harness();
    const result = await repository.list(listInput);

    const scopeMatcher: unknown = expect.objectContaining({ driverId: 'driver-id', isStoreReviewData: false, shopId: 'shop-id' });
    expect(prisma.routePlan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ planDate: 'desc' }, { id: 'desc' }],
      take: 21,
      where: scopeMatcher,
    }));
    expect(result).toEqual({
      nextCursor: null,
      visits: [
        {
          boxCount: 7, changedFields: ['memo', 'openTime'], deliveryDate: '2026-10-17',
          notes: { lunchEntryStatus: null, lunchTimeRange: null, memo: '후문으로 변경', openTime: '08:30', requiredArrivalTime: null },
          orderCount: 2, orderNotes: ['후문'], outcome: 'DELIVERED', routeName: '#606', routePlanId: 'route-17',
          visitedAt: '2026-10-17T07:10:00.000Z',
        },
        {
          boxCount: 3, changedFields: [], deliveryDate: '2026-10-16',
          notes: { lunchEntryStatus: null, lunchTimeRange: null, memo: '정문 경비실', openTime: null, requiredArrivalTime: null },
          orderCount: 2, orderNotes: ['부재'], outcome: 'PARTIAL', routeName: '#605', routePlanId: 'route-16',
          visitedAt: '2026-10-16T06:35:00.000Z',
        },
      ],
    });
  });

  test('pages by plan date and id with a cursor that round-trips', async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      ...routes[1]!, id: `route-${String(100 - index)}`, planDate: new Date(Date.UTC(2026, 8, 30 - index)),
    }));
    const first = await harness({ routePlans: many }).repository.list(listInput);
    expect(first.visits).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();

    const { prisma, repository } = harness({ routePlans: [] });
    await repository.list({ ...listInput, cursor: first.nextCursor });
    const cursorMatcher: unknown = expect.objectContaining({ OR: [
      { planDate: { lt: many[19]!.planDate } },
      { id: { lt: many[19]!.id }, planDate: many[19]!.planDate },
    ] });
    expect(prisma.routePlan.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: cursorMatcher }));
    await expect(repository.list({ ...listInput, cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(DriverDestinationVisitsCursorError);
  });

  test('refuses a destination of the other review classification or an unknown driver', async () => {
    await expect(harness({ driver: { isStoreReviewData: true } }).repository.list(listInput))
      .rejects.toBeInstanceOf(DriverDestinationVisitsScopeError);
    await expect(harness({ driver: null }).repository.list(listInput))
      .rejects.toBeInstanceOf(DriverDestinationVisitsScopeError);
  });
});
