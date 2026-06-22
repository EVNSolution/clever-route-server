import { readFile } from 'node:fs/promises';

import type { FastifyInstance } from 'fastify';

const OPENAPI_DOCUMENT_URL = new URL('../../docs/api/openapi.yaml', import.meta.url);
const DOCS_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'upgrade-insecure-requests'
].join(';');

export function registerApiDocsRoutes(app: FastifyInstance): void {
  app.get('/docs', (_request, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', DOCS_CSP)
      .send(renderDocsHtml());
  });

  app.get('/docs/openapi.yaml', async (_request, reply) => {
    const openApiDocument = await readFile(OPENAPI_DOCUMENT_URL, 'utf8');

    return reply
      .type('application/yaml; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(openApiDocument);
  });
}

function renderDocsHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CLEVER Delivery Server API Docs</title>
    <link rel="icon" href="data:," />
    <style>
      body { margin: 2rem; font-family: system-ui, sans-serif; line-height: 1.5; }
      a { color: #2563eb; font-weight: 700; }
    </style>
  </head>
  <body>
    <h1>CLEVER Delivery Server API Docs</h1>
    <p>Open the committed OpenAPI contract:</p>
    <p><a href="/docs/openapi.yaml">/docs/openapi.yaml</a></p>
  </body>
</html>`;
}
