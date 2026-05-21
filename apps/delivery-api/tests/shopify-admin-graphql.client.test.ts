import { describe, expect, test, vi } from 'vitest';

import { ShopifyAdminGraphqlClient } from '../src/modules/shopify/admin-graphql.client.js';

describe('ShopifyAdminGraphqlClient', () => {
  test('posts GraphQL requests to the shop Admin API endpoint with an access token', async () => {
    const fetchImpl = vi.fn((input: string, init: RequestInit) => {
      void input;
      void init;

      return Promise.resolve(
        new Response(JSON.stringify({ data: { shop: { name: 'Example' } } }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      );
    });
    const client = new ShopifyAdminGraphqlClient({
      accessToken: 'shpat_access_token',
      apiVersion: '2026-04',
      fetchImpl,
      shopDomain: 'Example.MyShopify.com'
    });

    await expect(
      client.request<{ shop: { name: string } }>({
        query: 'query ShopName { shop { name } }',
        variables: { first: 1 }
      })
    ).resolves.toEqual({ shop: { name: 'Example' } });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.myshopify.com/admin/api/2026-04/graphql.json',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': 'shpat_access_token'
        },
        method: 'POST'
      })
    );
  });

  test('raises GraphQL errors returned by Shopify', async () => {
    const client = new ShopifyAdminGraphqlClient({
      accessToken: 'shpat_access_token',
      apiVersion: '2026-04',
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ errors: [{ message: 'Access denied' }] }), { status: 200 })
        ),
      shopDomain: 'example.myshopify.com'
    });

    await expect(
      client.request({ query: 'query Orders { orders(first: 1) { nodes { id } } }' })
    ).rejects.toThrow('Shopify Admin GraphQL error: Access denied');
  });
});
