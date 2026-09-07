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
      id: 'child-version-1',
      routePlan: { isStoreReviewData: true },
      version: 7
    }));
    const repository = new PrismaDriverDeliverySpaceRepository({
      driverBundleHandoffRequest: {} as never,
      driverRouteNotificationAttempt: {} as never,
      dsvDispatchImportRow: {} as never,
      routeGroupingChildVersion: { findFirst } as never,
      routePlan: {} as never
    });

    await expect(repository.findRouteContext(scope())).resolves.toEqual({
      childVersionId: 'child-version-1',
      groupingId: 'group-1',
      groupingVersion: 7,
      isStoreReviewData: true
    });
    expect(findFirst).toHaveBeenCalledWith({
      select: {
        groupingId: true,
        id: true,
        routePlan: { select: { isStoreReviewData: true } },
        version: true
      },
      where: {
        driverId: 'driver-1',
        routePlanId: 'route-driver',
        shopId: 'shop-1',
        status: 'CURRENT'
      }
    });
  });

  test('filters bundle rows by both import and seller-order review mode in Prisma', async () => {
    const findMany = vi.fn(() => Promise.resolve([]));
    const repository = new PrismaDriverDeliverySpaceRepository({
      driverBundleHandoffRequest: {} as never,
      driverRouteNotificationAttempt: {} as never,
      dsvDispatchImportRow: { findMany } as never,
      routeGroupingChildVersion: {} as never,
      routePlan: {} as never
    });

    await repository.listBundleOrders({ groupingId: 'group-1', isStoreReviewData: true, shopId: 'shop-1' });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        destinationId: { not: null },
        importRecord: { isStoreReviewData: true },
        sellerOrder: {
          currentRouteVersion: { groupingId: 'group-1', status: 'CURRENT', supersededAt: null },
          isStoreReviewData: true
        },
        shopId: 'shop-1',
        status: 'APPLIED'
      }
    }));
  });

  test('maps the active-handoff unique constraint to a delivery-space conflict', async () => {
    const repository = new PrismaDriverDeliverySpaceRepository({
      driverBundleHandoffRequest: {
        create: vi.fn(() => Promise.reject(Object.assign(new Error('unique constraint'), { code: 'P2002' })))
      } as never,
      driverRouteNotificationAttempt: {} as never,
      dsvDispatchImportRow: {} as never,
      routeGroupingChildVersion: {} as never,
      routePlan: {} as never
    });

    await expect(repository.createHandoff({
      destinationId: 'dest-a',
      expectedVersion: 'v1',
      expiresAt: new Date('2026-08-03T00:10:00.000Z'),
      groupingId: 'group-1',
      shopId: 'shop-1',
      sourceDriverId: 'driver-1',
      sourceRoutePlanId: 'route-driver',
      targetDriverId: 'driver-2',
      targetRoutePlanId: 'route-recipient'
    })).rejects.toMatchObject({ code: 'DESTINATION_BUNDLE_ASSIGNMENT_CHANGED' });
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

  test('proposes handoff without moving the destination, then accept moves it atomically', async () => {
    const harness = setup(bundleOrders('mine'), { recipients: true });

    await expect(harness.service.getSpace(scope())).resolves.toMatchObject({
      recipients: [{ driverId: 'driver-2', driverName: '양우진' }]
    });
    await expect(harness.service.proposeHandoff({
      ...scope(),
      destinationId: 'dest-a',
      expectedVersion: 'v1',
      targetDriverId: 'driver-2'
    })).resolves.toMatchObject({
      destinationId: 'dest-a',
      targetDriverName: '양우진'
    });

    expect(harness.reassignMany).not.toHaveBeenCalled();
    expect(harness.recordHandoffNotification).toHaveBeenCalledWith(expect.objectContaining({
      driverId: 'driver-2',
      event: 'proposed',
      requestId: 'handoff-1',
      routePlanId: 'route-recipient'
    }));
    expect(harness.dispatchByIdempotencyKey).toHaveBeenCalledWith('driver-bundle-handoff:handoff-1:proposed');

    await harness.service.acceptHandoff({
      ...scope({ driverId: 'driver-2', routePlanId: 'route-recipient' }),
      requestId: 'handoff-1'
    });

    expect(harness.reassignMany).toHaveBeenCalledTimes(1);
    expect(harness.reassignMany).toHaveBeenCalledWith(expect.objectContaining({
      actor: { actorId: 'driver-2', actorType: 'DRIVER', principalType: 'DRIVER' },
      items: [
        expect.objectContaining({ expectedVersion: 'version-a1', sellerOrderId: 'order-a1' }),
        expect.objectContaining({ expectedVersion: 'version-a2', sellerOrderId: 'order-a2' })
      ],
      reason: 'DRIVER_DESTINATION_BUNDLE_TRANSFER',
      targetDriverId: 'driver-2',
      targetRoutePlanId: 'route-recipient'
    }));
    expect(harness.recordHandoffNotification).toHaveBeenCalledWith(expect.objectContaining({
      driverId: 'driver-1',
      event: 'applied',
      requestId: 'handoff-1',
      routePlanId: 'route-driver'
    }));
    expect(harness.updateHandoffStatus).toHaveBeenNthCalledWith(1, {
      fromStatus: 'PROPOSED',
      requestId: 'handoff-1',
      shopId: 'shop-1',
      status: 'PROCESSING'
    });
    expect(harness.updateHandoffStatus).toHaveBeenNthCalledWith(2, {
      fromStatus: 'PROCESSING',
      requestId: 'handoff-1',
      shopId: 'shop-1',
      status: 'APPLIED'
    });
    expect(harness.updateHandoffStatus.mock.invocationCallOrder[0])
      .toBeLessThan(harness.reassignMany.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
  });

  test('does not allow rejection after acceptance has claimed the request', async () => {
    const harness = setup(bundleOrders('mine'), { handoffStatus: 'PROCESSING', recipients: true });

    await expect(harness.service.rejectHandoff({
      ...scope({ driverId: 'driver-2', routePlanId: 'route-recipient' }),
      requestId: 'handoff-1'
    })).rejects.toMatchObject({ code: 'HANDOFF_REQUEST_NOT_FOUND' });
    expect(harness.updateHandoffStatus).not.toHaveBeenCalled();
    expect(harness.reassignMany).not.toHaveBeenCalled();
  });

  test('finishes a claimed request after the idempotent transfer already committed', async () => {
    const harness = setup(bundleOrders('target'), { handoffStatus: 'PROCESSING', recipients: true });

    await expect(harness.service.acceptHandoff({
      ...scope({ driverId: 'driver-2', routePlanId: 'route-recipient' }),
      requestId: 'handoff-1'
    })).resolves.toMatchObject({ routePlanId: 'route-recipient', version: 'v1' });
    expect(harness.reassignMany).not.toHaveBeenCalled();
    expect(harness.updateHandoffStatus).toHaveBeenCalledWith({
      fromStatus: 'PROCESSING',
      requestId: 'handoff-1',
      shopId: 'shop-1',
      status: 'APPLIED'
    });
  });

  test('rejects handoff to a driver outside the current grouping', async () => {
    const harness = setup(bundleOrders('mine'), { recipients: true });

    await expect(harness.service.proposeHandoff({
      ...scope(),
      destinationId: 'dest-a',
      expectedVersion: 'v1',
      targetDriverId: 'driver-outside'
    })).rejects.toMatchObject({ code: 'DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED' });
    expect(harness.reassignMany).not.toHaveBeenCalled();
  });

  test('reports a first-claim conflict from the atomic assignment command', async () => {
    const harness = setup(bundleOrders('public'));
    harness.reassignMany.mockRejectedValueOnce(new DsvAssignmentCommandError('SELLER_ORDER_ALREADY_ACQUIRED'));

    await expect(harness.service.acquire({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1' }))
      .rejects.toMatchObject({ code: 'DESTINATION_BUNDLE_ALREADY_ACQUIRED' });
  });

  test('exposes and acquires shared delivery without a registered route vehicle', async () => {
    const harness = setup(bundleOrders('public'));

    await expect(harness.service.getSpace(scope()))
      .resolves.toMatchObject({ available: [{ destinationId: 'dest-a' }] });
    await expect(harness.service.acquire({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1' }))
      .resolves.toMatchObject({ routePlanId: 'route-driver' });
    expect(harness.reassignMany).toHaveBeenCalledWith(expect.objectContaining({
      targetDriverId: 'driver-1',
      targetRoutePlanId: 'route-driver'
    }));
  });

  test.each(['2026-08-03', '2026-08-05'])('uses selected route bundles and atomic commands for service date %s', async (planDate) => {
    const options = {
      now: new Date('2026-08-04T14:59:59.000Z'),
      planDate
    };
    const publicHarness = setup(bundleOrders('public'), options);
    const mineHarness = setup(bundleOrders('mine'), options);

    await expect(publicHarness.service.getSpace(scope())).resolves.toMatchObject({
      available: [{ destinationId: 'dest-a', orderCount: 2 }]
    });
    await expect(mineHarness.service.getSpace(scope())).resolves.toMatchObject({
      mine: [{ destinationId: 'dest-a', orderCount: 2 }]
    });
    await expect(publicHarness.service.acquire({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1' }))
      .resolves.toMatchObject({ routePlanId: 'route-driver' });
    await expect(mineHarness.service.release({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1' }))
      .resolves.toMatchObject({ routePlanId: 'route-public' });
    expect(publicHarness.reassignMany).toHaveBeenCalledTimes(1);
    expect(mineHarness.unassignMany).toHaveBeenCalledTimes(1);
  });

  test('shows recipients and accepts a handoff for the selected previous date', async () => {
    const harness = setup(bundleOrders('mine'), { planDate: '2026-08-02', recipients: true });
    await expect(harness.service.getSpace(scope())).resolves.toMatchObject({ recipients: [{ driverId: 'driver-2' }] });
    await harness.service.proposeHandoff({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1', targetDriverId: 'driver-2' });
    await harness.service.acceptHandoff({ ...scope({ driverId: 'driver-2', routePlanId: 'route-recipient' }), requestId: 'handoff-1' });
    expect(harness.reassignMany).toHaveBeenCalledTimes(1);
  });

  test('hides review recipients and cross-mode handoffs from a normal driver in a mixed grouping', async () => {
    const harness = setup(bundleOrders('mine'), {
      accessibleRoutePlanIds: ['route-driver', 'route-recipient'],
      activeHandoffs: true,
      handoffTarget: 'review',
      mixedRecipients: true
    });

    await expect(harness.service.getSpace(scope())).resolves.toMatchObject({
      incomingHandoffs: [],
      outgoingHandoffs: [],
      recipients: [{ driverId: 'driver-2', driverName: '양우진' }]
    });
    await expect(harness.service.proposeHandoff({
      ...scope(),
      destinationId: 'dest-a',
      expectedVersion: 'v1',
      targetDriverId: 'driver-3'
    })).rejects.toMatchObject({ code: 'DESTINATION_BUNDLE_ROUTE_SCOPE_REJECTED' });
    await expect(harness.service.cancelHandoff({ ...scope(), requestId: 'handoff-1' }))
      .rejects.toMatchObject({ code: 'HANDOFF_REQUEST_NOT_FOUND' });
  });

  test('shows only review recipients to a review driver in a mixed grouping', async () => {
    const reviewRows = bundleOrders('mine').map((row) => ({
      ...row,
      driverId: 'driver-3',
      routePlanId: 'route-review'
    }));
    const harness = setup(reviewRows, {
      accessibleRoutePlanIds: ['route-review', 'route-review-recipient'],
      isStoreReviewData: true,
      mixedRecipients: true
    });

    await expect(harness.service.getSpace(scope({ driverId: 'driver-3', routePlanId: 'route-review' })))
      .resolves.toMatchObject({
        mine: [{ destinationId: 'dest-a' }],
        recipients: [{ driverId: 'driver-4', driverName: '검토 배송원' }]
      });
  });

  test('keeps mixed-mode public bundles in the bearer route mode', async () => {
    const normalRows = bundleOrders('public');
    const reviewRows = bundleOrders('public').map((row) => ({
      ...row,
      destinationId: 'dest-review',
      destinationName: '검토 배송지',
      orderId: `review-${row.orderId}`,
      routePlanId: 'route-review-public'
    }));
    const normalHarness = setup(normalRows, { reviewRows });
    const reviewHarness = setup(normalRows, { isStoreReviewData: true, reviewRows });

    await expect(normalHarness.service.getSpace(scope())).resolves.toMatchObject({
      available: [expect.objectContaining({ destinationId: 'dest-a' })]
    });
    await expect(reviewHarness.service.getSpace(scope({ driverId: 'driver-3', routePlanId: 'route-review' })))
      .resolves.toMatchObject({
        available: [expect.objectContaining({ destinationId: 'dest-review' })]
      });
  });

  test('keeps closed-route and stale-version failures on previous dates', async () => {
    const harness = setup(bundleOrders('mine'), { planDate: '2026-08-02' });
    await expect(harness.service.release({ ...scope(), destinationId: 'dest-a', expectedVersion: 'stale' }))
      .rejects.toMatchObject({ code: 'DESTINATION_BUNDLE_ASSIGNMENT_CHANGED' });
    expect(harness.unassignMany).not.toHaveBeenCalled();
    harness.unassignMany.mockRejectedValueOnce(new DsvAssignmentCommandError('SELLER_ORDER_TRANSFER_CLOSED'));
    await expect(harness.service.release({ ...scope(), destinationId: 'dest-a', expectedVersion: 'v1' }))
      .rejects.toMatchObject({ code: 'DESTINATION_BUNDLE_TRANSFER_CLOSED' });
  });

  test('uses the Seoul calendar date at the UTC day boundary', async () => {
    const harness = setup(bundleOrders('public'), {
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
  options: {
    accessibleRoutePlanIds?: string[];
    activeHandoffs?: boolean;
    handoffStatus?: 'PROCESSING' | 'PROPOSED';
    handoffTarget?: 'normal' | 'review';
    isStoreReviewData?: boolean;
    mixedRecipients?: boolean;
    now?: Date;
    planDate?: string;
    recipients?: boolean;
    reviewRows?: Awaited<ReturnType<DriverDeliverySpaceRepositoryContract['listBundleOrders']>>;
  } = {}
) {
  const grouping = groupingDetail(options.planDate, options.recipients, options.mixedRecipients);
  const getGrouping = vi.fn(() => Promise.resolve(grouping));
  const reassignMany = vi.fn(() => Promise.resolve({ assignmentResults: [], routePlanId: 'route-driver' }));
  const unassignMany = vi.fn(() => Promise.resolve({ assignmentResults: [], routePlanId: 'route-public' }));
  const handoff = {
    createdAt: new Date('2026-08-03T00:00:00.000Z'),
    destinationId: 'dest-a',
    expectedVersion: 'v1',
    expiresAt: new Date('2026-08-03T00:10:00.000Z'),
    groupingId: 'group-1',
    id: 'handoff-1',
    sourceDriverId: 'driver-1',
    sourceRoutePlanId: 'route-driver',
    status: options.handoffStatus ?? 'PROPOSED',
    targetDriverId: options.handoffTarget === 'review' ? 'driver-3' : 'driver-2',
    targetRoutePlanId: options.handoffTarget === 'review' ? 'route-review' : 'route-recipient'
  };
  const recordHandoffNotification = vi.fn(() => Promise.resolve());
  const dispatchByIdempotencyKey = vi.fn(() => Promise.resolve({ attemptId: 'attempt-1', status: 'SENT' as const }));
  const updateHandoffStatus = vi.fn((input: {
    status: 'APPLIED' | 'CANCELLED' | 'INVALIDATED' | 'PROCESSING' | 'REJECTED'
  }) => Promise.resolve({ ...handoff, status: input.status }));
  const repository: DriverDeliverySpaceRepositoryContract = {
    createHandoff: vi.fn(() => Promise.resolve(handoff)),
    filterAccessibleRoutePlanIds: vi.fn((input: { routePlanIds: readonly string[] }) => Promise.resolve(
      options.accessibleRoutePlanIds === undefined
        ? [...input.routePlanIds]
        : input.routePlanIds.filter((routePlanId) => options.accessibleRoutePlanIds?.includes(routePlanId) === true)
    )),
    findRouteContext: vi.fn((input: { driverId: string }) => Promise.resolve({
      childVersionId: input.driverId === 'driver-2' ? 'child-recipient' : 'child-driver',
      groupingId: 'group-1',
      groupingVersion: 1,
      isStoreReviewData: options.isStoreReviewData ?? false
    })),
    getHandoff: vi.fn(() => Promise.resolve(handoff)),
    listActiveHandoffs: vi.fn(() => Promise.resolve(options.activeHandoffs === true ? [handoff] : [])),
    listBundleOrders: vi.fn((input: { isStoreReviewData: boolean }) => Promise.resolve(
      input.isStoreReviewData ? options.reviewRows ?? rows : rows
    )),
    recordHandoffNotification,
    updateHandoffStatus
  };
  return {
    dispatchByIdempotencyKey,
    recordHandoffNotification,
    reassignMany,
    service: new DriverDeliverySpaceService(
      repository,
      { getGrouping } as unknown as RouteGroupingService,
      { reassignMany, unassignMany },
      () => options.now ?? new Date('2026-08-03T00:00:00.000Z'),
      { dispatchByIdempotencyKey }
    ),
    updateHandoffStatus,
    unassignMany
  };
}

function bundleOrders(owner: 'mine' | 'public' | 'target') {
  const driverId = owner === 'mine' ? 'driver-1' : owner === 'target' ? 'driver-2' : null;
  const routePlanId = owner === 'mine' ? 'route-driver' : owner === 'target' ? 'route-recipient' : 'route-public';
  return [
    { address: '서울 광진구', conditionCode: 'AMBIENT', currentRouteVersionId: 'version-a1', destinationId: 'dest-a', destinationName: '지오영', driverId, orderId: 'order-a1', routePlanId, shippedBoxes: 6 },
    { address: '서울 광진구', conditionCode: 'COLD', currentRouteVersionId: 'version-a2', destinationId: 'dest-a', destinationName: '지오영', driverId, orderId: 'order-a2', routePlanId, shippedBoxes: 3 }
  ];
}

function scope(overrides: Partial<ReturnType<typeof baseScope>> = {}) {
  return { ...baseScope(), ...overrides };
}

function baseScope() {
  return { accountId: 'account-1', driverId: 'driver-1', routePlanId: 'route-driver', shopDomain: 'dsv.test', shopId: 'shop-1', tokenVersion: 1 };
}

function groupingDetail(planDate = '2026-08-03', recipients = false, mixedRecipients = false): RouteGroupingDetailDto {
  const recipientChildren = recipients || mixedRecipients ? [recipientChild({
    driverId: 'driver-2',
    driverName: '양우진',
    routePlanId: 'route-recipient'
  })] : [];
  if (mixedRecipients) {
    recipientChildren.push(
      recipientChild({ driverId: 'driver-3', driverName: '검토 기사', routePlanId: 'route-review' }),
      recipientChild({ driverId: 'driver-4', driverName: '검토 배송원', routePlanId: 'route-review-recipient' })
    );
  }
  return {
    assignments: [], branches: [], children: recipientChildren, currentVersion: 1, dateRangeEnd: planDate, dateRangeStart: planDate,
    displayStatus: 'READY', id: 'group-1', linkedInventoryId: null, name: '배송', planDate, polygons: [],
    status: 'READY', totalOrders: 0, unresolvedOrders: 0, updatedAt: 'v1', warningState: []
  };
}

function recipientChild(input: { driverId: string; driverName: string; routePlanId: string }): RouteGroupingDetailDto['children'][number] {
  return {
      childVersion: 1,
      color: null,
      displayStatus: 'READY',
      driverId: input.driverId,
      driverName: input.driverName,
      notificationStatus: 'NOT_REQUIRED',
      orderIds: [],
      routeGeometry: null,
      routeMetrics: null,
      routePlan: null,
      routePlanId: input.routePlanId,
      routeIdx: null,
      routeStopPoints: [],
      sortOrder: 2,
      stops: [],
      stopsCount: 0,
      updatedAt: 'v1'
  };
}
