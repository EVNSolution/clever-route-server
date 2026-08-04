import { describe, expect, test, vi } from 'vitest';

import { PrismaShopifyOrderReconciliationRepository } from '../src/modules/shopify/order-reconciliation.repository.js';

describe('PrismaShopifyOrderReconciliationRepository', () => {
  test('uses a shop-scoped advisory lock and reuses an active job', async () => {
    const active = jobRecord({ status: 'RUNNING' });
    const transaction = transactionHarness({ findFirst: vi.fn(() => Promise.resolve(active)) });
    const prisma = prismaHarness(transaction);
    const repository = new PrismaShopifyOrderReconciliationRepository(prisma as never);

    await expect(repository.enqueueIfIdle({
      appId: 'clever',
      mode: 'INCREMENTAL',
      requestedBy: 'system:token-exchange',
      shopDomain: 'example.myshopify.com'
    })).resolves.toMatchObject({ enqueued: false, job: { id: active.id } });

    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.shopifyOrderReconciliationJob.create).not.toHaveBeenCalled();
  });

  test('skips immediately when another runtime owns the shop enqueue lock', async () => {
    const transaction = transactionHarness({
      queryRaw: vi.fn(() => Promise.resolve([{ locked: false }]))
    });
    const repository = new PrismaShopifyOrderReconciliationRepository(prismaHarness(transaction) as never);

    await expect(repository.enqueueIfIdle({
      appId: 'clever',
      mode: 'INCREMENTAL',
      requestedBy: 'system:token-exchange',
      shopDomain: 'example.myshopify.com'
    })).resolves.toEqual({ enqueued: false, job: null });

    expect(transaction.shop.findUnique).not.toHaveBeenCalled();
    expect(transaction.shopifyOrderReconciliationJob.findFirst).not.toHaveBeenCalled();
  });

  test('reactivates a retry-wait job immediately after token exchange', async () => {
    const waiting = jobRecord({
      attemptCount: 4,
      lastErrorCode: 'SHOPIFY_AUTH_ERROR',
      lastErrorMessageRedacted: 'Shopify request failed',
      nextRunAt: new Date('2026-08-04T05:30:00Z'),
      status: 'RETRY_WAIT'
    });
    const reactivated = jobRecord({ status: 'QUEUED' });
    const transaction = transactionHarness({
      findFirst: vi.fn(() => Promise.resolve(waiting)),
      update: vi.fn(() => Promise.resolve(reactivated))
    });
    const repository = new PrismaShopifyOrderReconciliationRepository(prismaHarness(transaction) as never);

    await expect(repository.enqueueIfIdle({
      appId: 'clever',
      mode: 'INCREMENTAL',
      requestedBy: 'system:token-exchange',
      shopDomain: 'example.myshopify.com'
    })).resolves.toMatchObject({ enqueued: false, job: { status: 'QUEUED' } });

    const updateCall = transaction.shopifyOrderReconciliationJob.update.mock.calls[0] as [{
      data: Record<string, unknown>;
      where: { id: string };
    }] | undefined;
    expect(updateCall?.[0]).toMatchObject({
      data: {
        attemptCount: 0,
        lastErrorCode: null,
        lastErrorMessageRedacted: null,
        requestedBy: 'system:token-exchange',
        status: 'QUEUED'
      },
      where: { id: waiting.id }
    });
  });

  test('creates one incremental job from the previous high-watermark overlap', async () => {
    const highWatermark = new Date('2026-08-04T05:00:00Z');
    const created = jobRecord({
      highWatermark: null,
      startedFrom: new Date('2026-08-04T04:50:00Z'),
      status: 'QUEUED'
    });
    const findFirst = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ highWatermark });
    const transaction = transactionHarness({
      create: vi.fn(() => Promise.resolve(created)),
      findFirst
    });
    const prisma = prismaHarness(transaction);
    const repository = new PrismaShopifyOrderReconciliationRepository(prisma as never);

    await expect(repository.enqueueIfIdle({
      appId: 'clever',
      mode: 'INCREMENTAL',
      requestedBy: 'system:token-exchange',
      shopDomain: 'example.myshopify.com'
    })).resolves.toMatchObject({ enqueued: true, job: { id: created.id } });

    const createCall = transaction.shopifyOrderReconciliationJob.create.mock.calls[0] as [{
      data: Record<string, unknown>;
    }] | undefined;
    expect(createCall?.[0]).toMatchObject({
      data: {
        appId: 'clever',
        mode: 'INCREMENTAL',
        overlapWindowSeconds: 600,
        requestedBy: 'system:token-exchange',
        shopDomain: 'example.myshopify.com',
        startedFrom: new Date('2026-08-04T04:50:00Z')
      }
    });
  });

  test('queues only installed read-order shops selected by the stale sweep', async () => {
    const transaction = transactionHarness();
    const prisma = prismaHarness(transaction, [
      { appId: 'clever', shopDomain: 'a.myshopify.com' },
      { appId: 'clever-route-dev', shopDomain: 'b.myshopify.com' }
    ]);
    const repository = new PrismaShopifyOrderReconciliationRepository(prisma as never);
    const enqueueIfIdle = vi.spyOn(repository, 'enqueueIfIdle')
      .mockResolvedValue({ enqueued: true, job: jobRecord() as never });
    const staleBefore = new Date('2026-08-04T05:00:00Z');

    await expect(repository.enqueueDueInstalledShops({
      limit: 100,
      now: new Date('2026-08-04T05:05:00Z'),
      requestedBy: 'system:periodic-reconciliation',
      staleBefore
    })).resolves.toEqual({ enqueued: 2, failed: 0, skipped: 0 });

    expect(enqueueIfIdle).toHaveBeenCalledTimes(2);
    const findManyCall = prisma.shop.findMany.mock.calls[0] as [{
      take: number;
      where: Record<string, unknown>;
    }] | undefined;
    expect(findManyCall?.[0]).toMatchObject({
      take: 100,
      where: {
        adminAccessTokenCiphertext: { not: null },
        tokenScopes: { has: 'read_orders' },
        uninstalledAt: null
      }
    });
    expect(JSON.stringify(findManyCall?.[0].where)).toContain('"status":"DEAD_LETTER"');
  });

  test('continues the stale sweep when one shop cannot be queued', async () => {
    const transaction = transactionHarness();
    const prisma = prismaHarness(transaction, [
      { appId: 'clever', shopDomain: 'a.myshopify.com' },
      { appId: 'clever-route-dev', shopDomain: 'b.myshopify.com' }
    ]);
    const repository = new PrismaShopifyOrderReconciliationRepository(prisma as never);
    vi.spyOn(repository, 'enqueueIfIdle')
      .mockRejectedValueOnce(new Error('shop removed during sweep'))
      .mockResolvedValueOnce({ enqueued: true, job: jobRecord() as never });

    await expect(repository.enqueueDueInstalledShops({
      limit: 100,
      requestedBy: 'system:periodic-reconciliation',
      staleBefore: new Date('2026-08-04T05:00:00Z')
    })).resolves.toEqual({ enqueued: 1, failed: 1, skipped: 0 });
  });
});

function prismaHarness(transaction: ReturnType<typeof transactionHarness>, shops: Array<{ appId: string; shopDomain: string }> = []) {
  return {
    $transaction: vi.fn((callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    order: {},
    shop: {
      findMany: vi.fn(() => Promise.resolve(shops)),
      findUnique: transaction.shop.findUnique
    },
    shopifyOrderReconciliationJob: transaction.shopifyOrderReconciliationJob
  };
}

function transactionHarness(overrides: {
  create?: ReturnType<typeof vi.fn>;
  findFirst?: ReturnType<typeof vi.fn>;
  queryRaw?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    $queryRaw: overrides.queryRaw ?? vi.fn(() => Promise.resolve([{ locked: true }])),
    order: {},
    shop: {
      findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
    },
    shopifyOrderReconciliationJob: {
      create: overrides.create ?? vi.fn(),
      findFirst: overrides.findFirst ?? vi.fn(),
      findUnique: vi.fn(),
      update: overrides.update ?? vi.fn(),
      updateMany: vi.fn()
    }
  };
}

function jobRecord(overrides: Record<string, unknown> = {}) {
  return { ...baseJobRecord(), ...overrides };
}

function baseJobRecord() {
  const now = new Date('2026-08-04T05:00:00Z');
  return {
    appId: 'clever',
    attemptCount: 0,
    correlationId: 'correlation-id',
    createdAt: now,
    createdCount: 0,
    deadLetteredAt: null,
    failedCount: 0,
    finalCanonicalCount: null,
    finishedAt: null,
    highWatermark: null,
    id: 'job-id',
    lastErrorCode: null,
    lastErrorMessageRedacted: null,
    leaseExpiresAt: null,
    leaseToken: null,
    maxAttempts: 5,
    mode: 'INCREMENTAL' as const,
    nextRunAt: now,
    overlapWindowSeconds: 600,
    pageCursor: null,
    pageSize: 50,
    requestedBy: 'system:test',
    scannedCount: 0,
    shopDomain: 'example.myshopify.com',
    shopId: 'shop-id',
    staleSkippedCount: 0,
    startedAt: null,
    startedFrom: null,
    status: 'QUEUED' as const,
    unchangedCount: 0,
    updatedAt: now,
    updatedCount: 0,
    warningCount: 0,
    warnings: null,
    workerId: null
  };
}
