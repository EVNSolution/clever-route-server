import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { ShopifySessionTokenVerifier } from '../src/modules/shopify/session-token-verifier.js';
import type { AdminOrdersDependencies } from '../src/routes/admin-orders.routes.js';
import type { AdminRoutePlanDependencies } from '../src/routes/admin-route-plans.routes.js';
import type { AdminSessionTokenVerifier } from '../src/routes/admin-session-auth.js';

const now = new Date('2026-10-02T05:00:00.000Z');
const nowSeconds = Math.floor(now.getTime() / 1000);
const mainClientId = 'main-client-id';
const mainClientSecret = 'main-client-secret';
const devClientId = 'dev-client-id';
const devClientSecret = 'dev-client-secret';
const shopDomain = 'example.myshopify.com';

type RecoverySurface = 'facets' | 'map' | 'orders-page' | 'route-plans';

describe('admin route session recovery', () => {
  test.each([
    ['orders-page', '/admin/orders/page?pageSize=50&sort=id_desc'],
    ['facets', '/admin/orders/facets'],
    ['map', '/admin/orders/map-points'],
    ['route-plans', '/admin/route-plans']
  ] as const)('%s rejects an expired token and accepts a fresh same-app token on retry', async (surface, url) => {
    const harness = await createHarness();
    const expiredToken = signSessionToken({ exp: nowSeconds, jti: `expired-${surface}` });
    const freshToken = signSessionToken({ exp: nowSeconds + 60, jti: `fresh-${surface}` });

    try {
      const expired = await harness.app.inject({
        headers: { authorization: `Bearer ${expiredToken}` },
        method: 'GET',
        url
      });
      const recovered = await harness.app.inject({
        headers: { authorization: `Bearer ${freshToken}` },
        method: 'GET',
        url
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(expired.statusCode).toBe(401);
      expect(expired.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Invalid Shopify session token' }
      });
      expect(recovered.statusCode).toBe(200);
      expect(harness.calls[surface]).toHaveBeenCalledOnce();
      expect(harness.calls[surface]).toHaveBeenCalledWith(expect.objectContaining({
        appId: 'clever',
        shopDomain
      }));

      const rejectionLogs = rejectedSessionLogs(harness.logLines);
      expect(rejectionLogs).toContainEqual(expect.objectContaining({
        event: 'shopify_admin_session_token_rejected',
        reason: 'expired',
        surface: surface === 'route-plans' ? 'admin_route_plans' : 'admin_orders'
      }));
      expect(harness.logLines.join('\n')).not.toContain(expiredToken);
      expect(harness.logLines.join('\n')).not.toContain(`expired-${surface}`);
    } finally {
      await harness.app.close();
    }
  });

  test('accepts the exact nbf boundary and rejects a token one second before it becomes active', async () => {
    const harness = await createHarness();
    const boundaryToken = signSessionToken({ nbf: nowSeconds });
    const futureToken = signSessionToken({ nbf: nowSeconds + 1 });

    try {
      const boundary = await harness.app.inject({
        headers: { authorization: `Bearer ${boundaryToken}` },
        method: 'GET',
        url: '/admin/orders/page?pageSize=50&sort=id_desc'
      });
      const notActive = await harness.app.inject({
        headers: { authorization: `Bearer ${futureToken}` },
        method: 'GET',
        url: '/admin/orders/page?pageSize=50&sort=id_desc'
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(boundary.statusCode).toBe(200);
      expect(notActive.statusCode).toBe(401);
      expect(rejectedSessionLogs(harness.logLines)).toContainEqual(expect.objectContaining({
        reason: 'not_active_yet',
        surface: 'admin_orders'
      }));
    } finally {
      await harness.app.close();
    }
  });

  test('does not turn an app mismatch into a transient expiry recovery', async () => {
    const harness = await createHarness();
    const firstToken = signSessionToken({ exp: nowSeconds + 60, jti: 'first-main-app-token' });
    const freshToken = signSessionToken({ exp: nowSeconds + 120, jti: 'fresh-main-app-token' });

    try {
      for (const token of [firstToken, freshToken]) {
        const response = await harness.app.inject({
          headers: {
            authorization: `Bearer ${token}`,
            'x-clever-app-id': 'clever-route-dev'
          },
          method: 'GET',
          url: '/admin/route-plans'
        });
        expect(response.statusCode).toBe(401);
      }
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.calls['route-plans']).not.toHaveBeenCalled();
      expect(rejectedSessionLogs(harness.logLines).filter((log) => log.reason === 'app_mismatch')).toHaveLength(2);
      expect(harness.logLines.join('\n')).not.toContain(firstToken);
      expect(harness.logLines.join('\n')).not.toContain(freshToken);
    } finally {
      await harness.app.close();
    }
  });

  test('keeps an unknown token audience unauthorized after a fresh-token retry', async () => {
    const harness = await createHarness();
    const firstToken = signSessionToken({ aud: 'unknown-client-id', jti: 'first-unknown-audience' });
    const freshToken = signSessionToken({ aud: 'unknown-client-id', exp: nowSeconds + 120, jti: 'fresh-unknown-audience' });

    try {
      for (const token of [firstToken, freshToken]) {
        const response = await harness.app.inject({
          headers: { authorization: `Bearer ${token}` },
          method: 'GET',
          url: '/admin/orders/facets'
        });
        expect(response.statusCode).toBe(401);
      }
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.calls.facets).not.toHaveBeenCalled();
      expect(rejectedSessionLogs(harness.logLines).filter((log) => log.reason === 'audience_mismatch')).toHaveLength(2);
    } finally {
      await harness.app.close();
    }
  });
});

async function createHarness() {
  const logLines: string[] = [];
  const listCanonicalOrderFacets = vi.fn<
    NonNullable<AdminOrdersDependencies['orderSyncService']['listCanonicalOrderFacets']>
  >(() => Promise.resolve({ totalCount: 0 }));
  const listCanonicalOrderMapPoints = vi.fn<
    NonNullable<AdminOrdersDependencies['orderSyncService']['listCanonicalOrderMapPoints']>
  >(() => Promise.resolve({ points: [] }));
  const listCanonicalOrdersPage = vi.fn<
    NonNullable<AdminOrdersDependencies['orderSyncService']['listCanonicalOrdersPage']>
  >(() => Promise.resolve({
    count: 0,
    countPrecision: 'exact' as const,
    filterHash: 'hmac-sha256:empty',
    pageInfo: {
      endCursor: null,
      hasNextPage: false,
      hasPreviousPage: false,
      readWatermark: '2026-10-02T05:00:00.000Z',
      startCursor: null
    },
    rows: [],
    sort: 'id_desc' as const
  }));
  const calls: Record<RecoverySurface, ReturnType<typeof vi.fn>> = {
    facets: listCanonicalOrderFacets,
    map: listCanonicalOrderMapPoints,
    'orders-page': listCanonicalOrdersPage,
    'route-plans': vi.fn(() => Promise.resolve([]))
  };
  const sessionTokenVerifier = deterministicVerifier();
  const adminOrders: AdminOrdersDependencies = {
    orderSyncService: {
      listCanonicalOrderFacets,
      listCanonicalOrderMapPoints,
      listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      listCanonicalOrdersPage,
      syncOrdersSnapshot: vi.fn(() => Promise.resolve({
        orders: [],
        sync: { created: 0, needsReview: 0, readyToPlan: 0, received: 0, skipped: 0, unchanged: 0, updated: 0 }
      }))
    },
    sessionTokenVerifier
  };
  const adminRoutePlans = {
    routePlanService: {
      listRoutePlans: calls['route-plans']
    },
    sessionTokenVerifier
  } as unknown as AdminRoutePlanDependencies;

  return {
    app: await buildApp({
      adminOrders,
      adminRoutePlans,
      logger: {
        level: 'warn',
        stream: { write: (line: string) => logLines.push(line) }
      }
    }),
    calls,
    logLines
  };
}

function deterministicVerifier(): AdminSessionTokenVerifier {
  const verifier = new ShopifySessionTokenVerifier({
    appCredentials: [
      { appId: 'clever', clientId: mainClientId, clientSecret: mainClientSecret },
      { appId: 'clever-route-dev', clientId: devClientId, clientSecret: devClientSecret }
    ]
  });

  return {
    verify(sessionToken, options = {}) {
      return verifier.verify(sessionToken, { ...options, now });
    }
  };
}

function signSessionToken(overrides: Record<string, unknown> = {}, signingSecret = mainClientSecret): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    aud: mainClientId,
    dest: `https://${shopDomain}`,
    exp: nowSeconds + 60,
    iat: nowSeconds,
    iss: `https://${shopDomain}/admin`,
    jti: 'route-session-recovery-test',
    nbf: nowSeconds - 5,
    sid: 'route-session-recovery-session',
    sub: 'shopify-user-id',
    ...overrides
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', signingSecret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

function rejectedSessionLogs(logLines: string[]): Array<Record<string, unknown>> {
  return logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === 'shopify_admin_session_token_rejected');
}
