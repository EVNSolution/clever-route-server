import { describe, expect, test, vi } from 'vitest';

import { PrismaDsvDispatchChangeRequestService } from '../src/modules/dsv/dsv-dispatch-change-request.service.js';
import type { DsvDispatchChangeRequestError } from '../src/modules/dsv/dsv-dispatch-change-request.service.js';

const shopId = '99999999-9999-4999-8999-999999999999';
const sellerOrderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deliveryStopId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const routeVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const routePlanId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('PrismaDsvDispatchChangeRequestService', () => {
  test('creates a pending active removal request and dispatches the driver notification', async () => {
    const harness = createHarness();
    const service = new PrismaDsvDispatchChangeRequestService(harness.prisma as never, harness.dispatcher);

    const result = await service.requestActiveRemoval(requestInput({ commandId: 'cmd-request-removal' }));

    expect(result).toEqual({
      changeRequestId: 'change-request-new',
      commandId: 'cmd-request-removal',
      deliveryStopId,
      sellerOrderId,
      status: 'PENDING_ACK',
      type: 'ACTIVE_ROUTE_ORDER_REMOVAL',
    });
    expect(harness.tx.dsvDispatchChangeRequest.create).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        commandReceiptId: 'receipt-new',
        deliveryStopId,
        priorSnapshot: { currentRouteVersionId: routeVersionId },
        removalReason: 'ACTIVE_ROUTE_ORDER_REMOVAL',
        routePlanId,
        routeVersionId,
        sellerOrderId,
        shopId,
        type: 'ACTIVE_ROUTE_ORDER_REMOVAL',
      }),
      select: { id: true },
    });
    expect(harness.tx.driverRouteNotificationAttempt.upsert).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      create: expect.objectContaining({
        idempotencyKey: 'dsv-dispatch-change:change-request-new',
        metadata: { changeRequestId: 'change-request-new' },
        routePlanId,
        shopId,
        status: 'PENDING',
      }),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      update: expect.objectContaining({
        metadata: { changeRequestId: 'change-request-new' },
        status: 'PENDING',
      }),
      where: { idempotencyKey: 'dsv-dispatch-change:change-request-new' },
    });
    expect(harness.dispatcher.dispatchByIdempotencyKey).toHaveBeenCalledWith('dsv-dispatch-change:change-request-new');
  });

  test('replays a completed active removal command without repeating side effects', async () => {
    const harness = createHarness();
    const service = new PrismaDsvDispatchChangeRequestService(harness.prisma as never, harness.dispatcher);

    const first = await service.requestActiveRemoval(requestInput({ commandId: 'cmd-replay-removal' }));
    const replay = await service.requestActiveRemoval(requestInput({ commandId: 'cmd-replay-removal' }));

    expect(replay).toEqual(first);
    expect(harness.tx.dsvCommandReceipt.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.dsvDispatchChangeRequest.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.driverRouteNotificationAttempt.upsert).toHaveBeenCalledTimes(1);
    expect(harness.dispatcher.dispatchByIdempotencyKey).toHaveBeenCalledTimes(2);
  });

  test('rejects active removal command replay when the payload does not match', async () => {
    const harness = createHarness();
    const service = new PrismaDsvDispatchChangeRequestService(harness.prisma as never, harness.dispatcher);
    await service.requestActiveRemoval(requestInput({ commandId: 'cmd-mismatch-removal' }));

    await expect(service.requestActiveRemoval(requestInput({
      commandId: 'cmd-mismatch-removal',
      deliveryStopId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      name: 'DsvDispatchChangeRequestError',
    } satisfies Partial<DsvDispatchChangeRequestError>);

    expect(harness.tx.dsvDispatchChangeRequest.create).toHaveBeenCalledTimes(1);
  });

  test('rejects active removal when a matching pending acknowledgement already exists', async () => {
    const harness = createHarness({ pendingChangeRequest: { id: 'change-request-existing' } });
    const service = new PrismaDsvDispatchChangeRequestService(harness.prisma as never, harness.dispatcher);

    await expect(service.requestActiveRemoval(requestInput({ commandId: 'cmd-pending-conflict' }))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });

    expect(harness.tx.dsvDispatchChangeRequest.create).not.toHaveBeenCalled();
    expect(harness.tx.driverRouteNotificationAttempt.upsert).not.toHaveBeenCalled();
  });

  test('rejects active removal when the delivery stop does not belong to the order route', async () => {
    const harness = createHarness({ deliveryStop: null });
    const service = new PrismaDsvDispatchChangeRequestService(harness.prisma as never, harness.dispatcher);

    await expect(service.requestActiveRemoval(requestInput({ commandId: 'cmd-wrong-stop' }))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });

    expect(harness.tx.dsvDispatchChangeRequest.create).not.toHaveBeenCalled();
    expect(harness.tx.driverRouteNotificationAttempt.upsert).not.toHaveBeenCalled();
  });

  test('cancels a pending change request when the expected version matches', async () => {
    const harness = createHarness();
    const service = new PrismaDsvDispatchChangeRequestService(harness.prisma as never, harness.dispatcher);

    await expect(service.cancel(cancelInput({ commandId: 'cmd-cancel-request' }))).resolves.toEqual({
      changeRequestId: 'change-request-existing',
      commandId: 'cmd-cancel-request',
      deliveryStopId,
      sellerOrderId,
      status: 'CANCELLED',
      type: 'ACTIVE_ROUTE_ORDER_REMOVAL',
    });

    expect(harness.tx.dsvDispatchChangeRequest.updateMany).toHaveBeenCalledWith({
      data: { status: 'CANCELLED' },
      where: { id: 'change-request-existing', shopId, status: 'PENDING_ACK' },
    });
  });

  test('rejects cancellation when the expected version is stale', async () => {
    const harness = createHarness();
    const service = new PrismaDsvDispatchChangeRequestService(harness.prisma as never, harness.dispatcher);

    await expect(service.cancel(cancelInput({
      commandId: 'cmd-cancel-stale',
      expectedVersion: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    }))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    expect(harness.tx.dsvDispatchChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  test('rejects cancellation when acknowledgement wins the status transition race', async () => {
    const harness = createHarness({ cancelUpdateCount: 0 });
    const service = new PrismaDsvDispatchChangeRequestService(harness.prisma as never, harness.dispatcher);

    await expect(service.cancel(cancelInput({ commandId: 'cmd-cancel-race' }))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });

    expect(harness.tx.dsvCommandReceipt.updateMany).not.toHaveBeenCalled();
  });

  test('recovers a cancelled unassigned order back to ready', async () => {
    const harness = createHarness({ order: { currentRouteVersionId: null, deliveryStatus: 'CANCELLED', id: sellerOrderId } });
    const service = new PrismaDsvDispatchChangeRequestService(harness.prisma as never, harness.dispatcher);

    await expect(service.recoverCancelledToUnassigned(recoveryInput({ commandId: 'cmd-recover-cancelled' }))).resolves.toEqual({
      commandId: 'cmd-recover-cancelled',
      operationStatus: 'UNASSIGNED',
      sellerOrderId,
    });

    expect(harness.tx.order.updateMany).toHaveBeenCalledWith({
      data: { deliveryStatus: 'READY' },
      where: { currentRouteVersionId: null, deliveryStatus: 'CANCELLED', id: sellerOrderId, shopId },
    });
  });

  test('rejects recovery when the cancelled order is still assigned to a route', async () => {
    const harness = createHarness({ order: { currentRouteVersionId: routeVersionId, deliveryStatus: 'CANCELLED', id: sellerOrderId } });
    const service = new PrismaDsvDispatchChangeRequestService(harness.prisma as never, harness.dispatcher);

    await expect(service.recoverCancelledToUnassigned(recoveryInput({ commandId: 'cmd-recover-assigned' }))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });

    expect(harness.tx.order.updateMany).not.toHaveBeenCalled();
  });
});

function createHarness(input: {
  cancelUpdateCount?: number;
  deliveryStop?: { id: string } | null;
  order?: { currentRouteVersionId: string | null; deliveryStatus?: string; id: string };
  pendingChangeRequest?: { id: string } | null;
} = {}) {
  let receipt: ({ id: string; payloadHash: string; responseBodyRef: string | null; status: string } & Record<string, unknown>) | null = null;
  const routedOrder = {
    currentRouteVersion: {
      driverId: 'driver-1',
      groupingId: 'grouping-1',
      id: routeVersionId,
      routePlan: { status: 'IN_PROGRESS' },
      routePlanId,
      version: 7,
    },
    currentRouteVersionId: routeVersionId,
    id: sellerOrderId,
  };
  const receiptRepository = {
    create: vi.fn((args: { data: { payloadHash: string } & Record<string, unknown> }) => {
      receipt = {
        ...args.data,
        id: 'receipt-new',
        responseBodyRef: null,
        status: 'STARTED',
      };
      return Promise.resolve({ id: 'receipt-new' });
    }),
    findUnique: vi.fn(() => Promise.resolve(receipt)),
    updateMany: vi.fn((args: { data: Record<string, unknown>; where: { commandId: string; commandName: string; payloadHash: string; shopId: string; status: string } }) => {
      if (
        receipt === null
        || receipt.commandId !== args.where.commandId
        || receipt.commandName !== args.where.commandName
        || receipt.payloadHash !== args.where.payloadHash
        || receipt.shopId !== args.where.shopId
        || receipt.status !== args.where.status
      ) {
        return Promise.resolve({ count: 0 });
      }
      receipt = {
        ...receipt,
        ...args.data,
        responseBodyRef: args.data.responseBodyRef as string,
        status: args.data.status as string,
      };
      return Promise.resolve({ count: 1 });
    }),
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    deliveryStop: {
      findFirst: vi.fn().mockResolvedValue(input.deliveryStop === undefined ? { id: deliveryStopId } : input.deliveryStop),
    },
    driverRouteNotificationAttempt: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    dsvCommandReceipt: receiptRepository,
    dsvDispatchChangeRequest: {
      create: vi.fn().mockResolvedValue({ id: 'change-request-new' }),
      findFirst: vi.fn((args: { where: { id?: string; status?: string } }) => {
        if (args.where.id !== undefined) {
          return Promise.resolve({
            deliveryStopId,
            id: 'change-request-existing',
            routeVersionId,
            sellerOrderId,
            status: 'PENDING_ACK',
            type: 'ACTIVE_ROUTE_ORDER_REMOVAL',
          });
        }
        return Promise.resolve(input.pendingChangeRequest ?? null);
      }),
      updateMany: vi.fn().mockResolvedValue({ count: input.cancelUpdateCount ?? 1 }),
    },
    order: {
      findFirst: vi.fn((args: { select: Record<string, unknown> }) => {
        if ('deliveryStatus' in args.select) {
          return Promise.resolve(input.order ?? { currentRouteVersionId: null, deliveryStatus: 'CANCELLED', id: sellerOrderId });
        }
        return Promise.resolve(routedOrder);
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn((fn: (transaction: typeof tx) => unknown) => fn(tx)),
    driverRouteNotificationAttempt: tx.driverRouteNotificationAttempt,
    dsvCommandReceipt: receiptRepository,
    dsvDispatchChangeRequest: tx.dsvDispatchChangeRequest,
    deliveryStop: tx.deliveryStop,
    order: tx.order,
    shop: { findUnique: vi.fn().mockResolvedValue({ id: shopId }) },
  };
  const dispatcher = {
    dispatchByIdempotencyKey: vi.fn().mockResolvedValue({ attemptId: 'attempt-1', status: 'SENT' }),
  };
  return { dispatcher, prisma, tx };
}

function requestInput(input: {
  commandId?: string;
  deliveryStopId?: string;
  expectedVersion?: string;
} = {}) {
  return {
    actor: { actorId: 'admin-1', actorType: 'DSV_ADMIN', principalType: 'DSV_ADMIN', requestId: 'req-1' },
    commandId: input.commandId ?? 'cmd-request-removal',
    deliveryStopId: input.deliveryStopId ?? deliveryStopId,
    expectedVersion: input.expectedVersion ?? routeVersionId,
    sellerOrderId,
    shopDomain: 'Example.MyShopify.Com',
  } as const;
}

function cancelInput(input: {
  commandId?: string;
  expectedVersion?: string | null;
} = {}) {
  return {
    actor: { actorId: 'admin-1', actorType: 'DSV_ADMIN', principalType: 'DSV_ADMIN', requestId: 'req-1' },
    changeRequestId: 'change-request-existing',
    commandId: input.commandId ?? 'cmd-cancel-request',
    expectedVersion: input.expectedVersion ?? routeVersionId,
    shopDomain: 'Example.MyShopify.Com',
  } as const;
}

function recoveryInput(input: { commandId?: string } = {}) {
  return {
    actor: { actorId: 'admin-1', actorType: 'DSV_ADMIN', principalType: 'DSV_ADMIN', requestId: 'req-1' },
    commandId: input.commandId ?? 'cmd-recover-cancelled',
    sellerOrderId,
    shopDomain: 'Example.MyShopify.Com',
  } as const;
}
