import { describe, expect, test, vi } from 'vitest';

import { loadTokenEncryptionKey } from '../src/modules/security/token-encryption.js';
import {
  PrismaShopTokenRepository,
  type ShopTokenRow
} from '../src/modules/shopify/shop-token.repository.js';
import { ShopTokenService } from '../src/modules/shopify/shop-token.service.js';

const encryptionKey = loadTokenEncryptionKey(
  'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
);

function createRepositoryHarness() {
  let stored: ShopTokenRow | null = null;
  const shop = {
    upsert: vi.fn(({ create, update }: { create: ShopTokenRow; update: Partial<ShopTokenRow> }) => {
      stored = {
        ...create,
        ...update,
        shopDomain: create.shopDomain,
        updatedAt: new Date('2026-05-07T00:00:00.000Z')
      };
      return Promise.resolve(stored);
    }),
    findUnique: vi.fn(() => Promise.resolve(stored))
  };

  return {
    prisma: { shop },
    repository: new PrismaShopTokenRepository({ shop })
  };
}

describe('ShopTokenService', () => {
  test('stores encrypted access and refresh tokens for a normalized shop domain', async () => {
    const { prisma, repository } = createRepositoryHarness();
    const service = new ShopTokenService({ encryptionKey, repository });

    const stored = await service.storeAdminApiToken({
      accessToken: 'shpat_access_token',
      accessTokenExpiresAt: new Date('2026-05-07T02:00:00.000Z'),
      apiVersion: '2026-04',
      refreshToken: 'shpat_refresh_token',
      refreshTokenExpiresAt: new Date('2026-05-08T02:00:00.000Z'),
      shopDomain: ' Example.MyShopify.com ',
      shopifyShopGid: 'gid://shopify/Shop/123',
      tokenIssuedAt: new Date('2026-05-07T01:00:00.000Z'),
      tokenScopes: ['read_orders', 'write_orders', 'read_orders']
    });

    expect(stored.shopDomain).toBe('example.myshopify.com');
    expect(stored.adminAccessTokenCiphertext).not.toContain('shpat_access_token');
    expect(stored.adminRefreshTokenCiphertext).not.toContain('shpat_refresh_token');
    expect(stored.tokenScopes).toEqual(['read_orders', 'write_orders']);
    expect(prisma.shop.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: 'example.myshopify.com' }
      })
    );
  });

  test('decrypts the stored Admin API access token for Shopify API calls', async () => {
    const { repository } = createRepositoryHarness();
    const service = new ShopTokenService({ encryptionKey, repository });

    await service.storeAdminApiToken({
      accessToken: 'shpat_access_token',
      apiVersion: '2026-04',
      shopDomain: 'example.myshopify.com',
      tokenScopes: ['read_orders']
    });

    await expect(service.getAdminAccessToken('example.myshopify.com')).resolves.toBe(
      'shpat_access_token'
    );
  });

  test('rejects invalid shop domains before writing tokens', async () => {
    const { prisma, repository } = createRepositoryHarness();
    const service = new ShopTokenService({ encryptionKey, repository });

    await expect(
      service.storeAdminApiToken({
        accessToken: 'shpat_access_token',
        apiVersion: '2026-04',
        shopDomain: 'not-a-shop.example.com',
        tokenScopes: ['read_orders']
      })
    ).rejects.toThrow('Shop domain must end with .myshopify.com');

    expect(prisma.shop.upsert).not.toHaveBeenCalled();
  });
});
