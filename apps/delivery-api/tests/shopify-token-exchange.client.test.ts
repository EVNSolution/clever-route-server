import { describe, expect, test, vi } from 'vitest';

import {
  ShopifyTokenExchangeClient,
  ShopifyTokenRefreshRejectedError
} from '../src/modules/shopify/token-exchange.client.js';

describe('ShopifyTokenExchangeClient', () => {
  test('requests an expiring offline access token using Shopify token exchange', async () => {
    const fetchImpl = vi.fn((input: string, init: RequestInit) => {
      void input;
      void init;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'shpat_access_token',
            expires_in: 3600,
            refresh_token: 'shprt_refresh_token',
            refresh_token_expires_in: 7_776_000,
            scope: 'read_orders,read_customers'
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        )
      );
    });
    const client = new ShopifyTokenExchangeClient({
      clientId: 'client-id-123',
      clientSecret: 'shared-secret-456',
      fetchImpl
    });

    const result = await client.exchangeSessionTokenForOfflineToken({
      sessionToken: 'session-token',
      shopDomain: 'example.myshopify.com'
    });

    expect(result).toEqual({
      accessToken: 'shpat_access_token',
      expiresIn: 3600,
      refreshToken: 'shprt_refresh_token',
      refreshTokenExpiresIn: 7_776_000,
      scope: 'read_orders,read_customers'
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.myshopify.com/admin/oauth/access_token',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        method: 'POST'
      })
    );
    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) {
      throw new Error('Expected token exchange fetch call');
    }
    const body = firstCall[1].body as URLSearchParams;
    expect(body.get('client_id')).toBe('client-id-123');
    expect(body.get('client_secret')).toBe('shared-secret-456');
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.get('subject_token')).toBe('session-token');
    expect(body.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id_token');
    expect(body.get('requested_token_type')).toBe(
      'urn:shopify:params:oauth:token-type:offline-access-token'
    );
    expect(body.get('expiring')).toBe('1');
  });

  test('chooses the Shopify client credential for the requested app id', async () => {
    const fetchImpl = vi.fn((input: string, init: RequestInit) => {
      void input;
      void init;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'shpat_dev_access_token',
            expires_in: 3_600,
            refresh_token: 'shprt_dev_refresh_token',
            refresh_token_expires_in: 7_776_000,
            scope: 'read_orders'
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        )
      );
    });
    const client = new ShopifyTokenExchangeClient({
      appCredentials: [
        { appId: 'clever', clientId: 'main-client-id', clientSecret: 'main-secret' },
        { appId: 'clever-route-dev', clientId: 'dev-client-id', clientSecret: 'dev-secret' }
      ],
      fetchImpl
    });

    await client.exchangeSessionTokenForOfflineToken({
      appId: 'clever-route-dev',
      sessionToken: 'dev-session-token',
      shopDomain: 'example.myshopify.com'
    });

    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) {
      throw new Error('Expected token exchange fetch call');
    }
    const body = firstCall[1].body as URLSearchParams;
    expect(body.get('client_id')).toBe('dev-client-id');
    expect(body.get('client_secret')).toBe('dev-secret');
    expect(body.get('subject_token')).toBe('dev-session-token');
  });

  test('refreshes an expiring offline access token with the stored refresh token', async () => {
    const fetchImpl = vi.fn((input: string, init: RequestInit) => {
      void input;
      void init;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'shpat_refreshed_access_token',
            expires_in: 3600,
            refresh_token: 'shprt_refreshed_refresh_token',
            refresh_token_expires_in: 7_776_000,
            scope: 'read_orders'
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        )
      );
    });
    const client = new ShopifyTokenExchangeClient({
      clientId: 'client-id-123',
      clientSecret: 'shared-secret-456',
      fetchImpl
    });

    const result = await client.refreshOfflineToken({
      refreshToken: 'shprt_old_refresh_token',
      shopDomain: 'example.myshopify.com'
    });

    expect(result).toEqual({
      accessToken: 'shpat_refreshed_access_token',
      expiresIn: 3600,
      refreshToken: 'shprt_refreshed_refresh_token',
      refreshTokenExpiresIn: 7_776_000,
      scope: 'read_orders'
    });
    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) {
      throw new Error('Expected token refresh fetch call');
    }
    const body = firstCall[1].body as URLSearchParams;
    expect(body.get('client_id')).toBe('client-id-123');
    expect(body.get('client_secret')).toBe('shared-secret-456');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('shprt_old_refresh_token');
  });

  test.each([
    ['missing refresh token', { refresh_token: undefined }],
    ['empty refresh token', { refresh_token: '' }],
    ['missing access expiry', { expires_in: undefined }],
    ['null access expiry', { expires_in: null }],
    ['zero access expiry', { expires_in: 0 }],
    ['negative access expiry', { expires_in: -1 }],
    ['missing refresh expiry', { refresh_token_expires_in: undefined }],
    ['null refresh expiry', { refresh_token_expires_in: null }],
    ['zero refresh expiry', { refresh_token_expires_in: 0 }],
    ['empty scope', { scope: '' }]
  ] as const)('rejects a successful refresh response with %s', async (_label, override) => {
    const client = new ShopifyTokenExchangeClient({
      clientId: 'client-id-123',
      clientSecret: 'shared-secret-456',
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
        access_token: 'shpat_refreshed_access_token',
        expires_in: 3_600,
        refresh_token: 'shprt_refreshed_refresh_token',
        refresh_token_expires_in: 7_776_000,
        scope: 'read_orders',
        ...override
      }), { status: 200 }))
    });

    const failure = client.refreshOfflineToken({
      refreshToken: 'shprt_old_refresh_token',
      shopDomain: 'example.myshopify.com'
    });
    await expect(failure).rejects.toThrow(/Shopify token refresh response/u);
    await expect(failure).rejects.not.toBeInstanceOf(ShopifyTokenRefreshRejectedError);
  });

  test('raises an exchange error when Shopify rejects the token exchange', async () => {
    const client = new ShopifyTokenExchangeClient({
      clientId: 'client-id-123',
      clientSecret: 'shared-secret-456',
      fetchImpl: () =>
        Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    });

    await expect(
      client.exchangeSessionTokenForOfflineToken({
        sessionToken: 'bad-session-token',
        shopDomain: 'example.myshopify.com'
      })
    ).rejects.toThrow('Shopify token exchange failed');
  });

  test('rejects a successful expiring exchange response with an incomplete rotating pair', async () => {
    const client = new ShopifyTokenExchangeClient({
      clientId: 'client-id-123',
      clientSecret: 'shared-secret-456',
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
        access_token: 'shpat_access_token',
        expires_in: 3_600,
        scope: 'read_orders'
      }), { status: 200 }))
    });

    await expect(client.exchangeSessionTokenForOfflineToken({
      sessionToken: 'valid-session-token',
      shopDomain: 'example.myshopify.com'
    })).rejects.toThrow('Shopify token exchange response missing refresh_token');
  });

  test.each([
    [400, 'invalid_grant'],
    [401, 'invalid_request']
  ] as const)('classifies terminal refresh rejection %i %s for safe session exchange fallback', async (status, error) => {
    const client = new ShopifyTokenExchangeClient({
      clientId: 'client-id-123',
      clientSecret: 'shared-secret-456',
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ error }), { status }))
    });

    await expect(client.refreshOfflineToken({
      refreshToken: 'retired-refresh-token',
      shopDomain: 'example.myshopify.com'
    })).rejects.toEqual(new ShopifyTokenRefreshRejectedError(status, error));
  });

  test.each([
    [400, 'temporarily_unavailable'],
    [401, undefined],
    [429, 'invalid_grant']
  ] as const)('does not classify ambiguous refresh failure %i %s as terminal', async (status, error) => {
    const client = new ShopifyTokenExchangeClient({
      clientId: 'client-id-123',
      clientSecret: 'shared-secret-456',
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ error }), { status }))
    });

    const failure = client.refreshOfflineToken({
      refreshToken: 'still-canonical-refresh-token',
      shopDomain: 'example.myshopify.com'
    });
    await expect(failure).rejects.toThrow('Shopify token refresh failed');
    await expect(failure).rejects.not.toBeInstanceOf(ShopifyTokenRefreshRejectedError);
  });

  test.each(['exchange', 'refresh'] as const)('bounds abort-ignoring %s requests with a stable timeout', async (operation) => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const client = new ShopifyTokenExchangeClient({
        clientId: 'client-id-123',
        clientSecret: 'shared-secret-456',
        fetchImpl: (_url, init) => {
          signal = init.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        },
        timeoutMs: 1_000
      });
      const request = operation === 'exchange'
        ? client.exchangeSessionTokenForOfflineToken({
            sessionToken: 'secret-session-token',
            shopDomain: 'example.myshopify.com'
          })
        : client.refreshOfflineToken({
            refreshToken: 'secret-refresh-token',
            shopDomain: 'example.myshopify.com'
          });
      const rejected = expect(request).rejects.toMatchObject({
        code: 'SHOPIFY_TOKEN_EXCHANGE_TIMEOUT',
        name: 'ShopifyTokenExchangeTimeoutError'
      });

      await vi.advanceTimersByTimeAsync(1_001);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps the deadline active while a response body stalls after headers', async () => {
    vi.useFakeTimers();
    try {
      const client = new ShopifyTokenExchangeClient({
        clientId: 'client-id-123',
        clientSecret: 'shared-secret-456',
        fetchImpl: () => Promise.resolve(new Response(new ReadableStream({ pull: () => new Promise(() => undefined) }))),
        timeoutMs: 1_000
      });
      const request = client.exchangeSessionTokenForOfflineToken({
        sessionToken: 'secret-session-token',
        shopDomain: 'example.myshopify.com'
      });
      const rejected = expect(request).rejects.toMatchObject({ code: 'SHOPIFY_TOKEN_EXCHANGE_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  test('rejects token responses above the bounded JSON body size', async () => {
    const client = new ShopifyTokenExchangeClient({
      clientId: 'client-id-123',
      clientSecret: 'shared-secret-456',
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
        access_token: 'x'.repeat(65_537),
        scope: 'read_orders'
      })))
    });

    await expect(client.exchangeSessionTokenForOfflineToken({
      sessionToken: 'secret-session-token',
      shopDomain: 'example.myshopify.com'
    })).rejects.toThrow('response exceeded 65536 bytes');
  });
});
