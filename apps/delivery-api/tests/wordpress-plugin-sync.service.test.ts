import { describe, expect, test, vi } from 'vitest';

import type { DecryptedWooCommerceConnection } from '../src/modules/commerce/commerce-connection.service.js';
import type { WordPressPluginOrderSyncService, WordPressPluginSyncRunRepository } from '../src/modules/wordpress-plugin/wordpress-plugin-sync.service.js';
import { WordPressPluginSyncRequestService } from '../src/modules/wordpress-plugin/wordpress-plugin-sync.service.js';
import type { WordPressPluginSyncRun } from '../src/modules/wordpress-plugin/wordpress-plugin.types.js';
import type { CanonicalOrderRow } from '../src/modules/shopify/order-sync.mapper.js';

const acceptedAt = new Date('2026-05-25T03:00:00.000Z');
const startedAt = new Date('2026-05-25T03:00:01.000Z');
const completedAt = new Date('2026-05-25T03:00:05.000Z');

describe('WordPressPluginSyncRequestService', () => {
  test('creates a durable queued sync run without doing Woo REST work inside the request path', async () => {
    const syncRunRepository = syncRunRepositoryMock();
    syncRunRepository.createSyncRunUnlessActive.mockResolvedValueOnce({
      alreadyRunning: false,
      run: syncRun({ acceptedAt: acceptedAt.toISOString(), status: 'QUEUED' }),
      startBackgroundProcessing: true
    });
    const syncOrders = vi.fn();
    const syncUpdatedOrders = vi.fn();
    const syncSingleOrder = vi.fn();
    const readDecryptedWooCommerceConnection = vi.fn(() => Promise.resolve(wooConnection()));
    const createOrderSyncService = vi.fn(() => ({ syncOrders, syncSingleOrder, syncUpdatedOrders }));
    const markRestSyncCompleted = vi.fn(() => Promise.resolve());
    const validateConnectionSiteUrl = vi.fn(() => Promise.resolve());
    const service = new WordPressPluginSyncRequestService({
      connectionService: { readDecryptedWooCommerceConnection },
      createOrderSyncService,
      freshnessRepository: { markRestSyncCompleted },
      now: () => acceptedAt,
      syncRunRepository,
      validateConnectionSiteUrl
    });

    await expect(
      service.requestSync({
        context: pluginContext(),
        payload: { modifiedAfter: new Date('2026-05-21T00:00:00.000Z'), pageSize: 25, status: 'processing' }
      })
    ).resolves.toEqual({
      alreadyRunning: false,
      message: 'Sync accepted. Processing is running in the background.',
      startBackgroundProcessing: true,
      syncRun: syncRun({ acceptedAt: acceptedAt.toISOString(), status: 'QUEUED' })
    });
    expect(syncRunRepository.createSyncRunUnlessActive).toHaveBeenCalledWith({
      acceptedAt,
      context: pluginContext(),
      request: { modifiedAfter: '2026-05-21T00:00:00.000Z', pageSize: 25, status: 'processing' }
    });
    expect(readDecryptedWooCommerceConnection).not.toHaveBeenCalled();
    expect(validateConnectionSiteUrl).not.toHaveBeenCalled();
    expect(createOrderSyncService).not.toHaveBeenCalled();
    expect(syncOrders).not.toHaveBeenCalled();
    expect(syncSingleOrder).not.toHaveBeenCalled();
    expect(syncUpdatedOrders).not.toHaveBeenCalled();
    expect(markRestSyncCompleted).not.toHaveBeenCalled();
  });

  test('creates a raw sync run without reading Woo REST or processing orders in the request path', async () => {
    const syncRunRepository = syncRunRepositoryMock();
    syncRunRepository.createRawSyncRunUnlessActive.mockResolvedValueOnce({
      alreadyRunning: false,
      run: syncRun({ acceptedAt: acceptedAt.toISOString(), request: { mode: 'raw_push', modifiedAfter: null, pageSize: 100, status: null }, status: 'QUEUED' }),
      startBackgroundProcessing: false
    });
    const service = createService({ syncRunRepository });

    await expect(
      service.requestRawSync({
        context: pluginContext(),
        payload: { modifiedAfter: null, pageSize: 100, status: null }
      })
    ).resolves.toEqual({
      alreadyRunning: false,
      message: 'Raw sync accepted. WordPress will upload order chunks in the background.',
      startBackgroundProcessing: false,
      syncRun: syncRun({ acceptedAt: acceptedAt.toISOString(), request: { mode: 'raw_push', modifiedAfter: null, pageSize: 100, status: null }, status: 'QUEUED' })
    });
    expect(syncRunRepository.createRawSyncRunUnlessActive).toHaveBeenCalledWith({
      acceptedAt,
      context: pluginContext(),
      request: { modifiedAfter: null, pageSize: 100, status: null }
    });
  });

  test('accepts raw chunks by delegating durable persistence and not running canonical sync inline', async () => {
    const syncRunRepository = syncRunRepositoryMock();
    syncRunRepository.acceptRawChunk.mockResolvedValueOnce({
      accepted: 1,
      duplicate: 0,
      invalid: 0,
      message: 'Raw sync chunk accepted. CLEVER will process stored orders in the background.',
      startBackgroundProcessing: true,
      syncRun: syncRun({ request: { mode: 'raw_push', modifiedAfter: null, pageSize: 100, status: null }, status: 'RUNNING' })
    });
    const syncOrders = vi.fn();
    const service = createService({ syncOrders, syncRunRepository });

    await expect(
      service.acceptRawChunk({
        context: pluginContext(),
        payload: {
          chunkId: 'chunk-1',
          chunkIndex: 0,
          orders: [{ id: 123, number: '123' }],
          syncRunId: '11111111-1111-4111-8111-111111111111'
        }
      })
    ).resolves.toMatchObject({ accepted: 1, duplicate: 0, invalid: 0, startBackgroundProcessing: true });
    expect(syncRunRepository.acceptRawChunk).toHaveBeenCalledWith({
      context: pluginContext(),
      now: acceptedAt,
      payload: {
        chunkId: 'chunk-1',
        chunkIndex: 0,
        orders: [{ id: 123, number: '123' }],
        syncRunId: '11111111-1111-4111-8111-111111111111'
      }
    });
    expect(syncOrders).not.toHaveBeenCalled();
  });

  test('processes durable raw rows through Woo canonical sync and records terminal row status', async () => {
    const syncRunRepository = syncRunRepositoryMock();
    syncRunRepository.listRawIngestsForProcessing.mockResolvedValueOnce([
      { id: 'raw-ingest-id', rawPayload: { id: 123, number: '123' }, sourceOrderId: '123', sourceOrderNumber: '123' }
    ]);
    syncRunRepository.markRawIngestProcessing.mockResolvedValueOnce(true);
    syncRunRepository.refreshRawSyncRunStatus.mockResolvedValueOnce(
      syncRun({ request: { mode: 'raw_push', modifiedAfter: null, pageSize: 100, status: null }, status: 'RUNNING' })
    );
    const syncOrders = vi.fn<WordPressPluginOrderSyncService['syncOrders']>(() =>
      Promise.resolve({
        orders: [{ orderId: 'canonical-order-id' } as CanonicalOrderRow],
        sync: { created: 1, needsReview: 0, readyToPlan: 1, received: 1, skipped: 0, unchanged: 0, updated: 0 }
      })
    );
    const service = createService({ syncOrders, syncRunRepository });

    await expect(
      service.processRawSyncRun({ context: pluginContext(), syncRunId: '11111111-1111-4111-8111-111111111111' })
    ).resolves.toEqual(syncRun({ request: { mode: 'raw_push', modifiedAfter: null, pageSize: 100, status: null }, status: 'RUNNING' }));
    expect(syncOrders).toHaveBeenCalledWith({ orders: [{ id: 123, number: '123' }], reason: 'raw_push' });
    expect(syncRunRepository.markRawIngestProcessed).toHaveBeenCalledWith({
      canonicalOrderId: 'canonical-order-id',
      context: pluginContext(),
      geocode: { failed: 0, notRequired: 0, pending: 1, resolved: 0 },
      ingestId: 'raw-ingest-id',
      now: acceptedAt,
      sync: { created: 1, needsReview: 0, readyToPlan: 1, received: 1, skipped: 0, unchanged: 0, updated: 0 },
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });
  });

  test('marks older raw snapshots as skipped instead of processed when canonical freshness rejects them', async () => {
    const syncRunRepository = syncRunRepositoryMock();
    syncRunRepository.listRawIngestsForProcessing.mockResolvedValueOnce([
      { id: 'raw-ingest-id', rawPayload: { id: 123, number: '123' }, sourceOrderId: '123', sourceOrderNumber: '123' }
    ]);
    syncRunRepository.markRawIngestProcessing.mockResolvedValueOnce(true);
    syncRunRepository.refreshRawSyncRunStatus.mockResolvedValueOnce(syncRun({ status: 'RUNNING' }));
    const syncOrders = vi.fn<WordPressPluginOrderSyncService['syncOrders']>(() =>
      Promise.resolve({
        orders: [{ orderId: 'canonical-order-id' } as CanonicalOrderRow],
        sync: { created: 0, needsReview: 0, readyToPlan: 0, received: 1, skipped: 0, unchanged: 1, updated: 0 }
      })
    );
    const service = createService({ syncOrders, syncRunRepository });

    await service.processRawSyncRun({ context: pluginContext(), syncRunId: '11111111-1111-4111-8111-111111111111' });

    expect(syncRunRepository.markRawIngestProcessed).not.toHaveBeenCalled();
    expect(syncRunRepository.markRawIngestSkipped).toHaveBeenCalledWith({
      context: pluginContext(),
      failureCode: 'RAW_ORDER_STALE_SOURCE_SNAPSHOT',
      failureMessage: 'Order was skipped because CLEVER already has a newer WooCommerce snapshot.',
      ingestId: 'raw-ingest-id',
      now: acceptedAt,
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });
  });

  test('redacts raw row processing failures before persisting failure summaries', async () => {
    const syncRunRepository = syncRunRepositoryMock();
    syncRunRepository.listRawIngestsForProcessing.mockResolvedValueOnce([
      { id: 'raw-ingest-id', rawPayload: { id: 123, billing: { email: 'jane@example.test' } }, sourceOrderId: '123', sourceOrderNumber: '123' }
    ]);
    syncRunRepository.markRawIngestProcessing.mockResolvedValueOnce(true);
    syncRunRepository.refreshRawSyncRunStatus.mockResolvedValueOnce(syncRun({ status: 'RUNNING' }));
    const syncOrders = vi.fn<WordPressPluginOrderSyncService['syncOrders']>(() =>
      Promise.reject(new Error('Woo rejected jane@example.test at 100 King St with ck_secret'))
    );
    const service = createService({ syncOrders, syncRunRepository });

    await service.processRawSyncRun({ context: pluginContext(), syncRunId: '11111111-1111-4111-8111-111111111111' });
    expect(syncRunRepository.markRawIngestFailed).toHaveBeenCalledWith({
      context: pluginContext(),
      failureCode: 'RAW_ORDER_PROCESSING_FAILED',
      failureMessage: 'Raw WooCommerce order could not be processed. Internal details were redacted; use the sync run id to inspect server logs.',
      ingestId: 'raw-ingest-id',
      now: acceptedAt,
      retryable: true,
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });
  });

  test('returns the active durable sync run instead of starting a duplicate request', async () => {
    const syncRunRepository = syncRunRepositoryMock();
    syncRunRepository.createSyncRunUnlessActive.mockResolvedValueOnce({
      alreadyRunning: true,
      run: syncRun({ startedAt: startedAt.toISOString(), status: 'RUNNING' }),
      startBackgroundProcessing: false
    });
    const syncUpdatedOrders = vi.fn();
    const service = createService({ syncRunRepository, syncUpdatedOrders });

    await expect(
      service.requestSync({
        context: pluginContext(),
        payload: { modifiedAfter: null, pageSize: 100, status: null }
      })
    ).resolves.toEqual({
      alreadyRunning: true,
      message: 'A sync is already queued or running in the background. Returning the active sync run.',
      startBackgroundProcessing: false,
      syncRun: syncRun({ startedAt: startedAt.toISOString(), status: 'RUNNING' })
    });
    expect(syncUpdatedOrders).not.toHaveBeenCalled();
  });

  test('processes a queued run, validates Woo site URL, persists final counts, and marks REST freshness after work completes', async () => {
    const connection = wooConnection();
    const validateConnectionSiteUrl = vi.fn(() => Promise.resolve());
    const syncRunRepository = syncRunRepositoryMock();
    syncRunRepository.markSyncRunRunning.mockResolvedValueOnce(
      syncRun({
        acceptedAt: acceptedAt.toISOString(),
        request: { modifiedAfter: '2026-05-21T00:00:00.000Z', pageSize: 25, status: 'processing' },
        startedAt: startedAt.toISOString(),
        status: 'RUNNING'
      })
    );
    syncRunRepository.markSyncRunSucceeded.mockImplementation((input) =>
      Promise.resolve(syncRun({
        acceptedAt: acceptedAt.toISOString(),
        completedAt: input.completedAt.toISOString(),
        request: { modifiedAfter: '2026-05-21T00:00:00.000Z', pageSize: 25, status: 'processing' },
        result: input.result,
        startedAt: startedAt.toISOString(),
        status: 'SUCCEEDED'
      }))
    );
    const syncUpdatedOrders = vi.fn(() =>
      Promise.resolve({
        orders: [orderRow('RESOLVED'), orderRow('PENDING'), orderRow('FAILED'), orderRow('NOT_REQUIRED')],
        pagesRead: 2,
        sync: { created: 1, needsReview: 1, readyToPlan: 3, received: 4, skipped: 0, unchanged: 1, updated: 2 }
      })
    );
    const markRestSyncCompleted = vi.fn(() => Promise.resolve());
    const service = createService({
      connection,
      markRestSyncCompleted,
      now: sequenceClock([startedAt, completedAt]),
      syncRunRepository,
      syncUpdatedOrders,
      validateConnectionSiteUrl
    });

    await expect(
      service.processSyncRun({ context: pluginContext(), syncRunId: '11111111-1111-4111-8111-111111111111' })
    ).resolves.toEqual(
      syncRun({
        acceptedAt: acceptedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        request: { modifiedAfter: '2026-05-21T00:00:00.000Z', pageSize: 25, status: 'processing' },
        result: {
          geocode: { failed: 1, notRequired: 1, pending: 1, resolved: 1 },
          pagesRead: 2,
          sync: { created: 1, needsReview: 1, readyToPlan: 3, received: 4, skipped: 0, unchanged: 1, updated: 2 },
          warnings: ['1 synced orders need delivery metadata review before routing.']
        },
        startedAt: startedAt.toISOString(),
        status: 'SUCCEEDED'
      })
    );
    expect(validateConnectionSiteUrl).toHaveBeenCalledWith({ connection });
    expect(syncUpdatedOrders).toHaveBeenCalledWith({
      modifiedAfter: new Date('2026-05-21T00:00:00.000Z'),
      overlapWindowMs: 10 * 60 * 1000,
      pageSize: 25,
      status: 'processing'
    });
    expect(markRestSyncCompleted).toHaveBeenCalledWith({ at: completedAt, connectionId: 'connection-id' });
    expect(syncRunRepository.markSyncRunSucceeded).toHaveBeenCalledWith({
      completedAt,
      context: pluginContext(),
      result: {
        geocode: { failed: 1, notRequired: 1, pending: 1, resolved: 1 },
        pagesRead: 2,
        sync: { created: 1, needsReview: 1, readyToPlan: 3, received: 4, skipped: 0, unchanged: 1, updated: 2 },
        warnings: ['1 synced orders need delivery metadata review before routing.']
      },
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });
  });

  test('marks a durable sync run as failed when Woo site URL validation blocks processing', async () => {
    const syncRunRepository = syncRunRepositoryMock();
    syncRunRepository.markSyncRunRunning.mockResolvedValueOnce(
      syncRun({ startedAt: startedAt.toISOString(), status: 'RUNNING' })
    );
    syncRunRepository.markSyncRunFailed.mockImplementation((input) =>
      Promise.resolve(syncRun({
        completedAt: input.completedAt.toISOString(),
        errorMessage: input.errorMessage,
        startedAt: startedAt.toISOString(),
        status: 'FAILED'
      }))
    );
    const syncUpdatedOrders = vi.fn();
    const service = createService({
      now: sequenceClock([startedAt, completedAt]),
      syncRunRepository,
      syncUpdatedOrders,
      validateConnectionSiteUrl: vi.fn(() =>
        Promise.reject(new Error('WooCommerce site URL must not resolve to private addresses'))
      )
    });

    await expect(
      service.processSyncRun({ context: pluginContext(), syncRunId: '11111111-1111-4111-8111-111111111111' })
    ).rejects.toThrow('WooCommerce site URL must not resolve to private addresses');
    expect(syncUpdatedOrders).not.toHaveBeenCalled();
    expect(syncRunRepository.markSyncRunFailed).toHaveBeenCalledWith({
      completedAt,
      context: pluginContext(),
      errorMessage: 'WooCommerce site URL failed safety validation.',
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });
  });

  test('persists only a generic failure message when sync errors contain customer or credential-like details', async () => {
    const syncRunRepository = syncRunRepositoryMock();
    syncRunRepository.markSyncRunRunning.mockResolvedValueOnce(
      syncRun({ startedAt: startedAt.toISOString(), status: 'RUNNING' })
    );
    syncRunRepository.markSyncRunFailed.mockImplementation((input) =>
      Promise.resolve(
        syncRun({
          completedAt: input.completedAt.toISOString(),
          errorMessage: input.errorMessage,
          startedAt: startedAt.toISOString(),
          status: 'FAILED'
        })
      )
    );
    const syncUpdatedOrders = vi.fn(() =>
      Promise.reject(new Error('Woo rejected jane@example.test at 123 Test St with ck_shortsecret'))
    );
    const service = createService({
      now: sequenceClock([startedAt, completedAt]),
      syncRunRepository,
      syncUpdatedOrders
    });

    await expect(
      service.processSyncRun({ context: pluginContext(), syncRunId: '11111111-1111-4111-8111-111111111111' })
    ).rejects.toThrow('Woo rejected');
    expect(syncRunRepository.markSyncRunFailed).toHaveBeenCalledWith({
      completedAt,
      context: pluginContext(),
      errorMessage: 'WooCommerce sync failed. Internal details were redacted; use the sync run id to inspect server logs.',
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });
  });

  test('validates the Woo site and refreshes one source order on demand', async () => {
    const syncRunRepository = syncRunRepositoryMock();
    const syncSingleOrder = vi.fn<WordPressPluginOrderSyncService['syncSingleOrder']>(() =>
      Promise.resolve({
        orders: [],
        sync: { created: 0, needsReview: 0, readyToPlan: 0, received: 1, skipped: 0, unchanged: 1, updated: 0 }
      })
    );
    const validateConnectionSiteUrl = vi.fn(() => Promise.resolve());
    const service = createService({
      syncRunRepository,
      syncSingleOrder,
      validateConnectionSiteUrl
    });

    await expect(
      service.syncSingleOrder({
        context: pluginContext(),
        sourceOrderId: '11432'
      })
    ).resolves.toEqual({
      orders: [],
      sync: { created: 0, needsReview: 0, readyToPlan: 0, received: 1, skipped: 0, unchanged: 1, updated: 0 }
    });
    expect(validateConnectionSiteUrl).toHaveBeenCalledWith({ connection: wooConnection() });
    expect(syncSingleOrder).toHaveBeenCalledWith({ sourceOrderId: '11432' });
  });

});

function createService(input: {
  connection?: DecryptedWooCommerceConnection;
  markRestSyncCompleted?: ReturnType<typeof vi.fn<(input: { at: Date; connectionId: string }) => Promise<void>>>;
  now?: () => Date;
  syncRunRepository: ReturnType<typeof syncRunRepositoryMock>;
  syncOrders?: ReturnType<typeof vi.fn<WordPressPluginOrderSyncService['syncOrders']>>;
  syncSingleOrder?: ReturnType<typeof vi.fn<WordPressPluginOrderSyncService['syncSingleOrder']>>;
  syncUpdatedOrders?: ReturnType<typeof vi.fn<WordPressPluginOrderSyncService['syncUpdatedOrders']>>;
  validateConnectionSiteUrl?: (input: { connection: DecryptedWooCommerceConnection }) => Promise<void>;
}): WordPressPluginSyncRequestService {
  const syncUpdatedOrders = input.syncUpdatedOrders ??
    vi.fn<WordPressPluginOrderSyncService['syncUpdatedOrders']>(() =>
      Promise.resolve({
        orders: [],
        pagesRead: 0,
        sync: { created: 0, needsReview: 0, readyToPlan: 0, received: 0, skipped: 0, unchanged: 0, updated: 0 }
      })
    );
  const syncOrders = input.syncOrders ??
    vi.fn<WordPressPluginOrderSyncService['syncOrders']>(() =>
      Promise.resolve({
        orders: [],
        sync: { created: 0, needsReview: 0, readyToPlan: 0, received: 0, skipped: 0, unchanged: 0, updated: 0 }
      })
    );
  const syncSingleOrder = input.syncSingleOrder ??
    vi.fn<WordPressPluginOrderSyncService['syncSingleOrder']>(() =>
      Promise.resolve({
        orders: [],
        sync: { created: 0, needsReview: 0, readyToPlan: 0, received: 0, skipped: 0, unchanged: 0, updated: 0 }
      })
    );
  return new WordPressPluginSyncRequestService({
    connectionService: { readDecryptedWooCommerceConnection: vi.fn(() => Promise.resolve(input.connection ?? wooConnection())) },
    createOrderSyncService: vi.fn(() => ({ syncOrders, syncSingleOrder, syncUpdatedOrders })),
    freshnessRepository: { markRestSyncCompleted: input.markRestSyncCompleted ?? vi.fn(() => Promise.resolve()) },
    now: input.now ?? (() => acceptedAt),
    syncRunRepository: input.syncRunRepository,
    ...(input.validateConnectionSiteUrl === undefined ? {} : { validateConnectionSiteUrl: input.validateConnectionSiteUrl })
  });
}

function syncRunRepositoryMock(): WordPressPluginSyncRunRepository & {
  acceptRawChunk: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['acceptRawChunk']>>;
  createRawSyncRunUnlessActive: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['createRawSyncRunUnlessActive']>>;
  createSyncRunUnlessActive: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['createSyncRunUnlessActive']>>;
  finalizeRawSyncRun: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['finalizeRawSyncRun']>>;
  findLatestSyncRun: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['findLatestSyncRun']>>;
  findSyncRunById: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['findSyncRunById']>>;
  listRawIngestsForProcessing: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['listRawIngestsForProcessing']>>;
  markRawIngestFailed: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['markRawIngestFailed']>>;
  markRawIngestProcessed: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['markRawIngestProcessed']>>;
  markRawIngestProcessing: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['markRawIngestProcessing']>>;
  markRawIngestSkipped: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['markRawIngestSkipped']>>;
  markSyncRunFailed: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['markSyncRunFailed']>>;
  markSyncRunRunning: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['markSyncRunRunning']>>;
  markSyncRunSucceeded: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['markSyncRunSucceeded']>>;
  refreshRawSyncRunStatus: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['refreshRawSyncRunStatus']>>;
} {
  return {
    acceptRawChunk: vi.fn(),
    createRawSyncRunUnlessActive: vi.fn(),
    createSyncRunUnlessActive: vi.fn(),
    finalizeRawSyncRun: vi.fn(),
    findLatestSyncRun: vi.fn(),
    findSyncRunById: vi.fn(),
    listRawIngestsForProcessing: vi.fn(() => Promise.resolve([])),
    markRawIngestFailed: vi.fn(),
    markRawIngestProcessed: vi.fn(),
    markRawIngestProcessing: vi.fn(),
    markRawIngestSkipped: vi.fn(),
    markSyncRunFailed: vi.fn(),
    markSyncRunRunning: vi.fn(),
    markSyncRunSucceeded: vi.fn(),
    refreshRawSyncRunStatus: vi.fn()
  };
}

function syncRun(input: Partial<WordPressPluginSyncRun> = {}): WordPressPluginSyncRun {
  return {
    acceptedAt: acceptedAt.toISOString(),
    completedAt: null,
    errorMessage: null,
    request: { modifiedAfter: null, pageSize: 100, status: null },
    result: null,
    startedAt: null,
    status: 'QUEUED',
    syncRunId: '11111111-1111-4111-8111-111111111111',
    ...input
  };
}

function pluginContext() {
  return {
    connectionId: 'connection-id',
    label: 'Woo',
    shopDomain: 'woo.example.test',
    shopId: 'shop-id',
    siteUrl: 'https://woo.example.test',
    status: 'ACTIVE' as const,
    tokenId: 'token-id',
    tokenPrefix: 'crp_token_prefix'
  };
}

function wooConnection(): DecryptedWooCommerceConnection {
  return {
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    credential: { fingerprint: null, rotatedAt: null, status: 'stored' },
    id: 'connection-id',
    label: 'Woo',
    lastRestSyncAt: null,
    lastWebhookAt: null,
    shopDomain: 'woo.example.test',
    siteUrl: 'https://woo.example.test',
    status: 'ACTIVE',
    timezone: null,
    verification: { lastVerifiedAt: null, status: null },
    webhook: { rotatedAt: null, status: 'stored' },
    webhookSecret: 'webhook-secret'
  };
}

function orderRow(geocodeStatus: CanonicalOrderRow['geocodeStatus']): CanonicalOrderRow {
  return { geocodeStatus } as CanonicalOrderRow;
}

function sequenceClock(values: Date[]): () => Date {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? values[values.length - 1] ?? acceptedAt;
}
