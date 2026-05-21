import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { verifyWooCommerceWebhookSignature } from '../src/modules/woocommerce/woocommerce-webhook-signature.js';

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
    const app = await buildApp({
      wooCommerceWebhook: { orderSyncService: { syncOrders }, siteUrl: 'https://woo.example.test', webhookSecret: 'secret' }
    });

    try {
      const response = await app.inject({ method: 'POST', payload: { id: 123 }, url: '/woocommerce/webhooks/orders' });
      expect(response.statusCode).toBe(400);
      expect(syncOrders).not.toHaveBeenCalled();

      const invalid = await app.inject({
        headers: { 'x-wc-webhook-signature': 'invalid' },
        method: 'POST',
        payload: { id: 123 },
        url: '/woocommerce/webhooks/orders'
      });
      expect(invalid.statusCode).toBe(401);
      expect(syncOrders).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('accepts valid order webhooks and syncs exactly one order', async () => {
    const syncOrders = vi.fn(() =>
      Promise.resolve({ sync: { created: 1, received: 1, unchanged: 0, updated: 0 } })
    );
    const app = await buildApp({
      wooCommerceWebhook: { orderSyncService: { syncOrders }, siteUrl: 'https://woo.example.test', webhookSecret: 'secret' }
    });
    const rawBody = JSON.stringify({ id: 123, number: '123', status: 'processing' });
    const signature = createHmac('sha256', 'secret').update(rawBody).digest('base64');

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
        url: '/woocommerce/webhooks/orders'
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: { received: 1, sync: { created: 1, received: 1, unchanged: 0, updated: 0 } },
        error: null
      });
      expect(syncOrders).toHaveBeenCalledWith({
        orders: [expect.objectContaining({ id: 123, number: '123' })],
        reason: 'webhook'
      });
    } finally {
      await app.close();
    }
  });
});
