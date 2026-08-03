import { describe, expect, test, vi } from 'vitest';

import { DsvAssignmentCommandError } from '../src/modules/dsv/dsv-assignment-command.service.js';
import {
  DriverDeliverySpaceService,
  PrismaDriverDeliverySpaceRepository,
  type DriverDeliverySpaceRepositoryContract
} from '../src/modules/driver/driver-delivery-space.service.js';
import type { RouteGroupingDetailDto, RouteGroupingService } from '../src/modules/route-grouping/route-grouping.types.js';

describe('DriverDeliverySpaceService', () => {
  test('passes only Prisma-supported route scope fields to the repository query', async () => {
    const findFirst = vi.fn(() => Promise.resolve({
      groupingId: 'group-1',
      routePlan: { vehicleId: 'vehicle-1' }
    }));
    const repository = new PrismaDriverDeliverySpaceRepository({
      dsvDispatchImportRow: {} as never,
      routeGroupingChildVersion: { findFirst } as never
    });

    await expect(repository.findRouteContext(scope())).resolves.toEqual({
      groupingId: 'group-1',
      vehicleId: 'vehicle-1'
    });
    expect(findFirst).toHaveBeenCalledWith({
      select: { groupingId: true, routePlan: { select: { vehicleId: true } } },
      where: {
        driverId: 'driver-1',
        routePlanId: 'route-driver',
        shopId: 'shop-1',
        status: 'CURRENT'
      }
    });
  });

  test('releases every order at one destination through one atomic batch command', async () => {
    const harness = setup(bundleOrders('mine'));

    await expect(harness.service.getSpace(scope())).resolves.toMatchObject({
      mine: [{ destinationId: 'dest-a', orderCount: 2 }]
    });
    await harness.service.release({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1' });

    expect(harness.unassignMany).toHaveBeenCalledTimes(1);
    expect(harness.unassignMany).toHaveBeenCalledWith(expect.objectContaining({
      actor: { actorId: 'driver-1', actorType: 'DRIVER', principalType: 'DRIVER' },
      items: [
        expect.objectContaining({ expectedVersion: 'version-a1', sellerOrderId: 'order-a1' }),
        expect.objectContaining({ expectedVersion: 'version-a2', sellerOrderId: 'order-a2' })
      ],
      shopDomain: 'dsv.test'
    }));
  });

  test('reports a first-claim conflict from the atomic assignment command', async () => {
    const harness = setup(bundleOrders('public'));
    harness.reassignMany.mockRejectedValueOnce(new DsvAssignmentCommandError('SELLER_ORDER_ALREADY_ACQUIRED'));

    await expect(harness.service.acquire({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1' }))
      .rejects.toMatchObject({ code: 'DESTINATION_BUNDLE_ALREADY_ACQUIRED' });
  });
});

function setup(rows: Awaited<ReturnType<DriverDeliverySpaceRepositoryContract['listBundleOrders']>>) {
  const grouping = groupingDetail();
  const getGrouping = vi.fn(() => Promise.resolve(grouping));
  const reassignMany = vi.fn(() => Promise.resolve({ assignmentResults: [], routePlanId: 'route-driver' }));
  const unassignMany = vi.fn(() => Promise.resolve({ assignmentResults: [], routePlanId: 'route-public' }));
  const repository: DriverDeliverySpaceRepositoryContract = {
    findRouteContext: vi.fn(() => Promise.resolve({ groupingId: 'group-1', vehicleId: 'vehicle-1' })),
    listBundleOrders: vi.fn(() => Promise.resolve(rows))
  };
  return {
    reassignMany,
    service: new DriverDeliverySpaceService(
      repository,
      { getGrouping } as unknown as RouteGroupingService,
      { reassignMany, unassignMany }
    ),
    unassignMany
  };
}

function bundleOrders(owner: 'mine' | 'public') {
  const driverId = owner === 'mine' ? 'driver-1' : null;
  const routePlanId = owner === 'mine' ? 'route-driver' : 'route-public';
  return [
    { address: '서울 광진구', conditionCode: 'AMBIENT', currentRouteVersionId: 'version-a1', destinationId: 'dest-a', destinationName: '지오영', driverId, orderId: 'order-a1', routePlanId, shippedBoxes: 6 },
    { address: '서울 광진구', conditionCode: 'COLD', currentRouteVersionId: 'version-a2', destinationId: 'dest-a', destinationName: '지오영', driverId, orderId: 'order-a2', routePlanId, shippedBoxes: 3 }
  ];
}

function scope() {
  return { accountId: 'account-1', driverId: 'driver-1', routePlanId: 'route-driver', shopDomain: 'dsv.test', shopId: 'shop-1', tokenVersion: 1 };
}

function groupingDetail(): RouteGroupingDetailDto {
  return {
    assignments: [], branches: [], children: [], currentVersion: 1, dateRangeEnd: '2026-08-03', dateRangeStart: '2026-08-03',
    displayStatus: 'READY', id: 'group-1', linkedInventoryId: null, name: '배송', planDate: '2026-08-03', polygons: [],
    status: 'READY', totalOrders: 0, unresolvedOrders: 0, updatedAt: 'v1', warningState: []
  };
}
