import { beforeEach, describe, expect, test, vi } from 'vitest';

const { replaceVersion, syncStops } = vi.hoisted(() => ({
  replaceVersion: vi.fn(() => Promise.resolve('version-new')),
  syncStops: vi.fn(() => Promise.resolve())
}));
vi.mock('../src/modules/route-grouping/route-grouping.service.js', () => ({
  replaceCurrentRouteGroupingChildVersion: replaceVersion,
  syncRoutePlanStopsPreservingRows: syncStops
}));

import {
  PrismaDriverRouteOrderService
} from '../src/modules/driver/driver-route-order.service.js';

const baseInput = {
  commandId: 'command-1',
  driverId: 'driver-1',
  expectedVersion: 'version-old',
  orderedStopIds: ['stop-2', 'stop-1'],
  routePlanId: 'route-1',
  shopId: 'shop-1'
};

describe('PrismaDriverRouteOrderService', () => {
  beforeEach(() => vi.clearAllMocks());

  test('reorders the exact stop set, replaces the child version, and replays the authoritative response', async () => {
    const { prisma, receipt, routeStops } = harness();
    const service = new PrismaDriverRouteOrderService(prisma as never);

    const first = await service.reorder(baseInput);
    const replay = await service.reorder(baseInput);

    expect(first).toEqual({
      routePlanId: 'route-1',
      routeVersionId: 'version-new',
      stops: [{ deliveryStopId: 'stop-2', sequence: 1 }, { deliveryStopId: 'stop-1', sequence: 2 }]
    });
    expect(replay).toEqual(first);
    expect(syncStops).toHaveBeenCalledWith(prisma, 'shop-1', 'route-1', [routeStops[1], routeStops[0]]);
    expect(replaceVersion).toHaveBeenCalledTimes(1);
    expect(prisma.routePlanGeometryCache.deleteMany).toHaveBeenCalledWith({ where: { routePlanId: 'route-1' } });
    const etaUpdate = prisma.routePlanStop.updateMany.mock.calls[0]?.[0];
    if (etaUpdate === undefined) throw new Error('Expected ETA invalidation');
    expect(etaUpdate.data).toMatchObject({
      distanceFromPreviousMeters: null,
      durationFromPreviousSeconds: null,
      etaInputRouteVersionId: 'version-new',
      etaStatus: 'PENDING'
    });
    expect(receipt.status).toBe('SUCCEEDED');
  });

  test.each([
    ['stale version', { child: null }, baseInput, 'VERSION_CONFLICT'],
    ['duplicate stop', {}, { ...baseInput, orderedStopIds: ['stop-1', 'stop-1'] }, 'INVALID_STOP_SET'],
    ['missing stop', {}, { ...baseInput, orderedStopIds: ['stop-1'] }, 'INVALID_STOP_SET'],
    ['extra stop', {}, { ...baseInput, orderedStopIds: ['stop-1', 'stop-2', 'stop-3'] }, 'INVALID_STOP_SET'],
    ['other driver', { driverId: 'driver-2' }, baseInput, 'ROUTE_SCOPE_REJECTED'],
    ['completed route', { status: 'COMPLETED' }, baseInput, 'ROUTE_COMPLETED']
  ])('rejects %s without replacing route authority', async (_description, options, input, code) => {
    const { prisma } = harness(options);
    const service = new PrismaDriverRouteOrderService(prisma as never);

    await expect(service.reorder(input)).rejects.toMatchObject({ code });
    expect(replaceVersion).not.toHaveBeenCalled();
  });

  test('rejects reuse of a commandId with a different payload', async () => {
    const { prisma } = harness();
    const service = new PrismaDriverRouteOrderService(prisma as never);
    await service.reorder(baseInput);

    await expect(service.reorder({ ...baseInput, orderedStopIds: ['stop-1', 'stop-2'] }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    expect(replaceVersion).toHaveBeenCalledTimes(1);
  });
});

type HarnessOptions = { child?: null; driverId?: string; status?: string };

function harness(options: HarnessOptions = {}) {
  const receipt: Record<string, unknown> = {};
  const routeStops = ['stop-1', 'stop-2'].map((deliveryStopId, index) => ({
    deliveryStopId,
    sequence: index + 1,
    deliveryStop: { order: { currentRouteVersionId: 'version-old', id: `order-${index + 1}`, shopifyOrderGid: `gid-${index + 1}` } }
  }));
  const prisma = {
    $queryRaw: vi.fn(() => Promise.resolve([])),
    $transaction: vi.fn((run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    dsvCommandReceipt: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(receipt, data, { id: 'receipt-1', status: 'STARTED' });
        return Promise.resolve({ id: 'receipt-1' });
      }),
      findUnique: vi.fn(() => Promise.resolve(receipt.id === undefined ? null : receipt)),
      updateMany: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(receipt, data);
        return Promise.resolve({ count: 1 });
      })
    },
    routeGroupingChildVersion: {
      findFirst: vi.fn(() => Promise.resolve(options.child === null ? null : {
        driverId: 'driver-1',
        groupingId: 'group-1',
        groupingVersionId: 'group-version-1',
        id: 'version-old',
        notificationStatus: 'SKIPPED',
        publishedAt: null,
        routePlanId: 'route-1',
        shopId: 'shop-1',
        snapshot: { name: 'Route 1', stops: [] },
        status: 'CURRENT',
        supersededAt: null,
        version: 1
      }))
    },
    routePlan: {
      findFirst: vi.fn(() => Promise.resolve({
        driverEvents: [],
        driverId: options.driverId ?? 'driver-1',
        routeStops,
        status: options.status ?? 'IN_PROGRESS'
      }))
    },
    routePlanGeometryCache: { deleteMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    routePlanStop: {
      updateMany: vi.fn((input: { data: Record<string, unknown> }) => {
        void input;
        return Promise.resolve({ count: 2 });
      })
    }
  };
  return { prisma, receipt, routeStops };
}
