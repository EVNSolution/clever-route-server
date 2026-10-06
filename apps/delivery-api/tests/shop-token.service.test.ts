import { describe, expect, test, vi } from 'vitest';

import { loadTokenEncryptionKey } from '../src/modules/security/token-encryption.js';
import {
  PrismaShopTokenRepository,
  ShopTokenInstallSupersededError,
  type ShopTokenRow
} from '../src/modules/shopify/shop-token.repository.js';
import { ShopTokenService } from '../src/modules/shopify/shop-token.service.js';
import { ShopifyTokenRefreshRejectedError } from '../src/modules/shopify/token-exchange.client.js';

const encryptionKey = loadTokenEncryptionKey(
  'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
);

function createRepositoryHarness() {
  let stored: ShopTokenRow | null = null;
  let tombstone = {
    redactedAt: new Date('2026-05-06T00:00:00.000Z'),
    reinstalledAt: null as Date | null
  };
  let transactionOptions: { maxWait?: number; timeout?: number } | undefined;
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
    findUnique: vi.fn(() => Promise.resolve(tombstone)),
    updateMany: vi.fn(({ data }: { data: { reinstalledAt: Date } }) => {
      tombstone = { ...tombstone, reinstalledAt: data.reinstalledAt };
      return Promise.resolve({ count: 1 });
    })
  };

  return {
    getStored: () => stored,
    getTransactionOptions: () => transactionOptions,
    markRedacted: (redactedAt: Date) => {
      stored = null;
      tombstone = { redactedAt, reinstalledAt: null };
    },
    markUninstalled: (uninstalledAt: Date) => {
      if (stored !== null) stored = { ...stored, uninstalledAt };
    },
    prisma: { shop, shopifyShopRedactionTombstone },
    repository: new PrismaShopTokenRepository({
      $transaction: (callback, options) => {
        transactionOptions = options;
        return callback({
          $queryRaw: vi.fn(() => Promise.resolve([{ lock: 'ok' }])),
          shop,
          shopifyShopRedactionTombstone
        });
      },
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
    const { getTransactionOptions, prisma, repository } = createRepositoryHarness();
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
    expect(getTransactionOptions()).toEqual({ maxWait: 135_000, timeout: 255_000 });
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

  test('returns one broker-safe offline token snapshot without exposing the Shopify refresh token', async () => {
    const { repository } = createRepositoryHarness();
    const refreshOfflineToken = vi.fn(() => Promise.reject(new Error('healthy token must not refresh')));
    const service = new ShopTokenService({
      encryptionKey,
      now: () => new Date('2026-05-07T03:00:00.000Z'),
      repository,
      tokenRefreshClient: { refreshOfflineToken }
    });

    await service.storeAdminApiToken({
      appId: 'clever-route-kfood',
      accessToken: 'shpat_healthy_access_token',
      accessTokenExpiresAt: new Date('2026-05-07T04:00:00.000Z'),
      apiVersion: '2026-04',
      refreshToken: 'shprt_must_remain_server_side',
      refreshTokenExpiresAt: new Date('2026-08-05T02:00:00.000Z'),
      shopDomain: 'example.myshopify.com',
      tokenScopes: ['read_orders']
    });

    const token = await service.getOfflineToken({
      appId: 'clever-route-kfood',
      shopDomain: 'example.myshopify.com'
    });

    expect(token).toEqual({
      accessToken: 'shpat_healthy_access_token',
      accessTokenExpiresAt: new Date('2026-05-07T04:00:00.000Z'),
      appId: 'clever-route-kfood',
      refreshTokenExpiresAt: new Date('2026-08-05T02:00:00.000Z'),
      shopDomain: 'example.myshopify.com',
      tokenScopes: ['read_orders']
    });
    expect(token).not.toHaveProperty('refreshToken');
    expect(refreshOfflineToken).not.toHaveBeenCalled();
  });

  test('falls back from a terminal refresh rejection to a verified session-token exchange', async () => {
    const { getStored, repository } = createRepositoryHarness();
    const refreshOfflineToken = vi.fn(() => Promise.reject(new ShopifyTokenRefreshRejectedError(401)));
    const exchangeSessionTokenForOfflineToken = vi.fn(() => Promise.resolve({
      accessToken: 'shpat_exchanged_access_token',
      expiresIn: 3_600,
      refreshToken: 'shprt_exchanged_refresh_token',
      refreshTokenExpiresIn: 7_776_000,
      scope: 'read_orders,read_locations'
    }));
    const service = new ShopTokenService({
      encryptionKey,
      now: () => new Date('2026-05-07T03:00:00.000Z'),
      repository,
      tokenExchangeClient: { exchangeSessionTokenForOfflineToken },
      tokenRefreshClient: { refreshOfflineToken }
    });

    await service.storeAdminApiToken({
      accessToken: 'shpat_expired_access_token',
      accessTokenExpiresAt: new Date('2026-05-07T02:00:00.000Z'),
      apiVersion: '2026-04',
      installedAt: new Date('2026-05-06T01:00:00.000Z'),
      refreshToken: 'shprt_rejected_refresh_token',
      refreshTokenExpiresAt: new Date('2026-08-05T02:00:00.000Z'),
      shopDomain: 'example.myshopify.com',
      tokenScopes: ['read_orders']
    });

    await expect(service.getOfflineToken({
      apiVersion: '2026-07',
      installedAt: new Date('2026-05-07T02:59:59.000Z'),
      sessionToken: 'verified-session-token',
      shopDomain: 'example.myshopify.com'
    })).resolves.toMatchObject({
      accessToken: 'shpat_exchanged_access_token',
      tokenScopes: ['read_orders', 'read_locations']
    });
    expect(exchangeSessionTokenForOfflineToken).toHaveBeenCalledWith({
      appId: 'clever',
      sessionToken: 'verified-session-token',
      shopDomain: 'example.myshopify.com'
    });
    expect(getStored()?.apiVersion).toBe('2026-07');
  });

  test('does not mint a competing token after a transient refresh failure', async () => {
    const { repository } = createRepositoryHarness();
    const refreshFailure = new Error('temporary Shopify outage');
    const refreshOfflineToken = vi.fn(() => Promise.reject(refreshFailure));
    const exchangeSessionTokenForOfflineToken = vi.fn(() => Promise.resolve({
      accessToken: 'must-not-be-used',
      expiresIn: 3_600,
      refreshToken: 'must-not-be-used',
      refreshTokenExpiresIn: 7_776_000,
      scope: 'read_orders'
    }));
    const service = new ShopTokenService({
      encryptionKey,
      now: () => new Date('2026-05-07T03:00:00.000Z'),
      repository,
      tokenExchangeClient: { exchangeSessionTokenForOfflineToken },
      tokenRefreshClient: { refreshOfflineToken }
    });

    await service.storeAdminApiToken({
      accessToken: 'shpat_expired_access_token',
      accessTokenExpiresAt: new Date('2026-05-07T02:00:00.000Z'),
      apiVersion: '2026-04',
      installedAt: new Date('2026-05-06T01:00:00.000Z'),
      refreshToken: 'shprt_refresh_token',
      refreshTokenExpiresAt: new Date('2026-08-05T02:00:00.000Z'),
      shopDomain: 'example.myshopify.com',
      tokenScopes: ['read_orders']
    });

    await expect(service.getOfflineToken({
      apiVersion: '2026-07',
      installedAt: new Date('2026-05-07T02:59:59.000Z'),
      sessionToken: 'verified-session-token',
      shopDomain: 'example.myshopify.com'
    })).rejects.toBe(refreshFailure);
    expect(exchangeSessionTokenForOfflineToken).not.toHaveBeenCalled();
  });

  test('preserves the canonical token row when a successful refresh response has an incomplete rotating pair', async () => {
    const { getStored, repository } = createRepositoryHarness();
    const refreshOfflineToken = vi.fn(() => Promise.resolve({
      accessToken: 'shpat_unusable_access_token',
      expiresIn: 3_600,
      refreshToken: null,
      refreshTokenExpiresIn: 7_776_000,
      scope: 'read_orders'
    }));
    const exchangeSessionTokenForOfflineToken = vi.fn();
    const service = new ShopTokenService({
      encryptionKey,
      now: () => new Date('2026-05-07T03:00:00.000Z'),
      repository,
      tokenExchangeClient: { exchangeSessionTokenForOfflineToken },
      tokenRefreshClient: { refreshOfflineToken }
    });
    await service.storeAdminApiToken({
      accessToken: 'shpat_canonical_access_token',
      accessTokenExpiresAt: new Date('2026-05-07T02:00:00.000Z'),
      apiVersion: '2026-04',
      installedAt: new Date('2026-05-06T01:00:00.000Z'),
      refreshToken: 'shprt_canonical_refresh_token',
      refreshTokenExpiresAt: new Date('2026-08-05T02:00:00.000Z'),
      shopDomain: 'example.myshopify.com',
      tokenScopes: ['read_orders']
    });
    const before = getStored();

    await expect(service.getOfflineToken({
      apiVersion: '2026-07',
      installedAt: new Date('2026-05-07T02:59:59.000Z'),
      sessionToken: 'verified-session-token',
      shopDomain: 'example.myshopify.com'
    })).rejects.toThrow('Shopify token refresh returned an incomplete rotating token pair');
    expect(getStored()).toEqual(before);
    expect(exchangeSessionTokenForOfflineToken).not.toHaveBeenCalled();
  });

  test('does not persist an incomplete expiring token exchange response', async () => {
    const { getStored, repository } = createRepositoryHarness();
    const exchangeSessionTokenForOfflineToken = vi.fn(() => Promise.resolve({
      accessToken: 'shpat_incomplete_exchange',
      expiresIn: 3_600,
      refreshToken: null,
      refreshTokenExpiresIn: 7_776_000,
      scope: 'read_orders'
    }));
    const service = new ShopTokenService({
      encryptionKey,
      now: () => new Date('2026-05-07T03:00:00.000Z'),
      repository,
      tokenExchangeClient: { exchangeSessionTokenForOfflineToken }
    });

    await expect(service.getOfflineToken({
      apiVersion: '2026-07',
      installedAt: new Date('2026-05-07T02:59:59.000Z'),
      sessionToken: 'verified-session-token',
      shopDomain: 'example.myshopify.com'
    })).rejects.toThrow('Shopify token exchange returned an incomplete rotating token pair');
    expect(getStored()).toBeNull();
  });

  test('rejects stale session exchange intent after shop redaction before calling Shopify', async () => {
    const { markRedacted, repository } = createRepositoryHarness();
    const exchangeSessionTokenForOfflineToken = vi.fn();
    const service = new ShopTokenService({
      encryptionKey,
      now: () => new Date('2026-05-07T03:00:00.000Z'),
      repository,
      tokenExchangeClient: { exchangeSessionTokenForOfflineToken }
    });
    markRedacted(new Date('2026-05-07T02:30:00.000Z'));

    await expect(service.getOfflineToken({
      apiVersion: '2026-07',
      installedAt: new Date('2026-05-07T02:00:00.000Z'),
      sessionToken: 'stale-verified-session-token',
      shopDomain: 'example.myshopify.com'
    })).rejects.toBeInstanceOf(ShopTokenInstallSupersededError);
    expect(exchangeSessionTokenForOfflineToken).not.toHaveBeenCalled();
  });

  test('does not refresh an uninstalled shop and only permits a newer verified install intent', async () => {
    const { markUninstalled, repository } = createRepositoryHarness();
    const refreshOfflineToken = vi.fn();
    const exchangeSessionTokenForOfflineToken = vi.fn(() => Promise.resolve({
      accessToken: 'shpat_reinstalled',
      expiresIn: 3_600,
      refreshToken: 'shprt_reinstalled',
      refreshTokenExpiresIn: 7_776_000,
      scope: 'read_orders'
    }));
    const service = new ShopTokenService({
      encryptionKey,
      now: () => new Date('2026-05-07T03:00:00.000Z'),
      repository,
      tokenExchangeClient: { exchangeSessionTokenForOfflineToken },
      tokenRefreshClient: { refreshOfflineToken }
    });
    await service.storeAdminApiToken({
      accessToken: 'shpat_old',
      accessTokenExpiresAt: new Date('2026-05-07T02:00:00.000Z'),
      apiVersion: '2026-07',
      installedAt: new Date('2026-05-06T01:00:00.000Z'),
      refreshToken: 'shprt_old',
      refreshTokenExpiresAt: new Date('2026-08-05T00:00:00.000Z'),
      shopDomain: 'example.myshopify.com',
      tokenScopes: ['read_orders']
    });
    markUninstalled(new Date('2026-05-07T02:30:00.000Z'));

    await expect(service.getAdminAccessToken('example.myshopify.com')).resolves.toBeNull();
    await expect(service.getOfflineToken({
      apiVersion: '2026-07',
      installedAt: new Date('2026-05-07T02:00:00.000Z'),
      sessionToken: 'stale-verified-session-token',
      shopDomain: 'example.myshopify.com'
    })).rejects.toBeInstanceOf(ShopTokenInstallSupersededError);
    await expect(service.getOfflineToken({
      apiVersion: '2026-07',
      installedAt: new Date('2026-05-07T02:45:00.000Z'),
      sessionToken: 'fresh-verified-session-token',
      shopDomain: 'example.myshopify.com'
    })).resolves.toMatchObject({ accessToken: 'shpat_reinstalled' });
    expect(refreshOfflineToken).not.toHaveBeenCalled();
    expect(exchangeSessionTokenForOfflineToken).toHaveBeenCalledTimes(1);
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
