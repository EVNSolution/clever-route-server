import type { ShopifyAdminGraphqlClient } from './admin-graphql.client.js';
import type {
  ClaimedShopifyOrderReconciliationJob,
  EnqueueShopifyOrderReconciliationInput,
  EnqueueShopifyOrderReconciliationResult,
  ShopifyOrderReconciliationJobDto
} from './order-reconciliation.types.js';
import { ShopifyOrderSyncService } from './order-sync.service.js';
import type { PrismaOrderSyncRepository } from './order-sync.repository.js';

type ReconciliationRepository = {
  claimNext(input: { leaseMs: number; now?: Date | undefined; workerId: string }): Promise<ClaimedShopifyOrderReconciliationJob | null>;
  enqueue(input: EnqueueShopifyOrderReconciliationInput): Promise<ShopifyOrderReconciliationJobDto>;
  enqueueDueInstalledShops(input: { limit: number; now?: Date | undefined; requestedBy: string; staleBefore: Date }): Promise<{ enqueued: number; failed: number; skipped: number }>;
  enqueueIfIdle(input: EnqueueShopifyOrderReconciliationInput): Promise<EnqueueShopifyOrderReconciliationResult>;
  findById(input: { appId?: string | undefined; jobId: string; shopDomain: string }): Promise<ShopifyOrderReconciliationJobDto | null>;
  markFailed(input: { error: unknown; jobId: string; leaseToken: string; maxAttemptsReached?: boolean | undefined; nextRunAt?: Date | undefined }): Promise<ShopifyOrderReconciliationJobDto | null>;
  markPageCommitted(input: {
    counts: { created: number; scanned: number; staleSkipped: number; unchanged: number; updated: number };
    highWatermark: Date | null;
    jobId: string;
    leaseExpiresAt: Date;
    leaseToken: string;
    pageCursor: string | null;
  }): Promise<ShopifyOrderReconciliationJobDto | null>;
  markSucceeded(input: { finalCanonicalCount: number; highWatermark: Date | null; jobId: string; leaseToken: string }): Promise<ShopifyOrderReconciliationJobDto | null>;
};

type ShopTokenReader = {
  getAdminAccessToken(input: { appId?: string | undefined; shopDomain: string }): Promise<string | null>;
};

type GraphqlClientFactory = (input: {
  accessToken: string;
  apiVersion: string;
  shopDomain: string;
}) => Pick<ShopifyAdminGraphqlClient, 'request'>;

export class ShopifyOrderReconciliationService {
  constructor(
    private readonly options: {
      defaultApiVersion: string;
      graphqlClientFactory: GraphqlClientFactory;
      maxPages?: number | undefined;
      repository: ReconciliationRepository;
      orderRepository: PrismaOrderSyncRepository;
      shopTokenService: ShopTokenReader;
    }
  ) {}

  enqueue(input: EnqueueShopifyOrderReconciliationInput): Promise<ShopifyOrderReconciliationJobDto> {
    return this.options.repository.enqueue(input);
  }

  enqueueIfIdle(input: EnqueueShopifyOrderReconciliationInput): Promise<EnqueueShopifyOrderReconciliationResult> {
    return this.options.repository.enqueueIfIdle(input);
  }

  enqueueDueInstalledShops(input: {
    limit: number;
    now?: Date | undefined;
    requestedBy: string;
    staleBefore: Date;
  }): Promise<{ enqueued: number; failed: number; skipped: number }> {
    return this.options.repository.enqueueDueInstalledShops(input);
  }

  status(input: {
    appId?: string | undefined;
    jobId: string;
    shopDomain: string;
  }): Promise<ShopifyOrderReconciliationJobDto | null> {
    return this.options.repository.findById(input);
  }

  async processNextDue(input: {
    leaseMs?: number | undefined;
    now?: Date | undefined;
    workerId: string;
  }): Promise<{ jobId: string | null; processed: boolean }> {
    const job = await this.options.repository.claimNext({
      leaseMs: input.leaseMs ?? 5 * 60 * 1000,
      now: input.now,
      workerId: input.workerId
    });
    if (job === null) return { jobId: null, processed: false };
    await this.processClaimed(job);
    return { jobId: job.id, processed: true };
  }

  async processClaimed(job: ClaimedShopifyOrderReconciliationJob): Promise<void> {
    const accessToken = await this.options.shopTokenService.getAdminAccessToken({
      appId: job.appId,
      shopDomain: job.shopDomain
    });
    if (accessToken === null) {
      await this.options.repository.markFailed({
        error: new Error('MISSING_OFFLINE_TOKEN'),
        jobId: job.id,
        leaseToken: job.leaseToken,
        maxAttemptsReached: true
      });
      return;
    }

    const syncService = new ShopifyOrderSyncService({
      graphqlClient: this.options.graphqlClientFactory({
        accessToken,
        apiVersion: this.options.defaultApiVersion,
        shopDomain: job.shopDomain
      }),
      repository: this.options.orderRepository
    });

    let cursor = job.pageCursor;
    let highWatermark = parseDateOrNull(job.highWatermark) ?? parseDateOrNull(job.startedFrom);
    const updatedSince = job.mode === 'FULL'
      ? new Date(0)
      : (parseDateOrNull(job.startedFrom) ?? new Date(0));

    try {
      const maxPages = this.options.maxPages ?? 1000;
      for (let page = 0; page < maxPages; page += 1) {
        const result = await syncService.syncUpdatedOrdersPage({
          after: cursor,
          appId: job.appId,
          first: job.pageSize,
          shopDomain: job.shopDomain,
          updatedSince
        });
        if (page === maxPages - 1 && result.hasNextPage) {
          await this.options.repository.markFailed({
            error: new Error('RECONCILIATION_PAGE_CAP_EXCEEDED'),
            jobId: job.id,
            leaseToken: job.leaseToken,
            maxAttemptsReached: job.attemptCount + 1 >= 5,
            nextRunAt: nextRetryAt(job.attemptCount + 1)
          });
          return;
        }
        const nextHighWatermark = maxDate(highWatermark, result.highWatermark);
        const committed = await this.options.repository.markPageCommitted({
          counts: {
            created: result.sync.created,
            scanned: result.ordersSynced,
            staleSkipped: result.sync.unchanged,
            unchanged: result.sync.unchanged,
            updated: result.sync.updated
          },
          highWatermark: nextHighWatermark,
          jobId: job.id,
          leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
          leaseToken: job.leaseToken,
          pageCursor: result.endCursor
        });
        if (committed === null) return;
        highWatermark = nextHighWatermark;
        cursor = result.endCursor;
        if (!result.hasNextPage) break;
      }

      const canonical = await this.options.orderRepository.listCanonicalOrders({
        appId: job.appId,
        filters: {},
        shopDomain: job.shopDomain
      });
      await this.options.repository.markSucceeded({
        finalCanonicalCount: canonical.length,
        highWatermark,
        jobId: job.id,
        leaseToken: job.leaseToken
      });
    } catch (error) {
      await this.options.repository.markFailed({
        error,
        jobId: job.id,
        leaseToken: job.leaseToken,
        maxAttemptsReached: job.attemptCount + 1 >= 5,
        nextRunAt: nextRetryAt(job.attemptCount + 1)
      });
    }
  }
}

function parseDateOrNull(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function nextRetryAt(attemptCount: number, now = new Date()): Date {
  const seconds = Math.min(30 * 60, 2 ** Math.max(0, attemptCount - 1) * 60);
  return new Date(now.getTime() + seconds * 1000);
}
