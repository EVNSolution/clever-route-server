import { describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';

type DsvSurfaceLog = {
  callerSurface: string;
  durationMs: number;
  event: string;
  legacyCategory: string;
  method: string;
  path: string;
  requestId: string;
  route: string;
  statusCode: number;
};

describe('G007 DSV API surface request logging', () => {
  test('classifies v1 reads with machine-readable request metadata', async () => {
    const { app, logLines } = await createLoggedApp();
    try {
      const response = await app.inject({
        headers: { 'x-caller-surface': 'local-remote-fixture-e2e' },
        method: 'GET',
        url: '/api/dsv/v1/dispatches?serviceDate=2026-07-23&limit=25',
      });

      const log = expectDsvSurfaceLog(logLines);
      expect(log).toMatchObject({
        callerSurface: 'local-remote-fixture-e2e',
        event: 'dsv_api_surface_request',
        legacyCategory: 'v1_read',
        method: 'GET',
        path: '/api/dsv/v1/dispatches?serviceDate=2026-07-23&limit=25',
        route: '/api/dsv/v1/dispatches',
        statusCode: response.statusCode,
      });
      expect(log.requestId).toEqual(expect.any(String));
      expect(log.durationMs).toEqual(expect.any(Number));
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
