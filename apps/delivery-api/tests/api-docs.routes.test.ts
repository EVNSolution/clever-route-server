import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';

describe('API documentation routes', () => {
  test('GET /docs serves a minimal page pointing at the deployed OpenAPI document', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/docs' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('CLEVER Delivery Server API Docs');
      expect(response.body).toContain('/docs/openapi.yaml');
      expect(response.body).toContain('rel="icon" href="data:,"');
    } finally {
      await app.close();
    }
  });

  test('GET /docs does not load scripts or third-party assets', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/docs' });
      const csp = String(response.headers['content-security-policy']);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('/docs/openapi.yaml');
      expect(response.body).not.toContain('/docs/swagger-ui/');
      expect(response.body).not.toContain('cdn.jsdelivr.net');
      expect(response.body).not.toMatch(/<script[\s>]/u);
      expect(csp).toContain("script-src 'none'");
      expect(csp).not.toContain('cdn.jsdelivr.net');
    } finally {
      await app.close();
    }
  });

  test('public docs exposure is backed by a sanitized review and omits private operator material', async () => {
    const app = await buildApp();
    const review = await readFile(
      new URL('../../../docs/security/public-docs-sanitized-review.md', import.meta.url),
      'utf8'
    );
    const openApiDocument = await readFile(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8');

    try {
      const response = await app.inject({ method: 'GET', url: '/docs' });
      const publishedDocs = [response.body, openApiDocument].join('\n--- openapi ---\n');

      expect(response.statusCode).toBe(200);
      expect(review).toContain('Status: approved');
      expect(review).toContain('protect `/docs`');
      expect(review).toContain('query-string credential examples');
      expect(publishedDocs).not.toMatch(
        /CLEVER_ADMIN_API_TOKEN|DELIVERY_API_PUBLIC_URL|consumerSecret|consumer_secret|consumerKey|consumer_key|webhookSecret|webhook_secret/u
      );
      expect(publishedDocs).not.toMatch(/curl -sS|docker compose|Route53|Caddy|admin\.cleversystem\.ai|apps\/admin-web/u);
      expect(publishedDocs).not.toMatch(/sk_live_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/u);
    } finally {
      await app.close();
    }
  });

  test('GET /docs/openapi.yaml serves the committed OpenAPI contract', async () => {
    const app = await buildApp();
    const expected = await readFile(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8');

    try {
      const response = await app.inject({ method: 'GET', url: '/docs/openapi.yaml' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('yaml');
      expect(response.body).toBe(expected);
    } finally {
      await app.close();
    }
  });
});
