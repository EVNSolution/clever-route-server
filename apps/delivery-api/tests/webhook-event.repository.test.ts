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
          email: 'customer@example.com',
          id: 191167,
          phone: '555-625-1199'
        },
        data_request: { id: 9999 },
        orders_requested: [299938, '280263'],
        shop_domain: 'example.myshopify.com',
        shop_id: 954889
      },
      rawBody: '{"topic":"customers/data_request"}',
      shopDomain: 'Example.myshopify.com',
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
      shop_domain: 'example.myshopify.com',
      shop_id: 954889
    });
    expect(createInput.data.status).toBe('RECEIVED');
    expect(createInput.data.topic).toBe('customers/data_request');
    const createPayload = createInput.data.payload;
    expect(JSON.stringify(createPayload)).not.toContain('customer@example.com');
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
          email: 'customer@example.com',
          id: 191167,
          phone: '555-625-1199'
        },
        orders_to_redact: [299938, '280263'],
        shop_domain: 'example.myshopify.com',
        shop_id: 954889
      },
      rawBody: '{"topic":"customers/redact"}',
      shopDomain: 'Example.myshopify.com',
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
      shop_domain: 'example.myshopify.com',
      shop_id: 954889
    });
    expect(createInput.data.status).toBe('PROCESSED');
    expect(createInput.data.topic).toBe('customers/redact');
    const createPayload = createInput.data.payload;
    expect(JSON.stringify(createPayload)).not.toContain('customer@example.com');
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
        shop_domain: 'example.myshopify.com',
        shop_id: 954889
      },
      rawBody: '{"topic":"shop/redact"}',
      shopDomain: 'Example.myshopify.com',
      topic: 'shop/redact',
      triggeredAt: new Date('2026-05-14T00:00:00.000Z'),
      webhookId: 'webhook-id'
    });

    expect(result).toEqual({ duplicate: false, webhookId: 'webhook-id' });
    expect(prisma.shop.delete).toHaveBeenCalledWith({ where: { id: 'shop-id' } });
    expect(prisma.shopifyWebhookEvent.create).not.toHaveBeenCalled();
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
