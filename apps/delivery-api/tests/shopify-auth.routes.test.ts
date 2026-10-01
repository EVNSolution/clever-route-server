import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { ShopifyTokenBrokerVerifier } from '../src/modules/shopify/token-broker-auth.js';
import type { ShopifyAuthDependencies } from '../src/routes/shopify-auth.routes.js';

const now = new Date('2026-05-07T01:00:00.000Z');
const installedAt = new Date('2026-05-07T00:59:00.000Z');
const clientId = 'client-id-123';
const clientSecret = 'shared-secret-456';
const devClientId = 'dev-client-id-789';
const devClientSecret = 'dev-secret-012';
const shopDomain = 'example.myshopify.com';

describe('Shopify auth routes', () => {
  test('rejects public token authority requests without a bearer session token', async () => {
    const harness = createHarness();
    const app = await buildApp({ shopifyAuth: harness.dependencies });
    try {
      const response = await app.inject({ method: 'POST', payload: { shopDomain }, url: '/shopify/auth/token-exchange' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ data: null, error: { code: 'UNAUTHORIZED', message: 'Missing bearer session token' } });
      expect(harness.getOfflineToken).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('uses the canonical token authority while exposing metadata only to the public route', async () => {
    const harness = createHarness();
    const logLines: string[] = [];
    const app = await buildApp({
      logger: { level: 'info', stream: { write: (line: string) => logLines.push(line) } },
      shopifyAuth: harness.dependencies
    });
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token', 'x-correlation-id': 'request-123' },
        method: 'POST', payload: { shopDomain }, url: '/shopify/auth/token-exchange'
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: { appId: 'clever', shopDomain, tokenScopes: ['read_orders', 'read_customers'], tokenStored: true },
        error: null
      });
      expect(response.body).not.toContain('shpat_access_token');
      expect(response.body).not.toContain('clever-route-managed-v1');
      expect(harness.verify).toHaveBeenCalledWith('session-token', { expectedShopDomain: shopDomain });
      expect(harness.getOfflineToken).toHaveBeenCalledWith({
        apiVersion: '2026-04', appId: 'clever', installedAt, sessionToken: 'session-token', shopDomain
      });
      expect(harness.enqueueIfIdle).toHaveBeenCalledWith({
        appId: 'clever', mode: 'INCREMENTAL', requestedBy: 'system:token-exchange', shopDomain
      });
      const serializedLogs = logLines.join('\n');
      expect(serializedLogs).toContain('shopify_admin_token_available');
      expect(serializedLogs).not.toContain('shpat_access_token');
      expect(serializedLogs).not.toContain('session-token');
      expect(serializedLogs).not.toContain('request-123');
      expect(serializedLogs).not.toContain(shopDomain);
    } finally { await app.close(); }
  });

  test('keeps public exchange successful when reconciliation cannot be queued', async () => {
    const harness = createHarness();
    harness.enqueueIfIdle.mockRejectedValueOnce(new Error('database temporarily unavailable'));
    const logLines: string[] = [];
    const app = await buildApp({
      logger: { level: 'warn', stream: { write: (line: string) => logLines.push(line) } },
      shopifyAuth: harness.dependencies
    });
    try {
      const response = await publicTokenRequest(app);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ data: { tokenStored: true }, error: null });
      expect(logLines.join('\n')).toContain('shopify_order_reconciliation_enqueue_failed');
    } finally { await app.close(); }
  });

  test('does not queue reconciliation without read_orders scope', async () => {
    const harness = createHarness();
    harness.getOfflineToken.mockResolvedValueOnce(offlineToken({ tokenScopes: ['read_locations'] }));
    const app = await buildApp({ shopifyAuth: harness.dependencies });
    try {
      expect((await publicTokenRequest(app)).statusCode).toBe(200);
      expect(harness.enqueueIfIdle).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('keeps invalid public session diagnostics sanitized', async () => {
    const harness = createHarness();
    harness.verify.mockImplementationOnce(() => { throw new Error('Invalid Shopify session token signature'); });
    const logLines: string[] = [];
    const app = await buildApp({
      logger: { level: 'warn', stream: { write: (line: string) => logLines.push(line) } },
      shopifyAuth: harness.dependencies
    });
    try {
      const response = await publicTokenRequest(app);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ data: null, error: { code: 'UNAUTHORIZED', message: 'Invalid Shopify session token' } });
      expect(harness.getOfflineToken).not.toHaveBeenCalled();
      expect(logLines.join('\n')).toContain('signature_mismatch');
      expect(logLines.join('\n')).not.toContain('session-token');
    } finally { await app.close(); }
  });

  test('rejects malformed public shop input before session verification', async () => {
    const harness = createHarness();
    const app = await buildApp({ shopifyAuth: harness.dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' }, method: 'POST', payload: { shopDomain: 123 }, url: '/shopify/auth/token-exchange'
      });
      expect(response.statusCode).toBe(400);
      expect(harness.verify).not.toHaveBeenCalled();
      expect(harness.getOfflineToken).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('maps canonical authority timeouts without leaking provider details', async () => {
    const harness = createHarness();
    harness.getOfflineToken.mockRejectedValueOnce(Object.assign(
      new Error('private@example.invalid 1 Secret Street token=shpat_private'),
      { code: 'SHOPIFY_TOKEN_EXCHANGE_TIMEOUT' }
    ));
    const logLines: string[] = [];
    const app = await buildApp({
      logger: { level: 'warn', stream: { write: (line: string) => logLines.push(line) } },
      shopifyAuth: harness.dependencies
    });
    try {
      const response = await publicTokenRequest(app);
      expect(response.statusCode).toBe(504);
      expect(response.json()).toMatchObject({ error: { code: 'SHOPIFY_TOKEN_EXCHANGE_TIMEOUT' } });
      const serialized = logLines.join('\n');
      expect(serialized).not.toContain('private@example.invalid');
      expect(serialized).not.toContain('Secret Street');
      expect(serialized).not.toContain('shpat_private');
      expect(serialized).not.toContain(shopDomain);
    } finally { await app.close(); }
  });

  test('keeps the broker route disabled unless a broker verifier is configured', async () => {
    const harness = createHarness({ broker: false });
    const app = await buildApp({ shopifyAuth: harness.dependencies });
    try {
      const response = await app.inject({ method: 'POST', payload: brokerBody(), url: '/shopify/auth/offline-token' });
      expect(response.statusCode).toBe(404);
      expect(harness.getOfflineToken).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('returns OAuth broker credentials with an opaque managed refresh marker', async () => {
    const harness = createHarness();
    const logLines: string[] = [];
    const app = await buildApp({
      logger: { level: 'info', stream: { write: (line: string) => logLines.push(line) } },
      shopifyAuth: harness.dependencies
    });
    try {
      const response = await brokerRequest(app, brokerBody());
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        access_token: 'shpat_access_token', expires_in: 3600,
        refresh_token: 'clever-route-managed-v1', refresh_token_expires_in: 7_776_000,
        scope: 'read_orders,read_customers'
      });
      expect(response.body).not.toContain('shprt_');
      expect(harness.getOfflineToken).toHaveBeenCalledWith({
        apiVersion: '2026-04', appId: 'clever', installedAt,
        sessionToken: 'session-token', shopDomain
      });
      expect(logLines.join('\n')).not.toContain('shpat_access_token');
      expect(logLines.join('\n')).not.toContain('session-token');
    } finally { await app.close(); }
  });

  test.each([
    ['missing signature', { omitSignature: true }],
    ['invalid signature', { signature: '00'.repeat(32) }],
    ['tampered body', { signedBody: brokerBody(), body: brokerBody({ shopDomain: 'other.myshopify.com' }) }]
  ])('rejects broker %s before token authority', async (_label, options) => {
    const harness = createHarness();
    const app = await buildApp({ shopifyAuth: harness.dependencies });
    try {
      const response = await brokerRequest(
        app,
        'body' in options ? options.body : brokerBody(),
        options
      );
      expect(response.statusCode).toBe(401);
      expect(harness.getOfflineToken).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test.each([
    ['app mismatch', { appId: 'clever-route-dev', shopDomain }],
    ['shop mismatch', { appId: 'clever', shopDomain: 'other.myshopify.com' }]
  ])('rejects broker session %s before token authority', async (_label, verifiedSession) => {
    const harness = createHarness();
    harness.verify.mockReturnValueOnce({ ...verifiedSession, issuedAt: installedAt, subject: '42' });
    const app = await buildApp({ shopifyAuth: harness.dependencies });
    try {
      expect((await brokerRequest(app, brokerBody())).statusCode).toBe(401);
      expect(harness.getOfflineToken).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('returns invalid_grant when canonical refresh authority has no token', async () => {
    const harness = createHarness();
    harness.getOfflineToken.mockResolvedValueOnce(null);
    const app = await buildApp({ shopifyAuth: harness.dependencies });
    try {
      const response = await brokerRequest(app, brokerBody({ operation: 'refresh', sessionToken: undefined }));
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ error: 'invalid_grant' });
    } finally { await app.close(); }
  });

  test('maps broker authority errors to a sanitized 502', async () => {
    const harness = createHarness();
    harness.getOfflineToken.mockRejectedValueOnce(new Error('shpat_private private@example.invalid'));
    const logLines: string[] = [];
    const app = await buildApp({
      logger: { level: 'warn', stream: { write: (line: string) => logLines.push(line) } },
      shopifyAuth: harness.dependencies
    });
    try {
      const response = await brokerRequest(app, brokerBody());
      expect(response.statusCode).toBe(502);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ error: 'temporarily_unavailable' });
      expect(response.body).not.toContain('shpat_private');
      expect(response.body).not.toContain('private@example.invalid');
      expect(logLines.join('\n')).not.toContain('shpat_private');
      expect(logLines.join('\n')).not.toContain('private@example.invalid');
    } finally { await app.close(); }
  });
});

function createHarness(options: { broker?: boolean } = {}) {
  const verify = vi.fn(() => ({ appId: 'clever', issuedAt: installedAt, shopDomain, subject: '42' }));
  const getOfflineToken = vi.fn<ShopifyAuthDependencies['shopTokenService']['getOfflineToken']>(
    () => Promise.resolve(offlineToken())
  );
  const enqueueIfIdle = vi.fn(() => Promise.resolve(null));
  const dependencies = {
    apiVersion: '2026-04', now: () => now,
    orderReconciliationService: { enqueueIfIdle }, sessionTokenVerifier: { verify }, shopTokenService: { getOfflineToken },
    ...(options.broker === false ? {} : {
      tokenBrokerVerifier: new ShopifyTokenBrokerVerifier({
        appCredentials: [
          { appId: 'clever', clientId, clientSecret },
          { appId: 'clever-route-dev', clientId: devClientId, clientSecret: devClientSecret }
        ],
        now: () => now
      })
    })
  } as unknown as ShopifyAuthDependencies;
  return { dependencies, enqueueIfIdle, getOfflineToken, verify };
}

function offlineToken(overrides: Partial<ReturnType<typeof offlineTokenBase>> = {}) {
  return { ...offlineTokenBase(), ...overrides };
}

function offlineTokenBase() {
  return {
    accessToken: 'shpat_access_token', accessTokenExpiresAt: new Date(now.getTime() + 3_600_000), appId: 'clever',
    refreshTokenExpiresAt: new Date(now.getTime() + 7_776_000_000), shopDomain, tokenScopes: ['read_orders', 'read_customers']
  };
}

function publicTokenRequest(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({
    headers: { authorization: 'Bearer session-token' }, method: 'POST', payload: { shopDomain }, url: '/shopify/auth/token-exchange'
  });
}

type BrokerBody = {
  clientId: string;
  operation: 'exchange' | 'refresh';
  sessionToken?: string | undefined;
  shopDomain: string;
};

function brokerBody(overrides: Partial<BrokerBody> = {}): BrokerBody {
  const body: BrokerBody = { clientId, shopDomain, operation: 'exchange', sessionToken: 'session-token', ...overrides };
  if (body.sessionToken === undefined) delete body.sessionToken;
  return body;
}

function brokerRequest(
  app: Awaited<ReturnType<typeof buildApp>>,
  body: BrokerBody,
  options: { body?: BrokerBody; omitSignature?: boolean; signature?: string; signedBody?: BrokerBody } = {}
) {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signature = options.signature ?? signBrokerBody(options.signedBody ?? body, timestamp, clientSecret);
  return app.inject({
    headers: {
      'x-clever-token-timestamp': timestamp,
      ...(options.omitSignature === true ? {} : { 'x-clever-token-signature': signature })
    },
    method: 'POST', payload: body, url: '/shopify/auth/offline-token'
  });
}

function signBrokerBody(body: BrokerBody, timestamp: string, secret: string): string {
  const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const canonical = ['clever-shopify-token-authority-v1', 'POST', '/shopify/auth/offline-token', timestamp, bodyHash].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
