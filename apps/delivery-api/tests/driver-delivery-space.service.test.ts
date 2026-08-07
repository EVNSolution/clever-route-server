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

  test('requires a registered route vehicle before exposing the shared delivery space', async () => {
    const harness = setup(bundleOrders('public'), null);

    await expect(harness.service.getSpace(scope()))
      .rejects.toMatchObject({ code: 'DESTINATION_BUNDLE_TARGET_VEHICLE_REQUIRED' });
  });

  test('hides and rejects public delivery bundles outside the current Seoul service date', async () => {
    const options = {
      now: new Date('2026-08-04T14:59:59.000Z'),
      planDate: '2026-08-03'
    };
    const publicHarness = setup(bundleOrders('public'), 'vehicle-1', options);
    const mineHarness = setup(bundleOrders('mine'), 'vehicle-1', options);

    await expect(publicHarness.service.getSpace(scope())).resolves.toMatchObject({
      available: []
    });
    await expect(mineHarness.service.getSpace(scope())).resolves.toMatchObject({
      mine: []
    });
    await expect(publicHarness.service.acquire({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1' }))
      .rejects.toMatchObject({ code: 'DESTINATION_BUNDLE_TRANSFER_CLOSED' });
    await expect(mineHarness.service.release({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1' }))
      .rejects.toMatchObject({ code: 'DESTINATION_BUNDLE_TRANSFER_CLOSED' });
    expect(publicHarness.reassignMany).not.toHaveBeenCalled();
    expect(mineHarness.unassignMany).not.toHaveBeenCalled();
  });

  test('uses the Seoul calendar date at the UTC day boundary', async () => {
    const harness = setup(bundleOrders('public'), 'vehicle-1', {
      now: new Date('2026-08-03T15:00:00.000Z'),
      planDate: '2026-08-04'
    });

    await expect(harness.service.getSpace(scope())).resolves.toMatchObject({
      available: [{ destinationId: 'dest-a' }]
    });
  });
});

function setup(
  rows: Awaited<ReturnType<DriverDeliverySpaceRepositoryContract['listBundleOrders']>>,
  vehicleId: string | null = 'vehicle-1',
  options: { now?: Date; planDate?: string } = {}
) {
  const grouping = groupingDetail(options.planDate);
  const getGrouping = vi.fn(() => Promise.resolve(grouping));
  const reassignMany = vi.fn(() => Promise.resolve({ assignmentResults: [], routePlanId: 'route-driver' }));
  const unassignMany = vi.fn(() => Promise.resolve({ assignmentResults: [], routePlanId: 'route-public' }));
  const repository: DriverDeliverySpaceRepositoryContract = {
    findRouteContext: vi.fn(() => Promise.resolve({ groupingId: 'group-1', vehicleId })),
    listBundleOrders: vi.fn(() => Promise.resolve(rows))
  };
  return {
    reassignMany,
    service: new DriverDeliverySpaceService(
      repository,
      { getGrouping } as unknown as RouteGroupingService,
      { reassignMany, unassignMany },
      () => options.now ?? new Date('2026-08-03T00:00:00.000Z')
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

function groupingDetail(planDate = '2026-08-03'): RouteGroupingDetailDto {
  return {
    assignments: [], branches: [], children: [], currentVersion: 1, dateRangeEnd: planDate, dateRangeStart: planDate,
    displayStatus: 'READY', id: 'group-1', linkedInventoryId: null, name: '배송', planDate, polygons: [],
    status: 'READY', totalOrders: 0, unresolvedOrders: 0, updatedAt: 'v1', warningState: []
  };
}
