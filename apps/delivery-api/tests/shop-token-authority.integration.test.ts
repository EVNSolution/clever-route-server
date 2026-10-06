import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { loadTokenEncryptionKey } from '../src/modules/security/token-encryption.js';
import { PrismaShopTokenRepository } from '../src/modules/shopify/shop-token.repository.js';
import { ShopTokenService } from '../src/modules/shopify/shop-token.service.js';
import { PrismaShopifyWebhookEventRepository } from '../src/modules/shopify/webhook-event.repository.js';

type RefreshOfflineToken = (input: {
  appId?: string | undefined;
  refreshToken: string;
  shopDomain: string;
}) => Promise<{
  accessToken: string;
  expiresIn: number | null;
  refreshToken: string | null;
  refreshTokenExpiresIn: number | null;
  scope: string;
}>;

const databaseUrl = process.env.SHOPIFY_TOKEN_AUTHORITY_DATABASE_URL;
const enabled = process.env.G006_DATABASE_TARGET_CLASS === 'safe-local-g006-disposable'
  && databaseUrl?.includes('127.0.0.1:55490/clever_g006') === true;
const describeDatabase = enabled ? describe : describe.skip;
const clients: PrismaClient[] = [];
const encryptionKey = loadTokenEncryptionKey(
  'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
);

describeDatabase('Shopify offline token authority PostgreSQL serialization', () => {
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
  });

  test('serializes concurrent refreshes across service instances for one app and shop', async () => {
    const firstPrisma = createClient();
    const secondPrisma = createClient();
    const shopDomain = uniqueShopDomain('refresh-race');
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const refreshOfflineToken = vi.fn(async () => {
      await refreshGate;
      return {
        accessToken: 'shpat_one_canonical_access_token',
        expiresIn: 3_600,
        refreshToken: 'shprt_one_canonical_refresh_token',
        refreshTokenExpiresIn: 7_776_000,
        scope: 'read_orders'
      };
    });
    const first = createService(firstPrisma, refreshOfflineToken);
    const second = createService(secondPrisma, refreshOfflineToken);

    await first.storeAdminApiToken({
      appId: 'clever-route-kfood',
      accessToken: 'shpat_expired',
      accessTokenExpiresAt: new Date('2026-05-07T01:00:00.000Z'),
      apiVersion: '2026-07',
      refreshToken: 'shprt_initial',
      refreshTokenExpiresAt: new Date('2026-08-05T00:00:00.000Z'),
      shopDomain,
      tokenScopes: ['read_orders']
    });

    const requests = Array.from({ length: 20 }, (_, index) => {
      const service = index % 2 === 0 ? first : second;
      return index % 3 === 0
        ? service.getAdminAccessToken({ appId: 'clever-route-kfood', shopDomain })
        : service.getOfflineToken({ appId: 'clever-route-kfood', shopDomain });
    });
    await vi.waitFor(() => expect(refreshOfflineToken).toHaveBeenCalledTimes(1));
    releaseRefresh();
    const results = await Promise.all(requests);

    expect(refreshOfflineToken).toHaveBeenCalledTimes(1);
    expect(results.every((result) => typeof result === 'string'
      ? result === 'shpat_one_canonical_access_token'
      : result?.accessToken === 'shpat_one_canonical_access_token')).toBe(true);
    expect(results.every((result) => typeof result === 'string'
      || (result !== null && !('refreshToken' in result)))).toBe(true);
    await firstPrisma.shop.delete({
      where: { appId_shopDomain: { appId: 'clever-route-kfood', shopDomain } }
    });
  });

  test('keeps the same shop isolated by app id while allowing both authorities to progress', async () => {
    const firstPrisma = createClient();
    const secondPrisma = createClient();
    const shopDomain = uniqueShopDomain('app-isolation');
    let releaseRefreshes!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefreshes = resolve; });
    const refreshOfflineToken: RefreshOfflineToken = vi.fn(async ({ appId }) => {
      await refreshGate;
      return {
        accessToken: `shpat_${appId ?? 'clever'}_access_token`,
        expiresIn: 3_600,
        refreshToken: `shprt_${appId ?? 'clever'}_refresh_token`,
        refreshTokenExpiresIn: 7_776_000,
        scope: 'read_orders'
      };
    });
    const first = createService(firstPrisma, refreshOfflineToken);
    const second = createService(secondPrisma, refreshOfflineToken);

    await Promise.all([
      first.storeAdminApiToken(expiredTokenInput('clever-route-kfood', shopDomain)),
      second.storeAdminApiToken(expiredTokenInput('clever-route-south', shopDomain))
    ]);

    const resultsPromise = Promise.all([
      first.getOfflineToken({ appId: 'clever-route-kfood', shopDomain }),
      second.getOfflineToken({ appId: 'clever-route-south', shopDomain })
    ]);
    await vi.waitFor(() => expect(refreshOfflineToken).toHaveBeenCalledTimes(2));
    releaseRefreshes();
    const results = await resultsPromise;

    expect(results.map((result) => result?.accessToken).sort()).toEqual([
      'shpat_clever-route-kfood_access_token',
      'shpat_clever-route-south_access_token'
    ]);
    await Promise.all([
      firstPrisma.shop.delete({ where: { appId_shopDomain: { appId: 'clever-route-kfood', shopDomain } } }),
      secondPrisma.shop.delete({ where: { appId_shopDomain: { appId: 'clever-route-south', shopDomain } } })
    ]);
  });

  test('lets shop redaction wait for an in-flight refresh, then removes and fences the token row', async () => {
    const tokenPrisma = createClient();
    const redactionPrisma = createClient();
    const shopDomain = uniqueShopDomain('refresh-redact');
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const refreshOfflineToken: RefreshOfflineToken = vi.fn(async () => {
      await refreshGate;
      return {
        accessToken: 'shpat_about_to_be_redacted',
        expiresIn: 3_600,
        refreshToken: 'shprt_about_to_be_redacted',
        refreshTokenExpiresIn: 7_776_000,
        scope: 'read_orders'
      };
    });
    const tokens = createService(tokenPrisma, refreshOfflineToken);
    const webhooks = new PrismaShopifyWebhookEventRepository(redactionPrisma);
    await tokens.storeAdminApiToken(expiredTokenInput('clever-route-kfood', shopDomain));

    const refresh = tokens.getOfflineToken({ appId: 'clever-route-kfood', shopDomain });
    await vi.waitFor(() => expect(refreshOfflineToken).toHaveBeenCalledTimes(1));
    let redactionSettled = false;
    const webhookId = randomUUID();
    const rawBody = JSON.stringify({ shop_domain: shopDomain, shop_id: 99123 });
    const redaction = webhooks.recordWebhook({
      appId: 'clever-route-kfood',
      apiVersion: '2026-07',
      eventId: null,
      payload: { shop_domain: shopDomain, shop_id: 99123 },
      rawBody,
      shopDomain,
      topic: 'shop/redact',
      triggeredAt: new Date(),
      webhookId
    }).finally(() => { redactionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(redactionSettled).toBe(false);

    releaseRefresh();
    await expect(refresh).resolves.toMatchObject({ accessToken: 'shpat_about_to_be_redacted' });
    await expect(redaction).resolves.toMatchObject({ duplicate: false, status: 'PROCESSED' });
    await expect(tokens.getOfflineToken({ appId: 'clever-route-kfood', shopDomain })).resolves.toBeNull();
    expect(refreshOfflineToken).toHaveBeenCalledTimes(1);
    await expect(tokenPrisma.shop.findUnique({
      where: { appId_shopDomain: { appId: 'clever-route-kfood', shopDomain } }
    })).resolves.toBeNull();

    await redactionPrisma.shopifyRedactedWebhookReceipt.deleteMany({
      where: { appId: 'clever-route-kfood', shopDomain }
    });
    await redactionPrisma.shopifyShopRedactionTombstone.delete({
      where: { appId_shopDomain: { appId: 'clever-route-kfood', shopDomain } }
    });
  });
});

function createClient(): PrismaClient {
  const scopedUrl = `${databaseUrl ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled'}${databaseUrl?.includes('?') === true ? '&' : '?'}connection_limit=4`;
  const client = new PrismaClient({ datasourceUrl: scopedUrl });
  clients.push(client);
  return client;
}

function createService(
  prisma: PrismaClient,
  refreshOfflineToken: RefreshOfflineToken
): ShopTokenService {
  return new ShopTokenService({
    encryptionKey,
    now: () => new Date('2026-05-07T03:00:00.000Z'),
    repository: new PrismaShopTokenRepository(prisma),
    tokenRefreshClient: { refreshOfflineToken }
  });
}

function expiredTokenInput(appId: string, shopDomain: string) {
  return {
    appId,
    accessToken: `shpat_${appId}_expired`,
    accessTokenExpiresAt: new Date('2026-05-07T01:00:00.000Z'),
    apiVersion: '2026-07',
    refreshToken: `shprt_${appId}_initial`,
    refreshTokenExpiresAt: new Date('2026-08-05T00:00:00.000Z'),
    shopDomain,
    tokenScopes: ['read_orders']
  };
}

function uniqueShopDomain(label: string): string {
  return `g006-token-${label}-${randomUUID().slice(0, 8)}.myshopify.com`;
}
