import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { DsvForbiddenError, type DsvPrincipal } from './dsv-principal.js';
import {
  DSV_OPERATIONAL_DRIVER_APP_ID,
  dsvOperationalDriverNotificationKinds,
  notificationCopy,
  type DsvOperationalDriverNotificationKind,
  type DsvOperationalPushProvider,
} from './dsv-operational-driver-notification.provider.js';

const MAX_INBOX_PAGE = 100;
const DEFAULT_INBOX_PAGE = 30;
const PUSH_SCHEMA_VERSION = '1';

type OperationalNotificationPrisma = Pick<
  PrismaClient,
  | '$queryRaw'
  | '$transaction'
  | 'driver'
  | 'driverAccount'
  | 'driverPushToken'
  | 'dsvDeliveryException'
  | 'dsvExecutionContext'
  | 'dsvNotificationCapability'
  | 'dsvOperationalNotification'
  | 'dsvOperationalNotificationAck'
  | 'dsvOperationalNotificationAttempt'
  | 'routePlan'
  | 'routeGroupingChildVersion'
  | 'routePlanStop'
>;

export type DsvOperationalNotificationSendPolicy = {
  allowedAccountIds: readonly string[];
  allowedKinds: readonly DsvOperationalDriverNotificationKind[];
  allowedShopIds: readonly string[];
  approvedAuthorizationId: string | null;
  approvedGeofencePolicyVersion: string | null;
  businessReminderCap: number | null;
  liveSendingEnabled: boolean;
  maxProviderAttempts: number | null;
  monitorWindowMs: number | null;
  notificationRetentionMs: number | null;
  retryDelayMs: number;
};

export type DsvOperationalNotificationSendPolicySource =
  | DsvOperationalNotificationSendPolicy
  | (() => DsvOperationalNotificationSendPolicy);

export const disabledDsvOperationalNotificationSendPolicy: DsvOperationalNotificationSendPolicy = {
  allowedAccountIds: [],
  allowedKinds: [],
  allowedShopIds: [],
  approvedAuthorizationId: null,
  approvedGeofencePolicyVersion: null,
  businessReminderCap: null,
  liveSendingEnabled: false,
  maxProviderAttempts: null,
  monitorWindowMs: null,
  notificationRetentionMs: null,
  retryDelayMs: 30_000,
};

export type DsvOperationalInboxItem = {
  ackedAt: string | null;
  businessStatus: 'CANCELLED' | 'EXPIRED' | 'OPEN' | 'RESOLVED';
  createdAt: string;
  expiresAt: string;
  id: string;
  kind: string;
  summary: { body: string; title: string };
};

export type DsvOperationalNotificationResolution = {
  destination:
    | { executionContextId: string; routePlanId: string; targetStopId?: string; type: 'EXECUTION' }
    | { type: 'ASSIGNMENT_RELEASED' }
    | { executionContextId: string; reportId: string; targetStopId: string; type: 'OPERATIONS_EXCEPTION' };
  notificationId: string;
};

export type DsvOperationalNotificationRunResult = {
  attempted: number;
  blockedByPolicy: boolean;
  dead: number;
  sent: number;
  skipped: number;
};

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  warn?(bindings: unknown, message?: string): void;
};

export class PrismaDsvOperationalDriverNotificationService {
  constructor(
    private readonly prisma: OperationalNotificationPrisma,
    private readonly provider: DsvOperationalPushProvider,
    private readonly policySource: DsvOperationalNotificationSendPolicySource = disabledDsvOperationalNotificationSendPolicy,
    private readonly options: { batchSize?: number; clock?: () => Date; leaseMs?: number } = {},
    private readonly logger?: LoggerLike,
  ) {}

  async list(input: {
    cursor?: string;
    limit?: number;
    now?: Date;
    principal: DsvPrincipal;
  }): Promise<{ items: DsvOperationalInboxItem[]; nextCursor: string | null }> {
    const now = input.now ?? new Date();
    const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_INBOX_PAGE, MAX_INBOX_PAGE));
    const audience = input.principal.principalType === 'DRIVER' ? 'DRIVER' : 'OPS';
    const accountId = audience === 'DRIVER' ? await this.requireDriverAccount(input.principal) : null;
    if (audience === 'OPS') this.requireOpsRead(input.principal);
    const acknowledgementActorId = accountId ?? (
      input.principal.principalType === 'DSV_ADMIN'
      && input.principal.actorId !== undefined
      && UUID_PATTERN.test(input.principal.actorId)
        ? input.principal.actorId
        : null
    );
    const cursor = decodeCursor(input.cursor);
    const rows = await this.prisma.dsvOperationalNotification.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        businessStatus: true,
        createdAt: true,
        expiresAt: true,
        id: true,
        kind: true,
      },
      take: limit + 1,
      where: {
        audience,
        expiresAt: { gt: now },
        shopId: input.principal.shopId,
        ...(accountId === null ? {} : { recipientAccountId: accountId }),
        ...(cursor === null ? {} : {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }),
      },
    });
    const page = rows.slice(0, limit);
    const acknowledgements = acknowledgementActorId === null || page.length === 0
      ? []
      : await this.prisma.dsvOperationalNotificationAck.findMany({
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, notificationId: true },
        where: { accountId: acknowledgementActorId, notificationId: { in: page.map((row) => row.id) }, shopId: input.principal.shopId },
      });
    const ackByNotification = new Map(acknowledgements.map((ack) => [ack.notificationId, ack.createdAt]));
    return {
      items: page.map((row) => ({
        ackedAt: ackByNotification.get(row.id)?.toISOString() ?? null,
        businessStatus: normalizeBusinessStatus(row.businessStatus),
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        id: row.id,
        kind: row.kind,
        summary: isDriverKind(row.kind)
          ? notificationCopy(row.kind)
          : { body: '관제 화면에서 예외 내용을 확인해 주세요.', title: '배송 예외 보고' },
      })),
      nextCursor: rows.length > limit && page.length > 0
        ? encodeCursor(page[page.length - 1]!)
        : null,
    };
  }

  async ack(input: {
    ackKind?: 'OPENED' | 'READ';
    notificationId: string;
    now?: Date;
    principal: DsvPrincipal;
  }): Promise<{ ackedAt: string; notificationId: string }> {
    const now = input.now ?? new Date();
    const isDriver = input.principal.principalType === 'DRIVER';
    const accountId = isDriver
      ? await this.requireDriverAccount(input.principal)
      : this.requireOpsActor(input.principal);
    const notification = await this.prisma.dsvOperationalNotification.findFirst({
      select: { id: true },
      where: {
        audience: isDriver ? 'DRIVER' : 'OPS',
        id: input.notificationId,
        shopId: input.principal.shopId,
        ...(isDriver ? { recipientAccountId: accountId } : { kind: 'N07' }),
      },
    });
    if (notification === null) throw new DsvOperationalNotificationNotFoundError();
    const ack = await this.prisma.dsvOperationalNotificationAck.upsert({
      create: {
        accountId,
        ackKind: input.ackKind ?? 'READ',
        createdAt: now,
        notificationId: notification.id,
        shopId: input.principal.shopId,
      },
      update: {},
      where: {
        notificationId_accountId_ackKind: {
          accountId,
          ackKind: input.ackKind ?? 'READ',
          notificationId: notification.id,
        },
      },
    });
    return { ackedAt: ack.createdAt.toISOString(), notificationId: notification.id };
  }

  async resolve(input: {
    notificationId: string;
    now?: Date;
    principal: DsvPrincipal;
  }): Promise<DsvOperationalNotificationResolution> {
    const now = input.now ?? new Date();
    const notification = await this.prisma.dsvOperationalNotification.findFirst({
      select: {
        assignmentEpoch: true,
        audience: true,
        businessStatus: true,
        eventId: true,
        executionContextId: true,
        expiresAt: true,
        id: true,
        kind: true,
        recipientAccountId: true,
        routeVersion: true,
        targetStopId: true,
      },
      where: { id: input.notificationId, shopId: input.principal.shopId },
    });
    if (notification === null || notification.expiresAt <= now) throw new DsvOperationalNotificationNotFoundError();
    if (input.principal.principalType !== 'DRIVER') {
      this.requireOpsRead(input.principal);
      if (notification.audience !== 'OPS' || notification.kind !== 'N07') {
        throw new DsvOperationalNotificationNotFoundError();
      }
      if (notification.eventId === null || notification.targetStopId === null) {
        throw new DsvOperationalNotificationNotFoundError();
      }
      const report = await this.prisma.dsvDeliveryException.findFirst({
        select: { id: true },
        where: { id: notification.eventId, shopId: input.principal.shopId },
      });
      if (report === null) throw new DsvOperationalNotificationNotFoundError();
      return {
        destination: {
          executionContextId: notification.executionContextId,
          reportId: report.id,
          targetStopId: notification.targetStopId,
          type: 'OPERATIONS_EXCEPTION',
        },
        notificationId: notification.id,
      };
    }
    const accountId = await this.requireDriverAccount(input.principal);
    if (notification.audience !== 'DRIVER' || notification.recipientAccountId !== accountId) {
      throw new DsvOperationalNotificationNotFoundError();
    }
    if (notification.kind === 'N03') {
      return { destination: { type: 'ASSIGNMENT_RELEASED' }, notificationId: notification.id };
    }
    const resolvedInformational = (notification.kind === 'N04' || notification.kind === 'N05')
      && notification.businessStatus === 'RESOLVED';
    if (notification.businessStatus !== 'OPEN' && !resolvedInformational) throw new DsvOperationalNotificationNotFoundError();
    const context = await this.loadCurrentAuthorizedContext({
      accountId,
      allowRouteVersionDrift: notification.kind === 'N04' || notification.kind === 'N05',
      assignmentEpoch: notification.assignmentEpoch,
      executionContextId: notification.executionContextId,
      routeVersion: notification.routeVersion,
      shopId: input.principal.shopId,
    });
    if (context === null) throw new DsvOperationalNotificationNotFoundError();
    if (notification.kind === 'N06') {
      if (notification.targetStopId === null || !await this.isCurrentNonTerminalStop({
        routePlanId: context.routePlanId,
        shopId: input.principal.shopId,
        targetStopId: notification.targetStopId,
      })) throw new DsvOperationalNotificationNotFoundError();
    }
    return {
      destination: {
        executionContextId: context.id,
        routePlanId: context.routePlanId,
        ...(notification.targetStopId === null ? {} : { targetStopId: notification.targetStopId }),
        type: 'EXECUTION',
      },
      notificationId: notification.id,
    };
  }

  async registerCapability(input: {
    installationId: string;
    kinds: readonly string[];
    now?: Date;
    principal: DsvPrincipal;
    schemaVersion: number;
    tokenId: string;
  }): Promise<{ capabilityId: string; kinds: DsvOperationalDriverNotificationKind[]; schemaVersion: number }> {
    const accountId = await this.requireDriverAccount(input.principal);
    const kinds = [...new Set(input.kinds)];
    if (input.installationId.trim() === '' || input.schemaVersion !== 1 || kinds.length === 0 || !kinds.every(isDriverKind)) {
      throw new DsvOperationalNotificationValidationError('Invalid notification capability.');
    }
    const token = await this.prisma.driverPushToken.findFirst({
      select: { appId: true, deviceId: true, id: true, status: true, tokenHash: true, updatedAt: true },
      where: { accountId, id: input.tokenId },
    });
    if (token === null || token.status !== 'ACTIVE' || token.appId !== DSV_OPERATIONAL_DRIVER_APP_ID) {
      throw new DsvOperationalNotificationNotFoundError();
    }
    if (token.deviceId === null || token.deviceId !== input.installationId) {
      throw new DsvOperationalNotificationValidationError('Capability installation does not match the push token installation.');
    }
    const capability = await this.prisma.dsvNotificationCapability.upsert({
      create: {
        accountId,
        createdAt: input.now ?? new Date(),
        installationId: input.installationId,
        kinds,
        schemaVersion: input.schemaVersion,
        shopId: input.principal.shopId,
        tokenHash: token.tokenHash,
        tokenId: token.id,
        tokenUpdatedAt: token.updatedAt,
      },
      update: {
        accountId,
        installationId: input.installationId,
        kinds,
        schemaVersion: input.schemaVersion,
        shopId: input.principal.shopId,
        tokenHash: token.tokenHash,
        tokenUpdatedAt: token.updatedAt,
      },
      where: { tokenId: token.id },
    });
    return { capabilityId: capability.id, kinds, schemaVersion: capability.schemaVersion };
  }

  async runOnce(now = new Date()): Promise<DsvOperationalNotificationRunResult> {
    const policy = this.currentPolicy();
    const result: DsvOperationalNotificationRunResult = {
      attempted: 0,
      blockedByPolicy: !isCompleteLivePolicy(policy),
      dead: 0,
      sent: 0,
      skipped: 0,
    };
    await this.expireOldNotifications(now);
    if (result.blockedByPolicy) return result;
    await this.materializeAttempts(now);
    const candidates = await this.prisma.dsvOperationalNotificationAttempt.findMany({
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      select: { id: true, leaseExpiresAt: true, status: true },
      take: this.options.batchSize ?? 25,
      where: {
        nextAttemptAt: { lte: now },
        OR: [
          { status: { in: ['PENDING', 'RETRY'] } },
          { leaseExpiresAt: { lte: now }, status: 'LEASED' },
        ],
      },
    });
    for (const candidate of candidates) {
      const claimNow = this.options.clock?.() ?? new Date();
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(claimNow.getTime() + (this.options.leaseMs ?? 60_000));
      const claimed = await this.prisma.dsvOperationalNotificationAttempt.updateMany({
        data: { attemptCount: { increment: 1 }, leaseExpiresAt, leaseToken, status: 'LEASED' },
        where: {
          id: candidate.id,
          ...(candidate.status === 'LEASED'
            ? { leaseExpiresAt: { lte: claimNow }, status: 'LEASED' }
            : { status: candidate.status }),
        },
      });
      if (claimed.count !== 1) continue;
      result.attempted += 1;
      const outcome = await this.processLease({ attemptId: candidate.id, leaseExpiresAt, leaseToken });
      result[outcome] += 1;
    }
    return result;
  }

  private async materializeAttempts(now: Date): Promise<void> {
    const policy = this.currentPolicy();
    const notifications = await this.prisma.$queryRaw<Array<{
      id: string;
      kind: string;
      recipientAccountId: string;
      shopId: string;
    }>>(Prisma.sql`
      SELECT
        notification."id",
        notification."kind",
        notification."recipientAccountId",
        notification."shopId"
      FROM "dsv_operational_notifications" notification
      WHERE notification."audience" = 'DRIVER'
        AND notification."businessStatus" = 'OPEN'
        AND notification."dueAt" <= ${now}
        AND notification."expiresAt" > ${now}
        AND notification."recipientAccountId" IS NOT NULL
        AND notification."kind" IN (${Prisma.join(policy.allowedKinds)})
        AND EXISTS (
          SELECT 1
          FROM "dsv_notification_capabilities" capability
          WHERE capability."shopId" = notification."shopId"
            AND capability."accountId" = notification."recipientAccountId"
            AND capability."kinds" @> ARRAY[notification."kind"]::text[]
            AND NOT EXISTS (
              SELECT 1
              FROM "dsv_operational_notification_attempts" attempt
              WHERE attempt."notificationId" = notification."id"
                AND attempt."tokenId" = capability."tokenId"
                AND attempt."capabilityId" = capability."id"
            )
        )
      ORDER BY notification."dueAt" ASC, notification."id" ASC
      LIMIT ${(this.options.batchSize ?? 25) * 2}
    `);
    for (const notification of notifications) {
      if (!isDriverKind(notification.kind) || !policy.allowedKinds.includes(notification.kind)) continue;
      const capabilities = await this.prisma.dsvNotificationCapability.findMany({
        select: { id: true, kinds: true, tokenId: true },
        where: { accountId: notification.recipientAccountId, shopId: notification.shopId },
      });
      const supported = capabilities.filter((capability) => capability.kinds.includes(notification.kind));
      if (supported.length === 0) continue;
      await this.prisma.dsvOperationalNotificationAttempt.createMany({
        data: supported.map((capability) => ({
          capabilityId: capability.id,
          nextAttemptAt: now,
          notificationId: notification.id,
          shopId: notification.shopId,
          tokenId: capability.tokenId,
        })),
        skipDuplicates: true,
      });
    }
  }

  private async processLease(input: {
    attemptId: string;
    leaseExpiresAt: Date;
    leaseToken: string;
  }): Promise<'dead' | 'sent' | 'skipped'> {
    const validationNow = this.options.clock?.() ?? new Date();
    const attempt = await this.prisma.dsvOperationalNotificationAttempt.findFirst({
      select: {
        attemptCount: true,
        capabilityId: true,
        id: true,
        notificationId: true,
        shopId: true,
        tokenId: true,
      },
      where: { id: input.attemptId, leaseToken: input.leaseToken, status: 'LEASED' },
    });
    if (attempt === null) return 'skipped';
    const { capability, notification, token } = await this.loadAttemptSendState(attempt);
    const validationPolicy = this.currentPolicy();
    if (
      isCompleteLivePolicy(validationPolicy)
      && attempt.attemptCount > validationPolicy.maxProviderAttempts!
    ) {
      const completed = await this.completeLease(input, {
        completedAt: validationNow,
        errorCode: 'PROVIDER_ATTEMPT_CAP_REACHED',
        leaseExpiresAt: null,
        leaseToken: null,
        status: 'DEAD',
      }, validationNow);
      return completed ? 'dead' : 'skipped';
    }
    const invalidReason = await this.validateBeforeSend(
      { capability, notification, now: validationNow, token },
      validationPolicy,
    );
    if (invalidReason !== null) {
      await this.completeLease(input, {
        completedAt: validationNow,
        errorCode: invalidReason,
        leaseExpiresAt: null,
        leaseToken: null,
        status: 'SKIPPED',
      }, validationNow);
      return 'skipped';
    }
    const fresh = await this.loadAttemptSendState(attempt);
    const sendNow = this.options.clock?.() ?? new Date();
    const sendPolicy = this.currentPolicy();
    if (!isCompleteLivePolicy(sendPolicy)) {
      await this.completeLease(input, {
        completedAt: sendNow,
        errorCode: 'LIVE_POLICY_DISABLED',
        leaseExpiresAt: null,
        leaseToken: null,
        status: 'SKIPPED',
      }, sendNow);
      return 'skipped';
    }
    const freshInvalidReason = await this.validateBeforeSend({ ...fresh, now: sendNow }, sendPolicy);
    if (freshInvalidReason !== null) {
      await this.completeLease(input, {
        completedAt: sendNow,
        errorCode: freshInvalidReason,
        leaseExpiresAt: null,
        leaseToken: null,
        status: 'SKIPPED',
      }, sendNow);
      return 'skipped';
    }
    const stillOwnsLease = await this.prisma.dsvOperationalNotificationAttempt.findFirst({
      select: { id: true },
      where: {
        id: input.attemptId,
        leaseExpiresAt: { gt: sendNow },
        leaseToken: input.leaseToken,
        status: 'LEASED',
      },
    });
    if (stillOwnsLease === null) return 'skipped';
    const kind = fresh.notification!.kind as DsvOperationalDriverNotificationKind;
    const copy = notificationCopy(kind);
    const providerResult = await this.provider.send({
      ...copy,
      collapseKey: kind === 'N06'
        ? `${fresh.notification!.executionContextId}:${kind}:${fresh.notification!.targetStopId}:${fresh.notification!.ordinal}`
        : `${fresh.notification!.executionContextId}:${kind}`,
      payload: {
        expiresAt: fresh.notification!.expiresAt.toISOString(),
        kind,
        notificationId: fresh.notification!.id,
        schemaVersion: PUSH_SCHEMA_VERSION,
      },
      token: fresh.token!.devicePushToken,
      ttlMs: Math.max(0, fresh.notification!.expiresAt.getTime() - sendNow.getTime()),
    });
    const completedAt = this.options.clock?.() ?? new Date();
    if (providerResult.status === 'SENT') {
      const completed = await this.completeLease(input, {
        completedAt,
        errorCode: null,
        leaseExpiresAt: null,
        leaseToken: null,
        providerMessageId: providerResult.providerMessageId ?? null,
        status: 'SENT',
      }, completedAt);
      return completed ? 'sent' : 'skipped';
    }
    if (providerResult.invalidToken === true) {
      const completed = await this.completeInvalidTokenLease(input, {
        completedAt,
        errorCode: providerResult.errorCode ?? 'INVALID_TOKEN',
        tokenHash: fresh.token!.tokenHash,
        tokenId: fresh.token!.id,
      });
      return completed ? 'dead' : 'skipped';
    }
    const exhausted = attempt.attemptCount >= sendPolicy.maxProviderAttempts! || completedAt >= fresh.notification!.expiresAt;
    const completed = await this.completeLease(input, {
      ...(exhausted ? { completedAt } : {}),
      errorCode: providerResult.errorCode ?? 'PROVIDER_SEND_FAILED',
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: new Date(completedAt.getTime() + sendPolicy.retryDelayMs),
      status: exhausted ? 'DEAD' : 'RETRY',
    }, completedAt);
    if (!completed) return 'skipped';
    return exhausted ? 'dead' : 'skipped';
  }

  private async loadAttemptSendState(attempt: {
    capabilityId: string;
    notificationId: string;
    shopId: string;
    tokenId: string;
  }) {
    const [notification, capability, token] = await Promise.all([
      this.prisma.dsvOperationalNotification.findFirst({
        select: {
          assignmentEpoch: true,
          audience: true,
          businessStatus: true,
          createdAt: true,
          dueAt: true,
          executionContextId: true,
          expiresAt: true,
          id: true,
          kind: true,
          ordinal: true,
          recipientAccountId: true,
          routeVersion: true,
          targetStopId: true,
        },
        where: { id: attempt.notificationId, shopId: attempt.shopId },
      }),
      this.prisma.dsvNotificationCapability.findFirst({
        select: {
          accountId: true,
          id: true,
          installationId: true,
          kinds: true,
          schemaVersion: true,
          shopId: true,
          tokenHash: true,
          tokenId: true,
          tokenUpdatedAt: true,
        },
        where: { id: attempt.capabilityId, shopId: attempt.shopId },
      }),
      this.prisma.driverPushToken.findUnique({
        select: {
          account: { select: { status: true } },
          accountId: true,
          appId: true,
          deviceId: true,
          devicePushToken: true,
          id: true,
          status: true,
          tokenHash: true,
          updatedAt: true,
        },
        where: { id: attempt.tokenId },
      }),
    ]);
    return { capability, notification, token };
  }

  private async validateBeforeSend(input: {
    capability: {
      accountId: string;
      id: string;
      installationId: string;
      kinds: string[];
      schemaVersion: number;
      shopId: string;
      tokenHash: string;
      tokenId: string;
      tokenUpdatedAt: Date;
    } | null;
    notification: {
      assignmentEpoch: bigint;
      audience: string;
      businessStatus: string;
      createdAt: Date;
      dueAt: Date;
      executionContextId: string;
      expiresAt: Date;
      id: string;
      kind: string;
      ordinal: number;
      recipientAccountId: string | null;
      routeVersion: number;
      targetStopId: string | null;
    } | null;
    now: Date;
    token: {
      account: { status: string };
      accountId: string;
      appId: string;
      deviceId: string | null;
      devicePushToken: string;
      id: string;
      status: string;
      tokenHash: string;
      updatedAt: Date;
    } | null;
  }, policy: DsvOperationalNotificationSendPolicy): Promise<string | null> {
    const { capability, notification, now, token } = input;
    if (!isCompleteLivePolicy(policy)) return 'LIVE_POLICY_DISABLED';
    if (notification === null || notification.audience !== 'DRIVER' || notification.businessStatus !== 'OPEN') return 'NOTIFICATION_NOT_OPEN';
    if (!isDriverKind(notification.kind) || !policy.allowedKinds.includes(notification.kind)) return 'KIND_NOT_ALLOWED';
    if (notification.dueAt > now) return 'NOTIFICATION_NOT_DUE';
    if (notification.expiresAt <= now) return 'NOTIFICATION_EXPIRED';
    if (notification.expiresAt.getTime() - notification.createdAt.getTime() > policy.notificationRetentionMs!) {
      return 'RETENTION_EXCEEDS_POLICY';
    }
    if (notification.kind === 'N05' && notification.ordinal > policy.businessReminderCap!) return 'REMINDER_CAP_REACHED';
    if (capability === null || token === null) return 'CAPABILITY_OR_TOKEN_MISSING';
    if (!policy.allowedShopIds.includes(capability.shopId) || !policy.allowedAccountIds.includes(capability.accountId)) {
      return 'RECIPIENT_NOT_ALLOWLISTED';
    }
    if (capability.accountId !== notification.recipientAccountId || token.accountId !== capability.accountId) return 'RECIPIENT_CHANGED';
    if (capability.tokenId !== token.id || capability.tokenHash !== token.tokenHash || capability.tokenUpdatedAt.getTime() !== token.updatedAt.getTime()) {
      return 'CAPABILITY_STALE';
    }
    if (token.deviceId === null || capability.installationId !== token.deviceId) return 'INSTALLATION_STALE';
    if (!capability.kinds.includes(notification.kind) || capability.schemaVersion !== 1) return 'KIND_UNSUPPORTED';
    if (token.status !== 'ACTIVE' || token.account.status !== 'ACTIVE' || token.appId !== DSV_OPERATIONAL_DRIVER_APP_ID) return 'TOKEN_OR_ACCOUNT_INACTIVE';
    const context = notification.kind === 'N03'
      ? await this.loadReleaseContext({
        accountId: capability.accountId,
        assignmentEpoch: notification.assignmentEpoch,
        executionContextId: notification.executionContextId,
        shopId: capability.shopId,
      })
      : await this.loadCurrentAuthorizedContext({
        accountId: capability.accountId,
        allowRouteVersionDrift: notification.kind === 'N04' || notification.kind === 'N05',
        assignmentEpoch: notification.assignmentEpoch,
        executionContextId: notification.executionContextId,
        routeVersion: notification.routeVersion,
        shopId: capability.shopId,
      });
    if (context === null) return 'EXECUTION_CONTEXT_STALE';
    if ((notification.kind === 'N04' || notification.kind === 'N05') && 'startedAt' in context && context.startedAt !== null) {
      return 'START_ALREADY_RECORDED';
    }
    if (context.notificationMode !== 'LIVE' || context.liveEligibleAt === null || context.liveEligibleAt > now) return 'EXECUTION_NOT_LIVE_ELIGIBLE';
    if (notification.createdAt < context.liveEligibleAt) return 'INTENT_PREDATES_LIVE_ELIGIBILITY';
    const contextPolicy = jsonRecord(context.policy);
    if (contextPolicy?.authorizationId !== policy.approvedAuthorizationId) return 'POLICY_AUTHORIZATION_MISMATCH';
    if (
      (notification.kind === 'N04' || notification.kind === 'N05' || notification.kind === 'N06')
      && contextPolicy?.policyVersion !== policy.approvedGeofencePolicyVersion
    ) return 'GEOFENCE_POLICY_MISMATCH';
    if (notification.kind === 'N06') {
      if (!('routePlanId' in context) || typeof context.routePlanId !== 'string' || notification.targetStopId === null || !await this.isCurrentNonTerminalStop({
        routePlanId: context.routePlanId,
        shopId: capability.shopId,
        targetStopId: notification.targetStopId,
      })) return 'TARGET_STOP_STALE';
    }
    if (notification.kind === 'N03') return null;
    if (context.monitorStartAt === null || context.monitorEndAt === null || now < context.monitorStartAt || now > context.monitorEndAt) return 'OUTSIDE_MONITOR_WINDOW';
    if (context.monitorEndAt.getTime() - context.monitorStartAt.getTime() > policy.monitorWindowMs!) return 'MONITOR_WINDOW_EXCEEDS_POLICY';
    return null;
  }

  private currentPolicy(): DsvOperationalNotificationSendPolicy {
    return typeof this.policySource === 'function' ? this.policySource() : this.policySource;
  }

  private async loadReleaseContext(input: {
    accountId: string;
    assignmentEpoch: bigint;
    executionContextId: string;
    shopId: string;
  }) {
    return this.prisma.dsvExecutionContext.findFirst({
      select: {
        liveEligibleAt: true,
        monitorEndAt: true,
        monitorStartAt: true,
        notificationMode: true,
        policy: true,
        status: true,
        closedAt: true,
      },
      where: {
        assignmentEpoch: { gte: input.assignmentEpoch },
        id: input.executionContextId,
        OR: [
          { assignmentEpoch: { gt: input.assignmentEpoch }, NOT: { recipientAccountId: input.accountId } },
          { closedAt: { not: null } },
          { status: { not: 'ACTIVE' } },
        ],
        shopId: input.shopId,
      },
    });
  }

  private async loadCurrentAuthorizedContext(input: {
    accountId: string;
    allowRouteVersionDrift?: boolean;
    assignmentEpoch: bigint;
    executionContextId: string;
    routeVersion: number;
    shopId: string;
  }) {
    const context = await this.prisma.dsvExecutionContext.findFirst({
      select: {
        closedAt: true,
        driverId: true,
        id: true,
        liveEligibleAt: true,
        monitorEndAt: true,
        monitorStartAt: true,
        notificationMode: true,
        policy: true,
        routePlanId: true,
        startedAt: true,
        status: true,
        vehicleId: true,
      },
      where: {
        assignmentEpoch: input.assignmentEpoch,
        id: input.executionContextId,
        recipientAccountId: input.accountId,
        ...(input.allowRouteVersionDrift === true ? {} : { routeVersion: input.routeVersion }),
        shopId: input.shopId,
      },
    });
    if (context === null || context.status !== 'ACTIVE' || context.closedAt !== null || context.driverId === null) return null;
    const route = await this.prisma.routePlan.findFirst({
      select: {
        driver: { select: { accountId: true, status: true } },
        driverId: true,
        status: true,
        vehicle: { select: { status: true } },
        vehicleId: true,
      },
      where: { id: context.routePlanId, shopId: input.shopId },
    });
    if (
      route === null
      || route.status === 'CANCELLED'
      || route.status === 'COMPLETED'
      || route.status === 'INCOMPLETE'
      || route.driverId !== context.driverId
      || route.vehicleId !== context.vehicleId
      || (context.vehicleId !== null && route.vehicle?.status !== 'ACTIVE')
      || route.driver?.accountId !== input.accountId
      || route.driver.status !== 'ACTIVE'
    ) return null;
    const publishedChild = await this.prisma.routeGroupingChildVersion.findFirst({
      select: { id: true },
      where: {
        driverId: context.driverId,
        publishedAt: { not: null },
        routePlanId: context.routePlanId,
        shopId: input.shopId,
        status: 'CURRENT',
        supersededAt: null,
      },
    });
    if (publishedChild === null) return null;
    return context;
  }

  private async requireDriverAccount(principal: DsvPrincipal): Promise<string> {
    if (principal.principalType !== 'DRIVER' || !principal.scopes.includes('driver:assignments:read')) {
      throw new DsvForbiddenError({ principal, requiredScopes: ['driver:assignments:read'] });
    }
    const driver = await this.prisma.driver.findFirst({
      select: { account: { select: { status: true } }, accountId: true, status: true },
      where: { id: principal.driverId, shopId: principal.shopId },
    });
    if (driver?.status !== 'ACTIVE' || driver.account?.status !== 'ACTIVE' || driver.accountId === null) {
      throw new DsvForbiddenError({ principal, requiredScopes: ['driver:assignments:read'] });
    }
    return driver.accountId;
  }

  private requireOpsRead(principal: DsvPrincipal): void {
    if (principal.principalType !== 'DSV_ADMIN' || !principal.scopes.includes('dsv:control:read')) {
      throw new DsvForbiddenError({ principal, requiredScopes: ['dsv:control:read'] });
    }
  }

  private requireOpsActor(principal: DsvPrincipal): string {
    this.requireOpsRead(principal);
    const actorId = principal.principalType === 'DSV_ADMIN' ? principal.actorId : undefined;
    if (actorId === undefined || !UUID_PATTERN.test(actorId)) {
      throw new DsvOperationalNotificationValidationError('Operations acknowledgement requires a UUID actor identifier.');
    }
    return actorId;
  }

  private async isCurrentNonTerminalStop(input: { routePlanId: string; shopId: string; targetStopId: string }): Promise<boolean> {
    const stop = await this.prisma.routePlanStop.findFirst({
      select: { deliveryStop: { select: { status: true } } },
      where: { deliveryStopId: input.targetStopId, routePlanId: input.routePlanId, shopId: input.shopId },
    });
    return stop !== null && !TERMINAL_STOP_STATUSES.has(stop.deliveryStop.status);
  }

  private async expireOldNotifications(now: Date): Promise<void> {
    const expired = await this.prisma.dsvOperationalNotification.findMany({
      select: { id: true },
      where: { businessStatus: 'OPEN', expiresAt: { lte: now } },
    });
    if (expired.length === 0) return;
    const ids = expired.map((row) => row.id);
    await this.prisma.$transaction([
      this.prisma.dsvOperationalNotification.updateMany({
        data: { businessStatus: 'EXPIRED', resolutionReason: 'TTL_EXPIRED', resolvedAt: now },
        where: { businessStatus: 'OPEN', id: { in: ids } },
      }),
      this.prisma.dsvOperationalNotificationAttempt.updateMany({
        data: { completedAt: now, errorCode: 'NOTIFICATION_EXPIRED', leaseExpiresAt: null, leaseToken: null, status: 'SKIPPED' },
        where: { notificationId: { in: ids }, status: { in: ['PENDING', 'RETRY'] } },
      }),
    ]);
  }

  private async completeLease(
    input: { attemptId: string; leaseExpiresAt: Date; leaseToken: string },
    data: Prisma.DsvOperationalNotificationAttemptUpdateManyMutationInput,
    completedAt: Date,
  ): Promise<boolean> {
    const completed = await this.prisma.dsvOperationalNotificationAttempt.updateMany({
      data,
      where: {
        id: input.attemptId,
        leaseExpiresAt: {
          equals: input.leaseExpiresAt,
          gt: completedAt,
        },
        leaseToken: input.leaseToken,
        status: 'LEASED',
      },
    });
    if (completed.count === 0) {
      this.logger?.warn?.({ attemptId: input.attemptId }, 'Rejected stale operational notification worker completion.');
    }
    return completed.count === 1;
  }

  private async completeInvalidTokenLease(
    input: { attemptId: string; leaseExpiresAt: Date; leaseToken: string },
    data: { completedAt: Date; errorCode: string; tokenHash: string; tokenId: string },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const completed = await transaction.dsvOperationalNotificationAttempt.updateMany({
        data: {
          completedAt: data.completedAt,
          errorCode: data.errorCode,
          leaseExpiresAt: null,
          leaseToken: null,
          status: 'DEAD',
        },
        where: {
          id: input.attemptId,
          leaseExpiresAt: { equals: input.leaseExpiresAt, gt: data.completedAt },
          leaseToken: input.leaseToken,
          status: 'LEASED',
        },
      });
      if (completed.count !== 1) return false;
      await transaction.driverPushToken.updateMany({
        data: { revokedAt: data.completedAt, status: 'INVALID' },
        where: { id: data.tokenId, tokenHash: data.tokenHash },
      });
      return true;
    });
  }
}

export class DsvOperationalNotificationNotFoundError extends Error {
  readonly code = 'DSV_OPERATIONAL_NOTIFICATION_NOT_FOUND';
  readonly httpStatus = 404;

  constructor() {
    super('Operational notification was not found.');
    this.name = 'DsvOperationalNotificationNotFoundError';
  }
}

export class DsvOperationalNotificationValidationError extends Error {
  readonly code = 'DSV_OPERATIONAL_NOTIFICATION_INVALID';
  readonly httpStatus = 400;

  constructor(message: string) {
    super(message);
    this.name = 'DsvOperationalNotificationValidationError';
  }
}

export function isCompleteLivePolicy(policy: DsvOperationalNotificationSendPolicy): boolean {
  return policy.liveSendingEnabled === true
    && Array.isArray(policy.allowedAccountIds)
    && policy.allowedAccountIds.length > 0
    && policy.allowedAccountIds.every((value) => typeof value === 'string' && UUID_PATTERN.test(value))
    && Array.isArray(policy.allowedShopIds)
    && policy.allowedShopIds.length > 0
    && policy.allowedShopIds.every((value) => typeof value === 'string' && UUID_PATTERN.test(value))
    && typeof policy.approvedAuthorizationId === 'string'
    && policy.approvedAuthorizationId.trim() !== ''
    && typeof policy.approvedGeofencePolicyVersion === 'string'
    && policy.approvedGeofencePolicyVersion.trim() !== ''
    && policy.businessReminderCap !== null
    && Number.isInteger(policy.businessReminderCap)
    && policy.businessReminderCap > 0
    && policy.maxProviderAttempts !== null
    && Number.isInteger(policy.maxProviderAttempts)
    && policy.maxProviderAttempts > 0
    && policy.monitorWindowMs !== null
    && Number.isFinite(policy.monitorWindowMs)
    && policy.monitorWindowMs > 0
    && policy.notificationRetentionMs !== null
    && Number.isFinite(policy.notificationRetentionMs)
    && policy.notificationRetentionMs > 0
    && Number.isFinite(policy.retryDelayMs)
    && policy.retryDelayMs >= 0
    && Array.isArray(policy.allowedKinds)
    && policy.allowedKinds.length > 0
    && policy.allowedKinds.every((kind) => typeof kind === 'string' && isDriverKind(kind));
}

function isDriverKind(value: string): value is DsvOperationalDriverNotificationKind {
  return (dsvOperationalDriverNotificationKinds as readonly string[]).includes(value);
}

function normalizeBusinessStatus(value: string): DsvOperationalInboxItem['businessStatus'] {
  if (value === 'CANCELLED' || value === 'EXPIRED' || value === 'RESOLVED') return value;
  return 'OPEN';
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): { createdAt: Date; id: string } | null {
  if (value === undefined) return null;
  try {
    const [createdAt, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
    const date = new Date(createdAt ?? '');
    if (rest.length !== 0 || id === undefined || !UUID_PATTERN.test(id)
      || Number.isNaN(date.getTime()) || date.toISOString() !== createdAt) throw new Error('invalid');
    return { createdAt: date, id };
  } catch {
    throw new DsvOperationalNotificationValidationError('Invalid inbox cursor.');
  }
}

function jsonRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, Prisma.JsonValue>;
}

const TERMINAL_STOP_STATUSES = new Set(['DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
