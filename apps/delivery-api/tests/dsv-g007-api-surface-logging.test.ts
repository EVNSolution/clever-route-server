import { describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';

type DsvSurfaceLog = {
  attemptId?: string;
  callerSurface: string;
  durationMs: number;
  event: string;
  legacyCategory: string;
  loadId?: string;
  method: string;
  path: string;
  requestId: string;
  route: string;
  statusCode: number;
};

describe('G007 DSV API surface request logging', () => {
  test('correlates only dispatch workspace list reads and removes their query strings', async () => {
    const { app, logLines } = await createLoggedApp();
    const loadId = '11111111-1111-4111-8111-111111111111';
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const paths = [
      '/api/dsv/v1/dispatches?serviceDate=2026-07-23&destinationName=Private%20Customer&orderNumber=SECRET-1',
      '/api/dsv/v1/drivers?limit=100',
      '/api/dsv/v1/vehicles?limit=100',
      '/api/dsv/v1/customers?cursor=private-customer-cursor',
      '/api/dsv/v1/destinations?cursor=private-destination-cursor',
    ];
    try {
      for (const url of paths) {
        const response = await app.inject({
          headers: {
            'x-caller-surface': 'dsv-dispatch',
            'x-dsv-attempt-id': attemptId,
            'x-dsv-load-id': loadId,
          },
          method: 'GET',
          url,
        });
        expect(response.statusCode).toBe(200);
      }

      const logs = dsvSurfaceLogs(logLines);
      expect(logs).toHaveLength(5);
      expect(logs.map((log) => log.path)).toEqual(paths.map((path) => path.split('?')[0]));
      for (const log of logs) {
        expect(log).toMatchObject({
          attemptId,
          callerSurface: 'dsv-dispatch',
          event: 'dsv_api_surface_request',
          legacyCategory: 'v1_read',
          loadId,
          method: 'GET',
          statusCode: 200,
        });
        expect(log.requestId).toEqual(expect.any(String));
        expect(log.durationMs).toEqual(expect.any(Number));
      }

      const serializedLogs = logLines.join('\n');
      for (const privateValue of [
        'Private Customer',
        'Private%20Customer',
        'SECRET-1',
        'private-customer-cursor',
        'private-destination-cursor',
      ]) {
        expect(serializedLogs).not.toContain(privateValue);
      }
    } finally {
      await app.close();
    }
  });

  test('omits missing or invalid diagnostic headers without changing GET behavior', async () => {
    const { app, logLines } = await createLoggedApp();
    try {
      const withoutHeaders = await app.inject({ method: 'GET', url: '/api/dsv/v1/drivers?limit=100' });
      const invalidHeaders = await app.inject({
        headers: {
          'x-caller-surface': 'dsv-dispatch',
          'x-dsv-attempt-id': 'not-a-uuid',
          'x-dsv-load-id': '11111111-1111-1111-8111-111111111111',
        },
        method: 'GET',
        url: '/api/dsv/v1/destinations?limit=100',
      });

      expect(withoutHeaders.statusCode).toBe(200);
      expect(invalidHeaders.statusCode).toBe(200);
      const logs = dsvSurfaceLogs(logLines);
      expect(logs).toHaveLength(2);
      expect(logs.every((log) => !Object.hasOwn(log, 'loadId') && !Object.hasOwn(log, 'attemptId'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('does not attach dispatch correlation to other DSV reads and keeps existing classification', async () => {
    const { app, logLines } = await createLoggedApp();
    try {
      const response = await app.inject({
        headers: {
          'x-dsv-attempt-id': '22222222-2222-4222-8222-222222222222',
          'x-dsv-load-id': '11111111-1111-4111-8111-111111111111',
        },
        method: 'GET',
        url: '/api/dsv/v1/control?serviceDate=2026-07-23',
      });

      expect(response.statusCode).toBe(200);
      const log = expectDsvSurfaceLog(logLines);
      expect(log).toMatchObject({
        callerSurface: 'unknown',
        legacyCategory: 'v1_read',
        path: '/api/dsv/v1/control?serviceDate=2026-07-23',
        route: '/api/dsv/v1/control',
        statusCode: 200,
      });
      expect(log).not.toHaveProperty('loadId');
      expect(log).not.toHaveProperty('attemptId');
    } finally {
      await app.close();
    }
  });

  test('removes diagnostic query strings from generic request logging without classifying the POST as a read', async () => {
    const { app, logLines } = await createLoggedApp();
    try {
      const response = await app.inject({
        method: 'POST',
        payload: {},
        url: '/api/dsv/v1/diagnostics/dispatch-load?destinationName=Private%20Customer',
      });

      expect(response.statusCode).toBe(200);
      expect(dsvSurfaceLogs(logLines)).toHaveLength(0);
      const incoming = logLines
        .map((line) => JSON.parse(line) as { msg?: string; req?: { url?: string } })
        .find((record) => record.msg === 'incoming request');
      expect(incoming?.req?.url).toBe('/api/dsv/v1/diagnostics/dispatch-load');
      expect(logLines.join('\n')).not.toContain('Private');
    } finally {
      await app.close();
    }
  });

  test('classifies only supported SellerOrder assignment command aliases as alias usage', async () => {
    const { app, logLines } = await createLoggedApp();
    try {
      await app.inject({
        method: 'POST',
        payload: {},
        url: '/api/dsv/seller-orders/11111111-1111-4111-8111-111111111111/assignment/reassign',
      });

      const log = expectDsvSurfaceLog(logLines);
      expect(log).toMatchObject({
        callerSurface: 'unknown',
        event: 'dsv_api_surface_request',
        legacyCategory: 'canonical_assignment_command_alias',
        method: 'POST',
        path: '/api/dsv/seller-orders/11111111-1111-4111-8111-111111111111/assignment/reassign',
        route: '/api/dsv/seller-orders/:sellerOrderId/assignment/reassign',
      });
    } finally {
      await app.close();
    }
  });

  test('classifies legacy reads and writes separately without logging unrelated requests', async () => {
    const { app, logLines } = await createLoggedApp();
    try {
      await app.inject({ method: 'GET', url: '/healthz' });
      await app.inject({ method: 'GET', url: '/api/dsv/conditions' });
      await app.inject({ method: 'POST', payload: {}, url: '/api/dsv/dispatch-imports' });

      const logs = dsvSurfaceLogs(logLines);
      expect(logs).toHaveLength(2);
      expect(logs.map((log) => log.legacyCategory)).toEqual(['legacy_read', 'legacy_write']);
      expect(logs.map((log) => `${log.method} ${log.route}`)).toEqual([
        'GET /api/dsv/conditions',
        'POST /api/dsv/dispatch-imports',
      ]);
      expect(logs.every((log) => log.event === 'dsv_api_surface_request')).toBe(true);
    } finally {
      await app.close();
    }
  });
});

async function createLoggedApp(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  logLines: string[];
}> {
  const logLines: string[] = [];
  const app = await buildApp({
    logger: {
      level: 'info',
      stream: { write: (line: string) => logLines.push(line) },
    },
  });
  for (const path of [
    '/api/dsv/v1/control',
    '/api/dsv/v1/dispatches',
    '/api/dsv/v1/drivers',
    '/api/dsv/v1/vehicles',
    '/api/dsv/v1/customers',
    '/api/dsv/v1/destinations',
  ]) {
    app.get(path, () => ({ data: null, error: null }));
  }
  app.post('/api/dsv/v1/diagnostics/dispatch-load', () => ({ data: null, error: null }));
  return { app, logLines };
}

function expectDsvSurfaceLog(logLines: string[]): DsvSurfaceLog {
  const logs = dsvSurfaceLogs(logLines);
  expect(logs).toHaveLength(1);
  return logs[0]!;
}

function dsvSurfaceLogs(logLines: string[]): DsvSurfaceLog[] {
  return logLines
    .map((line) => JSON.parse(line) as Partial<DsvSurfaceLog>)
    .filter((log): log is DsvSurfaceLog => log.event === 'dsv_api_surface_request');
}
