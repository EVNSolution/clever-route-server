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
    const syncUpdatedOrders = vi.fn();
    const service = createService({ syncRunRepository, syncUpdatedOrders });

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
    expect(syncUpdatedOrders).not.toHaveBeenCalled();
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

});

function createService(input: {
  connection?: DecryptedWooCommerceConnection;
  markRestSyncCompleted?: ReturnType<typeof vi.fn<(input: { at: Date; connectionId: string }) => Promise<void>>>;
  now?: () => Date;
  syncRunRepository: ReturnType<typeof syncRunRepositoryMock>;
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
  return new WordPressPluginSyncRequestService({
    connectionService: { readDecryptedWooCommerceConnection: vi.fn(() => Promise.resolve(input.connection ?? wooConnection())) },
    createOrderSyncService: vi.fn(() => ({ syncUpdatedOrders })),
    freshnessRepository: { markRestSyncCompleted: input.markRestSyncCompleted ?? vi.fn(() => Promise.resolve()) },
    now: input.now ?? (() => acceptedAt),
    syncRunRepository: input.syncRunRepository,
    ...(input.validateConnectionSiteUrl === undefined ? {} : { validateConnectionSiteUrl: input.validateConnectionSiteUrl })
  });
}

function syncRunRepositoryMock(): WordPressPluginSyncRunRepository & {
  createSyncRunUnlessActive: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['createSyncRunUnlessActive']>>;
  findLatestSyncRun: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['findLatestSyncRun']>>;
  findSyncRunById: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['findSyncRunById']>>;
  markSyncRunFailed: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['markSyncRunFailed']>>;
  markSyncRunRunning: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['markSyncRunRunning']>>;
  markSyncRunSucceeded: ReturnType<typeof vi.fn<WordPressPluginSyncRunRepository['markSyncRunSucceeded']>>;
} {
  return {
    createSyncRunUnlessActive: vi.fn(),
    findLatestSyncRun: vi.fn(),
    findSyncRunById: vi.fn(),
    markSyncRunFailed: vi.fn(),
    markSyncRunRunning: vi.fn(),
    markSyncRunSucceeded: vi.fn()
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
