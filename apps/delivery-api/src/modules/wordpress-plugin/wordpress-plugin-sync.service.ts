import type { CanonicalOrderRow } from '../shopify/order-sync.mapper.js';
import type { WooCommerceOrder } from '../woocommerce/woocommerce-order.types.js';
import type { WooCommerceSyncOrdersResult } from '../woocommerce/woocommerce-order-sync.service.js';
import type { DecryptedWooCommerceConnection } from '../commerce/commerce-connection.service.js';
import type {
  WordPressPluginConnectionContext,
  WordPressPluginRawSyncChunkInput,
  WordPressPluginRawSyncChunkResult,
  WordPressPluginRawSyncFinalizeInput,
  WordPressPluginRawSyncFinalizeResult,
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

const DEFAULT_WOO_MODIFIED_AFTER_OVERLAP_MS = 10 * 60 * 1000;

export type WordPressPluginSyncRunRepository = {
  createSyncRunUnlessActive(input: {
    acceptedAt: Date;
    context: WordPressPluginConnectionContext;
    request: WordPressPluginSyncRunRequest;
    source?: string;
    trigger?: string;
  }): Promise<{ alreadyRunning: boolean; run: WordPressPluginSyncRun; startBackgroundProcessing: boolean }>;
  createRawSyncRunUnlessActive(input: {
    acceptedAt: Date;
    context: WordPressPluginConnectionContext;
    request: WordPressPluginSyncRequestInput;
  }): Promise<{ alreadyRunning: boolean; run: WordPressPluginSyncRun; startBackgroundProcessing: boolean }>;
  acceptRawChunk(input: {
    context: WordPressPluginConnectionContext;
    now: Date;
    payload: WordPressPluginRawSyncChunkInput;
  }): Promise<WordPressPluginRawSyncChunkResult>;
  finalizeRawSyncRun(input: {
    context: WordPressPluginConnectionContext;
    now: Date;
    payload: WordPressPluginRawSyncFinalizeInput;
  }): Promise<WordPressPluginRawSyncFinalizeResult>;
  listRawIngestsForProcessing(input: {
    context: WordPressPluginConnectionContext;
    limit: number;
    now: Date;
    syncRunId: string;
  }): Promise<Array<{ id: string; rawPayload: unknown; sourceOrderId: string; sourceOrderNumber: string | null }>>;
  markRawIngestProcessing(input: {
    context: WordPressPluginConnectionContext;
    ingestId: string;
    now: Date;
    syncRunId: string;
  }): Promise<boolean>;
  markRawIngestProcessed(input: {
    canonicalOrderId: string | null;
    context: WordPressPluginConnectionContext;
    geocode: WordPressPluginSyncGeocodeSummary;
    ingestId: string;
    now: Date;
    sync: WordPressPluginSyncCounts;
    syncRunId: string;
  }): Promise<void>;
  markRawIngestSkipped(input: {
    context: WordPressPluginConnectionContext;
    failureCode: string;
    failureMessage: string;
    ingestId: string;
    now: Date;
    syncRunId: string;
  }): Promise<void>;
  markRawIngestFailed(input: {
    context: WordPressPluginConnectionContext;
    failureCode: string;
    failureMessage: string;
    ingestId: string;
    now: Date;
    retryable: boolean;
    syncRunId: string;
  }): Promise<void>;
  refreshRawSyncRunStatus(input: {
    context: WordPressPluginConnectionContext;
    now: Date;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun | null>;
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
    source?: string;
    trigger?: string;
  }): Promise<WordPressPluginSyncRequestAccepted> {
    const accepted = await this.dependencies.syncRunRepository.createSyncRunUnlessActive({
      acceptedAt: this.now(),
      context: input.context,
      request: toSyncRunRequest(input.payload),
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.trigger === undefined ? {} : { trigger: input.trigger })
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

  async requestRawSync(input: {
    context: WordPressPluginConnectionContext;
    payload: WordPressPluginSyncRequestInput;
  }): Promise<WordPressPluginSyncRequestAccepted> {
    const accepted = await this.dependencies.syncRunRepository.createRawSyncRunUnlessActive({
      acceptedAt: this.now(),
      context: input.context,
      request: input.payload
    });
    return {
      alreadyRunning: accepted.alreadyRunning,
      message: accepted.alreadyRunning
        ? 'A sync is already queued or running in the background. Returning the active sync run.'
        : 'Raw sync accepted. WordPress will upload order chunks in the background.',
      startBackgroundProcessing: accepted.startBackgroundProcessing,
      syncRun: accepted.run
    };
  }

  async acceptRawChunk(input: {
    context: WordPressPluginConnectionContext;
    payload: WordPressPluginRawSyncChunkInput;
  }): Promise<WordPressPluginRawSyncChunkResult> {
    const result = await this.dependencies.syncRunRepository.acceptRawChunk({
      context: input.context,
      now: this.now(),
      payload: input.payload
    });
    return result;
  }

  async finalizeRawSync(input: {
    context: WordPressPluginConnectionContext;
    payload: WordPressPluginRawSyncFinalizeInput;
  }): Promise<WordPressPluginRawSyncFinalizeResult> {
    const result = await this.dependencies.syncRunRepository.finalizeRawSyncRun({
      context: input.context,
      now: this.now(),
      payload: input.payload
    });
    return result;
  }

  async processRawSyncRun(input: {
    context: WordPressPluginConnectionContext;
    syncRunId: string;
  }): Promise<WordPressPluginSyncRun | null> {
    const connection = await this.dependencies.connectionService.readDecryptedWooCommerceConnection({
      connectionId: input.context.connectionId
    });
    if (connection === null) {
      await this.dependencies.syncRunRepository.markSyncRunFailed({
        completedAt: this.now(),
        context: input.context,
        errorMessage: 'WooCommerce connection was not available for sync.',
        syncRunId: input.syncRunId
      });
      return this.dependencies.syncRunRepository.findSyncRunById({ context: input.context, syncRunId: input.syncRunId });
    }

    const orderSyncService = this.dependencies.createOrderSyncService({ connection });
    for (let pass = 0; pass < 4; pass += 1) {
      const rows = await this.dependencies.syncRunRepository.listRawIngestsForProcessing({
        context: input.context,
        limit: 100,
        now: this.now(),
        syncRunId: input.syncRunId
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        const processing = await this.dependencies.syncRunRepository.markRawIngestProcessing({
          context: input.context,
          ingestId: row.id,
          now: this.now(),
          syncRunId: input.syncRunId
        });
        if (!processing) continue;
        try {
          const synced = await orderSyncService.syncOrders({
            orders: [row.rawPayload as WooCommerceOrder],
            reason: 'raw_push'
          });
          const canonicalOrderId = synced.orders[0]?.orderId ?? null;
          if (isStaleRawSyncResult(synced.sync)) {
            await this.dependencies.syncRunRepository.markRawIngestSkipped({
              context: input.context,
              failureCode: 'RAW_ORDER_STALE_SOURCE_SNAPSHOT',
              failureMessage: 'Order was skipped because CLEVER already has a newer WooCommerce snapshot.',
              ingestId: row.id,
              now: this.now(),
              syncRunId: input.syncRunId
            });
            continue;
          }
          const status = synced.sync.created > 0 || synced.sync.updated > 0 || synced.sync.unchanged > 0 ? 'processed' : 'skipped';
          if (status === 'processed') {
            await this.dependencies.syncRunRepository.markRawIngestProcessed({
              canonicalOrderId,
              context: input.context,
              geocode: summarizeGeocode(synced.orders),
              ingestId: row.id,
              now: this.now(),
              sync: synced.sync,
              syncRunId: input.syncRunId
            });
          } else {
            await this.dependencies.syncRunRepository.markRawIngestSkipped({
              context: input.context,
              failureCode: 'RAW_ORDER_SKIPPED',
              failureMessage: 'Order was skipped by canonical freshness rules.',
              ingestId: row.id,
              now: this.now(),
              syncRunId: input.syncRunId
            });
          }
        } catch (error) {
          await this.dependencies.syncRunRepository.markRawIngestFailed({
            context: input.context,
            failureCode: 'RAW_ORDER_PROCESSING_FAILED',
            failureMessage: sanitizeRawOrderErrorMessage(error),
            ingestId: row.id,
            now: this.now(),
            retryable: true,
            syncRunId: input.syncRunId
          });
        }
      }
    }

    return this.dependencies.syncRunRepository.refreshRawSyncRunStatus({
      context: input.context,
      now: this.now(),
      syncRunId: input.syncRunId
    });
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

  async syncSingleOrder(input: {
    context: WordPressPluginConnectionContext;
    sourceOrderId: number | string;
  }): Promise<WooCommerceSyncOrdersResult> {
    const connection = await this.dependencies.connectionService.readDecryptedWooCommerceConnection({
      connectionId: input.context.connectionId
    });
    if (connection === null) {
      throw new Error('WooCommerce connection not found for WordPress plugin sync');
    }

    await this.dependencies.validateConnectionSiteUrl?.({ connection });

    const orderSyncService = this.dependencies.createOrderSyncService({ connection });
    return orderSyncService.syncSingleOrder({ sourceOrderId: input.sourceOrderId });
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
        overlapWindowMs: DEFAULT_WOO_MODIFIED_AFTER_OVERLAP_MS,
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

function isStaleRawSyncResult(sync: WordPressPluginSyncCounts): boolean {
  return sync.created === 0 && sync.updated === 0 && sync.unchanged > 0;
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

function sanitizeRawOrderErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|ETIMEDOUT/iu.test(raw)) {
    return 'Raw WooCommerce order processing timed out before completion.';
  }
  return 'Raw WooCommerce order could not be processed. Internal details were redacted; use the sync run id to inspect server logs.';
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
  syncOrders(input: {
    orders: WooCommerceOrder[];
    reason: 'manual_backfill' | 'manual_single_order_refresh' | 'raw_push' | 'scheduled_incremental' | 'webhook';
  }): Promise<{
    orders: CanonicalOrderRow[];
    sync: WordPressPluginSyncCounts;
  }>;
  syncSingleOrder(input: {
    sourceOrderId: number | string;
  }): Promise<WooCommerceSyncOrdersResult>;
  syncUpdatedOrders(input: {
    modifiedAfter?: Date | null;
    overlapWindowMs?: number;
    pageSize: number;
    status?: string | null;
  }): Promise<{
    orders: CanonicalOrderRow[];
    pagesRead: number;
    sync: WordPressPluginSyncCounts;
  }>;
};
