import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  readShopifyDeliveryCycle,
  ShopifyDeliverySettingsError
} from '../src/modules/shopify/order-delivery-settings.js';
import { loadAdminOrdersRuntime } from '../src/modules/shopify/order-sync.dependencies.js';
import type { ShopifyOrderNode } from '../src/modules/shopify/order-sync.mapper.js';
import type { ShopTokenRow } from '../src/modules/shopify/shop-token.repository.js';
import { encryptSecret, loadTokenEncryptionKey } from '../src/modules/security/token-encryption.js';

const encryptionKey = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const shopDomain = 'example.myshopify.com';
const mainClientId = 'main-client-id';
const mainClientSecret = 'main-client-secret';
const devClientId = 'dev-client-id';
const devClientSecret = 'dev-client-secret';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Shopify delivery settings runtime dependencies', () => {
  test('uses the requested app and shop token for currentAppInstallation settings', async () => {
    const { prisma, shopFindUnique, transaction } = createPrismaHarness({ appId: 'clever-route-dev' });
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(graphqlResponse({
        currentAppInstallation: {
          legacyMetafield: {
            value: JSON.stringify({
              deliveryCycle: { cutoffTime: '18:00', cutoffWeekday: 'WEDNESDAY', timeZone: 'America/Toronto' }
            })
          },
          metafield: {
            value: JSON.stringify({
              deliveryCycle: { cutoffTime: '17:00', cutoffWeekday: 'TUESDAY', timeZone: 'America/Toronto' }
            })
          }
        },
        shop: { ianaTimezone: 'America/Vancouver' }
      }));
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = requiredRuntime(prisma, { withEncryptionKey: true });

    const result = await runtime.dependencies.orderSyncService.syncOrdersSnapshot({
      appId: 'clever-route-dev',
      deliveryCycle: { cutoffTime: '01:00', cutoffWeekday: 'SUNDAY', timeZone: 'America/Halifax' },
      orders: [],
      reason: 'orders_page_open',
      shopDomain,
      source: 'clever-app-orders',
      subject: 'shopify-user-id'
    });

    expect(result.orders).toEqual([]);
    expect(shopFindUnique.mock.calls[0]?.[0].where).toEqual({
      appId_shopDomain: { appId: 'clever-route-dev', shopDomain }
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://${shopDomain}/admin/api/2026-04/graphql.json`);
    expect(init?.headers).toEqual(expect.objectContaining({ 'X-Shopify-Access-Token': 'shpat_dev_access_token' }));
    if (typeof init?.body !== 'string') throw new Error('expected a JSON GraphQL request body');
    const requestBody = JSON.parse(init.body) as { query: string };
    expect(requestBody.query).toContain('shop { ianaTimezone }');
    expect(requestBody.query).toContain('metafield(namespace: "clever_route", key: "app_preferences")');
    expect(requestBody.query).toContain('legacyMetafield: metafield(namespace: "tomatono_route", key: "app_preferences")');
    expect(requestBody.query.indexOf('namespace: "clever_route"')).toBeLessThan(
      requestBody.query.indexOf('namespace: "tomatono_route"')
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  test.each([
    {
      installation: {
        legacyMetafield: {
          value: JSON.stringify({ deliveryCycle: { cutoffTime: '18:00', cutoffWeekday: 'WEDNESDAY' } })
        },
        metafield: {
          value: JSON.stringify({
            deliveryCycle: { cutoffTime: '17:00', cutoffWeekday: 'TUESDAY', timeZone: 'America/Toronto' }
          })
        }
      },
      expected: { cutoffTime: '17:00', cutoffWeekday: 'TUESDAY', timeZone: 'America/Vancouver' },
      label: 'modern settings before legacy'
    },
    {
      installation: {
        legacyMetafield: {
          value: JSON.stringify({
            deliveryCycle: { cutoffTime: '18:00', cutoffWeekday: 'WEDNESDAY', timeZone: 'America/Toronto' }
          })
        },
        metafield: null
      },
      expected: { cutoffTime: '18:00', cutoffWeekday: 'WEDNESDAY', timeZone: 'America/Vancouver' },
      label: 'legacy settings when modern is absent'
    }
  ])('uses $label while keeping shop.ianaTimezone authoritative', ({ expected, installation }) => {
    expect(readShopifyDeliveryCycle({
      currentAppInstallation: installation,
      shop: { ianaTimezone: 'America/Vancouver' }
    })).toEqual(expected);
  });

  test.each([
    ['missing encryption key', false, true],
    ['missing stored shop token', true, false]
  ] as const)('%s fails with the typed settings error before order writes', async (_label, withEncryptionKey, withToken) => {
    const { prisma, orderWrite, transaction } = createPrismaHarness({ withToken });
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = requiredRuntime(prisma, { withEncryptionKey });

    await expect(runtime.dependencies.orderSyncService.syncOrdersSnapshot({
      appId: 'clever',
      orders: [shopifyOrder()],
      reason: 'orders_page_open',
      shopDomain,
      source: 'clever-app-orders',
      subject: 'shopify-user-id'
    })).rejects.toBeInstanceOf(ShopifyDeliverySettingsError);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(orderWrite).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  test.each([
    ['invalid settings', () => Promise.resolve(graphqlResponse({
      currentAppInstallation: { legacyMetafield: null, metafield: { value: '{invalid-json' } },
      shop: { ianaTimezone: 'America/Toronto' }
    }))],
    ['settings read failure', () => Promise.reject(new Error('private upstream failure'))]
  ] as const)('%s returns a safe typed 503 instead of falling back to the request cycle', async (_label, fetchResult) => {
    const { prisma, orderWrite, transaction } = createPrismaHarness();
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return fetchResult();
    });
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = requiredRuntime(prisma, { withEncryptionKey: true });
    const app = await buildApp({ adminOrders: runtime.dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${signSessionToken()}` },
        method: 'PATCH',
        payload: {
          deliveryCycle: {
            cutoffTime: '01:00',
            cutoffWeekday: 'SUNDAY',
            timeZone: 'America/Halifax'
          },
          orders: [shopifyOrder()],
          reason: 'orders_page_open',
          source: 'clever-app-orders'
        },
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'SHOPIFY_DELIVERY_SETTINGS_UNAVAILABLE',
          message: 'Shopify delivery settings or shop timezone are unavailable; retry synchronization.'
        }
      });
      expect(response.body).not.toContain('private upstream failure');
      expect(response.body).not.toContain('UNAUTHORIZED');
      expect(orderWrite).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

function requiredRuntime(prisma: PrismaClient, options: { withEncryptionKey: boolean }) {
  const runtime = loadAdminOrdersRuntime({
    env: {
      SHOPIFY_API_KEY: mainClientId,
      SHOPIFY_API_SECRET: mainClientSecret,
      SHOPIFY_API_VERSION: '2026-04',
      SHOPIFY_DEV_API_KEY: devClientId,
      SHOPIFY_DEV_API_SECRET: devClientSecret,
      ...(options.withEncryptionKey ? { SHOPIFY_TOKEN_ENCRYPTION_KEY: encryptionKey } : {})
    },
    prisma
  });
  if (runtime === undefined) throw new Error('Expected admin orders runtime');
  return runtime;
}

function createPrismaHarness(options: { appId?: string; withToken?: boolean } = {}) {
  const token = options.withToken === false ? null : shopTokenRow(options.appId ?? 'clever');
  const orderWrite = vi.fn();
  const shopFindUnique = vi.fn((args: { select: Record<string, unknown>; where: unknown }) => {
    if ('adminAccessTokenCiphertext' in args.select) return Promise.resolve(token);
    return Promise.resolve({ id: 'shop-record-id' });
  });
  const transaction = vi.fn(() => Promise.reject(new Error('Unexpected transaction')));
  const prisma = {
    $transaction: transaction,
    order: {
      create: orderWrite,
      update: orderWrite,
      upsert: orderWrite
    },
    shop: {
      create: orderWrite,
      findFirst: vi.fn(() => Promise.resolve({ id: 'shop-record-id' })),
      findUnique: shopFindUnique,
      updateMany: orderWrite,
      upsert: orderWrite
    }
  } as unknown as PrismaClient;
  return { orderWrite, prisma, shopFindUnique, transaction };
}

function shopTokenRow(appId: string): ShopTokenRow {
  const now = new Date('2026-10-02T05:00:00.000Z');
  const accessToken = appId === 'clever-route-dev' ? 'shpat_dev_access_token' : 'shpat_main_access_token';
  return {
    adminAccessTokenCiphertext: encryptSecret(accessToken, {
      aad: `shopify-admin-token:access:${shopDomain}`,
      key: loadTokenEncryptionKey(encryptionKey)
    }),
    adminAccessTokenExpiresAt: null,
    adminRefreshTokenCiphertext: null,
    adminRefreshTokenExpiresAt: null,
    apiVersion: '2026-04',
    appId,
    createdAt: now,
    installedAt: now,
    shopDomain,
    shopifyShopGid: 'gid://shopify/Shop/1',
    tokenIssuedAt: now,
    tokenScopes: ['read_orders'],
    uninstalledAt: null,
    updatedAt: now
  };
}

function graphqlResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { 'content-type': 'application/json' },
    status: 200
  });
}

function signSessionToken(): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    aud: mainClientId,
    dest: `https://${shopDomain}`,
    exp: nowSeconds + 60,
    iat: nowSeconds,
    iss: `https://${shopDomain}/admin`,
    jti: 'delivery-settings-dependencies-test',
    nbf: nowSeconds - 5,
    sid: 'delivery-settings-test-session',
    sub: 'shopify-user-id'
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', mainClientSecret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

function shopifyOrder(): ShopifyOrderNode {
  return {
    cancelledAt: null,
    createdAt: '2026-05-05T14:00:00.000Z',
    currentTotalPriceSet: { shopMoney: { amount: '95.00', currencyCode: 'CAD' } },
    customAttributes: [
      { key: 'Delivery Area', value: 'Mississauga' },
      { key: 'Delivery Day', value: 'Friday 5pm to 9pm *Check delivery map' }
    ],
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: 'customer@example.com',
    id: 'gid://shopify/Order/123',
    legacyResourceId: '123',
    lineItems: { nodes: [] },
    name: '#1035',
    note: null,
    paymentGatewayNames: [],
    phone: null,
    processedAt: '2026-05-07T12:00:00.000Z',
    shippingAddress: null,
    updatedAt: '2026-05-07T13:00:00.000Z'
  };
}
