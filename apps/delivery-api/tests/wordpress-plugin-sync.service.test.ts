import { describe, expect, test, vi } from 'vitest';

import type { DecryptedWooCommerceConnection } from '../src/modules/commerce/commerce-connection.service.js';
import { WordPressPluginSyncRequestService } from '../src/modules/wordpress-plugin/wordpress-plugin-sync.service.js';

const now = new Date('2026-05-25T03:00:00.000Z');

describe('WordPressPluginSyncRequestService', () => {
  test('validates the Woo site URL before plugin-triggered REST sync', async () => {
    const connection = wooConnection();
    const validateConnectionSiteUrl = vi.fn(() => Promise.resolve());
    const syncUpdatedOrders = vi.fn(() =>
      Promise.resolve({
        pagesRead: 1,
        sync: { created: 0, needsReview: 0, readyToPlan: 0, received: 0, skipped: 0, unchanged: 0, updated: 0 }
      })
    );
    const markRestSyncCompleted = vi.fn(() => Promise.resolve());
    const service = new WordPressPluginSyncRequestService({
      connectionService: { readDecryptedWooCommerceConnection: vi.fn(() => Promise.resolve(connection)) },
      createOrderSyncService: vi.fn(() => ({ syncUpdatedOrders })),
      freshnessRepository: { markRestSyncCompleted },
      now: () => now,
      validateConnectionSiteUrl
    });

    await expect(
      service.requestSync({
        context: pluginContext(),
        payload: { modifiedAfter: null, pageSize: 100, status: null }
      })
    ).resolves.toEqual({
      pagesRead: 1,
      sync: { created: 0, needsReview: 0, readyToPlan: 0, received: 0, skipped: 0, unchanged: 0, updated: 0 },
      warnings: []
    });
    expect(validateConnectionSiteUrl).toHaveBeenCalledWith({ connection });
    expect(syncUpdatedOrders).toHaveBeenCalledOnce();
    expect(markRestSyncCompleted).toHaveBeenCalledWith({ at: now, connectionId: 'connection-id' });
  });

  test('does not run REST sync when Woo site URL validation fails', async () => {
    const syncUpdatedOrders = vi.fn();
    const service = new WordPressPluginSyncRequestService({
      connectionService: { readDecryptedWooCommerceConnection: vi.fn(() => Promise.resolve(wooConnection())) },
      createOrderSyncService: vi.fn(() => ({ syncUpdatedOrders })),
      freshnessRepository: { markRestSyncCompleted: vi.fn() },
      validateConnectionSiteUrl: vi.fn(() => Promise.reject(new Error('WooCommerce site URL must not resolve to private addresses')))
    });

    await expect(
      service.requestSync({
        context: pluginContext(),
        payload: { modifiedAfter: null, pageSize: 100, status: null }
      })
    ).rejects.toThrow('WooCommerce site URL must not resolve to private addresses');
    expect(syncUpdatedOrders).not.toHaveBeenCalled();
  });
});

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
