import { describe, expect, test, vi } from 'vitest';

import {
  DsvTimeConstraintCommandError,
  PrismaDsvTimeConstraintCommandService,
} from '../src/modules/dsv/dsv-time-constraint-command.service.js';
import { dsvAllowedTimeConstraintRedactedDiffKeys, dsvCanonicalNoteHash } from '../src/modules/dsv/dsv-time-constraint.js';

const shopId = '99999999-9999-4999-8999-999999999999';
const sellerOrderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deliveryStopId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const routeVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const routePlanId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('DSV time constraint command service', () => {
  test('confirms an unassigned stop with existing time window fields and redacted audit only', async () => {
    const harness = createHarness({
      currentRouteVersionId: null,
      currentRouteVersion: null,
      instructions: '오전 11시 배송',
    });
    const service = new PrismaDsvTimeConstraintCommandService(harness.prisma as never);

    const result = await service.confirm(command({
      expectedVersion: 'UNASSIGNED',
      timeWindowEnd: '11:00',
      timeWindowStart: '10:30',
    }));

    expect(result).toMatchObject({
      auditEventId: 'audit-1',
      deliveryStopId,
      rawNote: '오전 11시 배송',
      recalculation: {
        reason: 'UNASSIGNED_ORDER',
        retryable: false,
        routePlanId: null,
        status: 'NOT_REQUIRED',
      },
      reviewStatus: 'CONFIRMED',
      routeConstraintStatus: 'NOT_EVALUATED',
      sellerOrderId,
      sellerOrderKey: '2018330248',
      timeConstraint: {
        auditEventId: 'audit-1',
        status: 'CONFIRMED',
        timeWindowEnd: '11:00',
        timeWindowStart: '10:30',
      },
    });
    expect(harness.tx.deliveryStop.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        timeWindowEnd: new Date('1970-01-01T11:00:00.000Z'),
        timeWindowStart: new Date('1970-01-01T10:30:00.000Z'),
      },
    }));
    const auditData = firstMockArg<{ data: { redactedDiff: Record<string, unknown> } }>(harness.tx.dsvAuditEvent.create)?.data;
    expect(auditData).not.toHaveProperty('customerId');
    expect(auditData).not.toHaveProperty('destinationId');
    expect(Object.keys(auditData?.redactedDiff ?? {}).sort()).toEqual([...dsvAllowedTimeConstraintRedactedDiffKeys].sort());
    expect(JSON.stringify(auditData?.redactedDiff)).not.toMatch(/오전|address|customer|destination|driver|vehicle|geometry|routeConstraintStatus/u);
    expect(auditData?.redactedDiff.noteHash).toBe(dsvCanonicalNoteHash('오전 11시 배송'));
  });

  test('assigned absent scheduler is persisted as retryable failure and replayed without side effects', async () => {
    const harness = createHarness({
      currentRouteVersionId: routeVersionId,
      currentRouteVersion: { createdAt: new Date('2026-08-03T09:40:00.000Z'), routePlanId },
      instructions: '오전 11시 배송',
    });
    const logger = { warn: vi.fn() };
    const service = new PrismaDsvTimeConstraintCommandService(harness.prisma as never, undefined, logger);

    const first = await service.clear({
      ...clearCommand(),
      expectedVersion: routeVersionId,
    });
    const replay = await service.clear({
      ...clearCommand(),
      expectedVersion: routeVersionId,
    });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      recalculation: {
        reason: 'SCHEDULER_UNAVAILABLE',
        retryable: true,
        routePlanId,
        status: 'FAILED_TO_SCHEDULE',
      },
      routeConstraintStatus: 'PENDING_RECALCULATION',
    });
    expect(harness.prisma.dsvCommandReceipt.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.receipt()?.status).toBe('SUCCEEDED');
    expect(JSON.parse(harness.receipt()?.responseBodyRef ?? 'null')).toEqual(first);
    expect(harness.tx.deliveryStop.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.tx.dsvAuditEvent.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.dsvCommandReceipt.create).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      deliveryStopId,
      errorType: 'Error',
      event: 'dsv_time_constraint_recalculation_schedule_failed',
      routePlanId,
      sellerOrderId,
      shopId,
    }, 'DSV time constraint recalculation scheduling failed');
    expect(JSON.stringify(firstMockArg(logger.warn))).not.toMatch(/오전|rawNote|address|customer|destination|driver|vehicle|geometry/u);
  });

  test('assigned scheduler failure is persisted, replayed exactly, and does not repeat side effects', async () => {
    const harness = createHarness({
      currentRouteVersionId: routeVersionId,
      currentRouteVersion: { createdAt: new Date('2026-08-03T09:40:00.000Z'), routePlanId },
      instructions: '오전 11시 배송',
    });
    const scheduler = { schedule: vi.fn(() => { throw new Error('scheduler down'); }) };
    const logger = { warn: vi.fn() };
    const service = new PrismaDsvTimeConstraintCommandService(harness.prisma as never, scheduler, logger);

    const first = await service.confirm(command({
      expectedVersion: routeVersionId,
      timeWindowEnd: '11:00',
      timeWindowStart: '10:30',
    }));
    const replay = await service.confirm(command({
      expectedVersion: routeVersionId,
      timeWindowEnd: '11:00',
      timeWindowStart: '10:30',
    }));

    expect(replay).toEqual(first);
    expect(harness.prisma.dsvCommandReceipt.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.receipt()?.status).toBe('SUCCEEDED');
    expect(typeof harness.receipt()?.responseBodyRef).toBe('string');
    expect(JSON.parse(harness.receipt()?.responseBodyRef ?? 'null')).toEqual(first);
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    expect(scheduler.schedule).toHaveBeenCalledWith({
      routePlanIds: [routePlanId],
      shopDomain: 'tomatonofood.com',
    });
    expect(harness.tx.deliveryStop.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.tx.dsvAuditEvent.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.dsvCommandReceipt.create).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      recalculation: {
        reason: 'SCHEDULER_UNAVAILABLE',
        retryable: true,
        routePlanId,
        status: 'FAILED_TO_SCHEDULE',
      },
      routeConstraintStatus: 'PENDING_RECALCULATION',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      deliveryStopId,
      errorType: 'Error',
      event: 'dsv_time_constraint_recalculation_schedule_failed',
      routePlanId,
      sellerOrderId,
      shopId,
    }, 'DSV time constraint recalculation scheduling failed');
    expect(JSON.stringify(firstMockArg(logger.warn))).not.toMatch(/오전|rawNote|address|customer|destination|driver|vehicle|geometry/u);
  });

  test('defers an in-progress route time change until driver acknowledgement', async () => {
    const harness = createHarness({
      currentRouteVersionId: routeVersionId,
      currentRouteVersion: {
        createdAt: new Date('2026-08-03T09:40:00.000Z'),
        driverId: 'driver-1',
        groupingId: 'grouping-1',
        id: routeVersionId,
        routePlan: { status: 'IN_PROGRESS' },
        routePlanId,
        version: 7,
      },
      instructions: '오전 11시 배송',
    });
    const dispatcher = { dispatchByIdempotencyKey: vi.fn().mockResolvedValue({ attemptId: 'attempt-1', status: 'SENT' }) };
    const service = new PrismaDsvTimeConstraintCommandService(harness.prisma as never, undefined, undefined, dispatcher);

    const result = await service.confirm(command({
      expectedVersion: routeVersionId,
      timeWindowEnd: '11:00',
      timeWindowStart: '10:30',
    }));

    expect(result.changeRequestId).toBe('change-request-1');
    expect(harness.tx.deliveryStop.updateMany).not.toHaveBeenCalled();
    expect(harness.tx.dsvDispatchChangeRequest.create).toHaveBeenCalledOnce();
    expect(harness.tx.driverRouteNotificationAttempt.upsert).toHaveBeenCalledOnce();
    expect(dispatcher.dispatchByIdempotencyKey).toHaveBeenCalledWith('dsv-dispatch-change:change-request-1');
  });

  test('requires exact expected version including literal UNASSIGNED', async () => {
    const missing = createHarness({
      currentRouteVersionId: null,
      currentRouteVersion: null,
      instructions: null,
    });
    await expect(new PrismaDsvTimeConstraintCommandService(missing.prisma as never).confirm(command({
      expectedVersion: null,
      timeWindowEnd: '11:00',
      timeWindowStart: '10:30',
    }))).rejects.toMatchObject({ code: 'SELLER_ORDER_ASSIGNMENT_CHANGED' });
    expect(missing.tx.deliveryStop.updateMany).not.toHaveBeenCalled();

    const mismatch = createHarness({
      currentRouteVersionId: null,
      currentRouteVersion: null,
      instructions: null,
    });
    await expect(new PrismaDsvTimeConstraintCommandService(mismatch.prisma as never).confirm(command({
      expectedVersion: routeVersionId,
      timeWindowEnd: '11:00',
      timeWindowStart: '10:30',
    }))).rejects.toMatchObject({ code: 'SELLER_ORDER_ASSIGNMENT_CHANGED' });
    expect(mismatch.tx.deliveryStop.updateMany).not.toHaveBeenCalled();
  });

  test('rejects reassignment observed after locking with no stop or audit mutation', async () => {
    const reassignedRouteVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const harness = createHarness({
      currentRouteVersionId: reassignedRouteVersionId,
      currentRouteVersion: { createdAt: new Date('2026-08-03T09:45:00.000Z'), routePlanId },
      instructions: '오전 11시 배송',
    });
    const service = new PrismaDsvTimeConstraintCommandService(harness.prisma as never);

    await expect(service.confirm(command({
      expectedVersion: routeVersionId,
      timeWindowEnd: '11:00',
      timeWindowStart: '10:30',
    }))).rejects.toMatchObject({ code: 'SELLER_ORDER_ASSIGNMENT_CHANGED' });

    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(harness.tx.order.findFirst).toHaveBeenCalledTimes(1);
    expect(harness.tx.deliveryStop.findFirst).not.toHaveBeenCalled();
    expect(harness.tx.deliveryStop.updateMany).not.toHaveBeenCalled();
    expect(harness.tx.dsvAuditEvent.create).not.toHaveBeenCalled();
  });

  test('clear audit omits top-level customer and destination linkage with approved redacted diff only', async () => {
    const harness = createHarness({
      currentRouteVersionId: null,
      currentRouteVersion: null,
      instructions: null,
    });
    await new PrismaDsvTimeConstraintCommandService(harness.prisma as never).clear(clearCommand());

    const auditData = firstMockArg<{ data: { redactedDiff: Record<string, unknown> } }>(harness.tx.dsvAuditEvent.create)?.data;
    expect(auditData).toMatchObject({
      entityId: deliveryStopId,
      entityType: 'DeliveryStop',
      sellerOrderId,
    });
    expect(auditData).not.toHaveProperty('customerId');
    expect(auditData).not.toHaveProperty('destinationId');
    expect(Object.keys(auditData?.redactedDiff ?? {}).sort()).toEqual([...dsvAllowedTimeConstraintRedactedDiffKeys].sort());
    expect(JSON.stringify(auditData?.redactedDiff)).not.toMatch(/customer|destination|payload|address|driver|vehicle|geometry/u);
  });

  test('replays, rejects mismatched payloads, and reports active commands', async () => {
    const seed = createHarness({
      currentRouteVersionId: null,
      currentRouteVersion: null,
      instructions: null,
    });
    await new PrismaDsvTimeConstraintCommandService(seed.prisma as never).clear(clearCommand());
    const payloadHash = firstCreatedPayloadHash(seed);
    const replay = createHarness({
      currentRouteVersionId: null,
      currentRouteVersion: null,
      existingReceipt: {
        payloadHash,
        responseBodyRef: JSON.stringify({
          auditEventId: 'audit-replay',
          commandId: 'cmd-1',
          deliveryStopId,
          rawNote: null,
          recalculation: { reason: 'UNASSIGNED_ORDER', retryable: false, routePlanId: null, status: 'NOT_REQUIRED' },
          reviewStatus: 'NOT_APPLICABLE',
          routeConstraintStatus: 'NOT_APPLICABLE',
          sellerOrderId,
          sellerOrderKey: '2018330248',
          timeConstraint: null,
        }),
        status: 'SUCCEEDED',
      },
      instructions: null,
    });
    await expect(new PrismaDsvTimeConstraintCommandService(replay.prisma as never).clear(clearCommand()))
      .resolves.toMatchObject({ auditEventId: 'audit-replay' });

    const mismatch = createHarness({
      currentRouteVersionId: null,
      currentRouteVersion: null,
      existingReceipt: { payloadHash: 'different', responseBodyRef: null, status: 'SUCCEEDED' },
      instructions: null,
    });
    await expect(new PrismaDsvTimeConstraintCommandService(mismatch.prisma as never).clear(clearCommand()))
      .rejects.toBeInstanceOf(DsvTimeConstraintCommandError);

    const active = createHarness({
      currentRouteVersionId: null,
      currentRouteVersion: null,
      existingReceipt: { payloadHash, responseBodyRef: null, status: 'STARTED' },
      instructions: null,
    });
    await expect(new PrismaDsvTimeConstraintCommandService(active.prisma as never).clear(clearCommand()))
      .rejects.toMatchObject({ code: 'COMMAND_IN_PROGRESS' });
  });
});

function command(overrides: { expectedVersion?: string | null; timeWindowEnd: string; timeWindowStart: string }) {
  return {
    actor: { actorId: 'admin-1', actorType: 'DSV_ADMIN' as const, principalType: 'DSV_ADMIN' as const, requestId: 'req-1' },
    commandId: 'cmd-1',
    deliveryStopId,
    expectedVersion: overrides.expectedVersion,
    sellerOrderId,
    shopDomain: 'tomatonofood.com',
    timeWindowEnd: overrides.timeWindowEnd,
    timeWindowStart: overrides.timeWindowStart,
  };
}

function clearCommand() {
  return {
    actor: { actorId: 'admin-1', actorType: 'DSV_ADMIN' as const, principalType: 'DSV_ADMIN' as const, requestId: 'req-1' },
    commandId: 'cmd-1',
    deliveryStopId,
    expectedVersion: 'UNASSIGNED',
    sellerOrderId,
    shopDomain: 'tomatonofood.com',
  };
}

function createHarness(input: {
  currentRouteVersion: {
    createdAt: Date;
    driverId?: string;
    groupingId?: string;
    id?: string;
    routePlan?: { status: string };
    routePlanId: string;
    version?: number;
  } | null;
  currentRouteVersionId: string | null;
  existingReceipt?: { payloadHash: string | null; responseBodyRef: string | null; status: string };
  instructions: string | null;
}) {
  let receipt: ({
    id: string;
    payloadHash: string | null;
    responseBodyRef: string | null;
    status: string;
  } & Record<string, unknown>) | null = input.existingReceipt === undefined
    ? null
    : { id: 'receipt-existing', ...input.existingReceipt };
  const receiptRepository = {
    create: vi.fn((args: { data: Record<string, unknown> }) => {
      receipt = {
        ...args.data,
        id: 'receipt-1',
        payloadHash: args.data.payloadHash as string,
        responseBodyRef: null,
        status: 'STARTED',
      };
      return Promise.resolve({ id: receipt.id });
    }),
    findUnique: vi.fn(() => Promise.resolve(receipt)),
    updateMany: vi.fn((args: { data: Record<string, unknown>; where: { id: string; payloadHash: string; shopId: string; status: string } }) => {
      if (
        receipt === null
        || receipt.id !== args.where.id
        || receipt.payloadHash !== args.where.payloadHash
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
    $queryRaw: vi.fn(() => Promise.resolve([])),
    deliveryStop: {
      findFirst: vi.fn(() => Promise.resolve({
        id: deliveryStopId,
        instructions: input.instructions,
        timeWindowEnd: null,
        timeWindowStart: null,
      })),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
    driverRouteNotificationAttempt: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    dsvAuditEvent: {
      create: vi.fn(() => Promise.resolve({
        actorId: 'admin-1',
        eventType: 'TIME_CONSTRAINT_CONFIRMED',
        id: 'audit-1',
        occurredAt: new Date('2026-08-03T09:50:00.000Z'),
        redactedDiff: firstMockArg<{ data: { redactedDiff: unknown } }>(tx.dsvAuditEvent.create)?.data.redactedDiff ?? {},
      })),
    },
    dsvCommandReceipt: {
      create: receiptRepository.create,
      findUnique: receiptRepository.findUnique,
      updateMany: receiptRepository.updateMany,
    },
    dsvDispatchChangeRequest: {
      create: vi.fn().mockResolvedValue({ id: 'change-request-1' }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    order: {
      findFirst: vi.fn(() => Promise.resolve({
        currentRouteVersion: input.currentRouteVersion,
        currentRouteVersionId: input.currentRouteVersionId,
        customerId: 'customer-1',
        destinationId: 'destination-1',
        id: sellerOrderId,
        sellerOrderKey: '2018330248',
      })),
    },
  };
  const prisma = {
    $transaction: vi.fn((fn: (transaction: typeof tx) => unknown) => fn(tx)),
    dsvCommandReceipt: receiptRepository,
    shop: { findUnique: vi.fn(() => Promise.resolve({ id: shopId })) },
  };
  return { prisma, receipt: () => receipt, tx };
}

function firstCreatedPayloadHash(harness: ReturnType<typeof createHarness>): string {
  const receipt = firstMockArg<{ data: { payloadHash: string } }>(harness.tx.dsvCommandReceipt.create);
  return receipt?.data.payloadHash ?? 'unused';
}

function firstMockArg<T>(mock: { mock: { calls: unknown[][] } }): T | undefined {
  return mock.mock.calls[0]?.[0] as T | undefined;
}
