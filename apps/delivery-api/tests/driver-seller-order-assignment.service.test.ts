import { describe, expect, test, vi } from 'vitest';

import {
  DriverSellerOrderAlreadyAcquiredError,
  DriverSellerOrderAssignmentConflictError,
  DriverSellerOrderAssignmentService,
  DriverSellerOrderRecalculationUnavailableError
} from '../src/modules/driver/driver-seller-order-assignment.service.js';
import {
  RouteGroupingConflictError,
  RouteGroupingValidationError,
  type RouteGroupingAssignmentDto,
  type RouteGroupingChildDto,
  type RouteGroupingDetailDto,
  type RouteGroupingService,
  type SaveRouteGroupingDraftInput
} from '../src/modules/route-grouping/route-grouping.types.js';

const scope = {
  accountId: 'account-1',
  driverId: 'driver-1',
  routePlanId: 'route-1',
  shopDomain: 'example.myshopify.com',
  shopId: 'shop-1'
};

describe('DriverSellerOrderAssignmentService', () => {
  test('lists only whole SellerOrder rows from unassigned routes', async () => {
    const grouping = createGrouping();
    const service = createService({ grouping });

    await expect(service.listUnassigned(scope)).resolves.toEqual([
      expect.objectContaining({ orderId: 'order-3', sellerOrderKey: 'seller-order-3' })
    ]);
  });

  test('acquires one indivisible SellerOrder into the authenticated driver route', async () => {
    const grouping = createGrouping();
    const saveDraft = vi.fn((input: SaveRouteGroupingDraftInput) => Promise.resolve(applyDraft(grouping, input)));
    const service = createService({ grouping, saveDraft });

    const result = await service.acquire({ ...commandScope(), orderId: 'order-3' });

    expect(result).toMatchObject({ order: { orderId: 'order-3' }, routePlanId: 'route-1' });
    expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedUpdatedAt: grouping.updatedAt,
      groupingId: grouping.id,
      shopDomain: scope.shopDomain
    }));
    const routes = saveDraft.mock.calls[0]?.[0].routes ?? [];
    expect(routes.find((route) => route.routePlanId === 'route-1')?.orderIds).toEqual(['order-1', 'order-3']);
    expect(routes.find((route) => route.routePlanId === 'route-unassigned')?.orderIds).toEqual([]);
    expect(routes.flatMap((route) => route.orderIds).filter((orderId) => orderId === 'order-3')).toHaveLength(1);
  });

  test('uses the command expected version for acquire writes when provided', async () => {
    const grouping = createGrouping();
    const saveDraft = vi.fn((input: SaveRouteGroupingDraftInput) => Promise.resolve(applyDraft(grouping, input)));
    const service = createService({ grouping, saveDraft });

    await service.acquire({ ...commandScope({ expectedVersion: 'version-from-command' }), orderId: 'order-3' });

    expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedUpdatedAt: 'version-from-command'
    }));
  });

  test('routes acquire through the assignment command kernel when configured', async () => {
    const acquireDriverSellerOrder = vi.fn(() => Promise.resolve(assignmentCommandResult('receipt-acquire')));
    const saveDraft = vi.fn();
    const service = createService({
      commandKernel: {
        acquireDriverSellerOrder,
        releaseDriverSellerOrder: vi.fn()
      },
      grouping: createGrouping(),
      saveDraft
    });

    await expect(service.acquire({ ...commandScope({ expectedVersion: 'version-from-command' }), orderId: 'order-3' }))
      .resolves.toMatchObject({ receiptId: 'receipt-acquire' });

    expect(acquireDriverSellerOrder).toHaveBeenCalledWith({
      ...commandScope({ expectedVersion: 'version-from-command' }),
      orderId: 'order-3'
    });
    expect(saveDraft).not.toHaveBeenCalled();
  });

  test('delegates vehicle-less acquire to the assignment command kernel', async () => {
    const acquireDriverSellerOrder = vi.fn(() => Promise.resolve(assignmentCommandResult('receipt-no-vehicle')));
    const service = createService({
      commandKernel: {
        acquireDriverSellerOrder,
        releaseDriverSellerOrder: vi.fn()
      },
      grouping: createGrouping(),
      vehicleId: null
    });

    await expect(service.acquire({ ...commandScope(), orderId: 'order-3' }))
      .resolves.toMatchObject({ receiptId: 'receipt-no-vehicle' });
    expect(acquireDriverSellerOrder).toHaveBeenCalledWith({ ...commandScope(), orderId: 'order-3' });
  });

  test('acquires into a vehicle-less target route', async () => {
    const grouping = createGrouping();
    const saveDraft = vi.fn((input: SaveRouteGroupingDraftInput) => Promise.resolve(applyDraft(grouping, input)));
    const service = createService({ grouping, saveDraft, vehicleId: null });

    await expect(service.acquire({ ...commandScope(), orderId: 'order-3' }))
      .resolves.toMatchObject({ routePlanId: 'route-1' });
    expect(saveDraft).toHaveBeenCalledOnce();
  });

  test('maps a stale concurrent acquisition to the first-writer-wins conflict', async () => {
    const grouping = createGrouping();
    const alreadyAcquired = moveOrderInGrouping(grouping, 'order-3', 'route-unassigned', 'route-2');
    const getGrouping = vi.fn()
      .mockResolvedValueOnce(grouping)
      .mockResolvedValueOnce(alreadyAcquired);
    const saveDraft = vi.fn(() => Promise.reject(new RouteGroupingConflictError()));
    const service = createService({ getGrouping, grouping, saveDraft });

    await expect(service.acquire({ ...commandScope(), orderId: 'order-3' }))
      .rejects.toBeInstanceOf(DriverSellerOrderAlreadyAcquiredError);
  });

  test('does not persist a partial transfer when route recalculation is unavailable', async () => {
    const grouping = createGrouping();
    const saveDraft = vi.fn(() => Promise.reject(new RouteGroupingValidationError([
      'route optimization service is not configured'
    ])));
    const service = createService({ grouping, saveDraft });

    await expect(service.acquire({ ...commandScope(), orderId: 'order-3' }))
      .rejects.toBeInstanceOf(DriverSellerOrderRecalculationUnavailableError);
  });

  test('releases assignment without deleting the SellerOrder', async () => {
    const grouping = createGrouping();
    const saveDraft = vi.fn((input: SaveRouteGroupingDraftInput) => Promise.resolve(applyDraft(grouping, input)));
    const service = createService({ grouping, saveDraft });

    const result = await service.release({ ...commandScope(), orderId: 'order-1' });

    expect(result.order.orderId).toBe('order-1');
    const request = saveDraft.mock.calls[0]?.[0];
    expect(request?.removedOrderIds).toBeUndefined();
    expect(request?.routes.find((route) => route.routePlanId === 'route-1')?.orderIds).toEqual([]);
    expect(request?.routes.find((route) => route.routePlanId === 'route-unassigned')?.orderIds).toEqual([
      'order-3',
      'order-1'
    ]);
    expect(request?.routes.flatMap((route) => route.orderIds)).toContain('order-1');
  });

  test('uses the command expected version for release writes when provided', async () => {
    const grouping = createGrouping();
    const saveDraft = vi.fn((input: SaveRouteGroupingDraftInput) => Promise.resolve(applyDraft(grouping, input)));
    const service = createService({ grouping, saveDraft });

    await service.release({ ...commandScope({ expectedVersion: 'release-version-from-command' }), orderId: 'order-1' });

    expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedUpdatedAt: 'release-version-from-command'
    }));
  });

  test('routes release through the assignment command kernel when configured', async () => {
    const releaseDriverSellerOrder = vi.fn(() => Promise.resolve(assignmentCommandResult('receipt-release')));
    const saveDraft = vi.fn();
    const service = createService({
      commandKernel: {
        acquireDriverSellerOrder: vi.fn(),
        releaseDriverSellerOrder
      },
      grouping: createGrouping(),
      saveDraft
    });

    await expect(service.release({ ...commandScope({ expectedVersion: 'release-version-from-command' }), orderId: 'order-1' }))
      .resolves.toMatchObject({ receiptId: 'receipt-release' });

    expect(releaseDriverSellerOrder).toHaveBeenCalledWith({
      ...commandScope({ expectedVersion: 'release-version-from-command' }),
      orderId: 'order-1'
    });
    expect(saveDraft).not.toHaveBeenCalled();
  });

  test('rejects a grouping that contains an unmaterialized route before changing assignments', async () => {
    const grouping = createGrouping();
    grouping.children.push({
      ...child({ driverId: null, orderIds: [], routePlanId: 'temporary', sortOrder: 4 }),
      routePlan: null,
      routePlanId: null,
    });
    const saveDraft = vi.fn();
    const service = createService({ grouping, saveDraft });

    await expect(service.acquire({ ...commandScope(), orderId: 'order-3' }))
      .rejects.toBeInstanceOf(DriverSellerOrderAssignmentConflictError);
    expect(saveDraft).not.toHaveBeenCalled();
  });
});

function commandScope(input: { expectedVersion?: string | null } = {}) {
  return {
    ...scope,
    commandId: 'driver-command-1',
    expectedVersion: input.expectedVersion === undefined ? null : input.expectedVersion
  };
}

function createService(input: {
  commandKernel?: ConstructorParameters<typeof DriverSellerOrderAssignmentService>[2];
  getGrouping?: ReturnType<typeof vi.fn>;
  grouping: RouteGroupingDetailDto;
  saveDraft?: ReturnType<typeof vi.fn>;
  vehicleId?: string | null;
}): DriverSellerOrderAssignmentService {
  const getGrouping = input.getGrouping ?? vi.fn(() => Promise.resolve(input.grouping));
  const saveDraft = input.saveDraft ?? vi.fn((draft: SaveRouteGroupingDraftInput) => Promise.resolve(applyDraft(input.grouping, draft)));
  const routeGroupingService = { getGrouping, saveDraft } as unknown as RouteGroupingService;
  return new DriverSellerOrderAssignmentService(
    {
      findRouteContext: vi.fn(() => Promise.resolve({
        groupingId: input.grouping.id,
        vehicleId: input.vehicleId === undefined ? 'vehicle-1' : input.vehicleId
      }))
    },
    routeGroupingService,
    input.commandKernel
  );
}

function assignmentCommandResult(receiptId: string) {
  return {
    auditEventId: `audit-${receiptId}`,
    groupingId: 'grouping-1',
    groupingUpdatedAt: '2026-07-22T00:02:00.000Z',
    newRouteVersionId: `next-${receiptId}`,
    order: {
      addressLabel: 'Address 1',
      itemCount: 1,
      orderId: 'order-1',
      orderName: '#1',
      recipientName: 'Recipient 1',
      sellerOrderKey: 'seller-order-1',
      sourceSequence: 1
    },
    previousRouteVersionId: `previous-${receiptId}`,
    receiptId,
    routePlanId: 'route-1'
  };
}

function createGrouping(): RouteGroupingDetailDto {
  const assignments = ['order-1', 'order-2', 'order-3'].map((orderId, index) => assignment(orderId, index + 1));
  return {
    assignments,
    branches: [],
    children: [
      child({ driverId: 'driver-1', orderIds: ['order-1'], routePlanId: 'route-1', sortOrder: 1 }),
      child({ driverId: 'driver-2', orderIds: ['order-2'], routePlanId: 'route-2', sortOrder: 2 }),
      child({ driverId: null, orderIds: ['order-3'], routePlanId: 'route-unassigned', sortOrder: 3 })
    ],
    currentVersion: 1,
    dateRangeEnd: '2026-07-22',
    dateRangeStart: '2026-07-22',
    displayStatus: 'READY',
    id: 'grouping-1',
    linkedInventoryId: null,
    name: '오늘 배차',
    planDate: '2026-07-22',
    polygons: [],
    status: 'READY',
    totalOrders: assignments.length,
    unresolvedOrders: 0,
    updatedAt: '2026-07-22T00:00:00.000Z',
    warningState: []
  };
}

function assignment(orderId: string, sourceSequence: number): RouteGroupingAssignmentDto {
  return {
    addressLabel: `Address ${sourceSequence}`,
    assignedDriverId: null,
    assignedPolygonId: null,
    assignmentStatus: 'UNASSIGNED',
    coordinates: { latitude: 37.5, longitude: 127 },
    deliveryStopId: `stop-${sourceSequence}`,
    email: null,
    itemCount: sourceSequence,
    orderId,
    orderName: `#${sourceSequence}`,
    phone: null,
    recipientName: `Recipient ${sourceSequence}`,
    sourceOrderId: `seller-${orderId}`,
    sourceSequence
  };
}

function child(input: {
  driverId: string | null;
  orderIds: string[];
  routePlanId: string;
  sortOrder: number;
}): RouteGroupingChildDto {
  return {
    childVersion: 1,
    color: null,
    displayStatus: 'READY',
    driverId: input.driverId,
    driverName: input.driverId,
    notificationStatus: 'NOT_REQUIRED',
    orderIds: input.orderIds,
    routeGeometry: null,
    routeMetrics: null,
    routePlan: {
      createdAt: '2026-07-22T00:00:00.000Z',
      deliveryAreas: [],
      deliveryDays: [],
      depot: { latitude: 37.4, longitude: 126.9 },
      driverId: input.driverId,
      id: input.routePlanId,
      missingCoordinates: 0,
      name: input.routePlanId,
      planDate: '2026-07-22',
      routeEndMode: 'RETURN_TO_DEPOT',
      status: 'READY',
      stopsCount: input.orderIds.length,
      updatedAt: '2026-07-22T00:00:00.000Z'
    },
    routePlanId: input.routePlanId,
    routeIdx: input.sortOrder,
    routeStopPoints: [],
    sortOrder: input.sortOrder,
    stops: [],
    stopsCount: input.orderIds.length,
    updatedAt: '2026-07-22T00:00:00.000Z'
  };
}

function applyDraft(grouping: RouteGroupingDetailDto, input: SaveRouteGroupingDraftInput): RouteGroupingDetailDto {
  return {
    ...grouping,
    children: grouping.children.map((existing) => {
      const draft = input.routes.find((route) => route.routePlanId === existing.routePlanId);
      return draft === undefined ? existing : { ...existing, orderIds: draft.orderIds, stopsCount: draft.orderIds.length };
    }),
    updatedAt: '2026-07-22T00:01:00.000Z'
  };
}

function moveOrderInGrouping(
  grouping: RouteGroupingDetailDto,
  orderId: string,
  sourceRoutePlanId: string,
  targetRoutePlanId: string
): RouteGroupingDetailDto {
  return {
    ...grouping,
    children: grouping.children.map((existing) => {
      if (existing.routePlanId === sourceRoutePlanId) {
        return { ...existing, orderIds: existing.orderIds.filter((candidate) => candidate !== orderId) };
      }
      if (existing.routePlanId === targetRoutePlanId) {
        return { ...existing, orderIds: [...existing.orderIds, orderId] };
      }
      return existing;
    }),
    updatedAt: '2026-07-22T00:01:00.000Z'
  };
}
