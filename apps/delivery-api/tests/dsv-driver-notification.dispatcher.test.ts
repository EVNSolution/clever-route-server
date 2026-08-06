import { describe, expect, test, vi } from 'vitest';

import { PrismaDsvDriverNotificationDispatcher } from '../src/modules/dsv/dsv-driver-notification.dispatcher.js';
import { DsvDriverNotificationWorker } from '../src/modules/dsv/dsv-driver-notification.worker.js';
import type { DriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';
import { hashPushToken } from '../src/modules/route-grouping/driver-push-token.service.js';

const now = new Date('2026-08-06T08:00:00.000Z');

describe('PrismaDsvDriverNotificationDispatcher', () => {
  test('sends pending DSV change request attempts with only minimal identifiers', async () => {
    const { prisma, provider } = createHarness({
      metadata: {
        body: 'do not send this memo body',
        changeRequestId: 'change-request-id',
        orderMessageId: 'order-message-id'
      }
    });
    provider.sendRouteNotification.mockResolvedValue({ providerMessageId: 'fcm-id', status: 'SENT' });
    const dispatcher = new PrismaDsvDriverNotificationDispatcher(prisma as never, provider);

    await expect(dispatcher.dispatchByIdempotencyKey('dsv-dispatch-change:change-request-id', now)).resolves.toEqual({
      attemptId: 'attempt-id',
      status: 'SENT'
    });

    expect(provider.sendRouteNotification).toHaveBeenCalledWith({
      action: 'changed',
      childVersion: 7,
      devicePushToken: 'push-token',
      metadata: { changeRequestId: 'change-request-id', orderMessageId: 'order-message-id' },
      routeGroupingId: 'grouping-id',
      routePlanId: 'route-plan-id'
    });
    expect(JSON.stringify(provider.sendRouteNotification.mock.calls[0]?.[0])).not.toContain('do not send this memo body');
    expect(prisma.driverRouteNotificationAttempt.update).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        errorCode: null,
        errorMessage: null,
        provider: 'fake-fcm',
        providerMessageId: 'fcm-id',
        status: 'SENT'
      }),
      where: { id: 'attempt-id' }
    });
  });

  test('invalidates bad active driver tokens and records a failed retryable attempt', async () => {
    const { prisma, provider } = createHarness();
    provider.sendRouteNotification.mockResolvedValue({
      errorCode: 'messaging/registration-token-not-registered',
      errorMessage: 'bad token',
      invalidToken: true,
      status: 'FAILED'
    });
    const dispatcher = new PrismaDsvDriverNotificationDispatcher(prisma as never, provider);

    await expect(dispatcher.dispatchByIdempotencyKey('dsv-order-message:message-id', now)).resolves.toEqual({
      attemptId: 'attempt-id',
      status: 'FAILED'
    });

    expect(prisma.driverPushToken.updateMany).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: { revokedAt: expect.any(Date), status: 'INVALID' },
      where: { id: 'token-id', tokenHash: hashPushToken('push-token') }
    });
    expect(prisma.driverRouteNotificationAttempt.update).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        errorCode: 'messaging/registration-token-not-registered',
        errorMessage: 'bad token',
        status: 'FAILED'
      }),
      where: { id: 'attempt-id' }
    });
  });

  test('does not duplicate terminal sends for the same attempt idempotency key', async () => {
    const { prisma, provider } = createHarness({ status: 'SENT' });
    const dispatcher = new PrismaDsvDriverNotificationDispatcher(prisma as never, provider);

    await expect(dispatcher.dispatchByIdempotencyKey('dsv-order-message:message-id', now)).resolves.toEqual({
      attemptId: 'attempt-id',
      status: 'SENT'
    });

    expect(provider.sendRouteNotification).not.toHaveBeenCalled();
    expect(prisma.driverRouteNotificationAttempt.updateMany).not.toHaveBeenCalled();
  });

  test('persists unexpected lookup failures so operational alerts can report them', async () => {
    const { prisma, provider } = createHarness();
    prisma.driverRouteNotificationAttempt.findUnique.mockRejectedValueOnce(new Error('database unavailable'));
    const logger = { warn: vi.fn() };
    const dispatcher = new PrismaDsvDriverNotificationDispatcher(prisma as never, provider, logger);

    await expect(dispatcher.dispatchByIdempotencyKey('dsv-order-message:message-id', now)).resolves.toEqual({
      attemptId: null,
      status: 'FAILED'
    });

    expect(prisma.driverRouteNotificationAttempt.updateMany).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        errorCode: 'DRIVER_NOTIFICATION_DISPATCH_ERROR',
        errorMessage: 'database unavailable',
        status: 'FAILED'
      }),
      where: {
        idempotencyKey: 'dsv-order-message:message-id',
        status: { in: ['PENDING', 'FAILED'] }
      }
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('DsvDriverNotificationWorker', () => {
  test('retries due failed attempts without scanning fresh attempts', async () => {
    const prisma = {
      driverRouteNotificationAttempt: {
        findMany: vi.fn().mockResolvedValue([{ id: 'failed-attempt-id' }])
      }
    };
    const dispatcher = {
      dispatchAttemptId: vi.fn().mockResolvedValue({ attemptId: 'failed-attempt-id', status: 'SENT' })
    };
    const worker = new DsvDriverNotificationWorker(
      prisma as never,
      dispatcher as never,
      { batchSize: 5, failedRetryDelayMs: 60_000, pendingRetryDelayMs: 30_000 }
    );

    await expect(worker.runDueBatch(now)).resolves.toBe(1);

    expect(prisma.driverRouteNotificationAttempt.findMany).toHaveBeenCalledWith({
      orderBy: [{ attemptedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: 5,
      where: {
        OR: [
          { attemptedAt: { lte: new Date('2026-08-06T07:59:30.000Z') }, status: 'PENDING' },
          { attemptedAt: { lte: new Date('2026-08-06T07:59:00.000Z') }, status: 'FAILED' }
        ]
      }
    });
    expect(dispatcher.dispatchAttemptId).toHaveBeenCalledWith('failed-attempt-id', now);
  });
});

function createHarness(overrides: Record<string, unknown> = {}) {
  const attempt = {
    action: 'CHANGED',
    attemptedAt: new Date('2026-08-06T07:59:00.000Z'),
    driver: { accountId: 'account-id' },
    driverId: 'driver-id',
    groupingId: 'grouping-id',
    groupingVersion: 7,
    id: 'attempt-id',
    idempotencyKey: 'dsv-order-message:message-id',
    metadata: { orderMessageId: 'message-id' },
    routePlanId: 'route-plan-id',
    status: 'PENDING',
    ...overrides
  };
  const prisma = {
    driverPushToken: {
      findMany: vi.fn().mockResolvedValue([{
        devicePushToken: 'push-token',
        id: 'token-id',
        tokenHash: hashPushToken('push-token')
      }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    driverRouteNotificationAttempt: {
      findUnique: vi.fn().mockResolvedValue(attempt),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    }
  };
  const sendRouteNotification = vi.fn<DriverPushProvider['sendRouteNotification']>();
  const provider = {
    providerName: 'fake-fcm',
    sendRouteNotification
  };
  return { attempt, prisma, provider };
}
