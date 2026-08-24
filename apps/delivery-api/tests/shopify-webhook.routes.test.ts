import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ShopifyWebhookDependencies } from '../src/routes/shopify-webhook.routes.js';

const rawPayload = JSON.stringify({ id: 123, name: '#1001' });
const clientSecret = 'shared-secret-456';
const devClientSecret = 'dev-secret-789';

describe('Shopify webhook routes', () => {
  test.each([
    ['valid HMAC', undefined],
    ['invalid HMAC', 'invalid-hmac'],
    ['missing HMAC', null]
  ])('rejects malformed JSON before admission with %s', async (_label, hmac) => {
    const malformedBody = '{"id":1,"email":"private-customer@example.invalid"';
    const { dependencies, recordWebhook } = createDependencyHarness();
    const logLines: string[] = [];
    const app = await buildApp({
      logger: {
        level: 'warn',
        stream: { write: (line: string) => logLines.push(line) }
      },
      shopifyWebhook: dependencies
    });

    try {
      const response = await app.inject({
        headers: webhookHeaders({ hmac, rawBody: malformedBody }),
        method: 'POST',
        payload: malformedBody,
        url: '/shopify/webhooks'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' }
      });
      expect(recordWebhook).not.toHaveBeenCalled();

      const invalidJsonLog = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line.event === 'invalid_json_request_rejected');
      expect(invalidJsonLog).toMatchObject({
        event: 'invalid_json_request_rejected',
        route: '/shopify/webhooks'
      });
      expect(logLines.join('\n')).not.toContain(malformedBody);
      expect(logLines.join('\n')).not.toContain('private-customer@example.invalid');
      expect(logLines.join('\n')).not.toContain('SyntaxError');
      expect(logLines.join('\n')).not.toContain('stack');
    } finally {
      await app.close();
    }
  });

  test('admits a valid signed 1.1 MiB webhook under the Shopify-compatible route limit', async () => {
    const largeBody = JSON.stringify({ id: 123, padding: 'x'.repeat(1_100_000) });
    const { dependencies, recordWebhook } = createDependencyHarness();
    const app = await buildApp({ shopifyWebhook: dependencies });

    try {
      const response = await app.inject({
        headers: webhookHeaders({ rawBody: largeBody }),
        method: 'POST',
        payload: largeBody,
        url: '/shopify/webhooks'
      });

      expect(response.statusCode).toBe(202);
      expect(recordWebhook).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test('rejects JSON above 5 MiB with 413 before admission', async () => {
    const oversizedBody = JSON.stringify({ id: 123, padding: 'x'.repeat(5 * 1024 * 1024) });
    const { dependencies, recordWebhook } = createDependencyHarness();
    const app = await buildApp({ shopifyWebhook: dependencies });

    try {
      const response = await app.inject({
        headers: webhookHeaders({ rawBody: oversizedBody }),
        method: 'POST',
        payload: oversizedBody,
        url: '/shopify/webhooks'
      });

      expect(response.statusCode).toBe(413);
      expect(recordWebhook).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

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
          queued: false,
          status: 'QUEUED',
          webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
        },
        error: null
      });
      expect(recordWebhook).toHaveBeenCalledWith({
        appId: 'clever',
        apiVersion: '2026-04',
        eventId: '98880550-7158-44d4-b7cd-2c97c8a091b5',
        payload: { id: 123, name: '#1001' },
        rawBody: rawPayload,
        shopDomain: 'clever-route-test.myshopify.com',
        topic: 'orders/create',
        triggeredAt: new Date('2026-05-07T05:40:00.000Z'),
        webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
      });
    } finally {
      await app.close();
    }
  });

  test('records the app id for the Shopify credential whose webhook secret matches', async () => {
    const { dependencies, recordWebhook } = createDependencyHarness({
      appCredentials: [
        { appId: 'clever', clientSecret },
        { appId: 'clever-route-dev', clientSecret: devClientSecret }
      ]
    });
    const app = await buildApp({ shopifyWebhook: dependencies });

    try {
      const response = await app.inject({
        headers: webhookHeaders({
          hmac: createHmac('sha256', devClientSecret).update(rawPayload).digest('base64')
        }),
        method: 'POST',
        payload: rawPayload,
        url: '/shopify/webhooks'
      });

      expect(response.statusCode).toBe(202);
      expect(recordWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'clever-route-dev',
          shopDomain: 'clever-route-test.myshopify.com',
          webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
        })
      );
    } finally {
      await app.close();
    }
  });

  test('queues order topics after recording the receipt without inline processing', async () => {
    const { dependencies, recordWebhook } = createDependencyHarness();
    dependencies.orderWebhookProcessor = {
      canProcessTopic: (topic) => topic === 'orders/create'
    };
    const app = await buildApp({ shopifyWebhook: dependencies });

    try {
      const response = await app.inject({
        headers: webhookHeaders(),
        method: 'POST',
        payload: rawPayload,
        url: '/shopify/webhooks'
      });

      expect(response.statusCode).toBe(202);
      expect(recordWebhook).toHaveBeenCalledOnce();
      expect(response.json()).toEqual({
        data: {
          duplicate: false,
          queued: true,
          status: 'QUEUED',
          webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
        },
        error: null
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
          queued: false,
          status: 'DUPLICATE',
          webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
        },
        error: null
      });
    } finally {
      await app.close();
    }
  });

  test('acknowledges terminal redaction suppression with a successful non-queued receipt', async () => {
    const { dependencies, recordWebhook } = createDependencyHarness();
    recordWebhook.mockResolvedValueOnce({
      duplicate: false,
      status: 'IGNORED',
      webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd044'
    });
    const app = await buildApp({ shopifyWebhook: dependencies });

    try {
      const response = await app.inject({
        headers: { ...webhookHeaders(), 'x-shopify-topic': 'shop/redact' },
        method: 'POST',
        payload: rawPayload,
        url: '/shopify/webhooks'
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: { duplicate: false, queued: false, status: 'IGNORED' },
        error: null
      });
    } finally {
      await app.close();
    }
  });
});

function createDependencyHarness(input: {
  appCredentials?: ShopifyWebhookDependencies['appCredentials'];
} = {}): {
  dependencies: ShopifyWebhookDependencies;
  recordWebhook: ReturnType<typeof vi.fn<ShopifyWebhookDependencies['webhookService']['recordWebhook']>>;
} {
  const recordWebhook = vi.fn<ShopifyWebhookDependencies['webhookService']['recordWebhook']>(() =>
    Promise.resolve({
      duplicate: false,
      status: 'QUEUED',
      webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
    })
  );

  return {
    dependencies: {
      appCredentials: input.appCredentials ?? [{ appId: 'clever', clientSecret }],
      webhookService: {
        recordWebhook
      }
    },
    recordWebhook
  };
}

function webhookHeaders(overrides: { hmac?: string | null | undefined; rawBody?: string } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-shopify-api-version': '2026-04',
    'x-shopify-event-id': '98880550-7158-44d4-b7cd-2c97c8a091b5',
    'x-shopify-hmac-sha256':
      overrides.hmac ?? createHmac('sha256', clientSecret).update(overrides.rawBody ?? rawPayload).digest('base64'),
    'x-shopify-shop-domain': 'clever-route-test.myshopify.com',
    'x-shopify-topic': 'orders/create',
    'x-shopify-triggered-at': '2026-05-07T05:40:00.000Z',
    'x-shopify-webhook-id': 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043'
  };

  if (overrides.hmac === null) {
    delete headers['x-shopify-hmac-sha256'];
  }
  return headers;
}
