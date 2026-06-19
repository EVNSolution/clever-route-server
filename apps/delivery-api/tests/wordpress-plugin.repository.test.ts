import { describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES,
  hashSecret
} from '../src/modules/wordpress-plugin/wordpress-plugin-auth.service.js';
import { PrismaWordPressPluginRepository } from '../src/modules/wordpress-plugin/wordpress-plugin.repository.js';
import type { WordPressPluginConnectionContext } from '../src/modules/wordpress-plugin/wordpress-plugin.types.js';

const acceptedAt = new Date('2026-05-25T03:00:00.000Z');

describe('PrismaWordPressPluginRepository pairing-code lifecycle', () => {
  test('stores only a hash for server-generated pairing codes and uses the shared TTL default', async () => {
    const issuedAt = new Date('2026-06-04T01:00:00.000Z');
    const expiresAt = new Date(
      issuedAt.getTime() +
        DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES * 60_000
    );
    const commerceConnection = {
      findUnique: vi.fn(() =>
        Promise.resolve({
          id: 'connection-id',
          shopId: 'shop-id',
          siteUrl: 'https://woo.example.test'
        })
      )
    };
    const wordPressPluginPairingCode = {
      create: vi.fn(() => Promise.resolve({ id: 'pairing-code-id' }))
    };
    const repository = new PrismaWordPressPluginRepository({
      commerceConnection,
      wordPressPluginPairingCode
    } as never);

    const result = await repository.createPairingCode({
      commerceConnectionId: 'connection-id',
      expiresAt,
      issuedAt,
      issuedBy: 'web-operator',
      plaintextCode: 'crp-pair-plaintext',
      siteUrl: 'https://woo.example.test/'
    });

    expect(DEFAULT_WORDPRESS_PLUGIN_PAIRING_CODE_TTL_MINUTES).toBe(15);
    expect(result).toEqual({
      code: 'crp-pair-plaintext',
      expiresAt,
      siteUrl: 'https://woo.example.test',
      tokenPreview: null
    });
    expect(wordPressPluginPairingCode.create).toHaveBeenCalledWith({
      data: {
        codeHash: hashSecret('crp-pair-plaintext'),
        commerceConnectionId: 'connection-id',
        expiresAt,
        issuedAt,
        issuedBy: 'web-operator',
        shopId: 'shop-id',
        siteUrl: 'https://woo.example.test'
      },
      select: { id: true }
    });
    expect(JSON.stringify(wordPressPluginPairingCode.create.mock.calls)).not.toContain(
      'crp-pair-plaintext'
    );
  });

  test('rejects a pairing code site URL that differs from the connection site URL', async () => {
    const commerceConnection = {
      findUnique: vi.fn(() =>
        Promise.resolve({
          id: 'connection-id',
          shopId: 'shop-id',
          siteUrl: 'https://woo.example.test'
        })
      )
    };
    const wordPressPluginPairingCode = {
      create: vi.fn()
    };
    const repository = new PrismaWordPressPluginRepository({
      commerceConnection,
      wordPressPluginPairingCode
    } as never);

    await expect(
      repository.createPairingCode({
        commerceConnectionId: 'connection-id',
        expiresAt: new Date('2026-06-04T01:15:00.000Z'),
        issuedAt: new Date('2026-06-04T01:00:00.000Z'),
        issuedBy: 'web-operator',
        plaintextCode: 'crp-pair-plaintext',
        siteUrl: 'https://other.example.test'
      })
    ).rejects.toThrow(
      'WordPress plugin pairing code site URL must match the WooCommerce connection site URL'
    );
    expect(wordPressPluginPairingCode.create).not.toHaveBeenCalled();
  });
});

describe('PrismaWordPressPluginRepository raw ingest audit events', () => {
  test('records source-aware raw ingest events without requiring a raw ingest row', async () => {
    const commerceRawOrderIngestEvent = {
      create: vi.fn((input: unknown) => {
        void input;
        return Promise.resolve({ id: 'event-id' });
      })
    };
    const repository = new PrismaWordPressPluginRepository({ commerceRawOrderIngestEvent } as never);

    await repository.recordRawOrderIngestEvent({
      code: 'WOO_ORDER_MISSING_DELIVERY_METADATA',
      commerceConnectionId: 'connection-id',
      createdAt: acceptedAt,
      decision: 'REVIEW',
      message: 'Order is active but missing delivery metadata.',
      metadata: { status: 'processing' },
      rawPayloadSha256: 'raw-hash',
      severity: 'warning',
      shopId: 'shop-id',
      sourceLine: 'WOOCOMMERCE',
      sourceOrderId: '11815',
      sourceOrderNumber: '11815',
      stage: 'raw_intake',
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });

    expect(commerceRawOrderIngestEvent.create).toHaveBeenCalledWith({
      data: {
        code: 'WOO_ORDER_MISSING_DELIVERY_METADATA',
        commerceConnectionId: 'connection-id',
        createdAt: acceptedAt,
        decision: 'REVIEW',
        message: 'Order is active but missing delivery metadata.',
        metadata: { status: 'processing' },
        rawOrderIngestId: null,
        rawPayloadSha256: 'raw-hash',
        severity: 'warning',
        shopId: 'shop-id',
        sourceLine: 'WOOCOMMERCE',
        sourceOrderId: '11815',
        sourceOrderNumber: '11815',
        stage: 'raw_intake',
        syncRunId: '11111111-1111-4111-8111-111111111111'
      },
      select: { id: true }
    });
  });
});

describe('PrismaWordPressPluginRepository sync-run lifecycle', () => {
  test('marks stale running sync runs failed before creating a new active run', async () => {
    const commerceSyncRun = {
      create: vi.fn(() => Promise.resolve(syncRunRecord({ status: 'QUEUED' }))),
      findFirst: vi.fn(() => Promise.resolve(null)),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
    };
    const repository = new PrismaWordPressPluginRepository({ commerceSyncRun } as never);

    const result = await repository.createSyncRunUnlessActive({
      acceptedAt,
      context: pluginContext(),
      request: { modifiedAfter: null, pageSize: 100, status: null }
    });
    expect(result.alreadyRunning).toBe(false);
    expect(result.startBackgroundProcessing).toBe(true);
    expect(result.run.status).toBe('QUEUED');
    expect(result.run.syncRunId).toBe('11111111-1111-4111-8111-111111111111');
    expect(commerceSyncRun.updateMany).toHaveBeenCalledWith({
      data: {
        completedAt: acceptedAt,
        errorMessage: 'Sync run failed because the background worker did not complete before the recovery timeout.',
        status: 'FAILED',
        updatedAt: acceptedAt
      },
      where: {
        commerceConnectionId: 'connection-id',
        OR: [
          { startedAt: { lt: new Date('2026-05-25T02:30:00.000Z') } },
          { acceptedAt: { lt: new Date('2026-05-25T02:30:00.000Z') }, startedAt: null }
        ],
        shopId: 'shop-id',
        status: 'RUNNING'
      }
    });
    expect(commerceSyncRun.create).toHaveBeenCalledOnce();
  });

  test('returns an existing queued run with background processing enabled so crash-before-start can recover', async () => {
    const commerceSyncRun = {
      create: vi.fn(),
      findFirst: vi.fn(() => Promise.resolve(syncRunRecord({ status: 'QUEUED' }))),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(() => Promise.resolve({ count: 0 }))
    };
    const repository = new PrismaWordPressPluginRepository({ commerceSyncRun } as never);

    const result = await repository.createSyncRunUnlessActive({
      acceptedAt,
      context: pluginContext(),
      request: { modifiedAfter: null, pageSize: 100, status: null }
    });
    expect(result.alreadyRunning).toBe(true);
    expect(result.startBackgroundProcessing).toBe(true);
    expect(result.run.status).toBe('QUEUED');
    expect(commerceSyncRun.create).not.toHaveBeenCalled();
  });

  test('returns a non-stale running run without starting a duplicate background worker', async () => {
    const commerceSyncRun = {
      create: vi.fn(),
      findFirst: vi.fn(() => Promise.resolve(syncRunRecord({ startedAt: acceptedAt, status: 'RUNNING' }))),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(() => Promise.resolve({ count: 0 }))
    };
    const repository = new PrismaWordPressPluginRepository({ commerceSyncRun } as never);

    const result = await repository.createSyncRunUnlessActive({
      acceptedAt,
      context: pluginContext(),
      request: { modifiedAfter: null, pageSize: 100, status: null }
    });
    expect(result.alreadyRunning).toBe(true);
    expect(result.startBackgroundProcessing).toBe(false);
    expect(result.run.status).toBe('RUNNING');
    expect(commerceSyncRun.create).not.toHaveBeenCalled();
  });

  test('creates raw-push sync runs and decorates status with raw ingest counts', async () => {
    const commerceRawOrderIngest = {
      findMany: vi.fn(() => Promise.resolve([]))
    };
    const commerceSyncRun = {
      create: vi.fn((input: unknown) => {
        void input;
        return Promise.resolve(syncRunRecord({ requestPayload: { mode: 'raw_push', modifiedAfter: null, pageSize: 100, status: null }, status: 'QUEUED' }));
      }),
      findFirst: vi.fn(() => Promise.resolve(null)),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
    };
    const repository = new PrismaWordPressPluginRepository({ commerceRawOrderIngest, commerceSyncRun } as never);

    const result = await repository.createRawSyncRunUnlessActive({
      acceptedAt,
      context: pluginContext(),
      request: { modifiedAfter: null, pageSize: 100, status: null }
    });

    expect(result.alreadyRunning).toBe(false);
    expect(result.startBackgroundProcessing).toBe(false);
    expect(result.run.request.mode).toBe('raw_push');
    expect(result.run.raw).toEqual({
      accepted: 0,
      chunksReceived: 0,
      duplicate: 0,
      expectedChunkCount: null,
      expectedOrderCount: null,
      failed: 0,
      failures: [],
      finalizedAt: null,
      invalid: 0,
      processed: 0,
      rawRefreshed: 0,
      skipped: 0,
      waitingForChunks: true
    });
    const createdSyncRunInput = commerceSyncRun.create.mock.calls[0]?.[0] as
      | { data?: { requestPayload?: unknown; trigger?: unknown } & Record<string, unknown> }
      | undefined;
    expect(createdSyncRunInput?.data).toMatchObject({
      created: 0,
      geocodeFailed: 0,
      geocodeNotRequired: 0,
      geocodePending: 0,
      geocodeResolved: 0,
      needsReview: 0,
      pagesRead: 0,
      readyToPlan: 0,
      received: 0,
      requestPayload: { mode: 'raw_push', modifiedAfter: null, pageSize: 100, status: null },
      skipped: 0,
      trigger: 'raw_push',
      unchanged: 0,
      updated: 0
    });
  });

  test('records canonical processing counts on the raw sync run as each row completes', async () => {
    const commerceRawOrderIngest = {
      updateMany: vi.fn((input: unknown) => {
        void input;
        return Promise.resolve({ count: 1 });
      })
    };
    const commerceSyncRun = {
      updateMany: vi.fn((input: unknown) => {
        void input;
        return Promise.resolve({ count: 1 });
      })
    };
    const repository = new PrismaWordPressPluginRepository({ commerceRawOrderIngest, commerceSyncRun } as never);

    await repository.markRawIngestProcessed({
      canonicalOrderId: 'canonical-order-id',
      context: pluginContext(),
      geocode: { failed: 1, notRequired: 0, pending: 0, resolved: 0 },
      ingestId: 'raw-ingest-id',
      now: acceptedAt,
      sync: { created: 0, needsReview: 1, readyToPlan: 0, received: 1, skipped: 0, unchanged: 0, updated: 1 },
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });

    const rawUpdateInput = commerceRawOrderIngest.updateMany.mock.calls[0]?.[0] as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(rawUpdateInput?.data).toMatchObject({
      canonicalOrderId: 'canonical-order-id',
      status: 'PROCESSED'
    });
    expect(commerceSyncRun.updateMany).toHaveBeenCalledWith({
      data: {
        created: { increment: 0 },
        geocodeFailed: { increment: 1 },
        geocodeNotRequired: { increment: 0 },
        geocodePending: { increment: 0 },
        geocodeResolved: { increment: 0 },
        needsReview: { increment: 1 },
        readyToPlan: { increment: 0 },
        unchanged: { increment: 0 },
        updated: { increment: 1 },
        updatedAt: acceptedAt
      },
      where: {
        commerceConnectionId: 'connection-id',
        id: '11111111-1111-4111-8111-111111111111',
        shopId: 'shop-id',
        status: { in: ['QUEUED', 'RUNNING'] }
      }
    });
  });

  test('does not count stale event-backed processed updates after raw ingest leaves PROCESSING', async () => {
    const commerceRawOrderIngest = {
      updateMany: vi.fn((input: unknown) => {
        void input;
        return Promise.resolve({ count: 0 });
      })
    };
    const commerceRawOrderIngestEvent = {
      create: vi.fn()
    };
    const commerceSyncRun = {
      updateMany: vi.fn()
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
        callback({ commerceRawOrderIngest, commerceRawOrderIngestEvent, commerceSyncRun })
      )
    };
    const repository = new PrismaWordPressPluginRepository(prisma as never);

    await repository.markRawIngestProcessedWithEvent({
      canonicalOrderId: 'canonical-order-id',
      context: pluginContext(),
      event: {
        code: 'CANONICAL_DECISION_PROCESS',
        commerceConnectionId: 'connection-id',
        decision: 'PROCESS_CANONICAL',
        message: 'Processed.',
        severity: 'info',
        shopId: 'shop-id',
        sourceLine: 'WOOCOMMERCE',
        sourceOrderId: '123',
        sourceOrderNumber: '123',
        stage: 'processing',
        syncRunId: '11111111-1111-4111-8111-111111111111'
      },
      geocode: { failed: 0, notRequired: 1, pending: 0, resolved: 0 },
      ingestId: 'raw-ingest-id',
      now: acceptedAt,
      sync: { created: 1, needsReview: 0, readyToPlan: 1, received: 1, skipped: 0, unchanged: 0, updated: 0 },
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });

    const rawUpdateInput = commerceRawOrderIngest.updateMany.mock.calls[0]?.[0] as
      | { where?: Record<string, unknown> }
      | undefined;
    expect(rawUpdateInput?.where).toMatchObject({
      id: 'raw-ingest-id',
      status: 'PROCESSING'
    });
    expect(commerceRawOrderIngestEvent.create).not.toHaveBeenCalled();
    expect(commerceSyncRun.updateMany).not.toHaveBeenCalled();
  });

  test('keeps duplicate raw order accounting durable so finalize status does not wait forever', async () => {
    const commerceRawOrderIngest = {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([
          {
            failureCode: null,
            failureMessage: null,
            retryable: false,
            sourceOrderId: '123',
            sourceOrderNumber: '123',
            status: 'PROCESSED'
          }
        ])
        .mockResolvedValueOnce([{ chunkId: 'chunk-1' }])
    };
    const commerceSyncRun = {
      findFirst: vi.fn(() =>
        Promise.resolve(
          syncRunRecord({
            requestPayload: {
              duplicateCount: 1,
              expectedOrderCount: 2,
              finalizedAt: '2026-05-25T03:05:00.000Z',
              mode: 'raw_push',
              modifiedAfter: null,
              pageSize: 100,
              status: null
            },
            status: 'RUNNING'
          })
        )
      )
    };
    const repository = new PrismaWordPressPluginRepository({ commerceRawOrderIngest, commerceSyncRun } as never);

    const run = await repository.findSyncRunById({
      context: pluginContext(),
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });

    expect(run?.raw).toMatchObject({
      accepted: 1,
      duplicate: 1,
      expectedOrderCount: 2,
      invalid: 0,
      processed: 1,
      waitingForChunks: false
    });
  });

  test('retryable raw processing failures are reset for bounded replay before becoming terminal failures', async () => {
    const commerceRawOrderIngest = {
      updateMany: vi.fn((input: unknown) => {
        void input;
        return Promise.resolve({ count: 1 });
      })
    };
    const repository = new PrismaWordPressPluginRepository({ commerceRawOrderIngest } as never);

    await repository.markRawIngestFailed({
      context: pluginContext(),
      failureCode: 'RAW_ORDER_PROCESSING_FAILED',
      failureMessage: 'Transient provider timeout',
      ingestId: 'raw-ingest-id',
      now: acceptedAt,
      retryable: true,
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });

    expect(commerceRawOrderIngest.updateMany).toHaveBeenCalledOnce();
    const retryUpdateInput = commerceRawOrderIngest.updateMany.mock.calls[0]?.[0] as
      | { data?: Record<string, unknown>; where?: Record<string, unknown> }
      | undefined;
    expect(retryUpdateInput?.data).toMatchObject({
      failureCode: 'RAW_ORDER_PROCESSING_FAILED',
      processingStartedAt: null,
      retryable: true,
      status: 'RECEIVED'
    });
    expect(retryUpdateInput?.where).toMatchObject({
      attemptCount: { lt: 3 },
      status: 'PROCESSING'
    });
  });

  test('exhausted retryable raw processing failures become terminal non-retryable failures', async () => {
    const commerceRawOrderIngest = {
      updateMany: vi
        .fn((input: unknown) => {
          void input;
          return Promise.resolve({ count: 0 });
        })
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 })
    };
    const repository = new PrismaWordPressPluginRepository({ commerceRawOrderIngest } as never);

    await repository.markRawIngestFailed({
      context: pluginContext(),
      failureCode: 'RAW_ORDER_PROCESSING_FAILED',
      failureMessage: 'Transient provider timeout',
      ingestId: 'raw-ingest-id',
      now: acceptedAt,
      retryable: true,
      syncRunId: '11111111-1111-4111-8111-111111111111'
    });

    const terminalUpdateInput = commerceRawOrderIngest.updateMany.mock.calls[1]?.[0] as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(terminalUpdateInput?.data).toMatchObject({
      failureCode: 'RAW_ORDER_RETRY_EXHAUSTED',
      failureMessage: 'Order processing did not complete after multiple retry attempts.',
      retryable: false,
      status: 'FAILED'
    });
  });

  test('accepts raw chunks durably and treats exact duplicate payloads as idempotent', async () => {
    const commerceRawOrderIngest = {
      create: vi
        .fn((input: unknown): Promise<{ id: string }> => {
          void input;
          return Promise.resolve({ id: 'raw-1' });
        })
        .mockResolvedValueOnce({ id: 'raw-1' })
        .mockRejectedValueOnce({ code: 'P2002' }),
      findMany: vi.fn(() => Promise.resolve([]))
    };
    const commerceSyncRun = {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(syncRunRecord({ requestPayload: { mode: 'raw_push', modifiedAfter: null, pageSize: 100, status: null }, status: 'RUNNING' }))
        .mockResolvedValueOnce(syncRunRecord({ requestPayload: { expectedChunkCount: 1, mode: 'raw_push', modifiedAfter: null, pageSize: 100, status: null }, status: 'RUNNING' })),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
    };
    const repository = new PrismaWordPressPluginRepository({ commerceRawOrderIngest, commerceSyncRun } as never);

    const result = await repository.acceptRawChunk({
      context: pluginContext(),
      now: acceptedAt,
      payload: {
        chunkCount: 1,
        chunkId: 'chunk-1',
        chunkIndex: 0,
        orders: [
          { id: 123, number: '123', date_modified_gmt: '2026-05-20T00:00:00' },
          { id: 123, number: '123', date_modified_gmt: '2026-05-20T00:00:00' }
        ],
        syncRunId: '11111111-1111-4111-8111-111111111111'
      }
    });

    expect(result.accepted).toBe(1);
    expect(result.duplicate).toBe(1);
    expect(result.invalid).toBe(0);
    expect(result.startBackgroundProcessing).toBe(true);
    const createdRawInput = commerceRawOrderIngest.create.mock.calls[0]?.[0] as
      | { data?: { chunkId?: unknown; rawPayload?: unknown; sourceOrderId?: unknown; status?: unknown } }
      | undefined;
    expect(createdRawInput?.data).toMatchObject({
      chunkId: 'chunk-1',
      rawPayload: { id: 123, number: '123', date_modified_gmt: '2026-05-20T00:00:00' },
      sourceOrderId: '123',
      status: 'RECEIVED'
    });
  });

  test('records a pre-ingest audit event for raw chunks with missing order id', async () => {
    const commerceRawOrderIngest = {
      create: vi.fn(),
      findMany: vi.fn(() => Promise.resolve([]))
    };
    const commerceRawOrderIngestEvent = {
      create: vi.fn((input: unknown) => {
        void input;
        return Promise.resolve({ id: 'event-id' });
      })
    };
    const commerceSyncRun = {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(syncRunRecord({ requestPayload: { mode: 'raw_push', modifiedAfter: null, pageSize: 100, status: null }, status: 'RUNNING' }))
        .mockResolvedValueOnce(syncRunRecord({ requestPayload: { expectedChunkCount: 1, mode: 'raw_push', modifiedAfter: null, pageSize: 100, status: null }, status: 'RUNNING' })),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
    };
    const repository = new PrismaWordPressPluginRepository({ commerceRawOrderIngest, commerceRawOrderIngestEvent, commerceSyncRun } as never);

    const result = await repository.acceptRawChunk({
      context: pluginContext(),
      now: acceptedAt,
      payload: {
        chunkCount: 1,
        chunkId: 'chunk-1',
        chunkIndex: 0,
        orders: [{ id: null, line_items: [{ id: 1, name: 'Tomato box' }], number: 'draft-1' }],
        syncRunId: '11111111-1111-4111-8111-111111111111'
      }
    });

    expect(result.invalid).toBe(1);
    expect(result.accepted).toBe(0);
    expect(commerceRawOrderIngest.create).not.toHaveBeenCalled();
    const eventCreateInput = commerceRawOrderIngestEvent.create.mock.calls[0]?.[0] as
      | { data?: Record<string, unknown>; select?: unknown }
      | undefined;
    expect(eventCreateInput?.data).toMatchObject({
      code: 'RAW_SHAPE_MISSING_ORDER_ID',
      rawOrderIngestId: null,
      sourceOrderNumber: 'draft-1'
    });
    expect(eventCreateInput?.select).toEqual({ id: true });
  });

  test('health includes the latest sync run instead of duplicating freshness data', async () => {
    const commerceConnection = {
      findUnique: vi.fn(() => Promise.resolve({ lastRestSyncAt: null, lastWebhookAt: null }))
    };
    const commerceSyncRun = {
      findFirst: vi.fn(() => Promise.resolve(syncRunRecord({ status: 'SUCCEEDED' })))
    };
    const routePlan = {
      findFirst: vi.fn(() => Promise.resolve(null))
    };
    const repository = new PrismaWordPressPluginRepository({ commerceConnection, commerceSyncRun, routePlan } as never);

    const health = await repository.readHealth({ context: pluginContext(), now: acceptedAt });
    expect(health.connection).toEqual({
      connectionId: 'connection-id',
      label: 'Woo test',
      shopDomain: 'woo.example.test',
      siteUrl: 'https://woo.example.test',
      state: 'connected',
      tokenPrefix: 'crp_token_prefix'
    });
    expect(health.freshness).toEqual({
      lastRestSyncAt: null,
      lastRouteUpdatedAt: null,
      lastWebhookAt: null,
      serverTime: acceptedAt.toISOString()
    });
    expect(health.latestSyncRun?.status).toBe('SUCCEEDED');
    expect(health.latestSyncRun?.syncRunId).toBe('11111111-1111-4111-8111-111111111111');
    expect(commerceSyncRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { commerceConnectionId: 'connection-id', shopId: 'shop-id' }
      })
    );
  });
});

function pluginContext(): WordPressPluginConnectionContext {
  return {
    connectionId: 'connection-id',
    label: 'Woo test',
    shopDomain: 'woo.example.test',
    shopId: 'shop-id',
    siteUrl: 'https://woo.example.test',
    status: 'ACTIVE',
    tokenId: 'token-id',
    tokenPrefix: 'crp_token_prefix'
  };
}

function syncRunRecord(
  input: {
    requestPayload?: Record<string, unknown>;
    startedAt?: Date | null;
    status?: 'FAILED' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED';
  } = {}
) {
  return {
    acceptedAt,
    completedAt: null,
    created: null,
    errorMessage: null,
    geocodeFailed: null,
    geocodeNotRequired: null,
    geocodePending: null,
    geocodeResolved: null,
    id: '11111111-1111-4111-8111-111111111111',
    needsReview: null,
    pagesRead: null,
    readyToPlan: null,
    received: null,
    requestPayload: input.requestPayload ?? { modifiedAfter: null, pageSize: 100, status: null },
    skipped: null,
    startedAt: input.startedAt ?? null,
    status: input.status ?? 'QUEUED',
    unchanged: null,
    updated: null,
    warnings: []
  };
}
