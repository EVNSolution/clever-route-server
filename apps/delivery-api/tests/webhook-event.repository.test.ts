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

    expect(result).toEqual({ duplicate: false, status: 'PROCESSED', webhookId: 'webhook-id' });
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

    expect(result).toEqual({ duplicate: false, status: 'PROCESSED', webhookId: 'webhook-id' });
    expect(prisma.shop.delete).toHaveBeenCalledWith({ where: { id: 'shop-id' } });
    expect(prisma.shopifyWebhookEvent.create).not.toHaveBeenCalled();
  });
});


describe('PrismaShopifyWebhookEventRepository order webhook lifecycle', () => {
  test('reports duplicate delivery disposition without stealing queued or in-flight work', async () => {
    const retryable = createOrderWebhookPrismaHarness({ status: 'FAILED', lastError: 'TRANSIENT:upstream' });
    const retryableRepository = new PrismaShopifyWebhookEventRepository(
      retryable as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );
    await expect(retryableRepository.getOrderWebhookDeliveryDisposition(orderClaimInput())).resolves.toEqual({ action: 'queued', reason: 'retry_wait' });
    expect(retryable.shopifyWebhookEvent.updateMany).not.toHaveBeenCalled();

    const permanent = createOrderWebhookPrismaHarness({
      status: 'FAILED',
      lastError: 'PERMANENT:MISSING_OFFLINE_TOKEN'
    });
    const permanentRepository = new PrismaShopifyWebhookEventRepository(
      permanent as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );
    await expect(permanentRepository.getOrderWebhookDeliveryDisposition(orderClaimInput())).resolves.toEqual({
      action: 'noop',
      reason: 'permanent_failure'
    });
    expect(permanent.shopifyWebhookEvent.updateMany).not.toHaveBeenCalled();

    const processed = createOrderWebhookPrismaHarness({ status: 'PROCESSED' });
    const processedRepository = new PrismaShopifyWebhookEventRepository(
      processed as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );
    await expect(processedRepository.getOrderWebhookDeliveryDisposition(orderClaimInput())).resolves.toEqual({
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
      recentRepository.getOrderWebhookDeliveryDisposition(orderClaimInput())
    ).resolves.toEqual({ action: 'queued', reason: 'processing' });
    expect(recent.shopifyWebhookEvent.updateMany).not.toHaveBeenCalled();
  });

  test('worker claims due and expired rows and marks processed/retry without deleting orders', async () => {
    const prisma = createOrderWebhookPrismaHarness({
      status: 'PROCESSING',
      updatedAt: new Date('2026-07-08T00:00:00.000Z')
    });
    const repository = new PrismaShopifyWebhookEventRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );

    await expect(
      repository.claimNextOrderWebhook({
        leaseMs: 120_000,
        now: new Date('2026-07-08T00:03:00.000Z'),
        workerId: 'worker-1'
      })
    ).resolves.toMatchObject({ action: 'process', event: { webhookId: 'webhook-id' } });

    const dueQuery = prisma.shopifyWebhookEvent.findFirst.mock.calls[0]?.[0];
    expect(dueQuery).toEqual(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { status: 'PROCESSING', leaseExpiresAt: null }
        ]) as unknown
      }) as unknown
    }));
    const claimUpdate = prisma.shopifyWebhookEvent.updateMany.mock.calls[0]?.[0];
    expect(claimUpdate).toEqual(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { status: 'PROCESSING', leaseExpiresAt: null }
        ]) as unknown
      }) as unknown
    }));

    const claimedEvent = {
      appId: 'clever',
      id: 'event-row-id',
      leaseToken: 'lease-token'
    };
    await expect(repository.markOrderWebhookProcessed(claimedEvent)).resolves.toBe(true);
    await expect(repository.markOrderWebhookFailed({
      ...claimedEvent,
      attemptCount: 2,
      error: 'TRANSIENT:boom',
      maxAttempts: 8
    })).resolves.toBe(true);

    expect(prisma.order.deleteMany).not.toHaveBeenCalled();
    const processedUpdateInput = prisma.shopifyWebhookEvent.updateMany.mock.calls[1]?.[0] as
      | { data: { status: string } }
      | undefined;
    expect(processedUpdateInput?.data.status).toBe('PROCESSED');
    const retryUpdateDataMatcher: unknown = expect.objectContaining({
      lastError: 'TRANSIENT:boom',
      status: 'RETRY_WAIT'
    });
    const retryUpdateMatcher: unknown = expect.objectContaining({ data: retryUpdateDataMatcher });
    expect(prisma.shopifyWebhookEvent.updateMany).toHaveBeenCalledWith(retryUpdateMatcher);
  });

  test('dead-letters at max attempts and refuses stale lease-token settle writes', async () => {
    const prisma = createOrderWebhookPrismaHarness({ status: 'QUEUED' });
    const repository = new PrismaShopifyWebhookEventRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );

    await expect(repository.markOrderWebhookFailed({
      appId: 'clever',
      attemptCount: 8,
      error: 'TRANSIENT:boom',
      id: 'event-row-id',
      leaseToken: 'lease-token',
      maxAttempts: 8
    })).resolves.toBe(true);
    const deadLetterUpdateMatcher: unknown = expect.objectContaining({
      data: expect.objectContaining({ status: 'DEAD_LETTER' }) as unknown,
      where: { id: 'event-row-id', leaseToken: 'lease-token', status: 'PROCESSING' }
    });
    expect(prisma.shopifyWebhookEvent.updateMany).toHaveBeenCalledWith(deadLetterUpdateMatcher);

    prisma.shopifyWebhookEvent.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(repository.markOrderWebhookProcessed({
      appId: 'clever',
      id: 'event-row-id',
      leaseToken: 'stale-token'
    })).resolves.toBe(false);
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

type OrderWebhookEventStatus = 'RECEIVED' | 'QUEUED' | 'RETRY_WAIT' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'IGNORED' | 'DEAD_LETTER';

type OrderWebhookPrismaHarness = PrismaHarness & {
  shop: PrismaHarness['shop'] & {
    findUnique: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string } | null>>>;
  };
  shopifyWebhookEvent: PrismaHarness['shopifyWebhookEvent'] & {
    findUnique: ReturnType<
      typeof vi.fn<
        (input: unknown) => Promise<{
          apiVersion?: string | null;
          attemptCount?: number;
          id: string;
          lastError: string | null;
          leaseToken?: string | null;
          maxAttempts?: number;
          payload?: unknown;
          shop?: { appId: string; id: string; shopDomain: string };
          status: OrderWebhookEventStatus;
          topic?: string;
          triggeredAt?: Date | null;
          updatedAt: Date;
          webhookId?: string;
        } | null>
      >
    >;
    findFirst: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string; status: OrderWebhookEventStatus } | null>>>;
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
  base.shopifyWebhookEvent.findFirst = vi.fn(() => Promise.resolve({ id: 'event-row-id', status: input.status }));
  base.shopifyWebhookEvent.findUnique = vi.fn(() =>
    Promise.resolve({
      apiVersion: '2026-04',
      attemptCount: 2,
      id: 'event-row-id',
      lastError: input.lastError ?? null,
      leaseToken: 'lease-token',
      maxAttempts: 8,
      payload: { id: 123 },
      shop: { appId: 'clever', id: 'shop-id', shopDomain: 'clever-route-test.myshopify.com' },
      status: input.status,
      topic: 'orders/updated',
      triggeredAt: new Date('2026-07-08T00:00:00.000Z'),
      updatedAt: input.updatedAt ?? new Date('2026-07-08T00:00:00.000Z'),
      webhookId: 'webhook-id'
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
