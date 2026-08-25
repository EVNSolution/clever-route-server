import type { PrismaClient } from '@prisma/client';
import type { PrismaOperationalAlertRepository } from '../notifications/operational-alert.repository.js';
import { normalizeShopDomain } from '../commerce/commerce-connection.repository.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';

export type EmailRuntimeHealth = {
  automatic: {
    senderConfigured: boolean;
    workerEnabled: boolean;
  };
  configured: boolean;
  manual: { brevoConfigured: boolean };
  outbox: {
    deadLetter: number;
    lastErrorCode: string | null;
    lastSuccessAt: string | null;
    oldestPendingAt: string | null;
    pending: number;
    processing: number;
    retryWait: number;
  };
  state: 'DEGRADED' | 'DISABLED' | 'HEALTHY';
};

type EmailRuntimeHealthThresholds = {
  processingStaleAfterMs: number;
  queuedStaleAfterMs: number;
  retryWaitStaleAfterMs: number;
};

const DEFAULT_THRESHOLDS: EmailRuntimeHealthThresholds = {
  processingStaleAfterMs: 5 * 60_000,
  queuedStaleAfterMs: 15 * 60_000,
  retryWaitStaleAfterMs: 30 * 60_000
};
const MAX_THRESHOLD_MS = 7 * 24 * 60 * 60_000;

export class PrismaEmailRuntimeHealthService {
  private readonly thresholds: EmailRuntimeHealthThresholds;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: {
      automaticSenderConfigured: boolean;
      automaticWorkerEnabled: boolean;
      manualBrevoConfigured: boolean;
      thresholds?: Partial<EmailRuntimeHealthThresholds>;
    },
    private readonly alerts?: PrismaOperationalAlertRepository,
    private readonly now: () => Date = () => new Date()
  ) {
    this.thresholds = validateThresholds(config.thresholds);
  }

  async get(input: { shopDomain: string }): Promise<{ email: EmailRuntimeHealth; observedAt: string }> {
    const now = this.now();
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain: normalizeShopDomain(input.shopDomain) })
    });
    const shopId = shop?.id ?? '__missing_shop__';
    const scope = { shopId };
    const [pending, processing, retryWait, deadLetter, oldestQueued, oldestRetry, oldestProcessing, lastSuccess, lastError] = await Promise.all([
      this.prisma.customerRouteNotificationFact.count({ where: { ...scope, attemptCount: 0, status: 'QUEUED' } }),
      this.prisma.customerRouteNotificationFact.count({ where: { ...scope, status: 'PROCESSING' } }),
      this.prisma.customerRouteNotificationFact.count({ where: { ...scope, attemptCount: { gt: 0 }, status: 'QUEUED' } }),
      this.prisma.customerRouteNotificationFact.count({ where: {
        ...scope,
        OR: [{ errorCode: null }, { errorCode: { not: 'OPERATOR_DO_NOT_SEND' } }],
        status: 'DEAD'
      } }),
      this.prisma.customerRouteNotificationFact.findFirst({ orderBy: { occurredAt: 'asc' }, select: { occurredAt: true }, where: { ...scope, attemptCount: 0, status: 'QUEUED' } }),
      this.prisma.customerRouteNotificationFact.findFirst({ orderBy: { occurredAt: 'asc' }, select: { occurredAt: true }, where: { ...scope, attemptCount: { gt: 0 }, status: 'QUEUED' } }),
      this.prisma.customerRouteNotificationFact.findFirst({ orderBy: { updatedAt: 'asc' }, select: { updatedAt: true }, where: { ...scope, status: 'PROCESSING' } }),
      this.prisma.customerRouteNotificationFact.findFirst({ orderBy: { sentAt: 'desc' }, select: { sentAt: true }, where: { ...scope, sentAt: { not: null }, status: 'SENT' } }),
      this.prisma.customerRouteNotificationFact.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { errorCode: true, updatedAt: true },
        where: { ...scope, errorCode: { not: null }, NOT: { errorCode: 'OPERATOR_DO_NOT_SEND' } }
      })
    ]);
    const configured = this.config.automaticSenderConfigured && this.config.automaticWorkerEnabled;
    const unresolvedLastError = lastError !== null
      && (lastSuccess?.sentAt === null || lastSuccess?.sentAt === undefined || lastError.updatedAt === undefined || lastSuccess.sentAt <= lastError.updatedAt);
    const state = !configured
      ? 'DISABLED'
      : deadLetter > 0
        || isStale(oldestQueued?.occurredAt, now, this.thresholds.queuedStaleAfterMs)
        || isStale(oldestRetry?.occurredAt, now, this.thresholds.retryWaitStaleAfterMs)
        || isStale(oldestProcessing?.updatedAt, now, this.thresholds.processingStaleAfterMs)
        || unresolvedLastError
        ? 'DEGRADED'
        : 'HEALTHY';
    if (this.alerts !== undefined && shop !== null) {
      await (state === 'DISABLED'
        ? this.alerts.openOrObserve({
            dedupeKey: 'EMAIL_RUNTIME_DISABLED', observedAt: now, severity: 'CRITICAL', shopId: shop.id,
            title: 'Customer email runtime is disabled', type: 'EMAIL_RUNTIME_DISABLED'
          })
        : this.alerts.resolveByDedupeKey({
            dedupeKey: 'EMAIL_RUNTIME_DISABLED', resolutionCode: 'EMAIL_RUNTIME_RECOVERED', resolvedAt: now, shopId: shop.id
          }));
    }
    return {
      email: {
        automatic: {
          senderConfigured: this.config.automaticSenderConfigured,
          workerEnabled: this.config.automaticWorkerEnabled
        },
        configured,
        manual: { brevoConfigured: this.config.manualBrevoConfigured },
        outbox: {
          deadLetter,
          lastErrorCode: sanitizeErrorCode(lastError?.errorCode),
          lastSuccessAt: lastSuccess?.sentAt?.toISOString() ?? null,
          oldestPendingAt: oldestDate(oldestQueued?.occurredAt, oldestRetry?.occurredAt)?.toISOString() ?? null,
          pending,
          processing,
          retryWait
        },
        state
      },
      observedAt: now.toISOString()
    };
  }
}

function validateThresholds(input: Partial<EmailRuntimeHealthThresholds> | undefined): EmailRuntimeHealthThresholds {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...input };
  for (const [key, value] of Object.entries(thresholds)) {
    if (!Number.isInteger(value) || value < 1_000 || value > MAX_THRESHOLD_MS) {
      throw new Error(`${key} must be an integer between 1000 and ${MAX_THRESHOLD_MS}`);
    }
  }
  return thresholds;
}

function isStale(value: Date | null | undefined, now: Date, thresholdMs: number): boolean {
  return value !== null && value !== undefined && now.getTime() - value.getTime() > thresholdMs;
}

function oldestDate(...values: Array<Date | null | undefined>): Date | null {
  const dates = values.filter((value): value is Date => value instanceof Date);
  return dates.length === 0 ? null : new Date(Math.min(...dates.map((value) => value.getTime())));
}

function sanitizeErrorCode(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : 'UNSANITIZED_PROVIDER_ERROR';
}
