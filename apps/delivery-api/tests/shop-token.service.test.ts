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
    updateMany: vi.fn(({ data }: { data: Partial<ShopTokenRow> }) => {
      if (stored === null) return Promise.resolve({ count: 0 });
      stored = { ...stored, ...data };
      return Promise.resolve({ count: 1 });
    }),
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
  const shopifyShopRedactionTombstone = {
    findUnique: vi.fn(() => Promise.resolve({ redactedAt: new Date('2026-05-06T00:00:00.000Z'), reinstalledAt: null })),
    updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
  };

  return {
    getStored: () => stored,
    prisma: { shop, shopifyShopRedactionTombstone },
    repository: new PrismaShopTokenRepository({
      $transaction: (callback) => callback({
        $queryRaw: vi.fn(() => Promise.resolve([{ lock: 'ok' }])),
        shop,
        shopifyShopRedactionTombstone
      }),
      shop
    })
  };

}

describe('ShopTokenService', () => {
  test('fails closed when transactional privacy fencing is unavailable', () => {
    expect(() => new PrismaShopTokenRepository({ shop: {} } as never))
      .toThrow('Shop token repository requires transactional privacy fencing');
  });

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
      tokenScopes: ['read_orders', 'read_customers', 'read_orders']
    });

    expect(stored.shopDomain).toBe('example.myshopify.com');
    expect(stored.adminAccessTokenCiphertext).not.toContain('shpat_access_token');
    expect(stored.adminRefreshTokenCiphertext).not.toContain('shpat_refresh_token');
    expect(stored.tokenScopes).toEqual(['read_orders', 'read_customers']);
    expect(prisma.shop.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { appId_shopDomain: { appId: 'clever', shopDomain: 'example.myshopify.com' } }
      })
    );
    expect(prisma.shopifyShopRedactionTombstone.updateMany).toHaveBeenCalledWith({
      data: { reinstalledAt: stored.installedAt },
      where: {
        appId: 'clever',
        redactedAt: { lt: stored.installedAt },
        reinstalledAt: null,
        shopDomain: 'example.myshopify.com'
      }
    });
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

  test('refreshes an expired expiring offline access token before returning it', async () => {
    const { getStored, repository } = createRepositoryHarness();
    const refreshOfflineToken = vi.fn(() =>
      Promise.resolve({
        accessToken: 'shpat_refreshed_access_token',
        expiresIn: 3600,
        refreshToken: 'shprt_refreshed_refresh_token',
        refreshTokenExpiresIn: 7_776_000,
        scope: 'read_orders,read_locations'
      })
    );
    const service = new ShopTokenService({
      encryptionKey,
      now: () => new Date('2026-05-07T03:00:00.000Z'),
      repository,
      tokenRefreshClient: { refreshOfflineToken }
    });

    await service.storeAdminApiToken({
      accessToken: 'shpat_expired_access_token',
      accessTokenExpiresAt: new Date('2026-05-07T02:00:00.000Z'),
      apiVersion: '2026-04',
      refreshToken: 'shprt_refresh_token',
      refreshTokenExpiresAt: new Date('2026-08-05T02:00:00.000Z'),
      shopDomain: 'example.myshopify.com',
      tokenScopes: ['read_orders']
    });

    await expect(service.getAdminAccessToken('example.myshopify.com')).resolves.toBe(
      'shpat_refreshed_access_token'
    );
    expect(refreshOfflineToken).toHaveBeenCalledWith({
      appId: 'clever',
      refreshToken: 'shprt_refresh_token',
      shopDomain: 'example.myshopify.com'
    });
    expect(getStored()?.tokenScopes).toEqual(['read_orders', 'read_locations']);
    expect(getStored()?.adminAccessTokenExpiresAt?.toISOString()).toBe('2026-05-07T04:00:00.000Z');
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
