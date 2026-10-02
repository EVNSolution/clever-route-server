import Fastify from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import { registerJsonBodyParser } from '../src/routes/json-body-parser.js';
import { registerDriverRuntimeDiagnosticsRoutes } from '../src/routes/driver-runtime-diagnostics.routes.js';
import { signDriverAccountToken, signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';

const now = new Date('2026-10-02T12:00:00Z');
const deviceInstanceHash = 'a'.repeat(64);
const accountId = '10000000-0000-4000-8000-000000000001';
const recordId = '10000000-0000-4000-8000-000000000002';
const routePlanId = '10000000-0000-4000-8000-000000000003';
const secret = 'diagnostic-route-test-secret-32bytes';

function envelope() {
  const context = { appVersion: '1.0.0', versionCode: 1, os: 'ANDROID', osVersion: '15', deviceInstanceHash, routePlanId, sessionGeneration: '1' };
  const snapshot = {
    snapshotObservedAt: now.toISOString(), lifecycle: 'FOREGROUND', network: 'ONLINE', locationPermission: 'GRANTED_ALWAYS',
    locationService: 'ENABLED', locationTask: 'STARTED', locationTaskExpected: true,
    stateObservedAt: Object.fromEntries(['lifecycle', 'network', 'locationPermission', 'locationService', 'locationTask'].map((key) => [key, now.toISOString()])),
    businessQueue: { queueDepth: 0, oldestQueuedAt: null, oldestAgeMs: null, retryCount: 0, nextRetryAt: null, observedAt: now.toISOString() },
    lastGpsCallbackAt: now.toISOString(), lastGpsCollectedAt: now.toISOString(), lastGpsPersistedAt: now.toISOString(),
    lastGpsSendAttemptAt: now.toISOString(), lastGpsSendAcknowledgedAt: now.toISOString()
  };
  return {
    schemaVersion: 1, batchId: recordId, bootId: recordId, sentAt: now.toISOString(), discardedRecordCount: 0,
    liveContext: context, liveSnapshot: snapshot,
    records: [{ diagnosticId: recordId, bootId: recordId, sequence: 1, observedAt: now.toISOString(), kind: 'HEARTBEAT', context, snapshot }]
  };
}

async function harness() {
  const credential = { id: recordId, deviceId: recordId, accountId, deviceInstanceHash, expiresAt: new Date(now.getTime() + 86400000) };
  const service = {
    register: vi.fn().mockResolvedValue({ token: 'opaque-diagnostic-token', expiresAt: credential.expiresAt }),
    authenticate: vi.fn().mockImplementation((token: string) => Promise.resolve(token === 'opaque-diagnostic-token' ? credential : null)),
    recordContact: vi.fn().mockResolvedValue(undefined), recordFailure: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue({ revokedCount: 1 }),
    ingest: vi.fn().mockResolvedValue({ acceptedDiagnosticIds: [recordId], rejectedDiagnostics: [], serverReceivedAt: now.toISOString() }),
    listForShop: vi.fn().mockResolvedValue({ devices: [] })
  };
  const sessionTokenVerifier = { verify: vi.fn().mockImplementation((token: string) => {
    if (token !== 'admin-session') throw new Error('invalid');
    return { appId: 'clever', shopDomain: 'tenant-a.example', subject: 'operator' };
  }) };
  const logs: string[] = [];
  const app = Fastify({ logger: { level: 'warn', stream: { write: (value: string) => { logs.push(value); } } } });
  registerJsonBodyParser(app);
  await registerDriverRuntimeDiagnosticsRoutes(app, { service, jwtSecret: secret, sessionTokenVerifier, now: () => now });
  await app.ready();
  return { app, service, credential, sessionTokenVerifier, logs };
}

function accountToken() {
  return signDriverAccountToken({ accountId, tokenVersion: 2, expiresInSeconds: 60, subject: `driver-account:${accountId}` }, { secret }).token;
}

describe('driver runtime diagnostic HTTP boundary', () => {
  test('registration uses active account authorization and exact top-level mobile response', async () => {
    const { app, service } = await harness();
    try {
      const response = await app.inject({ method: 'POST', url: '/driver/sync-health/registrations', headers: { authorization: `Bearer ${accountToken()}` }, payload: { schemaVersion: 1, deviceInstanceHash } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ token: 'opaque-diagnostic-token', expiresAt: new Date(now.getTime() + 86400000).toISOString() });
      expect(service.register).toHaveBeenCalledWith({ accountId, tokenVersion: 2, deviceInstanceHash });
    } finally { await app.close(); }
  });

  test('a route or diagnostic bearer cannot mint another diagnostic credential', async () => {
    const { app, service } = await harness();
    const routeToken = signDriverRouteToken({ accountId, routePlanId, tokenVersion: 2, expiresInSeconds: 60, subject: `driver-account:${accountId}` }, { secret }).token;
    try {
      for (const token of [routeToken, 'opaque-diagnostic-token']) {
        const response = await app.inject({ method: 'POST', url: '/driver/sync-health/registrations', headers: { authorization: `Bearer ${token}` }, payload: { schemaVersion: 1, deviceInstanceHash } });
        expect(response.statusCode).toBe(401);
      }
      expect(service.register).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('cached diagnostic credential accepts contact before parsing without a business bearer', async () => {
    const { app, service, credential } = await harness();
    try {
      const response = await app.inject({ method: 'POST', url: '/driver/sync-health/diagnostics', headers: { authorization: 'Bearer opaque-diagnostic-token' }, payload: envelope() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ acceptedDiagnosticIds: [recordId], serverReceivedAt: now.toISOString() });
      expect(service.recordContact).toHaveBeenCalledWith(credential);
      expect(service.recordContact.mock.invocationCallOrder[0]).toBeLessThan(service.ingest.mock.invocationCallOrder[0]!);
      expect(service.register).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('malformed authenticated JSON records contact and stable failure without raw content', async () => {
    const { app, service, credential, logs } = await harness();
    try {
      const response = await app.inject({ method: 'POST', url: '/driver/sync-health/diagnostics', headers: { authorization: 'Bearer opaque-diagnostic-token', 'content-type': 'application/json' }, payload: '{"token":"private-payload-secret"' });
      expect(response.statusCode).toBe(400);
      expect(service.recordContact).toHaveBeenCalledWith(credential);
      expect(service.recordFailure).toHaveBeenCalledWith(credential, 'INVALID_JSON');
      expect(service.ingest).not.toHaveBeenCalled();
      expect(logs.join('')).not.toContain('private-payload-secret');
    } finally { await app.close(); }
  });

  test('rejected or expired diagnostic tokens consistently use 401 and record no attributed contact', async () => {
    const { app, service } = await harness();
    try {
      const response = await app.inject({ method: 'POST', url: '/driver/sync-health/diagnostics', headers: { authorization: 'Bearer expired-token' }, payload: envelope() });
      expect(response.statusCode).toBe(401);
      expect(service.recordContact).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('storage failure never returns accepted IDs or raw database errors', async () => {
    const { app, service, logs } = await harness();
    service.ingest.mockRejectedValueOnce(new Error('password=private-db-secret'));
    try {
      const response = await app.inject({ method: 'POST', url: '/driver/sync-health/diagnostics', headers: { authorization: 'Bearer opaque-diagnostic-token' }, payload: envelope() });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: { code: 'DIAGNOSTIC_STORAGE_UNAVAILABLE' } });
      expect(logs.join('')).not.toContain('private-db-secret');
    } finally { await app.close(); }
  });

  test('invalid records receive explicit rejection while valid persistence ACK is preserved', async () => {
    const { app, service } = await harness();
    const payload = envelope();
    payload.records[0]!.kind = 'UNKNOWN_KIND';
    service.ingest.mockResolvedValueOnce({ acceptedDiagnosticIds: [], rejectedDiagnostics: [], serverReceivedAt: now.toISOString() });
    try {
      const response = await app.inject({ method: 'POST', url: '/driver/sync-health/diagnostics', headers: { authorization: 'Bearer opaque-diagnostic-token' }, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ acceptedDiagnosticIds: [], rejectedDiagnostics: [{ diagnosticId: recordId, code: 'INVALID_RECORD' }] });
      expect(service.ingest.mock.calls[0]?.[1]).toMatchObject({ records: [] });
    } finally { await app.close(); }
  });

  test('read access requires tenant admin identity and derives scope from the verified session', async () => {
    const { app, service } = await harness();
    try {
      const denied = await app.inject({ method: 'GET', url: '/admin/drivers/runtime-diagnostics', headers: { authorization: 'Bearer opaque-diagnostic-token' } });
      expect(denied.statusCode).toBe(401);
      expect(service.listForShop).not.toHaveBeenCalled();
      const allowed = await app.inject({ method: 'GET', url: `/admin/drivers/runtime-diagnostics?routePlanId=${routePlanId}&shopDomain=other.example`, headers: { authorization: 'Bearer admin-session' } });
      expect(allowed.statusCode).toBe(200);
      expect(service.listForShop).toHaveBeenCalledWith({ appId: 'clever', shopDomain: 'tenant-a.example', routePlanId });
      expect(allowed.json()).toMatchObject({ data: { timeZone: 'America/Toronto', devices: [] } });
    } finally { await app.close(); }
  });
  test('random invalid credentials are limited before authentication database work', async () => {
    const { app, service } = await harness();
    try {
      for (let index = 0; index < 120; index += 1) {
        const response = await app.inject({ method: 'POST', url: '/driver/sync-health/diagnostics', headers: { authorization: `Bearer invalid-${index}` }, payload: envelope() });
        expect(response.statusCode).toBe(401);
      }
      const blocked = await app.inject({ method: 'POST', url: '/driver/sync-health/diagnostics', headers: { authorization: 'Bearer next-invalid' }, payload: envelope() });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: { code: 'RATE_LIMITED' } });
      expect(service.authenticate).toHaveBeenCalledTimes(120);
      expect(service.recordContact).not.toHaveBeenCalled();
      expect(service.recordFailure).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('per-device limits precede contact and failure writes', async () => {
    const { app, service } = await harness();
    try {
      for (let index = 0; index < 60; index += 1) {
        const response = await app.inject({ method: 'POST', url: '/driver/sync-health/diagnostics', headers: { authorization: 'Bearer opaque-diagnostic-token' }, payload: envelope() });
        expect(response.statusCode).toBe(200);
      }
      const blocked = await app.inject({ method: 'POST', url: '/driver/sync-health/diagnostics', headers: { authorization: 'Bearer opaque-diagnostic-token' }, payload: envelope() });
      expect(blocked.statusCode).toBe(429);
      expect(service.recordContact).toHaveBeenCalledTimes(60);
      expect(service.ingest).toHaveBeenCalledTimes(60);
      expect(service.recordFailure).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test.each([{ method: 'DELETE' as const, url: '/driver/sync-health/registrations', limit: 20 }, { method: 'GET' as const, url: '/admin/drivers/runtime-diagnostics', limit: 30 }])('protects $method $url before unauthorized work', async ({ method, url, limit }) => {
    const { app, service } = await harness();
    try {
      for (let index = 0; index < limit; index += 1) expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect((await app.inject({ method, url })).statusCode).toBe(429);
      expect(service.revoke).not.toHaveBeenCalled();
      expect(service.listForShop).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

});
