import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { verifyWooCommerceWebhookSignature } from '../src/modules/woocommerce/woocommerce-webhook-signature.js';
import type { WooCommerceWebhookDependencies } from '../src/routes/woocommerce-webhook.routes.js';

const connectionId = '11111111-1111-4111-8111-111111111111';

describe('WooCommerce webhook signature', () => {
  test('validates WooCommerce base64 HMAC-SHA256 signatures', () => {
    const rawBody = JSON.stringify({ id: 123 });
    const signature = createHmac('sha256', 'secret').update(rawBody).digest('base64');

    expect(verifyWooCommerceWebhookSignature({ rawBody, secret: 'secret', signature })).toBe(true);
    expect(verifyWooCommerceWebhookSignature({ rawBody, secret: 'secret', signature: 'bad' })).toBe(false);
  });
});

describe('WooCommerce webhook routes', () => {
  test('rejects missing or invalid signatures before syncing', async () => {
    const syncOrders = vi.fn();
    const connection = wooConnection();
    const readDecryptedWooCommerceConnection = vi.fn(() => Promise.resolve(connection));
    const readWooCommerceWebhookConnection = vi.fn(() => Promise.resolve(connection));
    const createOrderSyncService = vi.fn(() => ({ syncOrders }));
    const app = await buildApp({
      wooCommerceWebhook: {
        connectionService: { readDecryptedWooCommerceConnection, readWooCommerceWebhookConnection },
        createOrderSyncService
      }
    });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { id: 123 },
        url: `/woocommerce/webhooks/${connectionId}/orders`
      });
      expect(response.statusCode).toBe(400);
      expect(readDecryptedWooCommerceConnection).not.toHaveBeenCalled();
      expect(syncOrders).not.toHaveBeenCalled();

      const invalid = await app.inject({
        headers: { 'x-wc-webhook-signature': 'invalid' },
        method: 'POST',
        payload: { id: 123 },
        url: `/woocommerce/webhooks/${connectionId}/orders`
      });
      expect(invalid.statusCode).toBe(401);
      expect(readWooCommerceWebhookConnection).toHaveBeenCalledWith({ connectionId });
      expect(readDecryptedWooCommerceConnection).not.toHaveBeenCalled();
      expect(createOrderSyncService).not.toHaveBeenCalled();
      expect(syncOrders).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects malformed connection ids before touching credential storage', async () => {
    const readDecryptedWooCommerceConnection = vi.fn();
    const readWooCommerceWebhookConnection = vi.fn();
    const app = await buildApp({
      wooCommerceWebhook: {
        connectionService: { readDecryptedWooCommerceConnection, readWooCommerceWebhookConnection },
        createOrderSyncService: vi.fn(() => ({ syncOrders: vi.fn() }))
      }
    });

    try {
      const response = await app.inject({
        headers: { 'x-wc-webhook-signature': 'invalid' },
        method: 'POST',
        payload: { id: 123 },
        url: '/woocommerce/webhooks/not-a-uuid/orders'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'WooCommerce connection id must be a UUID' }
      });
      expect(readWooCommerceWebhookConnection).not.toHaveBeenCalled();
      expect(readDecryptedWooCommerceConnection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects unknown connection ids before signature verification', async () => {
    const syncOrders = vi.fn();
    const app = await buildApp({
      wooCommerceWebhook: {
        connectionService: {
          readDecryptedWooCommerceConnection: vi.fn(() => Promise.resolve(null)),
          readWooCommerceWebhookConnection: vi.fn(() => Promise.resolve(null))
        },
        createOrderSyncService: vi.fn(() => ({ syncOrders }))
      }
    });

    try {
      const response = await app.inject({
        headers: { 'x-wc-webhook-signature': 'invalid' },
        method: 'POST',
        payload: { id: 123 },
        url: `/woocommerce/webhooks/${connectionId}/orders`
      });

      expect(response.statusCode).toBe(404);
      expect(syncOrders).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('accepts valid order webhooks and syncs exactly one order', async () => {
    const syncOrders = vi.fn(() =>
      Promise.resolve({ sync: { created: 1, received: 1, unchanged: 0, updated: 0 } })
    );
    const connection = wooConnection();
    const createOrderSyncService = vi.fn(() => ({ syncOrders }));
    const markWooCommerceWebhookAccepted =
      vi.fn<NonNullable<WooCommerceWebhookDependencies['connectionService']['markWooCommerceWebhookAccepted']>>(() =>
        Promise.resolve()
      );
    const app = await buildApp({
      wooCommerceWebhook: {
        connectionService: {
          markWooCommerceWebhookAccepted,
          readDecryptedWooCommerceConnection: vi.fn(() => Promise.resolve(connection)),
          readWooCommerceWebhookConnection: vi.fn(() => Promise.resolve(connection))
        },
        createOrderSyncService
      }
    });
    const rawBody = JSON.stringify({ id: 123, number: '123', status: 'processing' });
    const signature = createHmac('sha256', connection.webhookSecret).update(rawBody).digest('base64');

    try {
      const response = await app.inject({
        headers: {
          'content-type': 'application/json',
          'x-wc-webhook-delivery-id': 'delivery-id',
          'x-wc-webhook-event': 'updated',
          'x-wc-webhook-resource': 'order',
          'x-wc-webhook-signature': signature,
          'x-wc-webhook-topic': 'order.updated'
        },
        method: 'POST',
        payload: rawBody,
        url: `/woocommerce/webhooks/${connectionId}/orders`
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: { received: 1, sync: { created: 1, received: 1, unchanged: 0, updated: 0 } },
        error: null
      });
      expect(createOrderSyncService).toHaveBeenCalledWith({ connection });
      expect(syncOrders).toHaveBeenCalledWith({
        orders: [expect.objectContaining({ id: 123, number: '123' })],
        reason: 'webhook'
      });
      const webhookWatermark = markWooCommerceWebhookAccepted.mock.calls[0]?.[0];
      expect(webhookWatermark?.at).toBeInstanceOf(Date);
      expect(webhookWatermark?.connectionId).toBe(connectionId);
    } finally {
      await app.close();
    }
  });
});

function wooConnection() {
  return {
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    credential: {
      fingerprint: null,
      rotatedAt: null,
      status: 'stored' as const
    },
    id: connectionId,
    label: 'Woo test',
    lastRestSyncAt: null,
    lastWebhookAt: null,
    shopDomain: 'woo.example.test',
    siteUrl: 'https://woo.example.test',
    status: 'ACTIVE' as const,
    timezone: 'America/Toronto',
    verification: {
      lastVerifiedAt: null,
      status: null
    },
    webhook: {
      rotatedAt: null,
      status: 'stored' as const
    },
    webhookSecret: 'secret'
  };
}
