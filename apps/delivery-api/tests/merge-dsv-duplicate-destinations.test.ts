import { describe, expect, test, vi } from 'vitest';

import {
  applyDestinationMerge,
  parseFlags,
  planDestinationMerges,
  planRoadAddressRewrites,
  runDestinationMergeRepair
} from '../src/scripts/merge-dsv-duplicate-destinations.js';

// Production pair 2026-10-13 (shop 95375ce2): same place, spacing differs only.
const shopId = '95375ce2-8a45-43d0-a7f0-b3de2a74191c';
const survivorId = '80f0fb81-44e0-4a1f-8342-adc88f1fcd72';
const duplicateId = '51752d94-4720-4a1e-b64c-b14d5cead00b';
const empty = {
  driverLunchEntryStatus: null, driverLunchEntryStatusUpdatedAt: null,
  driverLunchTimeRange: null, driverLunchTimeRangeUpdatedAt: null,
  driverMemo: null, driverMemoUpdatedAt: null,
  driverOpenTime: null, driverOpenTimeUpdatedAt: null,
  driverRequiredArrivalTime: null, driverRequiredArrivalTimeUpdatedAt: null,
  isStoreReviewData: false, mergedIntoProfileId: null
};
const jioyoungOld = {
  ...empty, canonicalName: '지오영', createdAt: new Date('2026-09-11T02:48:43.286Z'), id: survivorId,
  normalizedAddress: { address: '경기 안양시 동안구 흥안대로439번길30, 1층', detailAddress: '1층', name: '지오영', postalCode: '14058' }
};
const jioyoungNew = {
  ...empty, canonicalName: '지오영', createdAt: new Date('2026-09-17T23:14:26.719Z'), id: duplicateId,
  driverMemo: '후문 하차', driverMemoUpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
  normalizedAddress: { address: '경기 안양시 동안구 흥안대로439번길 30,1층', detailAddress: '1층', name: '지오영', postalCode: '14058' }
};
const other = {
  ...empty, canonicalName: '다른곳', createdAt: new Date('2026-09-01T00:00:00.000Z'), id: 'other-id',
  normalizedAddress: { address: '서울 강남구 테헤란로 1', detailAddress: null, name: '다른곳' }
};

describe('planDestinationMerges', () => {
  test('keeps the oldest profile and carries the only driver memo over from the duplicate', () => {
    const groups = planDestinationMerges(shopId, [jioyoungNew, other, jioyoungOld]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ mergedIds: [duplicateId], shopId, survivorId });
    expect(groups[0]?.notes).toMatchObject({ memo: '후문 하차', memoUpdatedAt: '2026-10-01T00:00:00.000Z', openTime: null });
  });

  test('keeps the most-used spelling as survivor, then the oldest', () => {
    const counts = new Map([[survivorId, 3], [duplicateId, 11]]);
    expect(planDestinationMerges(shopId, [jioyoungOld, jioyoungNew], (id) => counts.get(id) ?? 0)[0])
      .toMatchObject({ mergedIds: [survivorId], survivorId: duplicateId });
  });

  test('rewrites a jibun-only row to the bare road address of its same-name twin', () => {
    const road = {
      ...empty, canonicalName: '뉴신팜', createdAt: new Date('2026-09-02T00:00:00.000Z'), id: 'road-id',
      normalizedAddress: { address: '경기 김포시 고촌읍 아라육로57번길 46, 2층', jibunAddress: '고촌읍 전호리 744', name: '뉴신팜' }
    };
    const jibun = {
      ...empty, canonicalName: '뉴신팜', createdAt: new Date('2026-09-01T00:00:00.000Z'), id: 'jibun-id',
      normalizedAddress: { address: '경기 김포시 고촌읍 전호리 744번지', jibunAddress: '경기도 김포시 고촌읍 전호리 744', name: '뉴신팜' }
    };
    const otherName = { ...jibun, canonicalName: '뉴신팜 물류창고', id: 'warehouse-id' };
    const otherLot = { ...jibun, id: 'other-lot', normalizedAddress: { ...jibun.normalizedAddress, address: '경기 김포시 고촌읍 전호리 745' } };

    expect(planRoadAddressRewrites(shopId, [jibun, road, otherName, otherLot])).toEqual([
      { fromAddress: '경기 김포시 고촌읍 전호리 744번지', id: 'jibun-id', shopId, toAddress: '경기 김포시 고촌읍 아라육로57번길 46' }
    ]);
  });

  test('does not rewrite when the lot maps to two different road addresses', () => {
    const jibun = {
      ...empty, canonicalName: 'x', createdAt: new Date('2026-09-01T00:00:00.000Z'), id: 'jibun-id',
      normalizedAddress: { address: '서울 동대문구 답십리동 753', name: 'x' }
    };
    const roadA = { ...jibun, id: 'a', normalizedAddress: { address: '서울 동대문구 한천로 111', jibunAddress: '답십리동 753' } };
    const roadB = { ...jibun, id: 'b', normalizedAddress: { address: '서울 동대문구 답십리로60길 27', jibunAddress: '답십리동 753' } };
    expect(planRoadAddressRewrites(shopId, [jibun, roadA, roadB])).toEqual([]);
  });

  test('ignores already merged rows', () => {
    expect(planDestinationMerges(shopId, [jioyoungOld, { ...jioyoungNew, mergedIntoProfileId: survivorId }])).toEqual([]);
  });

  test('parses flags with dry-run as the default', () => {
    expect(parseFlags([])).toEqual({ apply: false, shopIds: [] });
    expect(parseFlags(['--apply', '--shop-id', shopId])).toEqual({ apply: true, shopIds: [shopId] });
    expect(() => parseFlags(['--shop-id'])).toThrow('Missing value');
  });
});

function fakePrisma(profiles = [jioyoungNew, other, jioyoungOld]) {
  const tx = {
    deliveryCustomerProfile: { findMany: vi.fn().mockResolvedValue(profiles), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    destinationTip: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    dsvDispatchImportRow: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
    order: {
      groupBy: vi.fn().mockResolvedValue([{ _count: { _all: 11 }, destinationId: survivorId }, { _count: { _all: 3 }, destinationId: duplicateId }]),
      updateMany: vi.fn().mockResolvedValue({ count: 3 })
    },
    shop: { findMany: vi.fn().mockResolvedValue([{ id: shopId, shopDomain: 'dsv.example.test' }]) }
  };
  return { ...tx, $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)) };
}

describe('runDestinationMergeRepair', () => {
  test('dry-run prints the 지오영 pair collapsing into one survivor and writes nothing', async () => {
    const prisma = fakePrisma();
    const lines: string[] = [];
    const reports = await runDestinationMergeRepair(prisma as never, { apply: false, shopIds: [] }, (line) => lines.push(line));

    expect(reports).toMatchObject([{ mergedIds: [duplicateId], orderCounts: { [survivorId]: 11, [duplicateId]: 3 }, survivorId }]);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
      { mode: 'dry-run', shopDomain: 'dsv.example.test', survivorId, mergedIds: [duplicateId] },
      { groups: 1, mergedProfiles: 1, mode: 'dry-run', roadAddressRewrites: 0, shops: 1, wroteDatabaseRows: false }
    ]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.deliveryCustomerProfile.update).not.toHaveBeenCalled();
  });

  test('apply repoints orders, import rows and tips, marks the duplicate merged and copies the notes to the survivor', async () => {
    const prisma = fakePrisma();
    await runDestinationMergeRepair(prisma as never, { apply: true, shopIds: [shopId] }, () => undefined);

    const repoint = { data: { destinationId: survivorId }, where: { destinationId: { in: [duplicateId] }, shopId } };
    expect(prisma.order.updateMany).toHaveBeenCalledWith(repoint);
    expect(prisma.dsvDispatchImportRow.updateMany).toHaveBeenCalledWith(repoint);
    expect(prisma.destinationTip.updateMany).toHaveBeenCalledWith(repoint);
    expect(prisma.deliveryCustomerProfile.updateMany).toHaveBeenCalledWith({
      data: { mergedIntoProfileId: survivorId }, where: { id: { in: [duplicateId] }, shopId }
    });
    expect(prisma.deliveryCustomerProfile.update.mock.calls[0]?.[0]).toMatchObject({
      data: { driverMemo: '후문 하차', driverMemoUpdatedAt: new Date('2026-10-01T00:00:00.000Z'), driverOpenTime: null },
      where: { id: survivorId }
    });
    expect(prisma.shop.findMany.mock.calls[0]?.[0]).toMatchObject({ where: { id: { in: [shopId] } } });
  });

  test('applyDestinationMerge reports the repointed row counts', async () => {
    const prisma = fakePrisma();
    const group = planDestinationMerges(shopId, [jioyoungOld, jioyoungNew])[0]!;
    await expect(applyDestinationMerge(prisma as never, group)).resolves.toEqual({ importRows: 3, orders: 3, tips: 0 });
  });
});
