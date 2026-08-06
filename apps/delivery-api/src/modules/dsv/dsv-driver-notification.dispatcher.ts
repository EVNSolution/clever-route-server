import type { Prisma, PrismaClient } from '@prisma/client';

import { hashPushToken } from '../route-grouping/driver-push-token.service.js';
import type {
  DriverPushProvider,
  DriverRoutePushAction,
  DriverRoutePushResult
} from '../route-grouping/driver-push.provider.js';

type LoggerLike = {
  warn?(bindings: unknown, message?: string): void;
};

type DsvDriverNotificationPrismaClient = Pick<
  PrismaClient,
  'driverPushToken' | 'driverRouteNotificationAttempt'
>;

type DriverNotificationAttempt = {
  action: 'ASSIGNED' | 'CANCELLED' | 'CHANGED' | 'RELEASED';
  attemptedAt: Date;
  driver?: { accountId: string | null } | null;
  groupingId: string;
  groupingVersion: number;
  id: string;
  metadata: Prisma.JsonValue | null;
  routePlanId: string;
  status: 'FAILED' | 'PENDING' | 'SENT' | 'SKIPPED';
};

export type DsvDriverNotificationDispatchResult = {
  attemptId: string | null;
  status: 'FAILED' | 'SENT' | 'SKIPPED';
};

export class PrismaDsvDriverNotificationDispatcher {
  constructor(
    private readonly prisma: DsvDriverNotificationPrismaClient,
    private readonly pushProvider: DriverPushProvider,
    private readonly logger?: LoggerLike
  ) {}

  async dispatchByIdempotencyKey(idempotencyKey: string, now = new Date()): Promise<DsvDriverNotificationDispatchResult> {
    try {
      const attempt = await this.prisma.driverRouteNotificationAttempt.findUnique({
        include: { driver: { select: { accountId: true } } },
        where: { idempotencyKey }
      });
      if (attempt === null) return { attemptId: null, status: 'SKIPPED' };
      return this.dispatchAttempt(attempt, now);
    } catch (error) {
      await this.recordUnexpectedFailure({ idempotencyKey }, error);
      return { attemptId: null, status: 'FAILED' };
    }
  }

  async dispatchAttemptId(attemptId: string, now = new Date()): Promise<DsvDriverNotificationDispatchResult> {
    try {
      const attempt = await this.prisma.driverRouteNotificationAttempt.findUnique({
        include: { driver: { select: { accountId: true } } },
        where: { id: attemptId }
      });
      if (attempt === null) return { attemptId: null, status: 'SKIPPED' };
      return this.dispatchAttempt(attempt, now);
    } catch (error) {
      await this.recordUnexpectedFailure({ id: attemptId }, error);
      return { attemptId, status: 'FAILED' };
    }
  }

  private async recordUnexpectedFailure(
    where: { id: string } | { idempotencyKey: string },
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : 'Driver notification dispatch failed unexpectedly.';
    this.logger?.warn?.({ errorName: error instanceof Error ? error.name : typeof error, where }, 'DSV driver notification dispatch failed unexpectedly');
    await this.prisma.driverRouteNotificationAttempt.updateMany({
      data: {
        completedAt: new Date(),
        errorCode: 'DRIVER_NOTIFICATION_DISPATCH_ERROR',
        errorMessage: message,
        status: 'FAILED',
      },
      where: { ...where, status: { in: ['PENDING', 'FAILED'] } },
    }).catch(() => undefined);
  }

  private async dispatchAttempt(attempt: DriverNotificationAttempt, now: Date): Promise<DsvDriverNotificationDispatchResult> {
    if (attempt.status === 'SENT' || attempt.status === 'SKIPPED') {
      return { attemptId: attempt.id, status: attempt.status };
    }
    const claimed = await this.prisma.driverRouteNotificationAttempt.updateMany({
      data: {
        attemptedAt: now,
        errorCode: null,
        errorMessage: null,
        provider: this.pushProvider.providerName,
        providerMessageId: null,
        status: 'PENDING'
      },
      where: { attemptedAt: attempt.attemptedAt, id: attempt.id, status: { in: ['PENDING', 'FAILED'] } }
    });
    if (claimed.count !== 1) {
      const current = await this.prisma.driverRouteNotificationAttempt.findUnique({
        select: { id: true, status: true },
        where: { id: attempt.id }
      });
      return {
        attemptId: current?.id ?? null,
        status: current?.status === 'SENT' || current?.status === 'FAILED' || current?.status === 'SKIPPED'
          ? current.status
          : 'SKIPPED'
      };
    }

    const result = await this.sendAttempt(attempt);
    await this.prisma.driverRouteNotificationAttempt.update({
      data: {
        completedAt: new Date(),
        errorCode: result.errorCode ?? null,
        errorMessage: result.errorMessage ?? null,
        provider: this.pushProvider.providerName,
        providerMessageId: result.providerMessageId ?? null,
        status: result.status
      },
      where: { id: attempt.id }
    });
    return { attemptId: attempt.id, status: result.status };
  }

  private async sendAttempt(attempt: DriverNotificationAttempt): Promise<DriverRoutePushResult> {
    const accountId = attempt.driver?.accountId ?? null;
    if (accountId === null) {
      return {
        errorCode: 'DRIVER_ACCOUNT_MISSING',
        errorMessage: 'Driver notification attempt is not linked to an active driver account.',
        status: 'SKIPPED'
      };
    }
    const tokens = await this.prisma.driverPushToken.findMany({
      orderBy: { lastSeenAt: 'desc' },
      where: { accountId, status: 'ACTIVE' }
    });
    if (tokens.length === 0) {
      return {
        errorCode: 'NO_ACTIVE_TOKEN',
        errorMessage: 'No active Push token is registered for the driver account.',
        status: 'SKIPPED'
      };
    }

    const tokenResults = await Promise.all(tokens.map(async (token) => ({
      result: await this.sendToken(attempt, token.devicePushToken),
      token
    })));
    const invalidatedAt = new Date();
    await Promise.all(tokenResults
      .filter(({ result }) => result.invalidToken === true)
      .map(({ token }) => this.prisma.driverPushToken.updateMany({
        data: { revokedAt: invalidatedAt, status: 'INVALID' },
        where: { id: token.id, tokenHash: hashPushToken(token.devicePushToken) }
      })));

    return tokenResults.find(({ result }) => result.status === 'SENT')?.result
      ?? tokenResults.find(({ result }) => result.status === 'FAILED')?.result
      ?? tokenResults[0]?.result
      ?? {
        errorCode: 'NO_PROVIDER_RESULT',
        errorMessage: 'Driver Push provider did not return a result.',
        status: 'FAILED'
      };
  }

  private async sendToken(attempt: DriverNotificationAttempt, devicePushToken: string): Promise<DriverRoutePushResult> {
    try {
      return await this.pushProvider.sendRouteNotification({
        action: toPushAction(attempt.action),
        childVersion: attempt.groupingVersion,
        devicePushToken,
        metadata: readMinimalMetadata(attempt.metadata),
        routeGroupingId: attempt.groupingId,
        routePlanId: attempt.routePlanId
      });
    } catch (error) {
      this.logger?.warn?.(
        {
          attemptId: attempt.id,
          errorName: error instanceof Error ? error.name : typeof error
        },
        'DSV driver notification provider threw during send'
      );
      return {
        errorCode: 'DRIVER_PUSH_PROVIDER_ERROR',
        errorMessage: error instanceof Error ? error.message : 'Driver Push provider failed.',
        status: 'FAILED'
      };
    }
  }
}

function toPushAction(action: DriverNotificationAttempt['action']): DriverRoutePushAction {
  switch (action) {
    case 'ASSIGNED':
      return 'assigned';
    case 'CANCELLED':
      return 'cancelled';
    case 'RELEASED':
      return 'released';
    case 'CHANGED':
      return 'changed';
  }
}

function readMinimalMetadata(metadata: Prisma.JsonValue | null): Record<string, string> | undefined {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const output: Record<string, string> = {};
  const changeRequestId = metadata.changeRequestId;
  if (typeof changeRequestId === 'string' && changeRequestId.trim() !== '') output.changeRequestId = changeRequestId;
  const orderMessageId = metadata.orderMessageId;
  if (typeof orderMessageId === 'string' && orderMessageId.trim() !== '') output.orderMessageId = orderMessageId;
  return Object.keys(output).length === 0 ? undefined : output;
}
