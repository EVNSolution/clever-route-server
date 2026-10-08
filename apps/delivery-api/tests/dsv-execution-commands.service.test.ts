/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { createHash } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import {
  PrismaDsvExecutionCommandsService,
  type DsvReportDeliveryExceptionInput,
  type DsvStartExecutionInput,
} from '../src/modules/dsv/dsv-execution-commands.service.js';

const ids = {
  account: '11111111-1111-4111-8111-111111111111',
  child: '22222222-2222-4222-8222-222222222222',
  command: '33333333-3333-4333-8333-333333333333',
  context: '44444444-4444-4444-8444-444444444444',
  driver: '55555555-5555-4555-8555-555555555555',
  route: '66666666-6666-4666-8666-666666666666',
  shop: '77777777-7777-4777-8777-777777777777',
  stop: '88888888-8888-4888-8888-888888888888',
};

const startInput: DsvStartExecutionInput = {
  accountId: ids.account,
  assignmentEpoch: '4',
  assignmentGeneration: '9',
  commandId: ids.command,
  driverId: ids.driver,
  executionContextId: ids.context,
  expectedRouteVersionId: ids.child,
  occurredAt: new Date('2026-10-06T09:00:00.000Z'),
  routeVersion: 3,
  shopDomain: 'tenant.example.test',
  shopId: ids.shop,
};

function harness() {
  const reportRow = {
    acknowledgedAt: null, assignmentEpoch: 4n, createdAt: new Date('2026-10-06T09:05:00.000Z'),
    driverId: ids.driver, executionContextId: ids.context, explanation: '수취인 부재',
    emailSentAt: null, emailStatus: 'PREPARED',
    id: '99999999-9999-4999-8999-999999999999', reasonCode: 'RECIPIENT_ABSENT', resolvedAt: null,
    routeVersion: 3, shopId: ids.shop, status: 'OPEN', targetStopId: ids.stop, recipientAccountId: ids.account,
  };
  const tx = {
    $queryRaw: vi.fn().mockImplementation((query: unknown) => {
      const strings = typeof query === 'object' && query !== null && 'strings' in query
        ? (query as { strings?: readonly string[] }).strings : undefined;
      const sql = strings?.join(' ') ?? '';
      return Promise.resolve(sql.includes('command_lock') ? [{ locked: 1 }] : sql.includes('route_plans') ? [{
      assignmentGeneration: 9n,
      driverId: ids.driver,
      id: ids.route,
    }] : [{
      assignmentEpoch: 4n,
      driverId: ids.driver,
      recipientAccountId: ids.account,
      routePlanId: ids.route,
      routeVersion: 3,
      serviceDate: new Date('2026-10-06T00:00:00.000Z'),
      status: 'ACTIVE',
    }]);
    }),
    driver: { findFirst: vi.fn().mockResolvedValue({ displayName: '홍길동', id: ids.driver }) },
    driverEvent: { findMany: vi.fn().mockResolvedValue([]) },
    dsvDeliveryException: {
      create: vi.fn().mockResolvedValue({ id: reportRow.id }),
      findFirst: vi.fn().mockResolvedValue(reportRow),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...reportRow, ...data })),
    },
    dsvExecutionCommand: { create: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(null) },
    dsvExecutionContext: {
      findUnique: vi.fn().mockResolvedValue({ routePlanId: ids.route }),
      update: vi.fn().mockResolvedValue({}),
    },
    dsvOperationalNotification: {
      create: vi.fn().mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    routeGroupingChildVersion: { findFirst: vi.fn().mockResolvedValue({ id: ids.child }) },
    routePlan: { findFirst: vi.fn().mockResolvedValue({ assignmentGeneration: 9n, driverId: ids.driver, id: ids.route }) },
    routePlanStop: { findFirst: vi.fn().mockResolvedValue({ deliveryStopId: ids.stop, deliveryStop: { status: 'PENDING' } }) },
  };
  const prisma = {
    $transaction: vi.fn((action: (client: typeof tx) => unknown) => action(tx)),
    dsvDeliveryException: {
      findFirst: tx.dsvDeliveryException.findFirst,
      findMany: vi.fn().mockResolvedValue([reportRow]),
    },
  };
  const recordDriverEventInTransaction = vi.fn()
    .mockResolvedValueOnce({ duplicate: true, eventId: 'legacy-start-event' })
    .mockResolvedValueOnce({ duplicate: false, eventId: 'new-pickup-event' });
  const service = new PrismaDsvExecutionCommandsService(prisma as never, { recordDriverEventInTransaction });
  return { prisma, recordDriverEventInTransaction, service, tx };
}

describe('PrismaDsvExecutionCommandsService', () => {
  test('atomically fills a missing pickup event after a legacy partial start', async () => {
    const { recordDriverEventInTransaction, service, tx } = harness();
    const result = await service.start(startInput);

    expect(result).toEqual({
      assignmentEpoch: '4', commandId: ids.command, duplicate: false, executionContextId: ids.context,
      pickupCompletedEventId: 'new-pickup-event', routeStartedEventId: 'legacy-start-event', routeVersion: 3,
    });
    expect(recordDriverEventInTransaction).toHaveBeenCalledTimes(2);
    expect(recordDriverEventInTransaction.mock.calls[0]?.[2]).toEqual({ skipDsvExecutionSync: true });
    expect(recordDriverEventInTransaction.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ clientEventId: `dsv:${ids.command}:route-started`, eventType: 'ROUTE_STARTED' }),
      expect.objectContaining({ clientEventId: `dsv:${ids.command}:pickup-completed`, eventType: 'PICKUP_COMPLETED' }),
    ]);
    expect(tx.dsvExecutionContext.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ reminderDueAt: null, reminderStatus: 'RESOLVED_START' }),
    }));
    expect(tx.dsvOperationalNotification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ kind: { in: ['N04', 'N05'] }, businessStatus: 'OPEN' }),
    }));
    expect(tx.dsvExecutionCommand.create).toHaveBeenCalledOnce();
  });

  test('replays a command result without writing driver events', async () => {
    const { recordDriverEventInTransaction, service, tx } = harness();
    tx.dsvExecutionCommand.findUnique.mockResolvedValueOnce({
      payloadHash: 'different until learned', result: {},
    });
    await expect(service.start(startInput)).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect(recordDriverEventInTransaction).not.toHaveBeenCalled();

    // Capture the hash written by one successful command, then use it for replay.
    tx.dsvExecutionCommand.findUnique.mockResolvedValueOnce(null);
    await service.start(startInput);
    const payloadHash = tx.dsvExecutionCommand.create.mock.calls[0]?.[0].data.payloadHash;
    const stored = tx.dsvExecutionCommand.create.mock.calls[0]?.[0].data.result;
    tx.dsvExecutionCommand.findUnique.mockResolvedValueOnce({ payloadHash, result: stored });
    recordDriverEventInTransaction.mockClear();
    expect(await service.start(startInput)).toEqual({ ...stored, duplicate: true });
    expect(recordDriverEventInTransaction).not.toHaveBeenCalled();
  });

  test('creates an operations exception and N07 intent without STOP_FAILED', async () => {
    const { recordDriverEventInTransaction, service, tx } = harness();
    const input: DsvReportDeliveryExceptionInput = {
      ...startInput,
      explanation: '수취인 부재를 관제에 보고',
      reasonCode: 'RECIPIENT_ABSENT',
      targetStopId: ids.stop,
    };
    const result = await service.reportDeliveryException(input);
    expect(result.exceptionId).toBe('99999999-9999-4999-8999-999999999999');
    expect(tx.dsvDeliveryException.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ reasonCode: 'RECIPIENT_ABSENT' }),
    }));
    expect(tx.dsvOperationalNotification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ audience: 'OPS', kind: 'N07' }),
    }));
    expect(recordDriverEventInTransaction).not.toHaveBeenCalled();
  });

  test('accepts a required free-text reason without a code or photo and prepares one immutable email job', async () => {
    const { recordDriverEventInTransaction, service, tx } = harness();
    const input = { ...startInput, reason: '  진입로 폐쇄로 배송할 수 없습니다.  ', targetStopId: ids.stop };
    const first = await service.reportDeliveryException(input);
    expect(first).toMatchObject({ reportStatus: 'ACCEPTED', emailStatus: 'PREPARED' });
    expect(tx.dsvDeliveryException.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        emailSnapshot: expect.objectContaining({
          driver: '홍길동', reason: '진입로 폐쇄로 배송할 수 없습니다.',
          reportedAt: startInput.occurredAt.toISOString(), serviceDate: '2026-10-06',
        }),
        emailStatus: 'PREPARED', explanation: '진입로 폐쇄로 배송할 수 없습니다.', reasonCode: 'FREE_TEXT',
      }),
    }));
    const stored = tx.dsvExecutionCommand.create.mock.calls[0]?.[0].data;
    tx.dsvExecutionCommand.findUnique.mockResolvedValueOnce({ payloadHash: stored.payloadHash, result: stored.result });
    expect(await service.reportDeliveryException(input)).toEqual({ ...first, duplicate: true });
    expect(tx.dsvDeliveryException.create).toHaveBeenCalledOnce();
    expect(tx.dsvOperationalNotification.create).toHaveBeenCalledOnce();
    expect(recordDriverEventInTransaction).not.toHaveBeenCalled();
  });

  test('preserves multiline free-text reasons in the report and email snapshot without loosening reason codes', async () => {
    const { service, tx } = harness();
    const reason = '진입로 폐쇄\r\n담당자 요청:\t내일 재방문\n오전 연락 필요';
    await service.reportDeliveryException({ ...startInput, reason, targetStopId: ids.stop });
    expect(tx.dsvDeliveryException.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ explanation: reason, emailSnapshot: expect.objectContaining({ reason }) }),
    }));
    await expect(service.reportDeliveryException({ ...startInput, reason: '진입로\u0000폐쇄', targetStopId: ids.stop }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.reportDeliveryException({ ...startInput, reasonCode: 'OTHER\nREASON', targetStopId: ids.stop }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('rejects missing or blank free-text reasons', async () => {
    const { service, tx } = harness();
    await expect(service.reportDeliveryException({ ...startInput, targetStopId: ids.stop }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.reportDeliveryException({ ...startInput, reason: '   ', targetStopId: ids.stop }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(tx.dsvDeliveryException.create).not.toHaveBeenCalled();
  });

  test('replays receipts created with the legacy fingerprint without creating historical email jobs', async () => {
    const { service, tx } = harness();
    const input = { ...startInput, reasonCode: 'RECIPIENT_ABSENT', targetStopId: ids.stop };
    const payloadHash = createHash('sha256').update('REPORT_DELIVERY_EXCEPTION\n' + JSON.stringify({
      ...input, explanation: null, reasonCode: input.reasonCode,
    })).digest('hex');
    const result = { assignmentEpoch: '4', commandId: ids.command, duplicate: false,
      exceptionId: 'historical-report', executionContextId: ids.context, notificationId: 'historical-notification', routeVersion: 3 };
    tx.dsvExecutionCommand.findUnique.mockResolvedValueOnce({ payloadHash, result });
    expect(await service.reportDeliveryException(input)).toEqual({
      ...result, duplicate: true, emailStatus: 'NOT_PREPARED', reportStatus: 'ACCEPTED',
    });
    expect(tx.dsvDeliveryException.create).not.toHaveBeenCalled();
  });

  test('rejects stale assignment fences before business writes', async () => {
    const { recordDriverEventInTransaction, service, tx } = harness();
    tx.$queryRaw.mockResolvedValueOnce([{ locked: 1 }]).mockResolvedValueOnce([{
      assignmentGeneration: 9n, driverId: ids.driver, id: ids.route,
    }]).mockResolvedValueOnce([{
      assignmentEpoch: 5n, driverId: ids.driver, recipientAccountId: ids.account,
      routePlanId: ids.route, routeVersion: 3, status: 'ACTIVE',
    }]);
    await expect(service.start(startInput)).rejects.toEqual(expect.objectContaining({ code: 'ASSIGNMENT_CHANGED' }));
    expect(recordDriverEventInTransaction).not.toHaveBeenCalled();
    expect(tx.dsvExecutionCommand.create).not.toHaveBeenCalled();
  });

  test('reuses arbitrary legacy start evidence and writes only the missing pickup event', async () => {
    const { recordDriverEventInTransaction, service, tx } = harness();
    const legacyOccurredAt = new Date('2026-10-06T08:45:00.000Z');
    tx.driverEvent.findMany.mockResolvedValueOnce([{
      eventType: 'ROUTE_STARTED', id: 'legacy-arbitrary-client-event', occurredAt: legacyOccurredAt,
    }]);
    recordDriverEventInTransaction.mockReset().mockResolvedValueOnce({ duplicate: false, eventId: 'pickup-only' });
    const result = await service.start(startInput);
    expect(result.routeStartedEventId).toBe('legacy-arbitrary-client-event');
    expect(result.pickupCompletedEventId).toBe('pickup-only');
    expect(recordDriverEventInTransaction).toHaveBeenCalledOnce();
    expect(recordDriverEventInTransaction.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      eventType: 'PICKUP_COMPLETED', occurredAt: legacyOccurredAt,
    }));
    expect(tx.dsvExecutionContext.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ startedAt: legacyOccurredAt }),
    }));
  });

  test('does not store a command receipt when the second event fails', async () => {
    const { recordDriverEventInTransaction, service, tx } = harness();
    recordDriverEventInTransaction.mockReset()
      .mockResolvedValueOnce({ duplicate: false, eventId: 'start' })
      .mockRejectedValueOnce(new Error('pickup failed'));
    await expect(service.start(startInput)).rejects.toThrow('pickup failed');
    expect(tx.dsvExecutionCommand.create).not.toHaveBeenCalled();
    expect(tx.dsvExecutionContext.update).not.toHaveBeenCalled();
  });

  test('reads tenant reports without driver events and changes only report notification state', async () => {
    const { prisma, recordDriverEventInTransaction, service, tx } = harness();
    const page = await service.listDeliveryExceptions({ shopId: ids.shop });
    expect(page.items[0]).toMatchObject({ assignmentEpoch: '4', reasonCode: 'RECIPIENT_ABSENT', status: 'OPEN' });
    expect(prisma.dsvDeliveryException.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { shopId: ids.shop } }));
    expect(recordDriverEventInTransaction).not.toHaveBeenCalled();

    const acknowledged = await service.acknowledgeDeliveryException({ id: '99999999-9999-4999-8999-999999999999', shopId: ids.shop });
    expect(acknowledged.status).toBe('ACKNOWLEDGED');
    expect(tx.dsvOperationalNotification.updateMany).not.toHaveBeenCalled();
    const resolved = await service.resolveDeliveryException({ id: '99999999-9999-4999-8999-999999999999', shopId: ids.shop });
    expect(resolved.status).toBe('RESOLVED');
    expect(tx.dsvOperationalNotification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ audience: 'OPS', eventId: '99999999-9999-4999-8999-999999999999', kind: 'N07' }),
    }));
    expect(recordDriverEventInTransaction).not.toHaveBeenCalled();
  });
});
