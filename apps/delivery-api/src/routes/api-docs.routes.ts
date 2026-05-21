import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import type { FastifyInstance } from 'fastify';

const OPENAPI_DOCUMENT_URL = new URL('../../docs/api/openapi.yaml', import.meta.url);
const require = createRequire(import.meta.url);
const SWAGGER_UI_STYLESHEET_URL = new URL(
  require.resolve('swagger-ui-dist/swagger-ui.css'),
  import.meta.url
);
const SWAGGER_UI_BUNDLE_URL = new URL(
  require.resolve('swagger-ui-dist/swagger-ui-bundle.js'),
  import.meta.url
);
const SWAGGER_UI_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  'upgrade-insecure-requests'
].join(';');

export function registerApiDocsRoutes(app: FastifyInstance): void {
  app.get('/docs', (_request, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', SWAGGER_UI_CSP)
      .send(renderSwaggerUiHtml());
  });

  app.get('/docs/swagger-ui/swagger-ui.css', async (_request, reply) => {
    const stylesheet = await readFile(SWAGGER_UI_STYLESHEET_URL, 'utf8');

    return reply
      .type('text/css; charset=utf-8')
      .header('Cache-Control', 'public, max-age=604800, immutable')
      .send(stylesheet);
  });

  app.get('/docs/swagger-ui/swagger-ui-bundle.js', async (_request, reply) => {
    const bundle = await readFile(SWAGGER_UI_BUNDLE_URL, 'utf8');

    return reply
      .type('application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=604800, immutable')
      .send(bundle);
  });

  app.get('/docs/swagger-ui/init.js', (_request, reply) => {
    return reply
      .type('application/javascript; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(renderSwaggerUiInitScript());
  });

  app.get('/docs/openapi.yaml', async (_request, reply) => {
    const openApiDocument = await readFile(OPENAPI_DOCUMENT_URL, 'utf8');

    return reply
      .type('application/yaml; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(openApiDocument);
  });
}

function renderSwaggerUiHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CLEVER Delivery Server API Docs</title>
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/docs/swagger-ui/swagger-ui.css" />
    <style>
      body { margin: 0; background: #ffffff; }
      .topbar { display: none; }
    </style>
  </head>
  <body>
    <noscript>
      JavaScript is required for the interactive Swagger UI. The raw OpenAPI document is available at
      <a href="/docs/openapi.yaml">/docs/openapi.yaml</a>.
    </noscript>
    <div id="swagger-ui">
      Loading CLEVER Delivery Server API docs. If this does not appear, open the raw
      <a href="/docs/openapi.yaml">OpenAPI YAML</a>.
    </div>
    <script src="/docs/swagger-ui/swagger-ui-bundle.js"></script>
    <script src="/docs/swagger-ui/init.js"></script>
  </body>
</html>`;
}

function renderSwaggerUiInitScript(): string {
  return `window.ui = SwaggerUIBundle({
  url: '/docs/openapi.yaml',
  dom_id: '#swagger-ui',
  deepLinking: true,
  presets: [SwaggerUIBundle.presets.apis],
  layout: 'BaseLayout'
});
`;
}
