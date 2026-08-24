import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { PrismaDriverProofMediaRepository } from '../src/modules/driver/driver-proof-media.repository.js';
import {
  DriverEventStopTransitionConflictError,
  PrismaDriverEventRepository
} from '../src/modules/driver/driver-event.repository.js';
import { mapShopifyOrderNodeToDeliveryInputs, type ShopifyOrderNode } from '../src/modules/shopify/order-sync.mapper.js';
import { PrismaOrderSyncRepository } from '../src/modules/shopify/order-sync.repository.js';
import { PrismaShopifyWebhookEventRepository } from '../src/modules/shopify/webhook-event.repository.js';
import { PrismaShopTokenRepository } from '../src/modules/shopify/shop-token.repository.js';
import { assertShopifyShopPrivacyWriteAllowed } from '../src/modules/shopify/order-privacy-redaction.js';
import { cleanupRouteOperationalEvidence } from '../src/modules/operations/route-operational-evidence-retention.js';
import {
  persistRouteTrackingGeometryPosition,
  readRouteTrackingGeometryDocument
} from '../src/modules/route-tracking/route-tracking.geometry.js';

const databaseUrl = process.env.SHOPIFY_WEBHOOK_DURABILITY_DATABASE_URL;
const enabled = (
  process.env.G006_DATABASE_TARGET_CLASS === 'safe-local-g006-disposable'
  && databaseUrl?.includes('127.0.0.1:55490/clever_g006') === true
) || (
  process.env.SHOP_PRIVACY_INVARIANT_DATABASE_TARGET_CLASS === 'safe-local-disposable'
  && databaseUrl?.includes('127.0.0.1') === true
);
const describeDatabase = enabled ? describe : describe.skip;
const clientSecret = 'g006-disposable-secret';
const clients: PrismaClient[] = [];

describeDatabase('Shopify order webhook PostgreSQL durability', () => {
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
  });

  test('validates HMAC against the exact whitespace and key order before durable admission', async () => {
    const prisma = createClient();
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const app = await buildApp({
      shopifyWebhook: {
        appCredentials: [{ appId: 'clever', clientSecret }],
        orderWebhookProcessor: { canProcessTopic: () => true },
        webhookService: repository
      }
    });
    const rawBody = '{\n  "name": "#G006",\n  "id": 6001\n}';
    const webhookId = randomUUID();
    const shopDomain = uniqueShopDomain('raw');

    try {
      const response = await app.inject({
        headers: webhookHeaders({ rawBody, shopDomain, webhookId }),
        method: 'POST',
        payload: rawBody,
        url: '/shopify/webhooks'
      });

      expect(response.statusCode).toBe(202);
      const shop = await prisma.shop.findUniqueOrThrow({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } });
      const event = await prisma.shopifyWebhookEvent.findUniqueOrThrow({
        where: { shopId_webhookId: { shopId: shop.id, webhookId } }
      });
      expect(event.rawBodySha256).toHaveLength(64);
      expect(event.payload).toEqual({
        admin_graphql_api_id: 'gid://shopify/Order/6001',
        orderId: 'gid://shopify/Order/6001',
        redacted: true,
        schema: 'shopify_order_reference_v1'
      });
      await prisma.shopifyWebhookEvent.delete({ where: { id: event.id } });
    } finally {
      await app.close();
    }
  });

  test('rejects valid-HMAC malformed JSON without creating shop or inbox state', async () => {
    const prisma = createClient();
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const app = await buildApp({
      shopifyWebhook: {
        appCredentials: [{ appId: 'clever', clientSecret }],
        webhookService: repository
      }
    });
    const rawBody = '{"id":6008,"email":"private-customer@g008.invalid"';
    const webhookId = randomUUID();
    const shopDomain = uniqueShopDomain('malformed');

    try {
      const response = await app.inject({
        headers: webhookHeaders({ rawBody, shopDomain, webhookId }),
        method: 'POST',
        payload: rawBody,
        url: '/shopify/webhooks'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' }
      });
      expect(await prisma.shop.count({ where: { appId: 'clever', shopDomain } })).toBe(0);
      expect(await prisma.shopifyWebhookEvent.count({
        where: { shop: { appId: 'clever', shopDomain }, webhookId }
      })).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('returns Shopify-compatible first and duplicate shop redaction receipts', async () => {
    const prisma = createClient();
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const app = await buildApp({
      shopifyWebhook: { appCredentials: [{ appId: 'clever', clientSecret }], webhookService: repository }
    });
    const shopDomain = uniqueShopDomain('redact-route-receipt');
    const webhookId = randomUUID();
    const rawBody = JSON.stringify({ shop_domain: shopDomain, shop_id: 99200 });
    const request = {
      headers: webhookHeaders({ rawBody, shopDomain, topic: 'shop/redact', webhookId }),
      method: 'POST' as const,
      payload: rawBody,
      url: '/shopify/webhooks'
    };
    try {
      const first = await app.inject(request);
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({ data: { duplicate: false, status: 'PROCESSED', webhookId } });
      const retry = await app.inject(request);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ data: { duplicate: true, status: 'IGNORED', webhookId } });
    } finally {
      await app.close();
    }
  });

  test('admits concurrent deliveries for one shop and webhook id exactly once', async () => {
    const prisma = createClient();
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const shopDomain = uniqueShopDomain('race');
    const webhookId = randomUUID();
    const input = webhookInput({ shopDomain, webhookId });

    const results = await Promise.all(Array.from({ length: 12 }, () => repository.recordWebhook(input)));

    const shop = await prisma.shop.findUniqueOrThrow({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } });
    expect(await prisma.shopifyWebhookEvent.count({ where: { shopId: shop.id, webhookId } })).toBe(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    await prisma.shopifyWebhookEvent.delete({ where: { shopId_webhookId: { shopId: shop.id, webhookId } } });
  });

  test('retains only replay identity through processing and retry then terminalizes while preserving duplicate acceptance', async () => {
    const prisma = createClient();
    await clearDueWebhookFixtures(prisma);
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const shopDomain = uniqueShopDomain('payload-lifecycle');
    const webhookId = randomUUID();
    const input = webhookInput({ shopDomain, webhookId, payload: {
      admin_graphql_api_id: 'gid://shopify/Order/6009',
      email: 'private-customer@g008.invalid',
      id: 6009,
      phone: '+1 519 555 6009',
      shipping_address: { address1: '6009 Private Street' }
    } });
    await repository.recordWebhook(input);
    const claimAt = new Date(Date.now() + 60_000);
    const first = await repository.claimNextOrderWebhook({ leaseMs: 1_000, now: claimAt, workerId: 'retry-worker' });
    if (first.action !== 'process') throw new Error('expected first claim');
    expect(first.event.payload).toEqual({ admin_graphql_api_id: 'gid://shopify/Order/6009', orderId: 'gid://shopify/Order/6009', redacted: true, schema: 'shopify_order_reference_v1' });
    const processingRow = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id: first.event.id } });
    expect(processingRow.status).toBe('PROCESSING');
    expect(JSON.stringify(processingRow.payload)).not.toMatch(/private-customer|email|phone|address/iu);
    await repository.markOrderWebhookFailed({
      ...first.event,
      error: 'TRANSIENT:fixture',
      nextRunAt: new Date(claimAt.getTime() + 2_000)
    });
    const retryRow = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id: first.event.id } });
    expect(retryRow.status).toBe('RETRY_WAIT');
    expect(retryRow.payload).toEqual({ admin_graphql_api_id: 'gid://shopify/Order/6009', orderId: 'gid://shopify/Order/6009', redacted: true, schema: 'shopify_order_reference_v1' });
    expect(JSON.stringify(retryRow.payload)).not.toMatch(/private-customer|email|phone|address/iu);

    const second = await repository.claimNextOrderWebhook({
      leaseMs: 1_000,
      now: new Date(claimAt.getTime() + 3_000),
      workerId: 'success-worker'
    });
    if (second.action !== 'process') throw new Error('expected retry claim');
    expect(await repository.markOrderWebhookProcessed(second.event)).toBe(true);
    const processed = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id: first.event.id } });
    expect(processed.payload).toEqual({
      redacted: true,
      schema: 'shopify_webhook_tombstone_v1',
      terminalStatus: 'PROCESSED'
    });
    expect(processed.payloadRedactedAt).not.toBeNull();
    expect(JSON.stringify(processed.payload)).not.toMatch(/private|email|phone|address/iu);

    await expect(repository.recordWebhook(input)).resolves.toMatchObject({ duplicate: true, status: 'PROCESSED' });
    expect(await prisma.shopifyWebhookEvent.count({ where: { id: first.event.id } })).toBe(1);
  });

  test('customers redact scrubs matching historical order inbox payload to replay-only identity', async () => {
    const prisma = createClient();
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const shopDomain = uniqueShopDomain('customer-redact');
    const orderWebhookId = randomUUID();
    await repository.recordWebhook(webhookInput({ shopDomain, webhookId: orderWebhookId, payload: {
      admin_graphql_api_id: 'gid://shopify/Order/6010',
      email: 'redact-me@g008.invalid',
      id: 6010,
      shipping_address: { address1: '6010 Erase Avenue' }
    } }));
    const redactPayload = {
      customer: { email: 'redact-me@g008.invalid', id: 88, phone: '+1 519 555 6010' },
      orders_to_redact: [6010],
      shop_domain: shopDomain
    };
    await repository.recordWebhook({
      apiVersion: '2026-07',
      eventId: randomUUID(),
      payload: redactPayload,
      rawBody: JSON.stringify(redactPayload),
      shopDomain,
      topic: 'customers/redact',
      triggeredAt: new Date(),
      webhookId: randomUUID()
    });

    const shop = await prisma.shop.findUniqueOrThrow({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } });
    const historical = await prisma.shopifyWebhookEvent.findUniqueOrThrow({
      where: { shopId_webhookId: { shopId: shop.id, webhookId: orderWebhookId } }
    });
    expect(historical.payload).toEqual({
      admin_graphql_api_id: 'gid://shopify/Order/6010',
      orderId: 'gid://shopify/Order/6010',
      redacted: true,
      schema: 'shopify_order_reference_v1'
    });
    expect(JSON.stringify(historical.payload)).not.toMatch(/redact-me|Erase Avenue|email|address/iu);
  });

  test('shop redact atomically tombstones the tenant and suppresses late order admission and retry', async () => {
    const prisma = createClient();
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const shopDomain = uniqueShopDomain('shop-redact-late');
    const orderInput = webhookInput({ shopDomain, webhookId: randomUUID(), payload: { id: 6100 } });
    await repository.recordWebhook(orderInput);
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { appId_shopDomain: { appId: 'clever', shopDomain } }
    });
    expect(await prisma.shopifyWebhookEvent.count({ where: { shopId: shop.id } })).toBe(1);

    const redactPayload = { shop_domain: shopDomain, shop_id: 99100 };
    await expect(repository.recordWebhook({
      ...webhookInput({ shopDomain, webhookId: randomUUID() }),
      payload: redactPayload,
      rawBody: JSON.stringify(redactPayload),
      topic: 'shop/redact'
    })).resolves.toMatchObject({ status: 'PROCESSED' });

    expect(await prisma.shop.findUnique({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } })).toBeNull();
    expect(await prisma.shopifyWebhookEvent.count({ where: { shopId: shop.id } })).toBe(0);
    expect(await prisma.shopifyShopRedactionTombstone.findUnique({
      where: { appId_shopDomain: { appId: 'clever', shopDomain } }
    })).toMatchObject({ shopDomain });
    await expect(repository.recordWebhook(orderInput)).resolves.toEqual({
      duplicate: true,
      status: 'IGNORED',
      webhookId: orderInput.webhookId
    });
    await expect(repository.recordWebhook({ ...orderInput, webhookId: randomUUID() })).resolves.toMatchObject({
      duplicate: true,
      status: 'IGNORED'
    });
    expect(await prisma.shop.findUnique({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } })).toBeNull();
  });

  test('database guard rejects direct Shop inserts behind active privacy tombstones', async () => {
    const prisma = createClient();
    const insertDomain = uniqueShopDomain('privacy-db-insert');

    await prisma.shopifyShopRedactionTombstone.create({
      data: {
        appId: 'clever',
        complianceWebhookId: randomUUID(),
        redactedAt: new Date('2026-08-25T00:00:00.000Z'),
        shopDomain: insertDomain
      }
    });

    await expect(prisma.shop.create({ data: { appId: 'clever', shopDomain: insertDomain } }))
      .rejects.toThrow('Shop write blocked by active privacy tombstone');
  });

  test('keeps unchanged Release 1 token repository paths compatible after the trigger migration', async () => {
    const prisma = createClient();
    const tokens = new PrismaShopTokenRepository(prisma);
    const webhooks = new PrismaShopifyWebhookEventRepository(prisma);
    const normalDomain = uniqueShopDomain('release1-normal-install');
    const reinstallDomain = uniqueShopDomain('release1-verified-reinstall');
    const reinstallAt = new Date('2030-01-01T02:00:00.000Z');

    await expect(tokens.upsertShopToken({
      ...tokenInput(normalDomain),
      installedAt: new Date('2026-08-25T01:00:00.000Z')
    })).resolves.toMatchObject({ shopDomain: normalDomain });

    await prisma.shopifyShopRedactionTombstone.create({
      data: {
        appId: 'clever',
        complianceWebhookId: randomUUID(),
        redactedAt: new Date('2029-01-01T00:00:00.000Z'),
        shopDomain: reinstallDomain
      }
    });
    await expect(tokens.upsertShopToken({
      ...tokenInput(reinstallDomain),
      installedAt: reinstallAt
    })).resolves.toMatchObject({ shopDomain: reinstallDomain });
    expect(await prisma.shopifyShopRedactionTombstone.findUniqueOrThrow({
      where: { appId_shopDomain: { appId: 'clever', shopDomain: reinstallDomain } }
    })).toMatchObject({ reinstalledAt: reinstallAt });

    const delayedWebhookId = randomUUID();
    await expect(webhooks.recordWebhook({
      ...webhookInput({ shopDomain: reinstallDomain, webhookId: delayedWebhookId, payload: { id: 6199 } }),
      triggeredAt: new Date('2029-12-31T23:59:00.000Z')
    })).resolves.toEqual({ duplicate: true, status: 'IGNORED', webhookId: delayedWebhookId });
  });

  test('preserves redaction receipts across reinstall and fences stale refresh and prior-install webhooks', async () => {
    const prisma = createClient();
    const webhooks = new PrismaShopifyWebhookEventRepository(prisma);
    const tokens = new PrismaShopTokenRepository(prisma);
    const shopDomain = uniqueShopDomain('shop-redact-reinstall');
    const beforeRedact = new Date('2020-01-01T01:00:00.000Z');
    const reinstallAt = new Date('2030-01-01T02:00:00.000Z');
    const afterReinstall = new Date('2030-01-01T03:00:00.000Z');
    const oldOrder = webhookInput({ shopDomain, webhookId: randomUUID(), payload: { id: 6110 } });
    await webhooks.recordWebhook({ ...oldOrder, triggeredAt: beforeRedact });
    const oldShop = await prisma.shop.findUniqueOrThrow({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } });
    const staleTokenSnapshot = oldShop;
    const redactWebhookId = randomUUID();
    const redactPayload = { shop_domain: shopDomain, shop_id: 99110 };
    const redact = {
      ...webhookInput({ shopDomain, webhookId: redactWebhookId }),
      payload: redactPayload,
      rawBody: JSON.stringify(redactPayload),
      topic: 'shop/redact'
    };
    await expect(webhooks.recordWebhook(redact)).resolves.toEqual({
      duplicate: false, status: 'PROCESSED', webhookId: redactWebhookId
    });

    await expect(tokens.updateRefreshedShopToken(tokenInput(shopDomain), staleTokenSnapshot)).resolves.toBeNull();
    expect(await prisma.shop.findUnique({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } })).toBeNull();
    await expect(tokens.upsertShopToken({ ...tokenInput(shopDomain), installedAt: beforeRedact }))
      .rejects.toMatchObject({ name: 'ShopTokenInstallSupersededError' });
    expect(await prisma.shop.findUnique({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } })).toBeNull();

    await expect(prisma.$transaction(async (tx) => {
      await assertShopifyShopPrivacyWriteAllowed(tx, { appId: 'clever', shopDomain });
      return tx.shop.create({ data: { appId: 'clever', shopDomain } });
    })).rejects.toMatchObject({ code: 'SHOP_PRIVACY_REDACTED' });
    await expect(prisma.shop.create({ data: { appId: 'clever', shopDomain } }))
      .rejects.toThrow('Shop write blocked by active privacy tombstone');
    // Release 1 remains rollback-compatible after the contract migration: its
    // verified-install path reactivates the tombstone before writing Shop.
    await tokens.upsertShopToken({ ...tokenInput(shopDomain), installedAt: reinstallAt });
    await expect(tokens.updateRefreshedShopToken({
      ...tokenInput(shopDomain),
      adminAccessTokenCiphertext: 'stale-refresh-ciphertext'
    }, staleTokenSnapshot)).resolves.toMatchObject({ adminAccessTokenCiphertext: 'ciphertext-access' });
    const epoch = await prisma.shopifyShopRedactionTombstone.findUniqueOrThrow({
      where: { appId_shopDomain: { appId: 'clever', shopDomain } }
    });
    expect(epoch.reinstalledAt).toEqual(reinstallAt);
    await expect(tokens.upsertShopToken({
      ...tokenInput(shopDomain),
      adminAccessTokenCiphertext: 'stale-ciphertext',
      installedAt: beforeRedact
    })).rejects.toMatchObject({ name: 'ShopTokenInstallSupersededError' });
    expect((await prisma.shop.findUniqueOrThrow({
      where: { appId_shopDomain: { appId: 'clever', shopDomain } }
    })).adminAccessTokenCiphertext).toBe('ciphertext-access');
    await tokens.upsertShopToken({ ...tokenInput(shopDomain), installedAt: afterReinstall });
    expect((await prisma.shopifyShopRedactionTombstone.findUniqueOrThrow({
      where: { appId_shopDomain: { appId: 'clever', shopDomain } }
    })).reinstalledAt).toEqual(reinstallAt);

    await expect(webhooks.recordWebhook(redact)).resolves.toEqual({
      duplicate: true, status: 'IGNORED', webhookId: redactWebhookId
    });
    expect(await prisma.shop.findUnique({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } })).not.toBeNull();

    const delayedOldRedactId = randomUUID();
    await expect(webhooks.recordWebhook({
      ...redact,
      triggeredAt: beforeRedact,
      webhookId: delayedOldRedactId
    })).resolves.toEqual({ duplicate: true, status: 'IGNORED', webhookId: delayedOldRedactId });
    expect(await prisma.shop.findUnique({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } })).not.toBeNull();

    const delayedOldId = randomUUID();
    await expect(webhooks.recordWebhook({
      ...webhookInput({ shopDomain, webhookId: delayedOldId, payload: { id: 6111 } }),
      triggeredAt: beforeRedact
    })).resolves.toEqual({ duplicate: true, status: 'IGNORED', webhookId: delayedOldId });
    expect(await prisma.shopifyRedactedWebhookReceipt.findUnique({
      where: { appId_shopDomain_webhookId: { appId: 'clever', shopDomain, webhookId: delayedOldId } }
    })).not.toBeNull();

    const currentOrderId = randomUUID();
    await expect(webhooks.recordWebhook({
      ...webhookInput({ shopDomain, webhookId: currentOrderId, payload: { id: 6112 } }),
      triggeredAt: afterReinstall
    })).resolves.toMatchObject({ duplicate: false, webhookId: currentOrderId });

    const newRedactId = randomUUID();
    await expect(webhooks.recordWebhook({ ...redact, triggeredAt: afterReinstall, webhookId: newRedactId })).resolves.toEqual({
      duplicate: false, status: 'PROCESSED', webhookId: newRedactId
    });
    expect(await prisma.shop.findUnique({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } })).toBeNull();

    const concurrentReinstallAt = new Date('2040-01-01T00:00:00.000Z');
    const concurrent = await Promise.allSettled([
      prisma.shop.upsert({
        create: { appId: 'clever', shopDomain },
        update: {},
        where: { appId_shopDomain: { appId: 'clever', shopDomain } }
      }),
      tokens.upsertShopToken({ ...tokenInput(shopDomain), installedAt: concurrentReinstallAt })
    ]);
    expect(concurrent[1]?.status).toBe('fulfilled');
    await expect(webhooks.recordWebhook({
      ...webhookInput({ shopDomain, webhookId: randomUUID(), payload: { id: 6113 } }),
      triggeredAt: new Date('2040-01-01T00:01:00.000Z')
    })).resolves.toMatchObject({ duplicate: false });
  });

  test('serializes rotating token refreshes without coupling CAS to unrelated Shop settings', async () => {
    const prisma = createClient();
    const tokens = new PrismaShopTokenRepository(prisma);
    const shopDomain = uniqueShopDomain('token-refresh-cas');
    await tokens.upsertShopToken({
      ...tokenInput(shopDomain),
      installedAt: new Date('2030-01-01T00:00:00.000Z')
    });
    const beforeSettings = await tokens.findByShopDomain({ appId: 'clever', shopDomain });
    if (beforeSettings === null) throw new Error('expected token snapshot');
    await prisma.shop.update({
      data: { defaultDepotAddress: 'non-token settings write' },
      where: { appId_shopDomain: { appId: 'clever', shopDomain } }
    });
    const afterSettings = await tokens.updateRefreshedShopToken({
      ...tokenInput(shopDomain),
      adminAccessTokenCiphertext: 'refresh-after-settings',
      tokenIssuedAt: new Date('2030-01-01T00:01:00.000Z')
    }, beforeSettings);
    expect(afterSettings?.adminAccessTokenCiphertext).toBe('refresh-after-settings');
    if (afterSettings === null) throw new Error('expected refreshed token');

    const [left, right] = await Promise.all([
      tokens.updateRefreshedShopToken({
        ...tokenInput(shopDomain), adminAccessTokenCiphertext: 'rotated-left', tokenIssuedAt: new Date('2030-01-01T00:02:00.000Z')
      }, afterSettings),
      tokens.updateRefreshedShopToken({
        ...tokenInput(shopDomain), adminAccessTokenCiphertext: 'rotated-right', tokenIssuedAt: new Date('2030-01-01T00:02:01.000Z')
      }, afterSettings)
    ]);
    const final = await tokens.findByShopDomain({ appId: 'clever', shopDomain });
    expect(final).not.toBeNull();
    expect(left?.adminAccessTokenCiphertext).toBe(final?.adminAccessTokenCiphertext);
    expect(right?.adminAccessTokenCiphertext).toBe(final?.adminAccessTokenCiphertext);
    expect(['rotated-left', 'rotated-right']).toContain(final?.adminAccessTokenCiphertext);
  });

  test('serializes concurrent shop redact and order admission to a redacted tenant', async () => {
    const prisma = createClient();
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const shopDomain = uniqueShopDomain('shop-redact-race');
    await repository.recordWebhook(webhookInput({ shopDomain, webhookId: randomUUID(), payload: { id: 6101 } }));
    const redactPayload = { shop_domain: shopDomain, shop_id: 99101 };

    await Promise.all([
      repository.recordWebhook(webhookInput({ shopDomain, webhookId: randomUUID(), payload: { id: 6102 } })),
      repository.recordWebhook({
        ...webhookInput({ shopDomain, webhookId: randomUUID() }),
        payload: redactPayload,
        rawBody: JSON.stringify(redactPayload),
        topic: 'shop/redact'
      })
    ]);

    expect(await prisma.shop.findUnique({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } })).toBeNull();
    expect(await prisma.shopifyShopRedactionTombstone.count({ where: { appId: 'clever', shopDomain } })).toBe(1);
  });

  test('serializes the common Shop writer fence ahead of redaction without post-redact recreation', async () => {
    const writer = createClient();
    const redactor = createClient();
    const repository = new PrismaShopifyWebhookEventRepository(redactor);
    const shopDomain = uniqueShopDomain('shop-writer-redact-race');
    let releaseWriter!: () => void;
    let signalWriterLocked!: () => void;
    const writerLocked = new Promise<void>((resolve) => { signalWriterLocked = resolve; });
    const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const write = writer.$transaction(async (tx) => {
      await assertShopifyShopPrivacyWriteAllowed(tx, { appId: 'clever', shopDomain });
      signalWriterLocked();
      await writerRelease;
      return tx.shop.upsert({
        create: { appId: 'clever', shopDomain },
        update: {},
        where: { appId_shopDomain: { appId: 'clever', shopDomain } }
      });
    });
    await writerLocked;
    const payload = { shop_domain: shopDomain, shop_id: 99102 };
    const redact = repository.recordWebhook({
      ...webhookInput({ shopDomain, webhookId: randomUUID() }),
      payload,
      rawBody: JSON.stringify(payload),
      topic: 'shop/redact'
    });
    releaseWriter();
    await Promise.all([write, redact]);

    expect(await writer.shop.findUnique({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } })).toBeNull();
    await expect(writer.$transaction(async (tx) => {
      await assertShopifyShopPrivacyWriteAllowed(tx, { appId: 'clever', shopDomain });
      return tx.shop.upsert({
        create: { appId: 'clever', shopDomain }, update: {}, where: { appId_shopDomain: { appId: 'clever', shopDomain } }
      });
    })).rejects.toMatchObject({ code: 'SHOP_PRIVACY_REDACTED' });
  }, 15_000);

  test('fences an abort-ignoring late order apply after its webhook lease is released', async () => {
    const prisma = createClient();
    const events = new PrismaShopifyWebhookEventRepository(prisma);
    const orders = new PrismaOrderSyncRepository(prisma);
    const shopDomain = uniqueShopDomain('late-order-claim');
    await events.recordWebhook(webhookInput({ shopDomain, webhookId: randomUUID(), payload: { id: 6103 } }));
    const first = await events.claimNextOrderWebhook({ leaseMs: 60_000, workerId: 'worker-old' });
    if (first.action !== 'process') throw new Error('expected first order webhook claim');
    await events.markOrderWebhookFailed({
      ...first.event,
      error: 'TRANSIENT:ORDER_WEBHOOK_PROCESSING_TIMEOUT',
      nextRunAt: new Date('2026-01-01T00:00:00.000Z')
    });
    const synced = mapShopifyOrderNodeToDeliveryInputs(orderNode(6103));

    await expect(orders.upsertOrderWithDeliveryStop({
      appId: 'clever',
      shopDomain,
      synced,
      webhookClaim: { eventId: first.event.id, leaseToken: first.event.leaseToken }
    })).resolves.toMatchObject({ reason: 'ORDER_WEBHOOK_CLAIM_LOST', status: 'skipped' });
    expect(await prisma.order.count({ where: { shopifyOrderLegacyId: 6103n } })).toBe(0);

    const retry = await events.claimNextOrderWebhook({ leaseMs: 60_000, workerId: 'worker-new' });
    if (retry.action !== 'process') throw new Error('expected retry order webhook claim');
    await expect(orders.upsertOrderWithDeliveryStop({
      appId: 'clever',
      shopDomain,
      synced,
      webhookClaim: { eventId: retry.event.id, leaseToken: retry.event.leaseToken }
    })).resolves.toMatchObject({ status: 'created' });
    expect(await prisma.order.count({ where: { shopifyOrderLegacyId: 6103n } })).toBe(1);
    await expect(events.markOrderWebhookFailed({
      ...retry.event,
      error: 'TRANSIENT:ORDER_WEBHOOK_PROCESSING_TIMEOUT',
      nextRunAt: new Date()
    })).resolves.toBe(false);
    await expect(prisma.shopifyWebhookEvent.findUniqueOrThrow({
      where: { id: retry.event.id }
    })).resolves.toMatchObject({ status: 'PROCESSED' });
  });

  test('prevents an in-flight claimed worker from recreating a redacted order and terminalizes its retry without PII', async () => {
    const prisma = createClient();
    await clearDueWebhookFixtures(prisma);
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const shopDomain = uniqueShopDomain('redact-race');
    const webhookId = randomUUID();
    const orderInput = webhookInput({
      payload: {
        admin_graphql_api_id: 'gid://shopify/Order/6006',
        email: 'race-private@g008.invalid',
        id: 6006,
        phone: '+1 519 555 6006',
        shipping_address: { address1: '6006 Race Street', name: 'Race Private' }
      },
      shopDomain,
      webhookId
    });
    await repository.recordWebhook(orderInput);
    const shop = await prisma.shop.findUniqueOrThrow({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } });
    const admitted = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { shopId_webhookId: { shopId: shop.id, webhookId } } });
    expect(admitted.payload).toEqual({ admin_graphql_api_id: 'gid://shopify/Order/6006', orderId: 'gid://shopify/Order/6006', redacted: true, schema: 'shopify_order_reference_v1' });
    expect(JSON.stringify(admitted.payload)).not.toMatch(/race-private|phone|address|name/iu);

    const claimed = await repository.claimNextOrderWebhook({
      leaseMs: 60_000,
      now: new Date(Date.now() + 60_000),
      workerId: 'privacy-race-worker'
    });
    if (claimed.action !== 'process') throw new Error('expected privacy race claim');
    await recordCustomerRedaction(repository, { legacyIds: [6006], shopDomain });

    const staleWrite = await new PrismaOrderSyncRepository(prisma).upsertOrderWithDeliveryStop({
      appId: 'clever',
      shopDomain,
      synced: mapShopifyOrderNodeToDeliveryInputs(orderNode(6006))
    });
    expect(staleWrite).toMatchObject({ reason: 'ORDER_PRIVACY_REDACTED', status: 'skipped' });
    expect(await prisma.order.count({ where: { shopId: shop.id, shopifyOrderLegacyId: 6006n } })).toBe(0);
    expect(await prisma.deliveryStop.count({ where: { shopId: shop.id } })).toBe(0);
    expect(await repository.markOrderWebhookProcessed(claimed.event)).toBe(true);
    const terminal = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id: claimed.event.id } });
    expect(terminal.status).toBe('PROCESSED');
    expect(JSON.stringify(terminal.payload)).not.toMatch(/race-private|phone|address|name/iu);
    await expect(repository.recordWebhook(orderInput)).resolves.toMatchObject({ duplicate: true, status: 'PROCESSED' });
    expect(await prisma.shopifyOrderRedactionTombstone.count({
      where: { appId: 'clever', shopId: shop.id, shopifyOrderLegacyId: 6006n }
    })).toBe(1);

    await expect(new PrismaOrderSyncRepository(prisma).upsertOrderWithDeliveryStop({
      appId: 'clever',
      shopDomain,
      synced: mapShopifyOrderNodeToDeliveryInputs(orderNode(6007))
    })).resolves.toMatchObject({ status: 'created' });
    expect(await prisma.order.count({ where: { shopId: shop.id, shopifyOrderLegacyId: 6007n } })).toBe(1);
  });

  test('serializes concurrent canonical upsert and customers redact to a permanently absent order', async () => {
    const prisma = createClient();
    await clearDueWebhookFixtures(prisma);
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const shopDomain = uniqueShopDomain('redact-concurrent');
    await repository.recordWebhook(webhookInput({ shopDomain, webhookId: randomUUID(), payload: { id: 6011 } }));
    const orderRepository = new PrismaOrderSyncRepository(createClient());

    await Promise.all([
      orderRepository.upsertOrderWithDeliveryStop({
        appId: 'clever',
        shopDomain,
        synced: mapShopifyOrderNodeToDeliveryInputs(orderNode(6011))
      }),
      recordCustomerRedaction(repository, { legacyIds: [6011], shopDomain })
    ]);

    const shop = await prisma.shop.findUniqueOrThrow({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } });
    expect(await prisma.order.count({ where: { shopId: shop.id, shopifyOrderLegacyId: 6011n } })).toBe(0);
    expect(await prisma.shopifyOrderRedactionTombstone.count({ where: { shopId: shop.id, shopifyOrderLegacyId: 6011n } })).toBe(1);
  });

  test('rolls back suppression, order deletion, inbox scrub, and receipt together on a compliance receipt fault', async () => {
    const prisma = createClient();
    await clearDueWebhookFixtures(prisma);
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const shopDomain = uniqueShopDomain('redact-atomic-fault');
    const webhookId = randomUUID();
    await repository.recordWebhook(webhookInput({ shopDomain, webhookId, payload: { id: 6020 } }));
    await new PrismaOrderSyncRepository(prisma).upsertOrderWithDeliveryStop({
      appId: 'clever',
      shopDomain,
      synced: mapShopifyOrderNodeToDeliveryInputs(orderNode(6020))
    });
    const shop = await prisma.shop.findUniqueOrThrow({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } });
    await prisma.shopifyWebhookEvent.update({
      data: { payload: { email: 'preexisting-private@g008.invalid', id: 6020 }, payloadRedactedAt: null },
      where: { shopId_webhookId: { shopId: shop.id, webhookId } }
    });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION g008_fail_customer_redact_receipt() RETURNS trigger AS $$
      BEGIN
        IF NEW.topic = 'customers/redact' THEN RAISE EXCEPTION 'injected compliance receipt fault'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER g008_fail_customer_redact_receipt
      BEFORE INSERT ON shopify_webhook_events
      FOR EACH ROW EXECUTE FUNCTION g008_fail_customer_redact_receipt();
    `);
    try {
      await expect(recordCustomerRedaction(repository, { legacyIds: [6020], shopDomain }))
        .rejects.toThrow('injected compliance receipt fault');
      expect(await prisma.order.count({ where: { shopId: shop.id, shopifyOrderLegacyId: 6020n } })).toBe(1);
      expect(await prisma.shopifyOrderRedactionTombstone.count({ where: { shopId: shop.id, shopifyOrderLegacyId: 6020n } })).toBe(0);
      const historical = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { shopId_webhookId: { shopId: shop.id, webhookId } } });
      expect(JSON.stringify(historical.payload)).toContain('preexisting-private@g008.invalid');
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS g008_fail_customer_redact_receipt ON shopify_webhook_events');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS g008_fail_customer_redact_receipt()');
      await prisma.shop.delete({ where: { id: shop.id } });
    }
  });

  test('keeps dead-letter replay evidence free of customer payload fields', async () => {
    const prisma = createClient();
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const shopDomain = uniqueShopDomain('dead-letter-minimal');
    const webhookId = randomUUID();
    await repository.recordWebhook(webhookInput({
      shopDomain,
      webhookId,
      payload: { email: 'dead-letter@g008.invalid', id: 6012, shipping_address: { address1: '6012 Private Street' } }
    }));
    const shop = await prisma.shop.findUniqueOrThrow({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } });
    await prisma.shopifyWebhookEvent.update({
      data: { deadLetteredAt: new Date(), status: 'DEAD_LETTER' },
      where: { shopId_webhookId: { shopId: shop.id, webhookId } }
    });
    const event = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { shopId_webhookId: { shopId: shop.id, webhookId } } });
    expect(event.payload).toEqual({ admin_graphql_api_id: 'gid://shopify/Order/6012', orderId: 'gid://shopify/Order/6012', redacted: true, schema: 'shopify_order_reference_v1' });
    expect(JSON.stringify(event.payload)).not.toMatch(/dead-letter|address|private/iu);
  });

  test('terminal retention is bounded and preserves retry, processing, dead-letter, and leased rows', async () => {
    const prisma = createClient();
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const shopDomain = uniqueShopDomain('retention');
    await repository.recordWebhook(webhookInput({ shopDomain, webhookId: randomUUID() }));
    const shop = await prisma.shop.findUniqueOrThrow({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } });
    const old = new Date('2026-01-01T00:00:00.000Z');
    const rows = await Promise.all([
      createWebhookFixture(prisma, shop.id, 'PROCESSED', old),
      createWebhookFixture(prisma, shop.id, 'IGNORED', old),
      createWebhookFixture(prisma, shop.id, 'RETRY_WAIT', old),
      createWebhookFixture(prisma, shop.id, 'PROCESSING', old, { leaseToken: 'active-lease' }),
      createWebhookFixture(prisma, shop.id, 'DEAD_LETTER', old)
    ]);
    const tombstone = await prisma.shopifyOrderRedactionTombstone.create({
      data: {
        appId: 'clever',
        complianceWebhookId: 'retention-legal-evidence',
        redactedAt: old,
        shopId: shop.id,
        shopifyOrderLegacyId: 6999n
      }
    });

    await expect(repository.deleteExpiredTerminalWebhookEvents({
      completedBefore: new Date('2026-02-01T00:00:00.000Z'),
      limit: 2
    })).resolves.toEqual({ deleted: 2, scanned: 2 });
    expect(await prisma.shopifyWebhookEvent.count({ where: { id: { in: rows.slice(0, 2).map(({ id }) => id) } } })).toBe(0);
    expect(await prisma.shopifyWebhookEvent.count({ where: { id: { in: rows.slice(2).map(({ id }) => id) } } })).toBe(3);
    expect(await prisma.shopifyOrderRedactionTombstone.findUnique({ where: { id: tombstone.id } })).not.toBeNull();
  });

  test('reconciles a crash-gap PENDING_UPLOAD object after the late-write fence and preserves READY proof', async () => {
    const prisma = createClient();
    const fixture = await createProofMediaDbFixture(prisma);
    const storageRoot = await mkdtemp(join(tmpdir(), 'clever-proof-crash-gap-'));
    const pendingKey = `driver-proof/${fixture.shop.shopDomain}/${fixture.routePlan.id}/${fixture.stop.id}/${randomUUID()}.jpg`;
    const readyKey = `driver-proof/${fixture.shop.shopDomain}/${fixture.routePlan.id}/${fixture.stop.id}/${randomUUID()}.jpg`;
    for (const key of [pendingKey, readyKey]) {
      const path = join(storageRoot, ...key.split('/'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from('proof'));
    }
    const [pending, ready] = await Promise.all([
      prisma.driverProofMedia.create({ data: proofMediaRow(fixture, pendingKey, 'PENDING_UPLOAD') }),
      prisma.driverProofMedia.create({ data: proofMediaRow(fixture, readyKey, 'READY') })
    ]);
    const repository = new PrismaDriverProofMediaRepository(prisma, { storageRoot });
    const cleanupNow = new Date('2026-08-25T10:00:00.000Z');

    try {
      await expect(repository.deleteStalePendingProofMedia({
        createdBefore: new Date(Date.now() + 60_000),
        now: cleanupNow
      })).resolves.toEqual({ deletedReservations: 0, missingFiles: 0, scanned: 1 });
      expect(await prisma.driverProofMedia.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
        uploadStatus: 'CLEANING'
      });
      await expect(readFile(join(storageRoot, ...pendingKey.split('/')))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await prisma.driverProofMedia.findUnique({ where: { id: ready.id } })).not.toBeNull();
      await expect(readFile(join(storageRoot, ...readyKey.split('/')))).resolves.toEqual(Buffer.from('proof'));

      await expect(repository.deleteStalePendingProofMedia({
        createdBefore: new Date(Date.now() + 60_000),
        now: new Date(cleanupNow.getTime() + 16 * 60 * 1000)
      })).resolves.toEqual({ deletedReservations: 1, missingFiles: 1, scanned: 1 });
      expect(await prisma.driverProofMedia.findUnique({ where: { id: pending.id } })).toBeNull();
    } finally {
      await rm(storageRoot, { force: true, recursive: true });
      await prisma.shop.delete({ where: { id: fixture.shop.id } });
    }
  });

  test('does not remove an object when finalize wins after stale cleanup selection', async () => {
    const prisma = createClient();
    const fixture = await createProofMediaDbFixture(prisma);
    const storageKey = `driver-proof/${fixture.shop.shopDomain}/${fixture.routePlan.id}/${fixture.stop.id}/${randomUUID()}.jpg`;
    const pending = await prisma.driverProofMedia.create({ data: proofMediaRow(fixture, storageKey, 'PENDING_UPLOAD') });
    let releaseSelection!: () => void;
    let selected!: () => void;
    const selectionReached = new Promise<void>((resolve) => { selected = resolve; });
    const selectionRelease = new Promise<void>((resolve) => { releaseSelection = resolve; });
    const remove = vi.fn(() => Promise.resolve('removed' as const));
    const repository = new PrismaDriverProofMediaRepository({
      driverProofMedia: {
        ...prisma.driverProofMedia,
        deleteMany: prisma.driverProofMedia.deleteMany.bind(prisma.driverProofMedia),
        findFirst: prisma.driverProofMedia.findFirst.bind(prisma.driverProofMedia),
        findMany: async (args: Parameters<typeof prisma.driverProofMedia.findMany>[0]) => {
          const rows = await prisma.driverProofMedia.findMany(args);
          selected();
          await selectionRelease;
          return rows;
        },
        update: prisma.driverProofMedia.update.bind(prisma.driverProofMedia),
        updateMany: prisma.driverProofMedia.updateMany.bind(prisma.driverProofMedia)
      },
      routePlan: prisma.routePlan,
      routePlanStop: prisma.routePlanStop
    } as never, { storage: { remove, write: vi.fn() } });
    const cleanup = repository.deleteStalePendingProofMedia({ createdBefore: new Date(Date.now() + 60_000) });
    await selectionReached;
    expect(await prisma.driverProofMedia.updateMany({
      data: { uploadStatus: 'READY' },
      where: { id: pending.id, uploadStatus: 'PENDING_UPLOAD' }
    })).toEqual({ count: 1 });
    releaseSelection();

    await expect(cleanup).resolves.toEqual({ deletedReservations: 0, missingFiles: 0, scanned: 1 });
    expect(remove).not.toHaveBeenCalled();
    expect(await prisma.driverProofMedia.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ uploadStatus: 'READY' });
    await prisma.shop.delete({ where: { id: fixture.shop.id } });
  });

  test('keeps cleanup evidence when a late PUT wins after cleanup and compensation removal fails', async () => {
    const prisma = createClient();
    const fixture = await createProofMediaDbFixture(prisma);
    const cleanupNow = new Date('2026-08-25T11:00:00.000Z');
    let objectPresent = false;
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const writeReached = new Promise<void>((resolve) => { writeStarted = resolve; });
    const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let removeCalls = 0;
    const storage = {
      remove: vi.fn(() => {
        removeCalls += 1;
        if (removeCalls === 2) return Promise.reject(new Error('temporary delete outage token=private'));
        const result = objectPresent ? 'removed' as const : 'missing' as const;
        objectPresent = false;
        return Promise.resolve(result);
      }),
      write: vi.fn(async (_input: unknown, signal: AbortSignal) => {
        writeStarted();
        await writeRelease;
        if (signal.aborted) throw signal.reason;
        objectPresent = true;
      })
    };
    const repository = new PrismaDriverProofMediaRepository(prisma, {
      createMediaId: randomUUID,
      now: () => cleanupNow,
      storage
    });
    const store = repository.storeProofMedia({
      contentType: 'image/jpeg',
      deliveryStopId: fixture.stop.id,
      driverId: fixture.driver.id,
      fileBytes: Buffer.from('late-proof'),
      filename: 'late.jpg',
      routePlanId: fixture.routePlan.id,
      shopDomain: fixture.shop.shopDomain,
      shopId: fixture.shop.id,
      source: 'camera'
    });

    await writeReached;
    await expect(repository.deleteStalePendingProofMedia({
      createdBefore: new Date(cleanupNow.getTime() + 60_000),
      now: cleanupNow
    })).resolves.toEqual({ deletedReservations: 0, missingFiles: 1, scanned: 1 });
    releaseWrite();
    await expect(store).rejects.toThrow('Proof media upload reservation could not be finalized');
    expect(objectPresent).toBe(true);
    const cleaning = await prisma.driverProofMedia.findFirstOrThrow({ where: { shopId: fixture.shop.id } });
    expect(cleaning).toMatchObject({ uploadStatus: 'CLEANING' });

    await expect(repository.deleteStalePendingProofMedia({
      createdBefore: new Date(cleanupNow.getTime() + 60_000),
      now: new Date(cleanupNow.getTime() + 16 * 60 * 1000)
    })).resolves.toEqual({ deletedReservations: 1, missingFiles: 0, scanned: 1 });
    expect(objectPresent).toBe(false);
    expect(await prisma.driverProofMedia.findUnique({ where: { id: cleaning.id } })).toBeNull();
    expect(storage.remove).toHaveBeenCalledTimes(3);
    await prisma.shop.delete({ where: { id: fixture.shop.id } });
  }, 15_000);

  test('deduplicates concurrent and response-lost proof uploads within authenticated scope', async () => {
    const prisma = createClient();
    const fixture = await createProofMediaDbFixture(prisma);
    let releaseWrite!: () => void;
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const write = vi.fn(async () => {
      signalWriteStarted();
      await writeRelease;
    });
    const storage = { remove: vi.fn(() => Promise.resolve('removed' as const)), write };
    const firstRepository = new PrismaDriverProofMediaRepository(prisma, { storage });
    const secondRepository = new PrismaDriverProofMediaRepository(prisma, { storage });
    const input = {
      contentType: 'image/jpeg',
      deliveryStopId: fixture.stop.id,
      driverId: fixture.driver.id,
      fileBytes: Buffer.from('durable-proof'),
      filename: 'proof.jpg',
      idempotencyKey: 'proof-media-v1:0123456789abcdef0123456789abcdef',
      routePlanId: fixture.routePlan.id,
      shopDomain: fixture.shop.shopDomain,
      shopId: fixture.shop.id,
      source: 'camera' as const
    };

    const first = firstRepository.storeProofMedia(input);
    await writeStarted;
    const concurrentRetry = secondRepository.storeProofMedia(input);
    releaseWrite();
    const [firstResult, retryResult] = await Promise.all([first, concurrentRetry]);
    const responseLostRetry = await secondRepository.storeProofMedia(input);

    expect(retryResult).toEqual(firstResult);
    expect(responseLostRetry).toEqual(firstResult);
    expect(write).toHaveBeenCalledOnce();
    expect(await prisma.driverProofMedia.count({ where: { shopId: fixture.shop.id } })).toBe(1);

    await expect(secondRepository.storeProofMedia({ ...input, fileBytes: Buffer.from('different-proof') }))
      .rejects.toMatchObject({ name: 'DriverProofMediaIdempotencyConflictError' });
    expect(write).toHaveBeenCalledOnce();
    await prisma.shop.delete({ where: { id: fixture.shop.id } });
  }, 15_000);

  test('expires terminal-route GPS source and geometry without touching active or recent location truth', async () => {
    const prisma = createClient();
    const terminal = await createProofMediaDbFixture(prisma);
    const active = await createProofMediaDbFixture(prisma);
    await prisma.routePlan.update({ data: { status: 'COMPLETED' }, where: { id: terminal.routePlan.id } });
    const old = new Date('2026-01-01T00:00:00.000Z');
    const recent = new Date('2026-08-24T00:00:00.000Z');
    const terminalOld = await createLocationEvent(prisma, terminal, old);
    const terminalRecent = await createLocationEvent(prisma, terminal, recent);
    const activeOld = await createLocationEvent(prisma, active, old);
    await Promise.all([
      createTrackingGeometry(prisma, terminal, terminalOld.id, old, new Date('2026-04-01T00:00:00.000Z')),
      createTrackingGeometry(prisma, active, activeOld.id, old, new Date('2026-04-01T00:00:00.000Z'))
    ]);

    await cleanupRouteOperationalEvidence(prisma, new Date('2026-08-25T00:00:00.000Z'));
    expect(await prisma.driverEvent.findUnique({ where: { id: terminalOld.id } })).toMatchObject({ latitude: null, longitude: null });
    expect(await prisma.driverEvent.findUnique({ where: { id: terminalRecent.id } })).not.toBeNull();
    expect(await prisma.driverEvent.findUnique({ where: { id: activeOld.id } })).toMatchObject({
      latitude: null,
      longitude: null,
      payload: { redacted: true, schema: 'driver_location_retention_tombstone_v1' }
    });
    expect(await prisma.routeTrackingGeometry.findUnique({ where: { routePlanId: terminal.routePlan.id } })).toBeNull();
    expect(await prisma.routeTrackingGeometry.findUnique({ where: { routePlanId: active.routePlan.id } })).toBeNull();

    await cleanupRouteOperationalEvidence(prisma, new Date('2026-08-25T00:00:00.000Z'));
    expect(await prisma.driverEvent.findUnique({ where: { id: terminalRecent.id } })).not.toBeNull();
    await prisma.shop.deleteMany({ where: { id: { in: [terminal.shop.id, active.shop.id] } } });
  });

  test('serializes retention after its stale read so a concurrent live position remains current', async () => {
    const prisma = createClient();
    const fixture = await createProofMediaDbFixture(prisma);
    const oldAt = new Date('2026-01-01T00:00:00.000Z');
    const freshAt = new Date('2026-08-24T23:59:00.000Z');
    const oldEvent = await createLocationEvent(prisma, fixture, oldAt);
    await createTrackingGeometry(prisma, fixture, oldEvent.id, oldAt, new Date('2026-04-01T00:00:00.000Z'));

    let releaseAppend!: () => void;
    const appendRelease = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let appendLocked!: () => void;
    const appendHasLock = new Promise<void>((resolve) => { appendLocked = resolve; });
    const append = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${fixture.routePlan.id}, 0))`;
      appendLocked();
      await appendRelease;
      const event = await tx.driverEvent.create({
        data: {
          driverId: fixture.driver.id,
          eventType: 'LOCATION_UPDATED',
          latitude: 43.451,
          longitude: -80.491,
          occurredAt: freshAt,
          payload: {},
          routePlanId: fixture.routePlan.id,
          shopId: fixture.shop.id
        }
      });
      await persistRouteTrackingGeometryPosition(tx, {
        driverId: fixture.driver.id,
        eventId: event.id,
        latitude: 43.451,
        longitude: -80.491,
        occurredAt: freshAt.toISOString(),
        receivedAt: freshAt.toISOString(),
        routePlanId: fixture.routePlan.id
      });
    });
    await appendHasLock;
    const cleanup = cleanupRouteOperationalEvidence(prisma, new Date('2026-08-25T00:00:00.000Z'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseAppend();
    await Promise.all([append, cleanup]);

    const current = await prisma.routeTrackingGeometry.findUniqueOrThrow({ where: { routePlanId: fixture.routePlan.id } });
    expect(current.lastEventId).not.toBe(oldEvent.id);
    expect(current.lastLatitude.toString()).toBe('43.451');
    expect(readRouteTrackingGeometryDocument(current).samples.at(-1)?.occurredAt).toBe(freshAt.toISOString());
    await prisma.shop.delete({ where: { id: fixture.shop.id } });
  });

  test('serializes concurrent geometry appends without losing either accepted position', async () => {
    const prisma = createClient();
    const fixture = await createProofMediaDbFixture(prisma);
    const occurredAt = [new Date('2026-08-24T00:00:00.000Z'), new Date('2026-08-24T00:05:00.000Z')];
    const events = await Promise.all(occurredAt.map((at, index) => prisma.driverEvent.create({
      data: {
        driverId: fixture.driver.id,
        eventType: 'LOCATION_UPDATED',
        latitude: 43.45 + index * 0.01,
        longitude: -80.49 - index * 0.01,
        occurredAt: at,
        payload: {},
        routePlanId: fixture.routePlan.id,
        shopId: fixture.shop.id
      }
    })));

    await Promise.all(events.map((event, index) => prisma.$transaction((tx) =>
      persistRouteTrackingGeometryPosition(tx, {
        driverId: fixture.driver.id,
        eventId: event.id,
        latitude: 43.45 + index * 0.01,
        longitude: -80.49 - index * 0.01,
        occurredAt: occurredAt[index]!.toISOString(),
        receivedAt: occurredAt[index]!.toISOString(),
        routePlanId: fixture.routePlan.id
      })
    )));

    const geometry = await prisma.routeTrackingGeometry.findUniqueOrThrow({ where: { routePlanId: fixture.routePlan.id } });
    expect(readRouteTrackingGeometryDocument(geometry).samples.map(({ eventId }) => eventId).sort())
      .toEqual(events.map(({ id }) => id).sort());
    await prisma.shop.delete({ where: { id: fixture.shop.id } });
  });

  test('keeps driver stop state monotonic across late and conflicting terminal events', async () => {
    const prisma = createClient();
    const fixture = await createProofMediaDbFixture(prisma);
    await prisma.routePlan.update({ data: { status: 'IN_PROGRESS' }, where: { id: fixture.routePlan.id } });
    const repository = new PrismaDriverEventRepository(prisma);
    const event = (clientEventId: string, eventType: 'STOP_ARRIVED' | 'STOP_DELIVERED' | 'STOP_FAILED') => ({
      clientEventId,
      deliveryStopId: fixture.stop.id,
      driverId: fixture.driver.id,
      eventType,
      latitude: null,
      longitude: null,
      occurredAt: new Date(),
      payload: {},
      routePlanId: fixture.routePlan.id,
      shopDomain: fixture.shop.shopDomain,
      shopId: fixture.shop.id
    });

    await repository.recordDriverEvent(event('delivered-first', 'STOP_DELIVERED'));
    await expect(repository.recordDriverEvent(event('late-arrived', 'STOP_ARRIVED')))
      .rejects.toBeInstanceOf(DriverEventStopTransitionConflictError);
    await expect(repository.recordDriverEvent(event('conflicting-failed', 'STOP_FAILED')))
      .rejects.toBeInstanceOf(DriverEventStopTransitionConflictError);
    await expect(repository.recordDriverEvent(event('delivered-retry-device', 'STOP_DELIVERED')))
      .resolves.toMatchObject({ duplicate: false });
    expect(await prisma.deliveryStop.findUniqueOrThrow({ where: { id: fixture.stop.id } })).toMatchObject({
      status: 'DELIVERED'
    });
    expect(await prisma.driverEvent.count({
      where: { clientEventId: { in: ['late-arrived', 'conflicting-failed'] }, driverId: fixture.driver.id }
    })).toBe(0);
    await prisma.shop.delete({ where: { id: fixture.shop.id } });
  });

  test('advances GPS retention beyond the first 1000 scrubbed active-route events', async () => {
    const prisma = createClient();
    const fixture = await createProofMediaDbFixture(prisma);
    const occurredAt = new Date('2020-01-01T00:00:00.000Z');
    await prisma.driverEvent.createMany({
      data: Array.from({ length: 1_001 }, (_, index) => ({
        clientEventId: `retention-${index}`,
        driverId: fixture.driver.id,
        eventType: 'LOCATION_UPDATED' as const,
        latitude: 43.45,
        longitude: -80.49,
        occurredAt,
        payload: { latitude: 43.45, longitude: -80.49 },
        routePlanId: fixture.routePlan.id,
        shopId: fixture.shop.id
      }))
    });

    expect(await cleanupRouteOperationalEvidence(prisma, new Date('2030-01-01T00:00:00.000Z'))).toMatchObject({
      locationContinuationRequired: false,
      locationEvents: 1_001
    });
    expect((await cleanupRouteOperationalEvidence(prisma, new Date('2030-01-01T00:00:00.000Z'))).locationEvents).toBe(0);
    expect(await prisma.driverEvent.count({
      where: { latitude: { not: null }, routePlanId: fixture.routePlan.id }
    })).toBe(0);
    expect(await prisma.driverEvent.count({ where: { routePlanId: fixture.routePlan.id } })).toBe(1_001);
    await prisma.shop.delete({ where: { id: fixture.shop.id } });
  }, 15_000);

  test('returns non-success when PostgreSQL is unavailable before admission', async () => {
    const unavailable = new PrismaClient({
      datasourceUrl: 'postgresql://disabled:disabled@127.0.0.1:55491/unavailable?connect_timeout=1'
    });
    clients.push(unavailable);
    const app = await buildApp({
      shopifyWebhook: {
        appCredentials: [{ appId: 'clever', clientSecret }],
        webhookService: new PrismaShopifyWebhookEventRepository(unavailable)
      }
    });
    const rawBody = JSON.stringify({ id: 6002 });

    try {
      const response = await app.inject({
        headers: webhookHeaders({ rawBody, shopDomain: uniqueShopDomain('outage'), webhookId: randomUUID() }),
        method: 'POST',
        payload: rawBody,
        url: '/shopify/webhooks'
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await app.close();
    }
  });

  test('failure logging excludes the raw webhook body and customer fields', async () => {
    const unavailable = new PrismaClient({
      datasourceUrl: 'postgresql://disabled:disabled@127.0.0.1:55491/unavailable?connect_timeout=1'
    });
    clients.push(unavailable);
    let logOutput = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logOutput += String(chunk);
        callback();
      }
    });
    const app = await buildApp({
      logger: { level: 'error', stream },
      shopifyWebhook: {
        appCredentials: [{ appId: 'clever', clientSecret }],
        webhookService: new PrismaShopifyWebhookEventRepository(unavailable)
      }
    });
    const rawBody = JSON.stringify({
      email: 'customer-private@g006.invalid',
      id: 6003,
      shipping_address: { address1: '6003 Private Webhook Street' }
    });

    try {
      await app.inject({
        headers: webhookHeaders({ rawBody, shopDomain: uniqueShopDomain('logging'), webhookId: randomUUID() }),
        method: 'POST',
        payload: rawBody,
        url: '/shopify/webhooks'
      });

      expect(logOutput).toContain('"level":50');
      expect(logOutput).not.toContain('customer-private@g006.invalid');
      expect(logOutput).not.toContain('6003 Private Webhook Street');
      expect(logOutput).not.toContain(rawBody);
    } finally {
      await app.close();
    }
  });

  test('a restarted worker reclaims an expired processing lease', async () => {
    const prisma = createClient();
    await clearDueWebhookFixtures(prisma);
    const repositoryBeforeRestart = new PrismaShopifyWebhookEventRepository(prisma);
    await repositoryBeforeRestart.recordWebhook(webhookInput({ shopDomain: uniqueShopDomain('restart'), webhookId: randomUUID() }));
    const firstClaimAt = new Date(Date.now() + 60_000);
    const first = await repositoryBeforeRestart.claimNextOrderWebhook({
      leaseMs: 1_000,
      now: firstClaimAt,
      workerId: 'worker-before-restart'
    });
    expect(first.action).toBe('process');

    const repositoryAfterRestart = new PrismaShopifyWebhookEventRepository(createClient());
    const reclaimed = await repositoryAfterRestart.claimNextOrderWebhook({
      leaseMs: 1_000,
      now: new Date(firstClaimAt.getTime() + 2_000),
      workerId: 'worker-after-restart'
    });

    expect(reclaimed.action).toBe('process');
    if (first.action === 'process' && reclaimed.action === 'process') {
      expect(reclaimed.event.id).toBe(first.event.id);
      expect(reclaimed.event.leaseToken).not.toBe(first.event.leaseToken);
      expect(reclaimed.event.attemptCount).toBe(2);
      expect(await repositoryAfterRestart.markOrderWebhookProcessed(reclaimed.event)).toBe(true);
    }
  });

  test('an expired lease holder cannot settle an event reclaimed by another worker', async () => {
    const prisma = createClient();
    await clearDueWebhookFixtures(prisma);
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    await repository.recordWebhook(webhookInput({ shopDomain: uniqueShopDomain('fence'), webhookId: randomUUID() }));
    const firstClaimAt = new Date(Date.now() + 60_000);
    const stale = await repository.claimNextOrderWebhook({ leaseMs: 1_000, now: firstClaimAt, workerId: 'stale' });
    const current = await repository.claimNextOrderWebhook({ leaseMs: 1_000, now: new Date(firstClaimAt.getTime() + 2_000), workerId: 'current' });
    if (stale.action !== 'process' || current.action !== 'process') throw new Error('expected both lease claims');

    expect(await repository.markOrderWebhookProcessed(stale.event)).toBe(false);
    expect(await repository.markOrderWebhookProcessed(current.event)).toBe(true);
  });

  test('replay after a crash between canonical upsert and inbox finalize keeps one business state', async () => {
    const prisma = createClient();
    await clearDueWebhookFixtures(prisma);
    const repository = new PrismaShopifyWebhookEventRepository(prisma);
    const shopDomain = uniqueShopDomain('crash');
    await repository.recordWebhook(webhookInput({ shopDomain, webhookId: randomUUID() }));
    const firstClaimAt = new Date(Date.now() + 60_000);
    const first = await repository.claimNextOrderWebhook({ leaseMs: 1_000, now: firstClaimAt, workerId: 'crashed' });
    if (first.action !== 'process') throw new Error('expected first claim');
    const orderRepository = new PrismaOrderSyncRepository(prisma);
    const synced = mapShopifyOrderNodeToDeliveryInputs(orderNode());

    await orderRepository.upsertOrderWithDeliveryStop({ appId: 'clever', shopDomain, synced });
    const restartedRepository = new PrismaShopifyWebhookEventRepository(createClient());
    const replay = await restartedRepository.claimNextOrderWebhook({ leaseMs: 1_000, now: new Date(firstClaimAt.getTime() + 2_000), workerId: 'restarted' });
    if (replay.action !== 'process') throw new Error('expected replay claim');
    await orderRepository.upsertOrderWithDeliveryStop({ appId: 'clever', shopDomain, synced });
    expect(await restartedRepository.markOrderWebhookProcessed(replay.event)).toBe(true);

    const shop = await prisma.shop.findUniqueOrThrow({ where: { appId_shopDomain: { appId: 'clever', shopDomain } } });
    expect(await prisma.order.count({ where: { shopId: shop.id, shopifyOrderGid: orderNode().id } })).toBe(1);
    expect(await prisma.deliveryStop.count({ where: { shopId: shop.id } })).toBe(1);
    expect(await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id: first.event.id } })).toMatchObject({
      attemptCount: 2,
      status: 'PROCESSED'
    });
  });
});

function createClient(): PrismaClient {
  const scopedUrl = `${databaseUrl ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled'}${databaseUrl?.includes('?') === true ? '&' : '?'}connection_limit=1`;
  const client = new PrismaClient({
    datasourceUrl: scopedUrl
  });
  clients.push(client);
  return client;
}

async function clearDueWebhookFixtures(prisma: PrismaClient): Promise<void> {
  await prisma.shop.deleteMany({
    where: { shopDomain: { startsWith: 'g006-' } }
  });
}

function uniqueShopDomain(label: string): string {
  return `g006-${label}-${randomUUID().slice(0, 8)}.myshopify.com`;
}

function webhookHeaders(input: { rawBody: string; shopDomain: string; topic?: string; webhookId: string }): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-shopify-api-version': '2026-07',
    'x-shopify-hmac-sha256': createHmac('sha256', clientSecret).update(input.rawBody).digest('base64'),
    'x-shopify-shop-domain': input.shopDomain,
    'x-shopify-topic': input.topic ?? 'orders/create',
    'x-shopify-webhook-id': input.webhookId
  };
}

function webhookInput(input: { payload?: unknown; shopDomain: string; webhookId: string }) {
  const payload = input.payload ?? { admin_graphql_api_id: 'gid://shopify/Order/6006', id: 6006 };
  const rawBody = JSON.stringify(payload);
  return {
    appId: 'clever',
    apiVersion: '2026-07',
    eventId: randomUUID(),
    payload,
    rawBody,
    shopDomain: input.shopDomain,
    topic: 'orders/create',
    triggeredAt: new Date('2026-08-24T00:00:00Z'),
    webhookId: input.webhookId
  };
}

async function recordCustomerRedaction(
  repository: PrismaShopifyWebhookEventRepository,
  input: { legacyIds: number[]; shopDomain: string }
) {
  const payload = { orders_to_redact: input.legacyIds, shop_domain: input.shopDomain };
  return repository.recordWebhook({
    apiVersion: '2026-07',
    eventId: randomUUID(),
    payload,
    rawBody: JSON.stringify(payload),
    shopDomain: input.shopDomain,
    topic: 'customers/redact',
    triggeredAt: new Date(),
    webhookId: randomUUID()
  });
}

async function createWebhookFixture(
  prisma: PrismaClient,
  shopId: string,
  status: 'DEAD_LETTER' | 'IGNORED' | 'PROCESSING' | 'PROCESSED' | 'RETRY_WAIT',
  timestamp: Date,
  input: { leaseToken?: string } = {}
) {
  return prisma.shopifyWebhookEvent.create({
    data: {
      apiVersion: '2026-07',
      createdAt: timestamp,
      eventId: randomUUID(),
      ...(input.leaseToken === undefined ? {} : { leaseExpiresAt: new Date(timestamp.getTime() + 60_000), leaseToken: input.leaseToken }),
      nextRunAt: timestamp,
      payload: { fixture: true },
      ...(status === 'PROCESSED' ? { processedAt: timestamp } : {}),
      rawBodySha256: '0'.repeat(64),
      receivedAt: timestamp,
      shopId,
      status,
      topic: 'orders/create',
      updatedAt: timestamp,
      webhookId: randomUUID()
    }
  });
}

async function createProofMediaDbFixture(prisma: PrismaClient) {
  const shop = await prisma.shop.create({ data: { appId: 'clever', shopDomain: uniqueShopDomain('proof-crash') } });
  const driver = await prisma.driver.create({ data: { displayName: 'Proof fixture', shopId: shop.id } });
  const order = await prisma.order.create({
    data: {
      name: '#PROOF',
      rawPayload: {},
      shopId: shop.id,
      shopifyOrderGid: `gid://shopify/Order/${randomUUID()}`
    }
  });
  const stop = await prisma.deliveryStop.create({ data: { orderId: order.id, shopId: shop.id } });
  const routePlan = await prisma.routePlan.create({
    data: {
      constraints: {},
      driverId: driver.id,
      metrics: {},
      name: 'Proof crash route',
      optimizerVersion: 'fixture',
      planDate: new Date('2026-08-24T00:00:00.000Z'),
      shopId: shop.id,
      status: 'READY'
    }
  });
  await prisma.routePlanStop.create({
    data: { deliveryStopId: stop.id, routePlanId: routePlan.id, sequence: 1, shopId: shop.id }
  });
  return { driver, routePlan, shop, stop };
}

async function createLocationEvent(
  prisma: PrismaClient,
  fixture: Awaited<ReturnType<typeof createProofMediaDbFixture>>,
  occurredAt: Date
) {
  return prisma.driverEvent.create({
    data: {
      driverId: fixture.driver.id,
      eventType: 'LOCATION_UPDATED',
      latitude: 43.45,
      longitude: -80.49,
      occurredAt,
      payload: {},
      routePlanId: fixture.routePlan.id,
      shopId: fixture.shop.id
    }
  });
}

async function createTrackingGeometry(
  prisma: PrismaClient,
  fixture: Awaited<ReturnType<typeof createProofMediaDbFixture>>,
  eventId: string,
  occurredAt: Date,
  expiresAt: Date
) {
  return prisma.routeTrackingGeometry.create({
    data: {
      expiresAt,
      firstOccurredAt: occurredAt,
      geometry: { coordinates: [[-80.49, 43.45]], type: 'LineString' },
      geometryPointCount: 1,
      lastDriverId: fixture.driver.id,
      lastEventId: eventId,
      lastLatitude: 43.45,
      lastLongitude: -80.49,
      lastOccurredAt: occurredAt,
      lastReceivedAt: occurredAt,
      routePlanId: fixture.routePlan.id,
      sampleMetadata: [{
        driverId: fixture.driver.id,
        eventId,
        occurredAt: occurredAt.toISOString(),
        receivedAt: occurredAt.toISOString()
      }],
      sourcePointCount: 1
    }
  });
}

function proofMediaRow(
  fixture: Awaited<ReturnType<typeof createProofMediaDbFixture>>,
  storageKey: string,
  uploadStatus: 'PENDING_UPLOAD' | 'READY'
) {
  return {
    contentType: 'image/jpeg',
    deliveryStopId: fixture.stop.id,
    driverId: fixture.driver.id,
    kind: 'PHOTO' as const,
    routePlanId: fixture.routePlan.id,
    sha256: '0'.repeat(64),
    shopId: fixture.shop.id,
    sizeBytes: 5,
    source: 'CAMERA' as const,
    storageKey,
    uploadStatus,
    uploadedAt: new Date('2026-08-20T00:00:00.000Z')
  };
}

function orderNode(legacyId = 6006): ShopifyOrderNode {
  return {
    cancelledAt: null,
    currentTotalPriceSet: { shopMoney: { amount: '18.00', currencyCode: 'CAD' } },
    customAttributes: [{ key: 'Delivery Area', value: 'Kitchener' }],
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: 'redacted@example.invalid',
    id: `gid://shopify/Order/${legacyId}`,
    legacyResourceId: String(legacyId),
    lineItems: { nodes: [{ quantity: 1, sku: 'G006', title: 'K-food' }] },
    name: `#G${legacyId}`,
    note: null,
    paymentGatewayNames: ['manual'],
    phone: null,
    processedAt: '2026-08-24T00:00:00Z',
    shippingAddress: {
      address1: '1 Test Ave', address2: null, city: 'Kitchener', countryCodeV2: 'CA', latitude: 43.45,
      longitude: -80.49, name: 'Redacted', phone: null, province: 'Ontario', provinceCode: 'ON', zip: 'N2G 1A1'
    },
    updatedAt: '2026-08-24T00:00:00Z'
  };
}

function tokenInput(shopDomain: string) {
  return {
    appId: 'clever',
    adminAccessTokenCiphertext: 'ciphertext-access',
    adminAccessTokenExpiresAt: null,
    adminRefreshTokenCiphertext: 'ciphertext-refresh',
    adminRefreshTokenExpiresAt: null,
    apiVersion: '2026-07',
    shopDomain,
    shopifyShopGid: null,
    tokenIssuedAt: new Date('2026-08-25T02:00:00.000Z'),
    tokenScopes: ['read_orders']
  };
}
