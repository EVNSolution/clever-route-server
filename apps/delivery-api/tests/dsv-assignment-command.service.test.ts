import { createHash } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import {
  DsvAssignmentCommandService,
  type DsvAssignmentCommandError,
  type DsvAssignmentCommandName,
} from '../src/modules/dsv/dsv-assignment-command.service.js';
import type {
  RouteGroupingDetailDto,
  RouteGroupingDraftRouteInput,
  RouteGroupingService,
} from '../src/modules/route-grouping/route-grouping.types.js';

type RoutePlanStopUpdateManyInput = {
  data: Record<string, unknown>;
  where: Record<string, unknown>;
};

describe('DsvAssignmentCommandService', () => {
  test('claims a receipt, moves assigned order to unassigned bucket, and records audit without removedOrderIds', async () => {
    const harness = createHarness();
    const result = await harness.service.unassign(adminInput({ commandId: 'cmd-unassign-1' }));

    expect(result).toMatchObject({
      assignmentStatus: 'UNASSIGNED',
      commandId: 'cmd-unassign-1',
      etaStatus: 'NOT_REQUIRED',
      newRouteVersionId: 'version-unassigned',
      previousRouteVersionId: 'version-route-a',
      routePlanId: 'route-unassigned',
      sellerOrderId: 'order-a',
    });
    const saveDraftInput = harness.savedDraftInput();
    expect(saveDraftInput).not.toHaveProperty('removedOrderIds');
    const routes = harness.savedRoutes();
    expect(routes.find((route: RouteGroupingDraftRouteInput) => route.routePlanId === 'route-a')?.orderIds).toEqual([]);
    expect(routes.find((route: RouteGroupingDraftRouteInput) => route.routePlanId === 'route-unassigned')?.orderIds).toEqual(['order-a']);
    const auditData = harness.createdAuditData();
    expect(auditData).toMatchObject({
      commandReceiptId: 'receipt-new',
      eventType: 'unassignSellerOrder',
      nextRouteVersionId: 'version-unassigned',
      previousRouteVersionId: 'version-route-a',
      sellerOrderId: 'order-a',
    });
  });

  test('reassign preserves history and inserts target sequence in one saveDraft call', async () => {
    const schedule = vi.fn();
    const harness = createHarness({ routeOptimizationScheduler: { schedule } });
    await harness.service.reassign({
      ...adminInput({ commandId: 'cmd-reassign-1' }),
      targetDriverId: 'driver-b',
      targetRoutePlanId: 'route-b',
      targetSequence: 1,
      targetVehicleId: 'vehicle-b',
    });

    expect(harness.routeGroupingService.saveDraft).toHaveBeenCalledTimes(1);
    const routes = harness.savedRoutes();
    expect(routes.find((route: RouteGroupingDraftRouteInput) => route.routePlanId === 'route-a')?.orderIds).toEqual([]);
    expect(routes.find((route: RouteGroupingDraftRouteInput) => route.routePlanId === 'route-b')?.orderIds).toEqual(['order-a']);
    const receiptUpdate = harness.updatedReceiptData();
    expect(receiptUpdate.data).toMatchObject({
      nextRoutePlanId: 'route-b',
      previousRoutePlanId: 'route-a',
      resultEntityType: 'SellerOrder',
      status: 'SUCCEEDED',
    });
    expect(receiptUpdate.where).toMatchObject({ status: 'STARTED' });
    expect(schedule).toHaveBeenCalledWith({
      routePlanIds: ['route-a', 'route-b'],
      shopDomain: 'example.myshopify.com',
    });
  });

  test('reassignMany moves 53 orders with one grouping save and one optimization schedule', async () => {
    const schedule = vi.fn();
    const orderIds = Array.from({ length: 53 }, (_, index) => `order-${index + 1}`);
    const grouping = groupingFixture();
    grouping.assignments = orderIds.map((orderId, index) => assignment(orderId, index + 1));
    if (grouping.children[0] !== undefined) grouping.children[0].orderIds = orderIds;
    grouping.totalOrders = orderIds.length;
    const harness = createHarness({ grouping, routeOptimizationScheduler: { schedule } });

    const result = await harness.service.reassignMany({
      actor: adminInput().actor,
      items: orderIds.map((sellerOrderId, index) => ({
        commandId: `cmd-batch-${index + 1}`,
        expectedVersion: 'version-route-a',
        sellerOrderId,
      })),
      reason: 'batch assignment',
      shopDomain: 'example.myshopify.com',
      targetDriverId: 'driver-b',
      targetRoutePlanId: 'route-b',
      targetVehicleId: 'vehicle-b',
    });

    expect(harness.routeGroupingService.saveDraft).toHaveBeenCalledTimes(1);
    expect(harness.savedRoutes().find((route) => route.routePlanId === 'route-a')?.orderIds).toEqual([]);
    expect(harness.savedRoutes().find((route) => route.routePlanId === 'route-b')?.orderIds).toEqual(orderIds);
    expect(result.assignmentResults.map((item) => item.sellerOrderId)).toEqual(orderIds);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test('unassignMany moves 53 orders atomically with one grouping save and one optimization schedule', async () => {
    const schedule = vi.fn();
    const orderIds = Array.from({ length: 53 }, (_, index) => `order-${index + 1}`);
    const grouping = groupingFixture();
    grouping.assignments = orderIds.map((orderId, index) => assignment(orderId, index + 1));
    if (grouping.children[0] !== undefined) grouping.children[0].orderIds = orderIds;
    grouping.totalOrders = orderIds.length;
    const harness = createHarness({ grouping, routeOptimizationScheduler: { schedule } });

    const result = await harness.service.unassignMany({
      actor: adminInput().actor,
      items: orderIds.map((sellerOrderId, index) => ({
        commandId: `cmd-batch-unassign-${index + 1}`,
        expectedVersion: 'version-route-a',
        sellerOrderId,
      })),
      reason: 'batch unassignment',
      shopDomain: 'example.myshopify.com',
    });

    expect(harness.routeGroupingService.saveDraft).toHaveBeenCalledTimes(1);
    expect(harness.savedRoutes().find((route) => route.routePlanId === 'route-a')?.orderIds).toEqual([]);
    expect(harness.savedRoutes().find((route) => route.routePlanId === 'route-unassigned')?.orderIds).toEqual(orderIds);
    expect(result.assignmentResults.map((item) => item.sellerOrderId)).toEqual(orderIds);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test('deleteMany removes 53 seller orders from one grouping and database transaction', async () => {
    const schedule = vi.fn();
    const orderIds = Array.from({ length: 53 }, (_, index) => `order-${index + 1}`);
    const grouping = groupingFixture();
    grouping.assignments = orderIds.map((orderId, index) => assignment(orderId, index + 1));
    if (grouping.children[0] !== undefined) grouping.children[0].orderIds = orderIds;
    grouping.totalOrders = orderIds.length;
    const harness = createHarness({ grouping, routeOptimizationScheduler: { schedule } });

    const result = await harness.service.deleteMany({
      actor: adminInput().actor,
      commandId: 'cmd-delete-53',
      items: orderIds.map((sellerOrderId) => ({ expectedVersion: 'version-route-a', sellerOrderId })),
      reason: 'demo hard delete',
      shopDomain: 'example.myshopify.com',
    });

    expect(harness.routeGroupingService.saveDraft).toHaveBeenCalledTimes(1);
    expect(harness.savedDraftInput()).toMatchObject({ removedOrderIds: orderIds });
    expect(harness.savedRoutes().find((route) => route.routePlanId === 'route-a')?.orderIds).toEqual([]);
    expect(harness.prisma.dsvDispatchImportRow.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { deliveryStopId: null, sellerOrderId: null },
    }));
    expect(harness.prisma.dsvCommandReceipt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { sellerOrderId: null },
      where: { sellerOrderId: { in: orderIds }, shopId: 'shop-1' },
    }));
    expect(harness.prisma.dsvAuditEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { sellerOrderId: null },
      where: { sellerOrderId: { in: orderIds }, shopId: 'shop-1' },
    }));
    expect(harness.prisma.order.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: orderIds }, shopId: 'shop-1' },
    }));
    expect(harness.prisma.dsvAuditEvent.createMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ commandId: 'cmd-delete-53', deletedSellerOrderIds: orderIds, receiptId: 'receipt-new' });
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test('deleteMany removes grouped and ungrouped seller orders in the same atomic request', async () => {
    const harness = createHarness({ ungroupedOrderIds: ['order-orphan'] });

    const result = await harness.service.deleteMany({
      actor: adminInput().actor,
      commandId: 'cmd-delete-mixed-ownership',
      items: [
        { expectedVersion: 'version-route-a', sellerOrderId: 'order-a' },
        { expectedVersion: 'UNASSIGNED', sellerOrderId: 'order-orphan' },
      ],
      reason: 'remove mixed dispatch rows',
      shopDomain: 'example.myshopify.com',
    });

    expect(harness.routeGroupingService.saveDraft).toHaveBeenCalledTimes(1);
    expect(harness.savedDraftInput()).toMatchObject({ removedOrderIds: ['order-a'] });
    expect(harness.prisma.order.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['order-a', 'order-orphan'] }, shopId: 'shop-1' },
    }));
    expect(result.deletedSellerOrderIds).toEqual(['order-a', 'order-orphan']);
  });

  test('deleteMany removes seller orders that belong to different route groupings', async () => {
    const secondGrouping = groupingFixture();
    secondGrouping.id = 'grouping-2';
    secondGrouping.assignments = [assignment('order-b', 1)];
    secondGrouping.children = [
      child({ driverId: 'driver-b', orderIds: ['order-b'], routePlanId: 'route-c', sortOrder: 1, vehicleId: 'vehicle-b' }),
      child({ driverId: null, orderIds: [], routePlanId: 'route-unassigned-b', sortOrder: 2, vehicleId: null }),
    ];
    secondGrouping.totalOrders = 1;
    const harness = createHarness({ secondaryGrouping: secondGrouping });

    const result = await harness.service.deleteMany({
      actor: adminInput().actor,
      commandId: 'cmd-delete-multiple-groupings',
      items: [
        { expectedVersion: 'version-route-a', sellerOrderId: 'order-a' },
        { expectedVersion: 'version-route-c', sellerOrderId: 'order-b' },
      ],
      reason: 'remove a complete service date',
      shopDomain: 'example.myshopify.com',
    });

    expect(harness.routeGroupingService.saveDraft).toHaveBeenCalledTimes(2);
    expect(harness.savedDraftInputs().map((draft) => ({ groupingId: draft.groupingId, removedOrderIds: draft.removedOrderIds }))).toEqual([
      { groupingId: 'grouping-1', removedOrderIds: ['order-a'] },
      { groupingId: 'grouping-2', removedOrderIds: ['order-b'] },
    ]);
    expect(result.deletedSellerOrderIds).toEqual(['order-a', 'order-b']);
  });

  test('deleteMany replays a completed batch without deleting again', async () => {
    const input = {
      actor: adminInput().actor,
      commandId: 'cmd-delete-replay',
      items: [{ expectedVersion: 'version-route-a', sellerOrderId: 'order-a' }],
      reason: 'demo hard delete',
      shopDomain: 'example.myshopify.com',
    };
    const replayResult = {
      commandId: input.commandId,
      deletedSellerOrderIds: ['order-a'],
      receiptId: 'receipt-existing',
    };
    const harness = createHarness({
      existingReceipt: {
        commandId: input.commandId,
        commandName: 'deleteSellerOrders',
        payloadHash: assignmentPayloadHash('deleteSellerOrders', input),
        responseBodyRef: JSON.stringify(replayResult),
        status: 'SUCCEEDED',
      },
    });

    await expect(harness.service.deleteMany(input)).resolves.toEqual(replayResult);
    expect(harness.routeGroupingService.saveDraft).not.toHaveBeenCalled();
    expect(harness.prisma.order.deleteMany).not.toHaveBeenCalled();
  });

  test('deleteMany rejects a mismatched or in-progress command receipt without deleting', async () => {
    const input = {
      actor: adminInput().actor,
      commandId: 'cmd-delete-guard',
      items: [{ expectedVersion: 'version-route-a', sellerOrderId: 'order-a' }],
      reason: 'demo hard delete',
      shopDomain: 'example.myshopify.com',
    };
    const mismatch = createHarness({
      existingReceipt: {
        commandId: input.commandId,
        commandName: 'deleteSellerOrders',
        payloadHash: 'different',
        responseBodyRef: null,
        status: 'SUCCEEDED',
      },
    });
    await expect(mismatch.service.deleteMany(input)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    } satisfies Partial<DsvAssignmentCommandError>);
    expect(mismatch.prisma.order.deleteMany).not.toHaveBeenCalled();

    const started = createHarness({
      existingReceipt: {
        commandId: input.commandId,
        commandName: 'deleteSellerOrders',
        payloadHash: assignmentPayloadHash('deleteSellerOrders', input),
        responseBodyRef: null,
        status: 'STARTED',
      },
    });
    await expect(started.service.deleteMany(input)).rejects.toMatchObject({
      code: 'COMMAND_IN_PROGRESS',
    } satisfies Partial<DsvAssignmentCommandError>);
    expect(started.prisma.order.deleteMany).not.toHaveBeenCalled();
  });

  test('reassign without target route uses the selected driver ready route when it exists', async () => {
    const harness = createHarness();

    await harness.service.reassign({
      ...adminInput({ commandId: 'cmd-reassign-existing-driver-route' }),
      targetDriverId: 'driver-b',
      targetVehicleId: 'vehicle-b',
    });

    expect(harness.routeGroupingService.saveDraft).toHaveBeenCalledTimes(1);
    const routes = harness.savedRoutes();
    expect(routes.find((route: RouteGroupingDraftRouteInput) => route.routePlanId === 'route-a')?.orderIds).toEqual([]);
    expect(routes.find((route: RouteGroupingDraftRouteInput) => route.routePlanId === 'route-b')?.orderIds).toEqual(['order-a']);
    expect(routes).not.toContainEqual(expect.objectContaining({ routePlanId: null, vehicleId: 'vehicle-b' }));
  });

  test('reassign without target route creates a driver draft route and requires a target vehicle', async () => {
    const missingVehicle = createHarness();
    await expect(missingVehicle.service.reassign({
      ...adminInput({ commandId: 'cmd-reassign-new-route-no-vehicle' }),
      targetDriverId: 'driver-c',
    })).rejects.toMatchObject({
      code: 'SELLER_ORDER_TARGET_VEHICLE_REQUIRED',
    } satisfies Partial<DsvAssignmentCommandError>);
    expect(missingVehicle.routeGroupingService.saveDraft).not.toHaveBeenCalled();

    const harness = createHarness();
    const result = await harness.service.reassign({
      ...adminInput({ commandId: 'cmd-reassign-new-route' }),
      targetDriverId: 'driver-c',
      targetSequence: 1,
      targetVehicleId: 'vehicle-c',
    });

    expect(result).toMatchObject({
      assignmentStatus: 'ASSIGNED',
      newRouteVersionId: 'version-route-new',
      routePlanId: 'route-new',
    });
    const newRoute = harness.savedRoutes().find((route: RouteGroupingDraftRouteInput) => route.routePlanId === null && route.driverId === 'driver-c');
    expect(newRoute).toMatchObject({
      orderIds: ['order-a'],
      vehicleId: 'vehicle-c',
    });
    expect(harness.updatedRoutePlanStops().at(-1)).toMatchObject({
      data: { etaInputRouteVersionId: 'version-route-new', etaStatus: 'PENDING' },
      where: { routePlanId: 'route-new' },
    });
  });

  test('reassign preserves other imported orders that have not been assigned to a route yet', async () => {
    const harness = createHarness({
      grouping: {
        ...groupingFixture(),
        assignments: [assignment('order-a', 1), assignment('order-b', 2)],
        children: [],
      },
    });

    await harness.service.reassign({
      ...adminInput({ commandId: 'cmd-reassign-imported-order', expectedVersion: 'UNASSIGNED' }),
      targetDriverId: 'driver-c',
      targetVehicleId: 'vehicle-c',
    });

    const routes = harness.savedRoutes();
    const remainingUnassigned = routes.find((route) => route.driverId === null);
    expect(remainingUnassigned?.orderIds).toEqual(['order-b']);
    expect(remainingUnassigned).not.toHaveProperty('routeIdx');
    expect(routes.find((route) => route.driverId === 'driver-c')?.orderIds).toEqual(['order-a']);
  });

  test('replays a succeeded command and rejects same id with different payload or STARTED receipt', async () => {
    const replay = createHarness({
      existingReceipt: {
        commandId: 'cmd-replay',
        commandName: 'unassignSellerOrder',
        payloadHash: assignmentPayloadHash('unassignSellerOrder', adminInput({ commandId: 'cmd-replay' })),
        responseBodyRef: JSON.stringify({
          assignmentStatus: 'UNASSIGNED',
          auditEventId: 'audit-existing',
          commandId: 'cmd-replay',
          etaStatus: 'NOT_REQUIRED',
          newRouteVersionId: 'version-unassigned',
          previousRouteVersionId: 'version-route-a',
          receiptId: 'receipt-existing',
          routePlanId: 'route-unassigned',
          sellerOrderId: 'order-a',
        }),
        status: 'SUCCEEDED',
      },
    });

    await expect(replay.service.unassign(adminInput({ commandId: 'cmd-replay' }))).resolves.toMatchObject({
      receiptId: 'receipt-existing',
    });
    expect(replay.routeGroupingService.saveDraft).not.toHaveBeenCalled();

    const mismatch = createHarness({
      existingReceipt: {
        commandId: 'cmd-replay',
        commandName: 'unassignSellerOrder',
        payloadHash: 'different',
        responseBodyRef: null,
        status: 'SUCCEEDED',
      },
    });
    await expect(mismatch.service.unassign(adminInput({ commandId: 'cmd-replay' }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    } satisfies Partial<DsvAssignmentCommandError>);

    const started = createHarness({
      existingReceipt: {
        commandId: 'cmd-started',
        commandName: 'unassignSellerOrder',
        payloadHash: assignmentPayloadHash('unassignSellerOrder', adminInput({ commandId: 'cmd-started' })),
        responseBodyRef: null,
        status: 'STARTED',
      },
    });
    await expect(started.service.unassign(adminInput({ commandId: 'cmd-started' }))).rejects.toMatchObject({
      code: 'COMMAND_IN_PROGRESS',
    } satisfies Partial<DsvAssignmentCommandError>);
  });

  test('rejects stale expected version, duplicate active owner, transfer closure, and vehicle mismatch before save', async () => {
    const stale = createHarness();
    await expect(stale.service.unassign(adminInput({ expectedVersion: 'stale' }))).rejects.toMatchObject({
      code: 'SELLER_ORDER_ASSIGNMENT_CHANGED',
    } satisfies Partial<DsvAssignmentCommandError>);
    expect(stale.routeGroupingService.saveDraft).not.toHaveBeenCalled();

    const duplicate = createHarness({
      grouping: groupingFixture({ duplicateOwner: true }),
    });
    await expect(duplicate.service.unassign(adminInput())).rejects.toMatchObject({
      code: 'DUPLICATE_ACTIVE_DELIVERY',
    } satisfies Partial<DsvAssignmentCommandError>);

    const closed = createHarness({
      grouping: groupingFixture({ routeAStatus: 'IN_PROGRESS' }),
    });
    await expect(closed.service.unassign(adminInput())).rejects.toMatchObject({
      code: 'SELLER_ORDER_TRANSFER_CLOSED',
    } satisfies Partial<DsvAssignmentCommandError>);

    const vehicleMismatch = createHarness();
    await expect(vehicleMismatch.service.reassign({
      ...adminInput(),
      targetDriverId: 'driver-b',
      targetRoutePlanId: 'route-b',
      targetVehicleId: 'wrong-vehicle',
    })).rejects.toMatchObject({
      code: 'SELLER_ORDER_TARGET_VEHICLE_REQUIRED',
    } satisfies Partial<DsvAssignmentCommandError>);
  });

  test('driver release and acquire enforce route scope and first-writer ownership', async () => {
    const release = createHarness();
    await release.service.release(driverInput({ commandId: 'cmd-release' }));
    expect(release.savedRoutes().find((route: RouteGroupingDraftRouteInput) => route.routePlanId === 'route-unassigned')?.orderIds).toEqual(['order-a']);

    const scoped = createHarness();
    await expect(scoped.service.release(driverInput({ driverId: 'driver-b' }))).rejects.toMatchObject({
      code: 'SELLER_ORDER_ROUTE_SCOPE_REJECTED',
    } satisfies Partial<DsvAssignmentCommandError>);

    const acquire = createHarness({ grouping: groupingFixture({ initiallyUnassigned: true }) });
    await acquire.service.acquire(driverInput({ commandId: 'cmd-acquire', expectedVersion: 'version-unassigned', sellerOrderId: 'order-a' }));
    expect(acquire.savedRoutes().find((route: RouteGroupingDraftRouteInput) => route.routePlanId === 'route-a')?.orderIds).toEqual(['order-a']);

    const alreadyOwned = createHarness();
    await expect(alreadyOwned.service.acquire(driverInput({ commandId: 'cmd-acquire-owned' }))).rejects.toMatchObject({
      code: 'SELLER_ORDER_ALREADY_ACQUIRED',
    } satisfies Partial<DsvAssignmentCommandError>);
  });

  test('updates canonical RoutePlanStop ETA ownership for every affected route', async () => {
    const harness = createHarness();

    await harness.service.unassign(adminInput({ commandId: 'cmd-eta-ownership' }));

    expect(harness.updatedRoutePlanStops()).toEqual([
      {
        data: {
          estimatedArrivalAt: null,
          etaCalculatedAt: null,
          etaFailureCode: null,
          etaFailureMessage: null,
          etaInputRouteVersionId: 'version-route-a',
          etaSource: null,
          etaStatus: 'PENDING',
        },
        where: { routePlanId: 'route-a' },
      },
      {
        data: {
          estimatedArrivalAt: null,
          etaCalculatedAt: null,
          etaFailureCode: null,
          etaFailureMessage: null,
          etaInputRouteVersionId: 'version-unassigned',
          etaSource: null,
          etaStatus: 'NOT_REQUIRED',
        },
        where: { routePlanId: 'route-unassigned' },
      },
    ]);
  });

  test('rewrites affected ETA rows even when a stop was previously failed', async () => {
    const harness = createHarness({ failedRoutePlanStops: 1 });

    const result = await harness.service.reassign({
      ...adminInput({ commandId: 'cmd-failed-eta-rewrite' }),
      targetDriverId: 'driver-b',
      targetRoutePlanId: 'route-b',
      targetVehicleId: 'vehicle-b',
    });

    expect(result.etaStatus).toBe('PENDING');
    expect(harness.prisma.routePlanStop.count).not.toHaveBeenCalled();
    expect(harness.updatedRoutePlanStops()).toEqual([
      {
        data: {
          estimatedArrivalAt: null,
          etaCalculatedAt: null,
          etaFailureCode: null,
          etaFailureMessage: null,
          etaInputRouteVersionId: 'version-route-a',
          etaSource: null,
          etaStatus: 'PENDING',
        },
        where: { routePlanId: 'route-a' },
      },
      {
        data: {
          estimatedArrivalAt: null,
          etaCalculatedAt: null,
          etaFailureCode: null,
          etaFailureMessage: null,
          etaInputRouteVersionId: 'version-route-b',
          etaSource: null,
          etaStatus: 'PENDING',
        },
        where: { routePlanId: 'route-b' },
      },
    ]);
  });

  test('does not add G005 or G006 read models, client storage, or ETA shadow projections', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/modules/dsv/dsv-assignment-command.service.ts', import.meta.url), 'utf8'));

    expect(source).not.toContain('/api/dsv/v1');
    expect(source).not.toContain('localStorage');
    expect(source).not.toMatch(/\b(?:DsvEta|dsvEta|dsv_eta|etaShadow|etaProjection)\b/u);
    expect(source).not.toMatch(/\bETA\s+(?:shadow|projection|table)\b/iu);
  });
});

function createHarness(input: {
  existingReceipt?: {
    commandId: string;
    commandName: DsvAssignmentCommandName;
    payloadHash: string;
    responseBodyRef: string | null;
    status: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  };
  failedRoutePlanStops?: number;
  grouping?: RouteGroupingDetailDto;
  routeOptimizationScheduler?: { schedule(input: { routePlanIds: Array<string | null>; shopDomain: string }): void };
  secondaryGrouping?: RouteGroupingDetailDto;
  ungroupedOrderIds?: string[];
} = {}) {
  const grouping = input.grouping ?? groupingFixture();
  const groupings = [grouping, ...(input.secondaryGrouping === undefined ? [] : [input.secondaryGrouping])];
  const currentRouteVersionIds = new Map<string, string | null>();
  const groupingIdByVersionId = new Map<string, string>();
  for (const candidateGrouping of groupings) {
    for (const child of candidateGrouping.children) {
      const versionId = routeVersionId(child.routePlanId);
      groupingIdByVersionId.set(versionId, candidateGrouping.id);
      for (const orderId of child.orderIds) {
        if (!currentRouteVersionIds.has(orderId)) currentRouteVersionIds.set(orderId, versionId);
      }
    }
    for (const assignment of candidateGrouping.assignments) {
      if (!currentRouteVersionIds.has(assignment.orderId)) currentRouteVersionIds.set(assignment.orderId, null);
    }
  }
  const saveDraft = vi.fn<RouteGroupingService['saveDraft']>((draftInput) => {
    const sourceGrouping = groupings.find((candidate) => candidate.id === draftInput.groupingId) ?? grouping;
    return Promise.resolve(groupingFromDraftRoutes(sourceGrouping, draftInput.routes));
  });
  const routeGroupingService = {
    getGrouping: vi.fn<RouteGroupingService['getGrouping']>(({ groupingId }) => Promise.resolve(groupings.find((candidate) => candidate.id === groupingId) ?? null)),
    saveDraft,
    saveDraftInTransaction: vi.fn((_tx: unknown, draftInput: Parameters<RouteGroupingService['saveDraft']>[0]) => saveDraft(draftInput)),
  };
  const prisma = {
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $queryRaw: vi.fn(() => Promise.resolve([{ locked: 1 }])),
    dsvAuditEvent: {
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        void args;
        return Promise.resolve({ id: 'audit-new' });
      }),
      createMany: vi.fn(() => Promise.resolve({ count: currentRouteVersionIds.size })),
      updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
    },
    dsvCommandReceipt: {
      create: vi.fn(() => Promise.resolve({ id: 'receipt-new' })),
      findUnique: vi.fn(() => Promise.resolve(input.existingReceipt === undefined ? null : {
        ...input.existingReceipt,
      })),
      updateMany: vi.fn((args: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        void args;
        return Promise.resolve({ count: 1 });
      }),
    },
    dsvDispatchImportRow: {
      updateMany: vi.fn(() => Promise.resolve({ count: currentRouteVersionIds.size })),
    },
    dsvVehicleDriverAssignment: {
      findFirst: vi.fn((args: { where?: { driverId?: string; vehicleId?: string } }) => {
        const expectedVehicleId = args.where?.driverId === 'driver-a'
          ? 'vehicle-a'
          : args.where?.driverId === 'driver-b'
            ? 'vehicle-b'
            : args.where?.driverId === 'driver-c'
              ? 'vehicle-c'
              : undefined;
        return Promise.resolve(expectedVehicleId === args.where?.vehicleId ? { id: `assignment-${args.where?.driverId}` } : null);
      }),
    },
    order: {
      deleteMany: vi.fn((args: { where?: { id?: { in?: string[] } } }) => Promise.resolve({
        count: args.where?.id?.in?.length ?? 0,
      })),
      findMany: vi.fn((args: { where?: { id?: { in?: string[] } } }) => Promise.resolve(
        (args.where?.id?.in ?? []).map((id) => ({
          currentRouteVersionId: currentRouteVersionIds.get(id) ?? null,
          customerId: 'customer-a',
          destinationId: 'destination-x',
          id,
        })),
      )),
      findFirst: vi.fn((args: { select?: { currentRouteVersionId?: boolean }; where?: { id?: string } }) => Promise.resolve(
        args.select?.currentRouteVersionId === true
          ? { currentRouteVersionId: currentRouteVersionIds.get(args.where?.id ?? 'order-a') ?? null }
          : { customerId: 'customer-a', destinationId: 'destination-x' },
      )),
      updateMany: vi.fn((args: { data: { currentRouteVersionId?: string | null }; where?: { id?: string } }) => {
        currentRouteVersionIds.set(args.where?.id ?? 'order-a', args.data.currentRouteVersionId ?? null);
        return Promise.resolve({ count: 1 });
      }),
    },
    routeGroupingChildVersion: {
      findFirst: vi.fn((args: { where?: { currentOrders?: unknown; id?: string; routePlanId?: string | null } }) => {
        if (args.where?.currentOrders !== undefined) return { groupingId: 'grouping-1' };
        if (args.where?.id !== undefined) {
          const groupingId = groupingIdByVersionId.get(args.where.id);
          const routePlanId = groupings.flatMap((candidate) => candidate.children).find((candidate) => routeVersionId(candidate.routePlanId) === args.where?.id)?.routePlanId;
          return groupingId === undefined || routePlanId === undefined ? null : { groupingId, routePlanId };
        }
        if (args.where?.id === 'version-route-new') return { groupingId: 'grouping-1', routePlanId: 'route-new' };
        if (args.where?.id === 'version-unassigned') return { groupingId: 'grouping-1', routePlanId: 'route-unassigned' };
        if (args.where?.routePlanId !== undefined) {
          const child = groupings.flatMap((candidate) => candidate.children).find((candidate) => candidate.routePlanId === args.where?.routePlanId);
          if (child !== undefined) return { driverId: child.driverId, id: routeVersionId(child.routePlanId), routePlanId: child.routePlanId };
        }
        if (args.where?.routePlanId === 'route-new') return { driverId: 'driver-c', id: 'version-route-new', routePlanId: 'route-new' };
        if (args.where?.routePlanId === 'route-unassigned') return { driverId: null, id: 'version-unassigned', routePlanId: 'route-unassigned' };
        return Promise.resolve(null);
      }),
    },
    routeGroupingOrder: {
      findFirst: vi.fn((args: { where?: { orderId?: string } }) => {
        const orderId = args.where?.orderId ?? '';
        if (input.ungroupedOrderIds?.includes(orderId) === true) return Promise.resolve(null);
        const ownerGrouping = groupings.find((candidate) => candidate.assignments.some((assignment) => assignment.orderId === orderId));
        return Promise.resolve(ownerGrouping === undefined ? null : { groupingId: ownerGrouping.id });
      }),
    },
    routePlan: {
      findFirst: vi.fn((args: { where?: { id?: string } }) => {
        if (args.where?.id === 'route-a') return Promise.resolve({ vehicleId: 'vehicle-a' });
        if (args.where?.id === 'route-b') return Promise.resolve({ vehicleId: 'vehicle-b' });
        if (args.where?.id === 'route-new') return Promise.resolve({ vehicleId: 'vehicle-c' });
        if (args.where?.id === 'route-unassigned') return Promise.resolve({ vehicleId: null });
        return Promise.resolve(null);
      }),
    },
    routePlanStop: {
      count: vi.fn(() => Promise.resolve(input.failedRoutePlanStops ?? 0)),
      updateMany: vi.fn<(args: RoutePlanStopUpdateManyInput) => Promise<{ count: number }>>(() => Promise.resolve({ count: 1 })),
    },
    shop: {
      findUnique: vi.fn(() => Promise.resolve({ id: 'shop-1' })),
    },
    vehicle: {
      findFirst: vi.fn((args: { where?: { id?: string } }) => {
        if (args.where?.id === 'vehicle-a' || args.where?.id === 'vehicle-b' || args.where?.id === 'vehicle-c') {
          return Promise.resolve({ id: args.where.id });
        }
        return Promise.resolve(null);
      }),
    },
  };
  const service = new DsvAssignmentCommandService(
    prisma as never,
    routeGroupingService as unknown as RouteGroupingService,
    input.routeOptimizationScheduler,
  );
  return {
    prisma,
    routeGroupingService,
    createdAuditData: (): Record<string, unknown> => {
      const call = prisma.dsvAuditEvent.create.mock.calls.at(-1);
      const args = call?.[0] as { data: Record<string, unknown> } | undefined;
      return args?.data ?? {};
    },
    savedDraftInput: () => {
      const call = vi.mocked(routeGroupingService.saveDraft).mock.calls.at(-1);
      return call?.[0] ?? {};
    },
    savedDraftInputs: () => vi.mocked(routeGroupingService.saveDraft).mock.calls.map((call) => call[0]),
    savedRoutes: () => {
      const call = vi.mocked(routeGroupingService.saveDraft).mock.calls.at(-1);
      return call?.[0].routes ?? [];
    },
    service,
    updatedReceiptData: () => {
      const call = prisma.dsvCommandReceipt.updateMany.mock.calls.at(-1);
      return call?.[0] ?? { data: {}, where: {} };
    },
    updatedRoutePlanStops: () => prisma.routePlanStop.updateMany.mock.calls.map((call) => call[0]),
  };
}

function adminInput(overrides: Partial<Parameters<DsvAssignmentCommandService['unassign']>[0]> = {}) {
  return {
    actor: { actorId: 'admin-1', actorType: 'DSV_ADMIN' as const, principalType: 'DSV_ADMIN' as const, requestId: 'request-1' },
    commandId: 'cmd-1',
    expectedVersion: 'version-route-a',
    reason: 'manual correction',
    sellerOrderId: 'order-a',
    shopDomain: 'example.myshopify.com',
    ...overrides,
  };
}

function assignmentPayloadHash(commandName: DsvAssignmentCommandName, input: unknown): string {
  return createHash('sha256').update(canonicalJson({ commandName, input: stableAssignmentInput(input) })).digest('hex');
}

function stableAssignmentInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const actor = record.actor;
  return {
    ...record,
    actor: actor !== null && typeof actor === 'object' && !Array.isArray(actor)
      ? Object.fromEntries(Object.entries(actor as Record<string, unknown>).filter(([key]) => key !== 'requestId'))
      : actor,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function groupingFromDraftRoutes(grouping: RouteGroupingDetailDto, routes: RouteGroupingDraftRouteInput[]): RouteGroupingDetailDto {
  const newDriverRoutes = routes
    .filter((route) => route.routePlanId === null && route.driverId !== null && route.driverId !== undefined)
    .map((route) => child({
      driverId: route.driverId ?? null,
      orderIds: route.orderIds,
      routePlanId: 'route-new',
      sortOrder: route.sortOrder ?? 4,
      vehicleId: route.vehicleId ?? null,
    }));
  return {
    ...grouping,
    children: [...grouping.children.map((child) => ({
      ...child,
      orderIds: routes.find((route) => route.routePlanId === child.routePlanId)?.orderIds ?? child.orderIds,
    })), ...newDriverRoutes],
  };
}

function routeVersionId(routePlanId: string | null): string {
  if (routePlanId === null) return 'version-null-route';
  return routePlanId === 'route-unassigned' ? 'version-unassigned' : `version-${routePlanId}`;
}

function driverInput(overrides: Partial<Parameters<DsvAssignmentCommandService['release']>[0]> = {}) {
  return {
    accountId: 'account-a',
    commandId: 'cmd-driver-1',
    driverId: 'driver-a',
    expectedVersion: 'version-route-a',
    orderId: 'legacy-order-id',
    reason: 'driver request',
    routePlanId: 'route-a',
    sellerOrderId: 'order-a',
    shopDomain: 'example.myshopify.com',
    shopId: 'shop-1',
    ...overrides,
  };
}

function groupingFixture(input: {
  duplicateOwner?: boolean;
  initiallyUnassigned?: boolean;
  routeAStatus?: 'READY' | 'IN_PROGRESS';
} = {}): RouteGroupingDetailDto {
  const orderA = assignment('order-a', 1);
  const routeAOrderIds = input.initiallyUnassigned === true ? [] : ['order-a'];
  const unassignedOrderIds = input.initiallyUnassigned === true ? ['order-a'] : [];
  return {
    assignments: [orderA],
    branches: [],
    children: [
      child({ displayStatus: input.routeAStatus ?? 'READY', driverId: 'driver-a', orderIds: routeAOrderIds, routePlanId: 'route-a', sortOrder: 1, vehicleId: 'vehicle-a' }),
      child({ driverId: 'driver-b', orderIds: input.duplicateOwner === true ? ['order-a'] : [], routePlanId: 'route-b', sortOrder: 2, vehicleId: 'vehicle-b' }),
      child({ driverId: null, orderIds: unassignedOrderIds, routePlanId: 'route-unassigned', sortOrder: 3, vehicleId: null }),
    ],
    currentVersion: 1,
    dateRangeEnd: '2026-07-22',
    dateRangeStart: '2026-07-22',
    displayStatus: 'READY',
    id: 'grouping-1',
    linkedInventoryId: null,
    name: 'Dispatch',
    planDate: '2026-07-22',
    polygons: [],
    status: 'READY',
    switchRoutes: [],
    totalOrders: 1,
    unresolvedOrders: 0,
    updatedAt: '2026-07-22T10:00:00.000Z',
    warningState: [],
  };
}

function child(input: {
  displayStatus?: 'READY' | 'IN_PROGRESS';
  driverId: string | null;
  orderIds: string[];
  routePlanId: string;
  sortOrder: number;
  vehicleId: string | null;
}): RouteGroupingDetailDto['children'][number] {
  return {
    childVersion: 1,
    color: null,
    displayStatus: input.displayStatus ?? 'READY',
    driverId: input.driverId,
    driverName: null,
    notificationStatus: 'NOT_REQUIRED',
    orderIds: input.orderIds,
    routeGeometry: null,
    routeIdx: input.sortOrder,
    routeMetrics: null,
    routePlan: {
      createdAt: '2026-07-22T09:00:00.000Z',
      deliveryAreas: [],
      deliveryDays: [],
      depot: { latitude: null, longitude: null },
      driver: null,
      driverId: input.driverId,
      id: input.routePlanId,
      itemSummary: { changedSincePublish: false, fingerprint: 'empty', itemTypes: 0, items: [], totalQuantity: 0 },
      missingCoordinates: 0,
      name: input.routePlanId,
      planDate: '2026-07-22',
      routeEndMode: 'RETURN_TO_DEPOT',
      status: 'READY',
      stopsCount: input.orderIds.length,
      updatedAt: '2026-07-22T09:00:00.000Z',
    },
    routePlanId: input.routePlanId,
    routeStopPoints: [],
    sortOrder: input.sortOrder,
    stops: input.orderIds.map((orderId, index) => assignment(orderId, index + 1)),
    stopsCount: input.orderIds.length,
    updatedAt: '2026-07-22T09:00:00.000Z',
  };
}

function assignment(orderId: string, sourceSequence: number): RouteGroupingDetailDto['assignments'][number] {
  return {
    addressLabel: 'Seoul',
    assignedDriverId: null,
    assignedPolygonId: null,
    assignmentStatus: 'ASSIGNED',
    coordinates: { latitude: null, longitude: null },
    deliveryStopId: `stop-${orderId}`,
    email: null,
    itemCount: 1,
    orderId,
    orderName: orderId,
    phone: null,
    recipientName: null,
    sourceOrderId: `seller-${orderId}`,
    sourceSequence,
  };
}
