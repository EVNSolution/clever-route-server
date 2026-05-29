import { describe, expect, test, vi } from 'vitest';

import { PrismaWordPressPluginRepository } from '../src/modules/wordpress-plugin/wordpress-plugin.repository.js';
import type { WordPressPluginConnectionContext } from '../src/modules/wordpress-plugin/wordpress-plugin.types.js';

const acceptedAt = new Date('2026-05-25T03:00:00.000Z');

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

function syncRunRecord(input: { startedAt?: Date | null; status?: 'FAILED' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' } = {}) {
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
    requestPayload: { modifiedAfter: null, pageSize: 100, status: null },
    skipped: null,
    startedAt: input.startedAt ?? null,
    status: input.status ?? 'QUEUED',
    unchanged: null,
    updated: null,
    warnings: []
  };
}
