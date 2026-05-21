import { describe, expect, test, vi } from 'vitest';

import { ShopifyTokenExchangeClient } from '../src/modules/shopify/token-exchange.client.js';

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
            scope: 'read_orders,write_orders'
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
      scope: 'read_orders,write_orders'
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
});
