import { describe, expect, test, vi } from 'vitest';
import { DriverDeliverySpaceService, type DriverDeliverySpaceRepositoryContract } from '../src/modules/driver/driver-delivery-space.service.js';
import { RouteGroupingConflictError, type RouteGroupingDetailDto, type RouteGroupingDraftRouteInput, type RouteGroupingService } from '../src/modules/route-grouping/route-grouping.types.js';

describe('DriverDeliverySpaceService', () => {
  test('moves every order at one destination in one draft save', async () => {
    const harness = setup(grouping('mine'), grouping('public'));
    await expect(harness.service.getSpace(scope())).resolves.toMatchObject({ mine: [{ destinationId: 'dest-a', orderCount: 2 }] });
    await harness.service.release({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1' });
    expect(harness.saveDraft).toHaveBeenCalledTimes(1);
    const routes = harness.routes();
    expect(routes.find((route) => route.routePlanId === 'route-driver')?.orderIds).toEqual([]);
    expect(routes.find((route) => route.routePlanId === 'route-public')?.orderIds).toEqual(['order-b', 'order-a1', 'order-a2']);
  });

  test('reports a first-claim conflict after another driver wins', async () => {
    const harness = setup(grouping('public'), grouping('mine'));
    harness.saveDraft.mockRejectedValueOnce(new RouteGroupingConflictError('stale'));
    harness.getGrouping.mockResolvedValueOnce(grouping('public')).mockResolvedValueOnce(grouping('mine'));
    await expect(harness.service.acquire({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1' }))
      .rejects.toMatchObject({ code: 'DESTINATION_BUNDLE_ALREADY_ACQUIRED' });
  });
});

function setup(initial: RouteGroupingDetailDto, saved: RouteGroupingDetailDto) {
  const getGrouping = vi.fn(() => Promise.resolve(initial));
  const saveDraft = vi.fn(() => Promise.resolve(saved));
  const repository: DriverDeliverySpaceRepositoryContract = {
    findRouteContext: vi.fn(() => Promise.resolve({ groupingId: 'group-1', vehicleId: 'vehicle-1' })),
    listBundleOrders: vi.fn(() => Promise.resolve([
      { address: '서울 광진구', conditionCode: 'AMBIENT', destinationId: 'dest-a', destinationName: '지오영', orderId: 'order-a1', shippedBoxes: 6 },
      { address: '서울 광진구', conditionCode: 'COLD', destinationId: 'dest-a', destinationName: '지오영', orderId: 'order-a2', shippedBoxes: 3 },
      { address: '서울 중랑구', conditionCode: 'AMBIENT', destinationId: 'dest-b', destinationName: '대주약품', orderId: 'order-b', shippedBoxes: 7 }
    ]))
  };
  return {
    getGrouping,
    saveDraft,
    routes() {
      const calls = saveDraft.mock.calls as unknown as Array<[{ routes: RouteGroupingDraftRouteInput[] }]>;
      return calls[0]?.[0].routes ?? [];
    },
    service: new DriverDeliverySpaceService(repository, { getGrouping, saveDraft } as unknown as RouteGroupingService)
  };
}

function scope() {
  return { accountId: 'account-1', driverId: 'driver-1', routePlanId: 'route-driver', shopDomain: 'dsv.test', shopId: 'shop-1', tokenVersion: 1 };
}

function grouping(destinationA: 'mine' | 'public'): RouteGroupingDetailDto {
  const driverIds = destinationA === 'mine' ? ['order-a1', 'order-a2'] : [];
  const publicIds = destinationA === 'public' ? ['order-b', 'order-a1', 'order-a2'] : ['order-b'];
  const child = (routePlanId: string, driverId: string | null, orderIds: string[], sortOrder: number) => ({
    childVersion: 1, color: null, displayStatus: 'READY', driverId, driverName: null, notificationStatus: 'NOT_REQUIRED', orderIds,
    routeGeometry: null, routeMetrics: null, routePlan: { id: routePlanId, updatedAt: 'now' }, routePlanId, routeIdx: sortOrder,
    routeStopPoints: [], sortOrder, stops: [], stopsCount: orderIds.length, updatedAt: 'now'
  });
  const orderIds = ['order-a1', 'order-a2', 'order-b'];
  return {
    assignments: orderIds.map((orderId, index) => ({ addressLabel: '주소', assignedDriverId: null, assignedPolygonId: null, assignmentStatus: 'ASSIGNED', coordinates: { latitude: null, longitude: null }, deliveryStopId: `stop-${index}`, email: null, itemCount: 1, orderId, orderName: orderId, phone: null, recipientName: null, sourceOrderId: orderId, sourceSequence: index + 1 })),
    branches: [], children: [child('route-driver', 'driver-1', driverIds, 1), child('route-public', null, publicIds, 2)] as unknown as RouteGroupingDetailDto['children'],
    currentVersion: 1, dateRangeEnd: '2026-08-03', dateRangeStart: '2026-08-03', displayStatus: 'READY', id: 'group-1', linkedInventoryId: null,
    name: '배송', planDate: '2026-08-03', polygons: [], status: 'READY', totalOrders: 3, unresolvedOrders: 0,
    updatedAt: destinationA === 'mine' ? 'v1' : 'v2', warningState: []
  };
}
