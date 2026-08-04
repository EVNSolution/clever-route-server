import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

import { redactTelemetryMessage, safeErrorCode } from '../security/safe-telemetry-redaction.js';
import { appScopedShopWhere, normalizeShopifyAppId } from './shopify-app-scope.js';
import type {
  ClaimedShopifyOrderReconciliationJob,
  EnqueueShopifyOrderReconciliationInput,
  EnqueueShopifyOrderReconciliationResult,
  ShopifyOrderReconciliationJobDto
} from './order-reconciliation.types.js';

type ReconciliationDataClient = Pick<PrismaClient, 'order' | 'shop' | 'shopifyOrderReconciliationJob'>;
type ReconciliationPrismaClient = ReconciliationDataClient & Pick<PrismaClient, '$transaction'>;

type JobRecord = Awaited<ReturnType<PrismaClient['shopifyOrderReconciliationJob']['findUnique']>>;

export class PrismaShopifyOrderReconciliationRepository {
  constructor(private readonly prisma: ReconciliationPrismaClient) {}

  async enqueue(input: EnqueueShopifyOrderReconciliationInput): Promise<ShopifyOrderReconciliationJobDto> {
    const appId = normalizeShopifyAppId(input.appId);
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ appId, shopDomain })
    });
    if (shop === null) throw new Error(`Shop not installed: ${input.shopDomain}`);

    return this.createJob(this.prisma, { appId, input, shopDomain, shopId: shop.id });
  }

  async enqueueIfIdle(input: EnqueueShopifyOrderReconciliationInput): Promise<EnqueueShopifyOrderReconciliationResult> {
    const appId = normalizeShopifyAppId(input.appId);
    const shopDomain = normalizeShopDomain(input.shopDomain);
    return this.prisma.$transaction(async (tx) => {
      const lock = await tx.$queryRaw<{ locked: boolean }[]>(Prisma.sql`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended(${`shopify-order-reconciliation:${appId}:${shopDomain}`}, 0)
        ) AS "locked"
      `);
      if (lock[0]?.locked !== true) return { enqueued: false, job: null };
      const shop = await tx.shop.findUnique({
        select: { id: true },
        where: appScopedShopWhere({ appId, shopDomain })
      });
      if (shop === null) throw new Error(`Shop not installed: ${input.shopDomain}`);

      const active = await tx.shopifyOrderReconciliationJob.findFirst({
        orderBy: { createdAt: 'desc' },
        where: {
          appId,
          shopId: shop.id,
          status: { in: ['QUEUED', 'RUNNING', 'RETRY_WAIT', 'FAILED'] }
        }
      });
      if (active !== null) {
        if (active.status === 'RETRY_WAIT' || active.status === 'FAILED') {
          const reactivated = await tx.shopifyOrderReconciliationJob.update({
            data: {
              attemptCount: 0,
              deadLetteredAt: null,
              finishedAt: null,
              lastErrorCode: null,
              lastErrorMessageRedacted: null,
              nextRunAt: new Date(),
              requestedBy: input.requestedBy ?? active.requestedBy,
              status: 'QUEUED'
            },
            where: { id: active.id }
          });
          return { enqueued: false, job: toDto(reactivated) };
        }
        return { enqueued: false, job: toDto(active) };
      }

      const job = await this.createJob(tx, { appId, input, shopDomain, shopId: shop.id });
      return { enqueued: true, job };
    });
  }

  async enqueueDueInstalledShops(input: {
    limit: number;
    now?: Date | undefined;
    requestedBy: string;
    staleBefore: Date;
  }): Promise<{ enqueued: number; failed: number; skipped: number }> {
    const now = input.now ?? new Date();
    const shops = await this.prisma.shop.findMany({
      orderBy: { updatedAt: 'asc' },
      select: { appId: true, shopDomain: true },
      take: Math.min(500, Math.max(1, input.limit)),
      where: {
        adminAccessTokenCiphertext: { not: null },
        tokenScopes: { has: 'read_orders' },
        uninstalledAt: null,
        AND: [
          {
            OR: [
              { adminAccessTokenExpiresAt: null },
              { adminAccessTokenExpiresAt: { gt: now } },
              {
                adminRefreshTokenCiphertext: { not: null },
                OR: [
                  { adminRefreshTokenExpiresAt: null },
                  { adminRefreshTokenExpiresAt: { gt: now } }
                ]
              }
            ]
          },
          {
            shopifyOrderReconciliationJobs: {
              none: {
                OR: [
                  { status: { in: ['QUEUED', 'RUNNING', 'RETRY_WAIT', 'FAILED'] } },
                  { status: 'SUCCEEDED', finishedAt: { gte: input.staleBefore } },
                  { status: 'DEAD_LETTER' }
                ]
              }
            }
          }
        ]
      }
    });

    let enqueued = 0;
    let failed = 0;
    let skipped = 0;
    for (const shop of shops) {
      try {
        const result = await this.enqueueIfIdle({
          appId: shop.appId,
          mode: 'INCREMENTAL',
          requestedBy: input.requestedBy,
          shopDomain: shop.shopDomain
        });
        if (result.enqueued) enqueued += 1;
        else skipped += 1;
      } catch {
        failed += 1;
      }
    }
    return { enqueued, failed, skipped };
  }

  private async createJob(client: ReconciliationDataClient, input: {
    appId: string;
    input: EnqueueShopifyOrderReconciliationInput;
    shopDomain: string;
    shopId: string;
  }): Promise<ShopifyOrderReconciliationJobDto> {
    const previous = await client.shopifyOrderReconciliationJob.findFirst({
      orderBy: { finishedAt: 'desc' },
      select: { highWatermark: true },
      where: { appId: input.appId, shopId: input.shopId, status: 'SUCCEEDED' }
    });
    const overlapWindowSeconds = clampInteger(input.input.overlapWindowSeconds, 60, 86_400, 600);
    const startedFrom = input.input.mode === 'FULL'
      ? null
      : subtractSeconds(previous?.highWatermark ?? null, overlapWindowSeconds);

    const job = await client.shopifyOrderReconciliationJob.create({
      data: {
        appId: input.appId,
        correlationId: input.input.correlationId ?? randomUUID(),
        mode: input.input.mode ?? 'INCREMENTAL',
        overlapWindowSeconds,
        pageSize: clampInteger(input.input.pageSize, 1, 100, 50),
        requestedBy: input.input.requestedBy ?? null,
        shopDomain: input.shopDomain,
        shopId: input.shopId,
        startedFrom
      }
    });
    return toDto(job);
  }

  async findById(input: {
    appId?: string | undefined;
    jobId: string;
    shopDomain: string;
  }): Promise<ShopifyOrderReconciliationJobDto | null> {
    const appId = normalizeShopifyAppId(input.appId);
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const job = await this.prisma.shopifyOrderReconciliationJob.findFirst({
      where: { appId, id: input.jobId, shopDomain }
    });
    return job === null ? null : toDto(job);
  }

  async claimNext(input: {
    leaseMs: number;
    now?: Date | undefined;
    workerId: string;
  }): Promise<ClaimedShopifyOrderReconciliationJob | null> {
    const now = input.now ?? new Date();
    const due = await this.prisma.shopifyOrderReconciliationJob.findFirst({
      orderBy: { nextRunAt: 'asc' },
      select: { id: true },
      where: {
        OR: [
          { status: { in: ['QUEUED', 'RETRY_WAIT', 'FAILED'] }, nextRunAt: { lte: now } },
          { status: 'RUNNING', leaseExpiresAt: { lt: now } }
        ]
      }
    });
    if (due === null) return null;

    const leaseToken = randomUUID();
    const claimed = await this.prisma.shopifyOrderReconciliationJob.updateMany({
      data: {
        attemptCount: { increment: 1 },
        lastErrorCode: null,
        lastErrorMessageRedacted: null,
        leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
        leaseToken,
        startedAt: now,
        status: 'RUNNING',
        workerId: input.workerId
      },
      where: {
        id: due.id,
        OR: [
          { status: { in: ['QUEUED', 'RETRY_WAIT', 'FAILED'] }, nextRunAt: { lte: now } },
          { status: 'RUNNING', leaseExpiresAt: { lt: now } }
        ]
      }
    });
    if (claimed.count !== 1) return null;

    const job = await this.prisma.shopifyOrderReconciliationJob.findUnique({ where: { id: due.id } });
    return job === null ? null : toClaimedDto(job);
  }

  async markPageCommitted(input: {
    counts: { created: number; scanned: number; staleSkipped: number; unchanged: number; updated: number };
    highWatermark: Date | null;
    jobId: string;
    leaseExpiresAt: Date;
    leaseToken: string;
    pageCursor: string | null;
  }): Promise<ShopifyOrderReconciliationJobDto | null> {
    const updated = await this.prisma.shopifyOrderReconciliationJob.updateMany({
      data: {
        createdCount: { increment: input.counts.created },
        ...(input.highWatermark === null ? {} : { highWatermark: input.highWatermark }),
        leaseExpiresAt: input.leaseExpiresAt,
        pageCursor: input.pageCursor,
        scannedCount: { increment: input.counts.scanned },
        staleSkippedCount: { increment: input.counts.staleSkipped },
        unchangedCount: { increment: input.counts.unchanged },
        updatedCount: { increment: input.counts.updated }
      },
      where: { id: input.jobId, leaseToken: input.leaseToken, status: 'RUNNING' }
    });
    if (updated.count !== 1) return null;
    const job = await this.prisma.shopifyOrderReconciliationJob.findUnique({ where: { id: input.jobId } });
    if (job === null) return null;
    return toDto(job);
  }

  async markSucceeded(input: { finalCanonicalCount: number; highWatermark: Date | null; jobId: string; leaseToken: string }): Promise<ShopifyOrderReconciliationJobDto | null> {
    const updated = await this.prisma.shopifyOrderReconciliationJob.updateMany({
      data: {
        finalCanonicalCount: input.finalCanonicalCount,
        finishedAt: new Date(),
        ...(input.highWatermark === null ? {} : { highWatermark: input.highWatermark }),
        leaseExpiresAt: null,
        leaseToken: null,
        pageCursor: null,
        status: 'SUCCEEDED',
        workerId: null
      },
      where: { id: input.jobId, leaseToken: input.leaseToken, status: 'RUNNING' }
    });
    if (updated.count !== 1) return null;
    const job = await this.prisma.shopifyOrderReconciliationJob.findUnique({ where: { id: input.jobId } });
    if (job === null) return null;
    return toDto(job);
  }

  async markFailed(input: { error: unknown; jobId: string; leaseToken: string; maxAttemptsReached?: boolean | undefined; nextRunAt?: Date | undefined }): Promise<ShopifyOrderReconciliationJobDto | null> {
    const terminal = input.maxAttemptsReached === true;
    const updated = await this.prisma.shopifyOrderReconciliationJob.updateMany({
      data: {
        deadLetteredAt: terminal ? new Date() : null,
        failedCount: { increment: 1 },
        finishedAt: terminal ? new Date() : null,
        lastErrorCode: safeErrorCode(input.error instanceof Error ? input.error.name : 'RECONCILIATION_ERROR'),
        lastErrorMessageRedacted: redactTelemetryMessage(input.error),
        leaseExpiresAt: null,
        leaseToken: null,
        nextRunAt: input.nextRunAt ?? new Date(Date.now() + 60_000),
        status: terminal ? 'DEAD_LETTER' : 'RETRY_WAIT',
        workerId: null
      },
      where: { id: input.jobId, leaseToken: input.leaseToken, status: 'RUNNING' }
    });
    if (updated.count !== 1) return null;
    const job = await this.prisma.shopifyOrderReconciliationJob.findUnique({ where: { id: input.jobId } });
    if (job === null) return null;
    return toDto(job);
  }
}

function toDto(job: NonNullable<JobRecord>): ShopifyOrderReconciliationJobDto {
  return {
    appId: job.appId,
    attemptCount: job.attemptCount,
    correlationId: job.correlationId,
    counts: {
      created: job.createdCount,
      failed: job.failedCount,
      finalCanonical: job.finalCanonicalCount,
      scanned: job.scannedCount,
      staleSkipped: job.staleSkippedCount,
      unchanged: job.unchangedCount,
      updated: job.updatedCount
    },
    createdAt: job.createdAt.toISOString(),
    deadLetteredAt: job.deadLetteredAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    highWatermark: job.highWatermark?.toISOString() ?? null,
    id: job.id,
    lastError: job.lastErrorCode === null || job.lastErrorMessageRedacted === null
      ? null
      : { code: job.lastErrorCode, message: job.lastErrorMessageRedacted },
    mode: job.mode,
    nextRunAt: job.nextRunAt.toISOString(),
    overlapWindowSeconds: job.overlapWindowSeconds,
    pageSize: job.pageSize,
    pageCursor: job.pageCursor,
    requestedBy: job.requestedBy,
    shopDomain: job.shopDomain,
    startedAt: job.startedAt?.toISOString() ?? null,
    startedFrom: job.startedFrom?.toISOString() ?? null,
    status: job.status,
    updatedAt: job.updatedAt.toISOString(),
    warningCount: job.warningCount
  };
}

function toClaimedDto(job: NonNullable<JobRecord>): ClaimedShopifyOrderReconciliationJob | null {
  if (job.leaseToken === null) return null;
  return { ...toDto(job), leaseToken: job.leaseToken };
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '').replace(/\/$/u, '');
  if (!withoutProtocol.endsWith('.myshopify.com')) throw new Error('Shop domain must end with .myshopify.com');
  return withoutProtocol;
}

function subtractSeconds(value: Date | null, seconds: number): Date | null {
  return value === null ? null : new Date(value.getTime() - seconds * 1000);
}
