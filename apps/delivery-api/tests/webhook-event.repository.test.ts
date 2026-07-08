import { describe, expect, test, vi } from 'vitest';

import { PrismaShopifyWebhookEventRepository } from '../src/modules/shopify/webhook-event.repository.js';

describe('PrismaShopifyWebhookEventRepository privacy compliance handling', () => {
  test('stores customers/data_request receipts without customer email or phone', async () => {
    const prisma = createPrismaHarness();
    const repository = new PrismaShopifyWebhookEventRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );

    await repository.recordWebhook({
      apiVersion: '2026-04',
      eventId: 'event-id',
      payload: {
        customer: {
          email: 'customer@clever.invalid',
          id: 191167,
          phone: '555-625-1199'
        },
        data_request: { id: 9999 },
        orders_requested: [299938, '280263'],
        shop_domain: 'clever-route-test.myshopify.com',
        shop_id: 954889
      },
      rawBody: '{"topic":"customers/data_request"}',
      shopDomain: 'Clever-Route-Test.myshopify.com',
      topic: 'customers/data_request',
      triggeredAt: new Date('2026-05-14T00:00:00.000Z'),
      webhookId: 'webhook-id'
    });

    expect(prisma.order.deleteMany).not.toHaveBeenCalled();
    const createInput = readCreateWebhookEventInput(prisma);
    expect(createInput.data.payload).toEqual({
      customer: { id: 191167 },
      data_request: { id: 9999 },
      orders_requested: ['299938', '280263'],
      shop_domain: 'clever-route-test.myshopify.com',
      shop_id: 954889
    });
    expect(createInput.data.status).toBe('RECEIVED');
    expect(createInput.data.topic).toBe('customers/data_request');
    const createPayload = createInput.data.payload;
    expect(JSON.stringify(createPayload)).not.toContain('customer@clever.invalid');
    expect(JSON.stringify(createPayload)).not.toContain('555-625-1199');
  });

  test('redacts customer order data before storing a sanitized customers/redact receipt', async () => {
    const prisma = createPrismaHarness();
    const repository = new PrismaShopifyWebhookEventRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );

    const result = await repository.recordWebhook({
      apiVersion: '2026-04',
      eventId: 'event-id',
      payload: {
        customer: {
          email: 'customer@clever.invalid',
          id: 191167,
          phone: '555-625-1199'
        },
        orders_to_redact: [299938, '280263'],
        shop_domain: 'clever-route-test.myshopify.com',
        shop_id: 954889
      },
      rawBody: '{"topic":"customers/redact"}',
      shopDomain: 'Clever-Route-Test.myshopify.com',
      topic: 'customers/redact',
      triggeredAt: new Date('2026-05-14T00:00:00.000Z'),
      webhookId: 'webhook-id'
    });

    expect(result).toEqual({ duplicate: false, webhookId: 'webhook-id' });
    expect(prisma.order.deleteMany).toHaveBeenCalledWith({
      where: {
        shopId: 'shop-id',
        shopifyOrderLegacyId: { in: [299938n, 280263n] }
      }
    });
    const createInput = readCreateWebhookEventInput(prisma);
    expect(createInput.data.payload).toEqual({
      customer: { id: 191167 },
      orders_to_redact: ['299938', '280263'],
      shop_domain: 'clever-route-test.myshopify.com',
      shop_id: 954889
    });
    expect(createInput.data.status).toBe('PROCESSED');
    expect(createInput.data.topic).toBe('customers/redact');
    const createPayload = createInput.data.payload;
    expect(JSON.stringify(createPayload)).not.toContain('customer@clever.invalid');
    expect(JSON.stringify(createPayload)).not.toContain('555-625-1199');
  });

  test('deletes all shop-scoped delivery data for shop/redact without retaining the payload', async () => {
    const prisma = createPrismaHarness();
    const repository = new PrismaShopifyWebhookEventRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );

    const result = await repository.recordWebhook({
      apiVersion: '2026-04',
      eventId: 'event-id',
      payload: {
        shop_domain: 'clever-route-test.myshopify.com',
        shop_id: 954889
      },
      rawBody: '{"topic":"shop/redact"}',
      shopDomain: 'Clever-Route-Test.myshopify.com',
      topic: 'shop/redact',
      triggeredAt: new Date('2026-05-14T00:00:00.000Z'),
      webhookId: 'webhook-id'
    });

    expect(result).toEqual({ duplicate: false, webhookId: 'webhook-id' });
    expect(prisma.shop.delete).toHaveBeenCalledWith({ where: { id: 'shop-id' } });
    expect(prisma.shopifyWebhookEvent.create).not.toHaveBeenCalled();
  });
});


describe('PrismaShopifyWebhookEventRepository order webhook lifecycle', () => {
  test('claims retryable states and leaves completed/permanent/recent processing events alone', async () => {
    const retryable = createOrderWebhookPrismaHarness({ status: 'FAILED', lastError: 'TRANSIENT:upstream' });
    const retryableRepository = new PrismaShopifyWebhookEventRepository(
      retryable as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );
    await expect(retryableRepository.claimOrderWebhook(orderClaimInput())).resolves.toEqual({ action: 'process' });
    const retryClaimInput = retryable.shopifyWebhookEvent.updateMany.mock.calls[0]?.[0] as
      | { data: { status: string } }
      | undefined;
    expect(retryClaimInput?.data.status).toBe('PROCESSING');

    const permanent = createOrderWebhookPrismaHarness({
      status: 'FAILED',
      lastError: 'PERMANENT:MISSING_OFFLINE_TOKEN'
    });
    const permanentRepository = new PrismaShopifyWebhookEventRepository(
      permanent as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );
    await expect(permanentRepository.claimOrderWebhook(orderClaimInput())).resolves.toEqual({
      action: 'noop',
      reason: 'permanent_failure'
    });
    expect(permanent.shopifyWebhookEvent.updateMany).not.toHaveBeenCalled();

    const processed = createOrderWebhookPrismaHarness({ status: 'PROCESSED' });
    const processedRepository = new PrismaShopifyWebhookEventRepository(
      processed as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );
    await expect(processedRepository.claimOrderWebhook(orderClaimInput())).resolves.toEqual({
      action: 'noop',
      reason: 'already_done'
    });

    const recent = createOrderWebhookPrismaHarness({
      status: 'PROCESSING',
      updatedAt: new Date('2026-07-08T00:01:30.000Z')
    });
    const recentRepository = new PrismaShopifyWebhookEventRepository(
      recent as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );
    await expect(
      recentRepository.claimOrderWebhook({
        ...orderClaimInput(),
        now: new Date('2026-07-08T00:02:00.000Z'),
        processingStaleAfterMs: 120_000
      })
    ).resolves.toEqual({ action: 'conflict', retryAfterSeconds: 120 });
    expect(recent.shopifyWebhookEvent.updateMany).not.toHaveBeenCalled();
  });

  test('reclaims stale processing and marks processed/failed without deleting orders', async () => {
    const prisma = createOrderWebhookPrismaHarness({
      status: 'PROCESSING',
      updatedAt: new Date('2026-07-08T00:00:00.000Z')
    });
    const repository = new PrismaShopifyWebhookEventRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );

    await expect(
      repository.claimOrderWebhook({
        ...orderClaimInput(),
        now: new Date('2026-07-08T00:03:00.000Z'),
        processingStaleAfterMs: 120_000
      })
    ).resolves.toEqual({ action: 'process' });

    await repository.markOrderWebhookProcessed(orderClaimInput());
    await repository.markOrderWebhookFailed({ ...orderClaimInput(), error: 'TRANSIENT:boom' });

    expect(prisma.order.deleteMany).not.toHaveBeenCalled();
    const processedUpdateInput = prisma.shopifyWebhookEvent.update.mock.calls[0]?.[0] as
      | { data: { status: string } }
      | undefined;
    expect(processedUpdateInput?.data.status).toBe('PROCESSED');
    expect(prisma.shopifyWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastError: 'TRANSIENT:boom', status: 'FAILED' } })
    );
  });
});

type CreateWebhookEventInput = {
  data: {
    payload: unknown;
    status?: string;
    topic?: string;
  };
};

type PrismaHarness = {
  order: { deleteMany: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ count: number }>>> };
  shop: {
    delete: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string }>>>;
    upsert: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string }>>>;
  };
  shopifyWebhookEvent: {
    create: ReturnType<typeof vi.fn<(input: CreateWebhookEventInput) => Promise<{ id: string }>>>;
  };
};

function createPrismaHarness(): PrismaHarness {
  return {
    order: {
      deleteMany: vi.fn(() => Promise.resolve({ count: 2 }))
    },
    shop: {
      delete: vi.fn(() => Promise.resolve({ id: 'shop-id' })),
      upsert: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
    },
    shopifyWebhookEvent: {
      create: vi.fn(() => Promise.resolve({ id: 'event-id' }))
    }
  };
}

function readCreateWebhookEventInput(prisma: PrismaHarness): CreateWebhookEventInput {
  const input = prisma.shopifyWebhookEvent.create.mock.calls[0]?.[0];
  if (input === undefined) {
    throw new Error('Expected shopifyWebhookEvent.create to be called');
  }

  return input;
}

type OrderWebhookEventStatus = 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'IGNORED';

type OrderWebhookPrismaHarness = PrismaHarness & {
  shop: PrismaHarness['shop'] & {
    findUnique: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string } | null>>>;
  };
  shopifyWebhookEvent: PrismaHarness['shopifyWebhookEvent'] & {
    findUnique: ReturnType<
      typeof vi.fn<
        (input: unknown) => Promise<{
          id: string;
          lastError: string | null;
          status: OrderWebhookEventStatus;
          updatedAt: Date;
        } | null>
      >
    >;
    update: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string }>>>;
    updateMany: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ count: number }>>>;
  };
};

function createOrderWebhookPrismaHarness(input: {
  lastError?: string | null;
  status: OrderWebhookEventStatus;
  updatedAt?: Date;
}): OrderWebhookPrismaHarness {
  const base = createPrismaHarness() as OrderWebhookPrismaHarness;
  base.shop.findUnique = vi.fn(() => Promise.resolve({ id: 'shop-id' }));
  base.shopifyWebhookEvent.findUnique = vi.fn(() =>
    Promise.resolve({
      id: 'event-row-id',
      lastError: input.lastError ?? null,
      status: input.status,
      updatedAt: input.updatedAt ?? new Date('2026-07-08T00:00:00.000Z')
    })
  );
  base.shopifyWebhookEvent.update = vi.fn(() => Promise.resolve({ id: 'event-row-id' }));
  base.shopifyWebhookEvent.updateMany = vi.fn(() => Promise.resolve({ count: 1 }));
  return base;
}

function orderClaimInput() {
  return {
    appId: 'clever',
    shopDomain: 'clever-route-test.myshopify.com',
    webhookId: 'webhook-id'
  };
}
