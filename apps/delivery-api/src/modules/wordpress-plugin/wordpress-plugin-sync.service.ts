import type { CanonicalOrderRow } from '../shopify/order-sync.mapper.js';
import type { DecryptedWooCommerceConnection } from '../commerce/commerce-connection.service.js';
import type {
  WordPressPluginConnectionContext,
  WordPressPluginSyncCounts,
  WordPressPluginSyncGeocodeSummary,
  WordPressPluginSyncRequestInput,
  WordPressPluginSyncRequestResult,
  WordPressPluginSyncRun,
  WordPressPluginSyncRunRequest,
  WordPressPluginSyncRunResult
} from './wordpress-plugin.types.js';

export type WordPressPluginSyncRequestAccepted = WordPressPluginSyncRequestResult & {
  startBackgroundProcessing: boolean;
};

export type WordPressPluginSyncRunRepository = {
  createSyncRunUnlessActive(input: {
    acceptedAt: Date;
    context: WordPressPluginConnectionContext;
    request: WordPressPluginSyncRunRequest;
  }): Promise<{ alreadyRunning: boolean; run: WordPressPluginSyncRun; startBackgroundProcessing: boolean }>;
  findLatestSyncRun(input: { context: WordPressPluginConnectionContext }): Promise<WordPressPluginSyncRun | null>;
  findSyncRunById(input: {
    context: WordPressPluginConnectionContext;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun | null>;
  markSyncRunFailed(input: {
    completedAt: Date;
    context: WordPressPluginConnectionContext;
    errorMessage: string;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun>;
  markSyncRunRunning(input: {
    context: WordPressPluginConnectionContext;
    startedAt: Date;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun | null>;
  markSyncRunSucceeded(input: {
    completedAt: Date;
    context: WordPressPluginConnectionContext;
    result: WordPressPluginSyncRunResult;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun>;
};

export type WordPressPluginSyncServiceDependencies = {
  connectionService: {
    readDecryptedWooCommerceConnection(input: { connectionId: string }): Promise<DecryptedWooCommerceConnection | null>;
  };
  createOrderSyncService(input: { connection: DecryptedWooCommerceConnection }): WordPressPluginOrderSyncService;
  freshnessRepository: {
    markRestSyncCompleted(input: { at: Date; connectionId: string }): Promise<void>;
  };
  now?: () => Date;
  syncRunRepository: WordPressPluginSyncRunRepository;
  validateConnectionSiteUrl?(input: { connection: DecryptedWooCommerceConnection }): Promise<void>;
};

export class WordPressPluginSyncRequestService {
  constructor(private readonly dependencies: WordPressPluginSyncServiceDependencies) {}

  async requestSync(input: {
    context: WordPressPluginConnectionContext;
    payload: WordPressPluginSyncRequestInput;
  }): Promise<WordPressPluginSyncRequestAccepted> {
    const accepted = await this.dependencies.syncRunRepository.createSyncRunUnlessActive({
      acceptedAt: this.now(),
      context: input.context,
      request: toSyncRunRequest(input.payload)
    });

    return {
      alreadyRunning: accepted.alreadyRunning,
      message: accepted.alreadyRunning
        ? 'A sync is already queued or running in the background. Returning the active sync run.'
        : 'Sync accepted. Processing is running in the background.',
      startBackgroundProcessing: accepted.startBackgroundProcessing,
      syncRun: accepted.run
    };
  }

  readSyncRun(input: {
    context: WordPressPluginConnectionContext;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun | null> {
    return this.dependencies.syncRunRepository.findSyncRunById(input);
  }

  readLatestSyncRun(input: {
    context: WordPressPluginConnectionContext;
  }): Promise<WordPressPluginSyncRun | null> {
    return this.dependencies.syncRunRepository.findLatestSyncRun(input);
  }

  async processSyncRun(input: {
    context: WordPressPluginConnectionContext;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun | null> {
    const running = await this.dependencies.syncRunRepository.markSyncRunRunning({
      context: input.context,
      startedAt: this.now(),
      syncRunId: input.syncRunId
    });
    if (running === null) return null;

    try {
      const connection = await this.dependencies.connectionService.readDecryptedWooCommerceConnection({
        connectionId: input.context.connectionId
      });
      if (connection === null) {
        throw new Error('WooCommerce connection not found for WordPress plugin sync');
      }

      await this.dependencies.validateConnectionSiteUrl?.({ connection });

      const orderSyncService = this.dependencies.createOrderSyncService({ connection });
      const result = await orderSyncService.syncUpdatedOrders({
        modifiedAfter: parseOptionalDate(running.request.modifiedAfter),
        pageSize: running.request.pageSize,
        status: running.request.status
      });
      const warnings = deriveWarnings(result.sync);
      const completedAt = this.now();

      await this.dependencies.freshnessRepository.markRestSyncCompleted({
        at: completedAt,
        connectionId: input.context.connectionId
      });

      return this.dependencies.syncRunRepository.markSyncRunSucceeded({
        completedAt,
        context: input.context,
        result: {
          geocode: summarizeGeocode(result.orders),
          pagesRead: result.pagesRead,
          sync: result.sync,
          warnings
        },
        syncRunId: input.syncRunId
      });
    } catch (error) {
      await this.dependencies.syncRunRepository.markSyncRunFailed({
        completedAt: this.now(),
        context: input.context,
        errorMessage: sanitizeErrorMessage(error),
        syncRunId: input.syncRunId
      });
      throw error;
    }
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }
}

function toSyncRunRequest(payload: WordPressPluginSyncRequestInput): WordPressPluginSyncRunRequest {
  return {
    modifiedAfter: payload.modifiedAfter?.toISOString() ?? null,
    pageSize: payload.pageSize,
    status: payload.status ?? null
  };
}

function parseOptionalDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function deriveWarnings(sync: WordPressPluginSyncCounts): string[] {
  const warnings: string[] = [];
  if (sync.needsReview > 0) {
    warnings.push(`${sync.needsReview} synced orders need delivery metadata review before routing.`);
  }
  return warnings;
}

function summarizeGeocode(orders: CanonicalOrderRow[]): WordPressPluginSyncGeocodeSummary {
  const summary: WordPressPluginSyncGeocodeSummary = {
    failed: 0,
    notRequired: 0,
    pending: 0,
    resolved: 0
  };
  for (const order of orders) {
    if (order.geocodeStatus === 'RESOLVED') summary.resolved += 1;
    else if (order.geocodeStatus === 'FAILED') summary.failed += 1;
    else if (order.geocodeStatus === 'NOT_REQUIRED') summary.notRequired += 1;
    else summary.pending += 1;
  }
  return summary;
}

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/private addresses/iu.test(raw) || /site URL/iu.test(raw)) {
    return 'WooCommerce site URL failed safety validation.';
  }
  if (/connection not found/iu.test(raw)) {
    return 'WooCommerce connection was not available for sync.';
  }
  if (/timeout|timed out|ETIMEDOUT/iu.test(raw)) {
    return 'WooCommerce sync timed out before completion.';
  }
  return 'WooCommerce sync failed. Internal details were redacted; use the sync run id to inspect server logs.';
}

export type WordPressPluginOrderSyncService = {
  syncUpdatedOrders(input: {
    modifiedAfter?: Date | null;
    pageSize: number;
    status?: string | null;
  }): Promise<{
    orders: CanonicalOrderRow[];
    pagesRead: number;
    sync: WordPressPluginSyncCounts;
  }>;
};
