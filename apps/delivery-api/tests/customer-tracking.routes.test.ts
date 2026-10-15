import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { customerTrackingToken, loadCustomerTrackingLinks } from '../src/modules/customer-tracking/customer-tracking-link.js';

const STOP_ID = '11111111-1111-4111-8111-111111111111';
const links = loadCustomerTrackingLinks({ DELIVERY_API_PUBLIC_URL: 'https://route.example.com', JWT_SECRET: 'secret' });

async function withApp(run: (app: Awaited<ReturnType<typeof buildApp>>, getStatus: ReturnType<typeof vi.fn>) => Promise<void>) {
  if (links === undefined) throw new Error('links should load');
  const webDistPath = await mkdtemp(join(tmpdir(), 'tracking-web-'));
  await mkdir(join(webDistPath, '.vite'));
  await writeFile(join(webDistPath, '.vite', 'manifest.json'), JSON.stringify({
    _maplibre: { css: ['assets/maplibre.css'], file: 'assets/maplibre.js' },
    'tracking.html': { css: ['assets/tracking.css'], file: 'assets/tracking.js', imports: ['_maplibre'] },
  }));
  const getStatus = vi.fn().mockImplementation((id: string) => Promise.resolve(id === STOP_ID ? { orderName: '#2368', stage: 'PREPARING' } : null));
  const app = await buildApp({
    customerTracking: {
      links,
      readMapConfig: () => ({
        allowedHosts: ['tiles.openfreemap.org'],
        attribution: null,
        providerMode: 'public_allowlisted',
        status: 'configured',
        styleAudit: null,
        styleUrl: '/admin/ui/app/vendor/style.json',
      }),
      service: { getStatus },
      webDistPath,
    },
  });
  try {
    await run(app, getStatus);
  } finally {
    await app.close();
    await rm(webDistPath, { force: true, recursive: true });
  }
}

describe('customer tracking routes', () => {
  test('serves the tracking shell and status for a valid signed token', async () => {
    await withApp(async (app) => {
      if (links === undefined) throw new Error('links should load');
      const token = customerTrackingToken(links, STOP_ID);

      const page = await app.inject({ method: 'GET', url: `/t/${token}` });
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['referrer-policy']).toBe('no-referrer');
      expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(page.headers['content-security-policy']).toContain('https://tiles.openfreemap.org');
      expect(page.body).toContain('<script type="module" src="/admin/ui/app/assets/tracking.js"></script>');
      expect(page.body).toMatch(/assets\/maplibre\.css">\s*<link rel="stylesheet" href="\/admin\/ui\/app\/assets\/tracking\.css">/u);
      expect(page.body).toContain('data-map-style="/admin/ui/app/vendor/style.json"');

      const status = await app.inject({ method: 'GET', url: `/t/${token}/status` });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ data: { orderName: '#2368', stage: 'PREPARING' } });
    });
  });

  test('returns 404 without touching data for an unsigned or tampered token', async () => {
    await withApp(async (app, getStatus) => {
      const page = await app.inject({ method: 'GET', url: `/t/${STOP_ID}.AAAAAAAAAAAAAAAAAAAAAA` });
      const status = await app.inject({ method: 'GET', url: `/t/${STOP_ID}/status` });

      expect(page.statusCode).toBe(404);
      expect(page.body).toContain('Tracking link not found');
      expect(status.statusCode).toBe(404);
      expect(status.json()).toEqual({ error: { code: 'TRACKING_LINK_NOT_FOUND' } });
      expect(getStatus).not.toHaveBeenCalled();
    });
  });
});
