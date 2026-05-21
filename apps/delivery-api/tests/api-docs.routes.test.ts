import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';

describe('API documentation routes', () => {
  test('GET /docs serves a Swagger UI page pointing at the deployed OpenAPI document', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/docs' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('CLEVER Delivery Server API Docs');
      expect(response.body).toContain('/docs/openapi.yaml');
      expect(response.body).toContain('/docs/swagger-ui/swagger-ui-bundle.js');
      expect(response.body).toContain('rel="icon" href="data:,"');
    } finally {
      await app.close();
    }
  });

  test('GET /docs uses same-origin Swagger UI assets instead of a public CDN', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/docs' });
      const csp = String(response.headers['content-security-policy']);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('/docs/swagger-ui/swagger-ui.css');
      expect(response.body).toContain('/docs/swagger-ui/swagger-ui-bundle.js');
      expect(response.body).toContain('/docs/swagger-ui/init.js');
      expect(response.body).not.toContain('cdn.jsdelivr.net');
      expect(response.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain('cdn.jsdelivr.net');
    } finally {
      await app.close();
    }
  });

  test('GET /docs/swagger-ui assets are served by the API server', async () => {
    const app = await buildApp();

    try {
      const css = await app.inject({ method: 'GET', url: '/docs/swagger-ui/swagger-ui.css' });
      const js = await app.inject({ method: 'GET', url: '/docs/swagger-ui/swagger-ui-bundle.js' });
      const init = await app.inject({ method: 'GET', url: '/docs/swagger-ui/init.js' });

      expect(css.statusCode).toBe(200);
      expect(css.headers['content-type']).toContain('text/css');
      expect(css.body).toContain('swagger-ui');
      expect(js.statusCode).toBe(200);
      expect(js.headers['content-type']).toContain('javascript');
      expect(js.body).toContain('SwaggerUIBundle');
      expect(init.statusCode).toBe(200);
      expect(init.headers['content-type']).toContain('javascript');
      expect(init.body).toContain("url: '/docs/openapi.yaml'");
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
