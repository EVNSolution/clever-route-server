import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ShopifyWebhookDependencies } from '../src/routes/shopify-webhook.routes.js';

const rawPayload = JSON.stringify({ id: 123, name: '#1001' });
const clientSecret = 'shared-secret-456';

describe('Shopify webhook routes', () => {
  test('rejects webhook requests without a valid Shopify HMAC', async () => {
    const { dependencies, recordWebhook } = createDependencyHarness();
    const app = await buildApp({ shopifyWebhook: dependencies });

    try {
      const response = await app.inject({
        headers: webhookHeaders({ hmac: 'invalid-hmac' }),
        method: 'POST',
        payload: rawPayload,
        url: '/shopify/webhooks'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Invalid Shopify webhook HMAC' }
      });
      expect(recordWebhook).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('records a valid webhook receipt with normalized Shopify headers', async () => {
    const { dependencies, recordWebhook } = createDependencyHarness();
    const app = await buildApp({ shopifyWebhook: dependencies });

    try {
      const response = await app.inject({
        headers: webhookHeaders(),
        method: 'POST',
        payload: rawPayload,
        url: '/shopify/webhooks'
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: {
          duplicate: false,
          webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
        },
        error: null
      });
      expect(recordWebhook).toHaveBeenCalledWith({
        apiVersion: '2026-04',
        eventId: '98880550-7158-44d4-b7cd-2c97c8a091b5',
        payload: { id: 123, name: '#1001' },
        rawBody: rawPayload,
        shopDomain: 'example.myshopify.com',
        topic: 'orders/create',
        triggeredAt: new Date('2026-05-07T05:40:00.000Z'),
        webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
      });
    } finally {
      await app.close();
    }
  });

  test('reports duplicate webhook receipts idempotently', async () => {
    const { dependencies, recordWebhook } = createDependencyHarness();
    recordWebhook.mockResolvedValueOnce({
      duplicate: true,
      webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
    });
    const app = await buildApp({ shopifyWebhook: dependencies });

    try {
      const response = await app.inject({
        headers: webhookHeaders(),
        method: 'POST',
        payload: rawPayload,
        url: '/shopify/webhooks'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          duplicate: true,
          webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
        },
        error: null
      });
    } finally {
      await app.close();
    }
  });
});

function createDependencyHarness(): {
  dependencies: ShopifyWebhookDependencies;
  recordWebhook: ReturnType<typeof vi.fn<ShopifyWebhookDependencies['webhookService']['recordWebhook']>>;
} {
  const recordWebhook = vi.fn<ShopifyWebhookDependencies['webhookService']['recordWebhook']>(() =>
    Promise.resolve({
      duplicate: false,
      webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
    })
  );

  return {
    dependencies: {
      clientSecret,
      webhookService: {
        recordWebhook
      }
    },
    recordWebhook
  };
}

function webhookHeaders(overrides: { hmac?: string } = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-shopify-api-version': '2026-04',
    'x-shopify-event-id': '98880550-7158-44d4-b7cd-2c97c8a091b5',
    'x-shopify-hmac-sha256':
      overrides.hmac ?? createHmac('sha256', clientSecret).update(rawPayload).digest('base64'),
    'x-shopify-shop-domain': 'example.myshopify.com',
    'x-shopify-topic': 'orders/create',
    'x-shopify-triggered-at': '2026-05-07T05:40:00.000Z',
    'x-shopify-webhook-id': 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
  };
}
