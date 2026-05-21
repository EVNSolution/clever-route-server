import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';

import { loadShopifyAuthDependencies } from '../src/modules/shopify/auth.dependencies.js';
import type { ShopTokenRow } from '../src/modules/shopify/shop-token.repository.js';

describe('loadShopifyAuthDependencies', () => {
  test('leaves the auth route disabled until Shopify secrets are configured', () => {
    const { prisma } = createPrismaHarness();

    expect(loadShopifyAuthDependencies({ env: {}, prisma })).toBeUndefined();
  });

  test('wires session verification, token exchange, and encrypted shop-token storage from env', async () => {
    const { prisma, shop } = createPrismaHarness();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'shpat_access_token',
            scope: 'read_orders'
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        )
      )
    );

    const dependencies = loadShopifyAuthDependencies({
      env: {
        SHOPIFY_API_KEY: 'client-id-123',
        SHOPIFY_API_SECRET: 'shared-secret-456',
        SHOPIFY_API_VERSION: '2026-04',
        SHOPIFY_TOKEN_ENCRYPTION_KEY: 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
      },
      fetchImpl,
      prisma
    });

    expect(dependencies).not.toBeUndefined();
    if (dependencies === undefined) {
      throw new Error('Expected Shopify auth dependencies');
    }

    const verified = dependencies.sessionTokenVerifier.verify(signTestSessionToken(), {});
    expect(verified.shopDomain).toBe('example.myshopify.com');

    await expect(
      dependencies.tokenExchangeClient.exchangeSessionTokenForOfflineToken({
        sessionToken: 'session-token',
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toEqual({
      accessToken: 'shpat_access_token',
      expiresIn: null,
      refreshToken: null,
      refreshTokenExpiresIn: null,
      scope: 'read_orders'
    });

    await dependencies.shopTokenService.storeAdminApiToken({
      accessToken: 'shpat_access_token',
      apiVersion: dependencies.apiVersion,
      shopDomain: 'example.myshopify.com',
      tokenScopes: ['read_orders']
    });

    const upsertCall = shop.upsert.mock.calls[0];
    expect(upsertCall).toBeDefined();
    if (upsertCall === undefined) {
      throw new Error('Expected shop token upsert call');
    }
    const [upsertArgs] = upsertCall;
    expect(upsertArgs.create.shopDomain).toBe('example.myshopify.com');
    expect(upsertArgs.create.adminAccessTokenCiphertext).not.toContain('shpat_access_token');
  });
});

type ShopUpsertArgs = {
  create: ShopTokenRow;
};

function createPrismaHarness(): {
  prisma: PrismaClient;
  shop: {
    upsert: ReturnType<typeof vi.fn<(args: ShopUpsertArgs) => Promise<ShopTokenRow>>>;
  };
} {
  const shop = {
    upsert: vi.fn(({ create }: { create: ShopTokenRow }) => Promise.resolve(create)),
    findUnique: vi.fn(() => Promise.resolve(null))
  };

  return {
    prisma: { shop } as unknown as PrismaClient,
    shop
  };
}

function signTestSessionToken(): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    aud: 'client-id-123',
    dest: 'https://example.myshopify.com',
    exp: nowSeconds + 60,
    iat: nowSeconds,
    iss: 'https://example.myshopify.com/admin',
    jti: 'f8912129-1af6-4cad-9ca3-76b0f7621087',
    nbf: nowSeconds - 5,
    sid: 'aaea182f2732d44c23057c0fea584021a4485b2bd25d3eb7fd349313ad24c685',
    sub: '42'
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', 'shared-secret-456')
    .update(signingInput)
    .digest('base64url');

  return `${signingInput}.${signature}`;
}
