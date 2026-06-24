import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ShopifyAuthDependencies } from '../src/routes/shopify-auth.routes.js';

const verifySession = (): { appId: string; shopDomain: string; subject: string } => ({
  appId: 'clever',
  shopDomain: 'example.myshopify.com',
  subject: '42'
});

const storeAdminApiToken = (): Promise<{ appId: string; shopDomain: string; tokenScopes: string[] }> =>
  Promise.resolve({
    appId: 'clever',
    shopDomain: 'example.myshopify.com',
    tokenScopes: ['read_orders', 'write_orders']
  });

const exchangeSessionTokenForOfflineToken = (): Promise<{
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresIn: number;
  scope: string;
}> =>
  Promise.resolve({
    accessToken: 'shpat_access_token',
    expiresIn: 3600,
    refreshToken: 'shprt_refresh_token',
    refreshTokenExpiresIn: 7_776_000,
    scope: 'read_orders,write_orders'
  });

const baseDependencies: ShopifyAuthDependencies = {
  apiVersion: '2026-04',
  sessionTokenVerifier: {
    verify: vi.fn(verifySession)
  },
  shopTokenService: {
    storeAdminApiToken: vi.fn(storeAdminApiToken)
  },
  tokenExchangeClient: {
    exchangeSessionTokenForOfflineToken: vi.fn(exchangeSessionTokenForOfflineToken)
  }
};

describe('Shopify auth routes', () => {
  test('rejects token exchange requests without a bearer session token', async () => {
    const app = await buildApp({ shopifyAuth: baseDependencies });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: { shopDomain: 'example.myshopify.com' },
        url: '/shopify/auth/token-exchange'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing bearer session token' }
      });
    } finally {
      await app.close();
    }
  });

  test('exchanges a verified session token and stores encrypted shop token metadata', async () => {
    const { dependencies, exchange, store, verify } = createDependencyHarness();
    const app = await buildApp({ shopifyAuth: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { shopDomain: 'example.myshopify.com' },
        url: '/shopify/auth/token-exchange'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          appId: 'clever',
          shopDomain: 'example.myshopify.com',
          tokenStored: true,
          tokenScopes: ['read_orders', 'write_orders']
        },
        error: null
      });
      expect(verify).toHaveBeenCalledWith('session-token', {
        expectedShopDomain: 'example.myshopify.com'
      });
      expect(exchange).toHaveBeenCalledWith({
        appId: 'clever',
        sessionToken: 'session-token',
        shopDomain: 'example.myshopify.com'
      });
      expect(store).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'clever',
          accessToken: 'shpat_access_token',
          apiVersion: '2026-04',
          refreshToken: 'shprt_refresh_token',
          shopDomain: 'example.myshopify.com',
          tokenScopes: ['read_orders', 'write_orders']
        })
      );
    } finally {
      await app.close();
    }
  });

  test('logs invalid session tokens with a sanitized reason during token exchange', async () => {
    const { dependencies, exchange, verify } = createDependencyHarness();
    verify.mockImplementationOnce(() => {
      throw new Error('Invalid Shopify session token signature');
    });
    const logLines: string[] = [];
    const app = await buildApp({
      logger: {
        level: 'warn',
        stream: { write: (line: string) => logLines.push(line) }
      },
      shopifyAuth: dependencies
    });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { shopDomain: 'example.myshopify.com' },
        url: '/shopify/auth/token-exchange'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Invalid Shopify session token' }
      });
      expect(exchange).not.toHaveBeenCalled();
      expect(
        logLines.some((line) =>
          line.includes('shopify admin session token rejected') &&
          line.includes('shopify_admin_session_token_rejected') &&
          line.includes('shopify_auth_token_exchange') &&
          line.includes('signature_mismatch') &&
          !line.includes('session-token')
        )
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('rejects malformed optional shop domain before token exchange', async () => {
    const { dependencies, exchange, verify } = createDependencyHarness();
    const app = await buildApp({ shopifyAuth: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { shopDomain: 123 },
        url: '/shopify/auth/token-exchange'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'shopDomain must be a non-empty string' }
      });
      expect(verify).not.toHaveBeenCalled();
      expect(exchange).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('maps Shopify token exchange failures to bad gateway', async () => {
    const { dependencies, exchange } = createDependencyHarness();
    exchange.mockRejectedValueOnce(new Error('Shopify token exchange failed'));
    const app = await buildApp({ shopifyAuth: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { shopDomain: 'example.myshopify.com' },
        url: '/shopify/auth/token-exchange'
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'SHOPIFY_TOKEN_EXCHANGE_FAILED',
          message: 'Shopify token exchange failed'
        }
      });
    } finally {
      await app.close();
    }
  });
});

function createDependencyHarness(): {
  dependencies: ShopifyAuthDependencies;
  exchange: ReturnType<typeof vi.fn<typeof exchangeSessionTokenForOfflineToken>>;
  store: ReturnType<typeof vi.fn<typeof storeAdminApiToken>>;
  verify: ReturnType<typeof vi.fn<typeof verifySession>>;
} {
  const verify = vi.fn(verifySession);
  const store = vi.fn(storeAdminApiToken);
  const exchange = vi.fn(exchangeSessionTokenForOfflineToken);

  return {
    dependencies: {
      apiVersion: baseDependencies.apiVersion,
      sessionTokenVerifier: {
        verify
      },
      shopTokenService: {
        storeAdminApiToken: store
      },
      tokenExchangeClient: {
        exchangeSessionTokenForOfflineToken: exchange
      }
    },
    exchange,
    store,
    verify
  };
}
