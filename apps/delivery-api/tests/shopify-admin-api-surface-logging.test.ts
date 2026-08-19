import { describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';

type ShopifyAdminSurfaceLog = {
  appId: string;
  correlationId: string;
  durationMs: number;
  event: string;
  method: string;
  requestId: string;
  route: string;
  statusCode: number;
  surface: string;
};

describe('Shopify admin API surface request logging', () => {
  test('correlates app-facing request and response metadata without payloads', async () => {
    const logLines: string[] = [];
    const app = await buildApp({
      logger: {
        level: 'info',
        stream: { write: (line: string) => logLines.push(line) }
      }
    });

    try {
      const response = await app.inject({
        headers: {
          'x-clever-app-id': 'clever-route-dev',
          'x-clever-client-request-id': 'orders-resource-123'
        },
        method: 'GET',
        url: '/admin/orders/page?page=2&search=private'
      });
      await new Promise((resolve) => setImmediate(resolve));

      const logs = logLines
        .map((line) => JSON.parse(line) as Partial<ShopifyAdminSurfaceLog>)
        .filter((log): log is ShopifyAdminSurfaceLog => log.event === 'shopify_admin_api_surface_request');

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        appId: 'clever-route-dev',
        correlationId: 'orders-resource-123',
        method: 'GET',
        route: '/admin/orders/page',
        statusCode: response.statusCode,
        surface: 'orders'
      });
      expect(logs[0]?.requestId).toEqual(expect.any(String));
      expect(logs[0]?.durationMs).toEqual(expect.any(Number));
      expect(JSON.stringify(logs[0])).not.toContain('private');
      expect(JSON.stringify(logs[0])).not.toContain('payload');
    } finally {
      await app.close();
    }
  });
});
