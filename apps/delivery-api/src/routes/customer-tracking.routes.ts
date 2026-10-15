import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';

import { readCustomerTrackingToken, type CustomerTrackingLinks } from '../modules/customer-tracking/customer-tracking-link.js';
import type { CustomerTrackingService } from '../modules/customer-tracking/customer-tracking.service.js';
import { escapeHtml } from './admin-ui-shell-rendering.js';
import { buildRouteOpsCsp } from './admin-ui-route-planning.js';

type MapConfig = Parameters<typeof buildRouteOpsCsp>[0];

export type CustomerTrackingDependencies = {
  links: CustomerTrackingLinks;
  readMapConfig: () => MapConfig;
  service: Pick<CustomerTrackingService, 'getStatus'>;
  webDistPath: string;
};

const ROUTE_OPS_ASSET_BASE = '/admin/ui/app';
const NOT_FOUND_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tracking link not found</title></head><body><main><h1>Tracking link not found</h1><p>This link is invalid or has expired.</p></main></body></html>';

export function registerCustomerTrackingRoutes(app: FastifyInstance, dependencies: CustomerTrackingDependencies): void {
  app.get<{ Params: { token: string } }>('/t/:token', async (request, reply) => {
    applyPublicHeaders(reply);
    const status = await readStatus(dependencies, request.params.token);
    if (status === null) return reply.code(404).type('text/html; charset=utf-8').send(NOT_FOUND_HTML);
    const mapConfig = dependencies.readMapConfig();
    return reply
      .code(200)
      .header('Content-Security-Policy', buildRouteOpsCsp(mapConfig))
      .type('text/html; charset=utf-8')
      .send(renderShell(dependencies.webDistPath, mapConfig.status === 'configured' ? mapConfig.styleUrl : null));
  });

  app.get<{ Params: { token: string } }>('/t/:token/status', async (request, reply) => {
    applyPublicHeaders(reply);
    const status = await readStatus(dependencies, request.params.token);
    if (status === null) return reply.code(404).send({ error: { code: 'TRACKING_LINK_NOT_FOUND' } });
    return reply.code(200).send({ data: status });
  });
}

async function readStatus(dependencies: CustomerTrackingDependencies, token: string) {
  const deliveryStopId = readCustomerTrackingToken(dependencies.links, token);
  return deliveryStopId === null ? null : dependencies.service.getStatus(deliveryStopId);
}

function applyPublicHeaders(reply: FastifyReply): void {
  reply
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Robots-Tag', 'noindex, nofollow');
}

function renderShell(webDistPath: string, mapStyleUrl: string | null): string {
  const assets = readTrackingAssets(webDistPath);
  const css = assets.css.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('\n    ');
  const script = assets.entry === null ? '' : `<script type="module" src="${escapeHtml(assets.entry)}"></script>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Track your delivery</title>
    ${css}
  </head>
  <body>
    <div id="customer-tracking-root" data-map-style="${escapeHtml(mapStyleUrl ?? '')}">
      <noscript>Tracking needs JavaScript.</noscript>
    </div>
    ${script}
  </body>
</html>`;
}

type ManifestChunk = { css?: string[]; file?: string; imports?: string[] };

// Statically imported chunks (MapLibre) carry their own CSS; the shell must link it too.
function collectCss(manifest: Record<string, ManifestChunk>, key: string, seen: Set<string>): string[] {
  if (seen.has(key)) return [];
  seen.add(key);
  const chunk = manifest[key];
  if (chunk === undefined) return [];
  return [...(chunk.imports ?? []).flatMap((child) => collectCss(manifest, child, seen)), ...(chunk.css ?? [])];
}

function readTrackingAssets(webDistPath: string): { css: string[]; entry: string | null } {
  const manifestPath = join(webDistPath, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) return { css: [], entry: null };
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, ManifestChunk>;
    const entry = manifest['tracking.html'];
    return {
      css: collectCss(manifest, 'tracking.html', new Set()).map((asset) => `${ROUTE_OPS_ASSET_BASE}/${asset}`),
      entry: typeof entry?.file === 'string' ? `${ROUTE_OPS_ASSET_BASE}/${entry.file}` : null,
    };
  } catch {
    return { css: [], entry: null };
  }
}
