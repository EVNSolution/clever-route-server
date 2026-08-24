import { describe, expect, test, vi } from 'vitest';

import { PrismaShopifyWebhookEventRepository } from '../src/modules/shopify/webhook-event.repository.js';

describe('PrismaShopifyWebhookEventRepository privacy compliance handling', () => {
  test('stores only a replay identity envelope for nonterminal order webhooks', async () => {
    const prisma = createPrismaHarness();
    const repository = new PrismaShopifyWebhookEventRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );

    await repository.recordWebhook({
      apiVersion: '2026-07',
      eventId: 'event-id',
      payload: {
        admin_graphql_api_id: 'gid://shopify/Order/299938',
        email: 'customer@clever.invalid',
        id: 299938,
        phone: '555-625-1199',
        shipping_address: { address1: '99 Private Street', name: 'Private Customer' }
      },
      rawBody: '{"topic":"orders/create"}',
      shopDomain: 'clever-route-test.myshopify.com',
      topic: 'orders/create',
      triggeredAt: new Date('2026-08-24T00:00:00.000Z'),
      webhookId: 'order-webhook-id'
    });

    const createInput = readCreateWebhookEventInput(prisma);
    expect(createInput.data.payload).toEqual({
      admin_graphql_api_id: 'gid://shopify/Order/299938',
      orderId: 'gid://shopify/Order/299938',
      redacted: true,
      schema: 'shopify_order_reference_v1'
    });
    expect(createInput.data.payloadRedactedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(createInput.data.payload)).not.toMatch(/customer|phone|address|private/iu);
  });

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
        shopifyOrderLegacyId: { in: [280263n, 299938n] }
      }
    });
    expect(prisma.shopifyOrderRedactionTombstone.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    const anyDate: unknown = expect.any(Date);
    const anyArray: unknown = expect.any(Array);
    expect(prisma.shopifyWebhookEvent.updateMany).toHaveBeenCalledWith({
      data: {
        payload: {
          admin_graphql_api_id: 'gid://shopify/Order/299938',
          orderId: 'gid://shopify/Order/299938',
          redacted: true,
          schema: 'shopify_order_reference_v1'
        },
        payloadRedactedAt: anyDate
      },
      where: {
        OR: anyArray,
        shopId: 'shop-id',
        topic: { in: anyArray }
      }
    });
    const createInput = readCreateWebhookEventInput(prisma);
    expect(createInput.data.payload).toEqual({
      redacted: true,
      schema: 'shopify_webhook_tombstone_v1',
      terminalStatus: 'PROCESSED'
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
    expect(prisma.shopifyShopRedactionTombstone.upsert).toHaveBeenCalledOnce();
    expect(prisma.shop.deleteMany).toHaveBeenCalledWith({
      where: { appId: 'clever', shopDomain: 'clever-route-test.myshopify.com' }
    });
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
      | { data: { payload: unknown; payloadRedactedAt: Date; status: string } }
      | undefined;
    expect(processedUpdateInput?.data.status).toBe('PROCESSED');
    expect(processedUpdateInput?.data.payload).toEqual({
      redacted: true,
      schema: 'shopify_webhook_tombstone_v1',
      terminalStatus: 'PROCESSED'
    });
    expect(processedUpdateInput?.data.payloadRedactedAt).toBeInstanceOf(Date);
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

  test('deletes only bounded expired terminal webhook rows', async () => {
    const prisma = createOrderWebhookPrismaHarness({ status: 'PROCESSED' });
    prisma.shopifyWebhookEvent.findMany = vi.fn(() => Promise.resolve([
      { id: 'processed-old' },
      { id: 'ignored-old' }
    ]));
    prisma.shopifyWebhookEvent.deleteMany = vi.fn(() => Promise.resolve({ count: 2 }));
    const repository = new PrismaShopifyWebhookEventRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaShopifyWebhookEventRepository>[0]
    );

    await expect(repository.deleteExpiredTerminalWebhookEvents({
      completedBefore: new Date('2026-07-01T00:00:00.000Z'),
      limit: 2
    })).resolves.toEqual({ deleted: 2, scanned: 2 });
    expect(prisma.shopifyWebhookEvent.findMany).toHaveBeenCalledWith({
      orderBy: { updatedAt: 'asc' },
      select: { id: true },
      take: 2,
      where: {
        OR: [
          { processedAt: { lt: new Date('2026-07-01T00:00:00.000Z') }, status: 'PROCESSED' },
          { status: 'IGNORED', updatedAt: { lt: new Date('2026-07-01T00:00:00.000Z') } }
        ]
      }
    });
    expect(prisma.shopifyWebhookEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['processed-old', 'ignored-old'] } }
    });
  });
});

type CreateWebhookEventInput = {
  data: {
    payload: unknown;
    payloadRedactedAt?: Date;
    status?: string;
    topic?: string;
  };
};

type PrismaHarness = {
  $queryRaw: ReturnType<typeof vi.fn<() => Promise<unknown[]>>>;
  $transaction: ReturnType<typeof vi.fn>;
  order: { deleteMany: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ count: number }>>> };
  shop: {
    deleteMany: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ count: number }>>>;
    findUnique: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string } | null>>>;
    findUniqueOrThrow: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string }>>>;
    upsert: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string }>>>;
  };
  shopifyWebhookEvent: {
    create: ReturnType<typeof vi.fn<(input: CreateWebhookEventInput) => Promise<{ id: string }>>>;
    findUnique: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ status: string } | null>>>;
    updateMany: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ count: number }>>>;
  };
  shopifyOrderRedactionTombstone: {
    upsert: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string }>>>
  };
  shopifyRedactedWebhookReceipt: {
    create: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string }>>>;
    findUnique: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string } | null>>>;
  };
  shopifyShopRedactionTombstone: {
    findUnique: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string } | null>>>;
    upsert: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ id: string }>>>;
  };
};

function createPrismaHarness(): PrismaHarness {
  const prisma = {
    $queryRaw: vi.fn(() => Promise.resolve([])),
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(prisma)),
    order: {
      deleteMany: vi.fn(() => Promise.resolve({ count: 2 }))
    },
    shop: {
      deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
      findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' })),
      findUniqueOrThrow: vi.fn(() => Promise.resolve({ id: 'shop-id' })),
      upsert: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
    },
    shopifyWebhookEvent: {
      create: vi.fn(() => Promise.resolve({ id: 'event-id' })),
      findUnique: vi.fn(() => Promise.resolve({ status: 'PROCESSED' })),
      updateMany: vi.fn((input: unknown) => {
        void input;
        return Promise.resolve({ count: 1 });
      })
    },
    shopifyOrderRedactionTombstone: {
      upsert: vi.fn(() => Promise.resolve({ id: 'tombstone-id' }))
    },
    shopifyRedactedWebhookReceipt: {
      create: vi.fn(() => Promise.resolve({ id: 'receipt-id' })),
      findUnique: vi.fn(() => Promise.resolve(null))
    },
    shopifyShopRedactionTombstone: {
      findUnique: vi.fn(() => Promise.resolve(null)),
      upsert: vi.fn(() => Promise.resolve({ id: 'shop-tombstone-id' }))
    }
  };
  return prisma;
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
    findMany: ReturnType<typeof vi.fn<(input: unknown) => Promise<Array<{ id: string }>>>>;
    deleteMany: ReturnType<typeof vi.fn<(input: unknown) => Promise<{ count: number }>>>;
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
  base.shop.findUnique = vi.fn((findInput: unknown) => {
    void findInput;
    return Promise.resolve({ id: 'shop-id' });
  });
  base.shopifyWebhookEvent.findFirst = vi.fn(() => Promise.resolve({ id: 'event-row-id', status: input.status }));
  base.shopifyWebhookEvent.findMany = vi.fn(() => Promise.resolve([]));
  base.shopifyWebhookEvent.deleteMany = vi.fn(() => Promise.resolve({ count: 0 }));
  base.shopifyWebhookEvent.findUnique = vi.fn((findInput: unknown) => {
    void findInput;
    return (
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
  });
  base.shopifyWebhookEvent.update = vi.fn(() => Promise.resolve({ id: 'event-row-id' }));
  base.shopifyWebhookEvent.updateMany = vi.fn((updateInput: unknown) => {
    void updateInput;
    return Promise.resolve({ count: 1 });
  });
  return base;
}

function orderClaimInput() {
  return {
    appId: 'clever',
    shopDomain: 'clever-route-test.myshopify.com',
    webhookId: 'webhook-id'
  };
}
