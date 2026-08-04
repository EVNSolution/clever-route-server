import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';

import { OrdersPaginationNotReadyError, PrismaOrderQueryRepository } from '../src/modules/shopify/order-query.repository.js';
import {
  createOrdersFilterHash,
  encodeOrdersCursor,
  OrdersPlanningReferenceDateError
} from '../src/modules/shopify/order-pagination.js';

describe('PrismaOrderQueryRepository page query', () => {
  test('applies normalized filters and the immutable tuple before LIMIT 51', async () => {
    const findMany = vi.fn<(query: unknown) => Promise<unknown[]>>(() => Promise.resolve([]));
    const prisma = prismaHarness({ findMany, missingSequence: null });
    const repository = new PrismaOrderQueryRepository(prisma, 'test-secret');

    const page = await repository.listPage({
      appId: 'clever',
      filters: {
        deliveryState: 'planned',
        orderedDateFrom: '2026-05-01',
        orderedDateTo: '2026-05-31',
        routeOpsToday: '2026-08-04',
        scope: 'planning',
        tab: 'unplanned'
      },
      shopDomain: 'example.myshopify.com'
    });

    expect(page.rows).toEqual([]);
    expect(findMany).toHaveBeenCalledOnce();
    const query = findMany.mock.calls[0]?.[0] as { orderBy?: unknown; take?: unknown; where?: unknown } | undefined;
    expect(query?.orderBy).toEqual([{ displayOrderSequence: 'desc' }, { id: 'desc' }]);
    expect(query?.take).toBe(51);
    expect(Array.isArray((query?.where as { AND?: unknown } | undefined)?.AND)).toBe(true);
    expect(JSON.stringify(query)).toContain('processedAt');
    expect(JSON.stringify(query)).toContain('routePlanStops');
    expect(JSON.stringify(query)).toContain('2026-08-04T00:00:00.000Z');
    expect(JSON.stringify(query)).not.toContain('__invalid_missing_today__');
  });

  test('rejects planning queries without an explicit reference date', async () => {
    const findMany = vi.fn<(query: unknown) => Promise<unknown[]>>();
    const repository = new PrismaOrderQueryRepository(
      prismaHarness({ findMany, missingSequence: null }),
      'test-secret'
    );
    await expect(repository.listPage({ filters: { scope: 'planning' }, shopDomain: 'example.myshopify.com' }))
      .rejects.toBeInstanceOf(OrdersPlanningReferenceDateError);
    expect(findMany).not.toHaveBeenCalled();
  });

  test('adds an indexable sequence bound before applying the exact forward tuple predicate', async () => {
    const findMany = vi.fn<(query: unknown) => Promise<unknown[]>>(() => Promise.resolve([]));
    const repository = new PrismaOrderQueryRepository(
      prismaHarness({ findMany, missingSequence: null }),
      'test-secret'
    );
    const filters = { routeOpsToday: '2026-08-04', scope: 'planning' } as const;
    const after = encodeOrdersCursor({
      appId: 'clever',
      boundary: 'after',
      filterHash: createOrdersFilterHash(filters, 'test-secret'),
      orderId: '00000000-0000-0000-0000-000000000020',
      readWatermark: new Date().toISOString(),
      sequence: '250000',
      shopId: '00000000-0000-0000-0000-000000000001'
    }, 'test-secret');

    await repository.listPage({ after, appId: 'clever', filters, shopDomain: 'example.myshopify.com' });

    const query = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    const whereJson = JSON.stringify(
      query?.where,
      (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value
    );
    expect(whereJson).toContain('"lte":"250000"');
    expect(whereJson).toContain('"lt":"250000"');
    expect(whereJson).toContain('00000000-0000-0000-0000-000000000020');
  });

  test('adds the matching indexable bound for backward traversal', async () => {
    const findMany = vi.fn<(query: unknown) => Promise<unknown[]>>(() => Promise.resolve([]));
    const repository = new PrismaOrderQueryRepository(
      prismaHarness({ findMany, missingSequence: null }),
      'test-secret'
    );
    const filters = { routeOpsToday: '2026-08-04', scope: 'planning' } as const;
    const before = encodeOrdersCursor({
      appId: 'clever',
      boundary: 'before',
      filterHash: createOrdersFilterHash(filters, 'test-secret'),
      orderId: '00000000-0000-0000-0000-000000000020',
      readWatermark: new Date().toISOString(),
      sequence: '250000',
      shopId: '00000000-0000-0000-0000-000000000001'
    }, 'test-secret');

    await repository.listPage({ appId: 'clever', before, filters, shopDomain: 'example.myshopify.com' });

    const query = findMany.mock.calls[0]?.[0] as { orderBy?: unknown; where?: unknown } | undefined;
    const whereJson = JSON.stringify(
      query?.where,
      (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value
    );
    expect(query?.orderBy).toEqual([{ displayOrderSequence: 'asc' }, { id: 'asc' }]);
    expect(whereJson).toContain('"gte":"250000"');
    expect(whereJson).toContain('"gt":"250000"');
    expect(whereJson).toContain('00000000-0000-0000-0000-000000000020');
  });

  test('hard-stops instead of silently dropping reachable null sequences', async () => {
    const findMany = vi.fn<(query: unknown) => Promise<unknown[]>>();
    const repository = new PrismaOrderQueryRepository(
      prismaHarness({ findMany, missingSequence: { id: 'private-order-id' } }),
      'test-secret'
    );
    await expect(repository.listPage({ shopDomain: 'example.myshopify.com' }))
      .rejects.toBeInstanceOf(OrdersPaginationNotReadyError);
    expect(findMany).not.toHaveBeenCalled();
  });

  test('uses one stable snapshot filter for numeric page 3 exact count and offset', async () => {
    const findMany = vi.fn<(query: unknown) => Promise<unknown[]>>(() => Promise.resolve([]));
    const count = vi.fn<(query: unknown) => Promise<number>>(() => Promise.resolve(123));
    const repository = new PrismaOrderQueryRepository(
      prismaHarness({ count, findMany, missingSequence: null }),
      'test-secret'
    );

    const page = await repository.listPage({
      page: 3,
      readWatermark: '2026-08-04T00:00:00.000Z',
      shopDomain: 'example.myshopify.com'
    });

    expect(page).toMatchObject({
      count: 123,
      countPrecision: 'exact',
      pageInfo: {
        currentPage: 3,
        hasNextPage: false,
        hasPreviousPage: true,
        readWatermark: '2026-08-04T00:00:00.000Z',
        totalPages: 3
      },
      rows: []
    });
    expect(count).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledOnce();
    const countQuery = firstCallArg(count) as { where: unknown };
    const findManyQuery = firstCallArg(findMany) as { orderBy?: unknown; skip?: unknown; take?: unknown; where?: unknown };
    expect(findManyQuery.orderBy).toEqual([{ displayOrderSequence: 'desc' }, { id: 'desc' }]);
    expect(findManyQuery.skip).toBe(100);
    expect(findManyQuery.take).toBe(50);
    expect(findManyQuery.where).toEqual(countQuery.where);
    expect(JSON.stringify(findManyQuery.where)).toContain('2026-08-04T00:00:00.000Z');
  });

  test('keeps numeric page totals consistent with normalized filters', async () => {
    const findMany = vi.fn<(query: unknown) => Promise<unknown[]>>(() => Promise.resolve([]));
    const count = vi.fn<(query: unknown) => Promise<number>>(() => Promise.resolve(8));
    const repository = new PrismaOrderQueryRepository(
      prismaHarness({ count, findMany, missingSequence: null }),
      'test-secret'
    );

    const page = await repository.listPage({
      filters: { deliveryState: 'planned', routeOpsToday: '2026-08-04', scope: 'planning' },
      page: 1,
      shopDomain: 'example.myshopify.com'
    });

    expect(page.count).toBe(8);
    expect(page.pageInfo.currentPage).toBe(1);
    expect(page.pageInfo.totalPages).toBe(1);
    const countQuery = firstCallArg(count);
    const findManyQuery = firstCallArg(findMany) as { where?: unknown };
    expect(findManyQuery.where).toEqual((countQuery as { where: unknown }).where);
    const whereJson = JSON.stringify(countQuery);
    expect(whereJson).toContain('routePlanStops');
    expect(whereJson).toContain('2026-08-04T00:00:00.000Z');
  });

  test('persists only keyed hashes and canonical ids for a PII-bearing selection filter', async () => {
    const snapshotCreate = vi.fn<(input: { data: unknown }) => Promise<{
      expiresAt: Date;
      id: string;
      selectedCount: number;
      snapshotWatermark: Date;
    }>>(() => Promise.resolve({
      expiresAt: new Date('2026-08-04T00:15:00.000Z'),
      id: 'snapshot-1',
      selectedCount: 1,
      snapshotWatermark: new Date('2026-08-04T00:00:00.000Z')
    }));
    const snapshotOrderCreateMany = vi.fn(() => Promise.resolve({ count: 1 }));
    const tx = {
      order: { findMany: vi.fn(() => Promise.resolve([{ id: 'order-1' }])) },
      orderSelectionSnapshot: { create: snapshotCreate },
      orderSelectionSnapshotOrder: { createMany: snapshotOrderCreateMany }
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      orderSelectionSnapshot: {
        deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
        findMany: vi.fn(() => Promise.resolve([]))
      },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-1' })) }
    } as unknown as PrismaClient;
    const repository = new PrismaOrderQueryRepository(prisma, 'test-secret');

    const result = await repository.createSelectionSnapshot({
      actor: 'customer@example.com',
      appId: 'clever',
      filters: { search: '+1-416-555-0199' },
      shopDomain: 'example.myshopify.com'
    });

    const persisted = JSON.stringify(snapshotCreate.mock.calls[0]?.[0]);
    expect(persisted).not.toContain('customer@example.com');
    expect(persisted).not.toContain('+1-416-555-0199');
    expect(persisted).not.toContain(result.selectionToken);
    expect(persisted).toContain('hmac-sha256:');
    expect(result.selectionToken).toHaveLength(43);
    const snapshotCreateInput = firstCallArg(snapshotCreate) as {
      data: { actorSubjectHash: string; tokenHash: string };
    };
    expect(snapshotCreateInput.data.actorSubjectHash).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(snapshotCreateInput.data.tokenHash).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(snapshotOrderCreateMany).toHaveBeenCalledWith({
      data: [{ excludedAt: null, orderId: 'order-1', snapshotId: 'snapshot-1' }]
    });
  });

  test('persists exact snapshot membership and rejects exclusions outside the snapshot filter', async () => {
    const snapshotCreate = vi.fn(() => Promise.resolve({
      expiresAt: new Date('2026-08-04T00:15:00.000Z'),
      id: 'snapshot-1',
      selectedCount: 1,
      snapshotWatermark: new Date('2026-08-04T00:00:00.000Z')
    }));
    const snapshotOrderCreateMany = vi.fn(() => Promise.resolve({ count: 2 }));
    const tx = {
      order: { findMany: vi.fn(() => Promise.resolve([{ id: 'order-1' }, { id: 'order-2' }])) },
      orderSelectionSnapshot: { create: snapshotCreate },
      orderSelectionSnapshotOrder: { createMany: snapshotOrderCreateMany }
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      orderSelectionSnapshot: { deleteMany: vi.fn(), findMany: vi.fn(() => Promise.resolve([])) },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-1' })) }
    } as unknown as PrismaClient;
    const repository = new PrismaOrderQueryRepository(prisma, 'test-secret');

    await expect(repository.createSelectionSnapshot({
      actor: 'actor-1',
      appId: 'clever',
      excludeOrderIds: ['not-a-member'],
      shopDomain: 'example.myshopify.com'
    })).rejects.toThrow('Invalid or expired selection snapshot');

    await repository.createSelectionSnapshot({
      actor: 'actor-1',
      appId: 'clever',
      excludeOrderIds: ['order-2'],
      shopDomain: 'example.myshopify.com'
    });

    expect(snapshotCreate).toHaveBeenCalledTimes(1);
    const membershipCreateInput = firstCallArg(snapshotCreate) as { data: { selectedCount: number } };
    const membershipRowsInput = firstCallArg(snapshotOrderCreateMany) as {
      data: Array<{ excludedAt: Date | null; orderId: string; snapshotId: string }>;
    };
    expect(membershipCreateInput.data.selectedCount).toBe(1);
    expect(membershipRowsInput.data).toHaveLength(2);
    expect(membershipRowsInput.data[0]).toEqual({ excludedAt: null, orderId: 'order-1', snapshotId: 'snapshot-1' });
    expect(membershipRowsInput.data[1]?.excludedAt).toBeInstanceOf(Date);
    expect(membershipRowsInput.data[1]).toMatchObject({ orderId: 'order-2', snapshotId: 'snapshot-1' });
  });

  test('claims and applies a snapshot bulk update inside one serializable transaction', async () => {
    const snapshotUpdateMany = vi.fn(() => Promise.resolve({ count: 1 }));
    const orderUpdate = vi.fn(() => Promise.resolve({ id: 'order-1' }));
    const deliveryStopUpsert = vi.fn(() => Promise.resolve({ id: 'stop-1' }));
    const tx = {
      deliveryStop: { upsert: deliveryStopUpsert },
      order: {
        findMany: vi.fn(() => Promise.resolve([{ cancelledAt: null, deliveryStops: [], financialStatus: null, id: 'order-1', rawPayload: {} }])),
        update: orderUpdate
      },
      orderSelectionSnapshot: {
        findFirst: vi.fn(() => Promise.resolve({
          consumedAt: null,
          expiresAt: new Date('2026-08-04T00:15:00.000Z'),
          id: 'snapshot-1',
          orders: [
            { excludedAt: null, orderId: 'order-1' },
            { excludedAt: new Date('2026-08-04T00:01:00.000Z'), orderId: 'order-2' }
          ],
          selectedCount: 1,
          shopId: 'shop-1'
        })),
        updateMany: snapshotUpdateMany
      },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-1' })) }
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
    const repository = new PrismaOrderQueryRepository({ $transaction: transaction } as unknown as PrismaClient, 'test-secret');

    await expect(repository.bulkPatchSelectionSnapshot({
      actor: 'actor-1',
      appId: 'clever',
      field: 'state',
      selectionToken: 'opaque',
      shopDomain: 'example.myshopify.com',
      value: 'ASSIGNED'
    })).resolves.toEqual({
      noOp: 0,
      resolved: 1,
      selected: 1,
      skipped: 0,
      skippedByReason: { cancelled: 0, missing: 0, routeLocked: 0 },
      updated: 1
    });

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
    expect(snapshotUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { consumedAt: null, id: 'snapshot-1' }
    }));
    expect(orderUpdate).toHaveBeenCalledOnce();
    expect(JSON.stringify(firstCallArg(orderUpdate))).not.toContain('actor-1');
    expect(JSON.stringify(firstCallArg(orderUpdate))).not.toContain('UpdatedBy');
    expect(deliveryStopUpsert).toHaveBeenCalledOnce();
  });

  test('reports no-op, missing, and ineligible selected members with allowlisted skippedByReason counts', async () => {
    const tx = {
      order: {
        findMany: vi.fn(() => Promise.resolve([
          {
            cancelledAt: null,
            deliveryStops: [],
            financialStatus: 'PAID',
            id: 'order-1',
            rawPayload: { cleverManualPaymentStatus: 'PAID' }
          },
          {
            cancelledAt: null,
            deliveryStops: [],
            financialStatus: 'PENDING',
            id: 'order-2',
            rawPayload: {}
          },
          {
            cancelledAt: new Date('2026-08-04T00:02:00.000Z'),
            deliveryStops: [],
            financialStatus: 'PENDING',
            id: 'cancelled-order',
            rawPayload: {}
          }
        ])),
        update: vi.fn(() => Promise.resolve({ id: 'order-2' }))
      },
      orderSelectionSnapshot: {
        findFirst: vi.fn(() => Promise.resolve({
          consumedAt: null,
          expiresAt: new Date('2026-08-04T00:15:00.000Z'),
          id: 'snapshot-1',
          orders: [
            { excludedAt: null, orderId: 'order-1' },
            { excludedAt: null, orderId: 'order-2' },
            { excludedAt: null, orderId: 'cancelled-order' },
            { excludedAt: null, orderId: 'deleted-order' }
          ],
          selectedCount: 4,
          shopId: 'shop-1'
        })),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
      },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-1' })) }
    };
    const repository = new PrismaOrderQueryRepository({
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    } as unknown as PrismaClient, 'test-secret');

    await expect(repository.bulkPatchSelectionSnapshot({
      actor: 'actor@example.com',
      appId: 'clever',
      field: 'payment',
      selectionToken: 'opaque',
      shopDomain: 'example.myshopify.com',
      value: 'PAID'
    })).resolves.toEqual({
      noOp: 1,
      resolved: 2,
      selected: 4,
      skipped: 2,
      skippedByReason: { cancelled: 1, missing: 1, routeLocked: 0 },
      updated: 1
    });

    expect(tx.order.update).toHaveBeenCalledOnce();
    const updateJson = JSON.stringify(firstCallArg(tx.order.update));
    expect(updateJson).not.toContain('actor@example.com');
    expect(updateJson).not.toContain('deleted-order');
  });

  test('skips route-locked delivery-state members during bulk eligibility revalidation', async () => {
    const tx = {
      order: {
        findMany: vi.fn(() => Promise.resolve([
          {
            cancelledAt: null,
            deliveryStops: [{
              routePlanStops: [{
                routePlan: {
                  optimizationJobs: [],
                  status: 'IN_PROGRESS'
                }
              }],
              status: 'PENDING'
            }],
            financialStatus: null,
            id: 'locked-order',
            rawPayload: {}
          },
          {
            cancelledAt: null,
            deliveryStops: [{
              routePlanStops: [{
                routePlan: {
                  optimizationJobs: [{ id: 'job-1' }],
                  status: 'READY'
                }
              }],
              status: 'PENDING'
            }],
            financialStatus: null,
            id: 'optimizing-order',
            rawPayload: {}
          },
          {
            cancelledAt: null,
            deliveryStops: [{ routePlanStops: [], status: 'PENDING' }],
            financialStatus: null,
            id: 'eligible-order',
            rawPayload: {}
          }
        ])),
        update: vi.fn(() => Promise.resolve({ id: 'eligible-order' }))
      },
      deliveryStop: { upsert: vi.fn(() => Promise.resolve({ id: 'stop-1' })) },
      orderSelectionSnapshot: {
        findFirst: vi.fn(() => Promise.resolve({
          consumedAt: null,
          expiresAt: new Date('2026-08-04T00:15:00.000Z'),
          id: 'snapshot-1',
          orders: [
            { excludedAt: null, orderId: 'locked-order' },
            { excludedAt: null, orderId: 'optimizing-order' },
            { excludedAt: null, orderId: 'eligible-order' }
          ],
          selectedCount: 3,
          shopId: 'shop-1'
        })),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
      },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-1' })) }
    };
    const repository = new PrismaOrderQueryRepository({
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    } as unknown as PrismaClient, 'test-secret');

    await expect(repository.bulkPatchSelectionSnapshot({
      actor: 'actor-1',
      appId: 'clever',
      field: 'state',
      selectionToken: 'opaque',
      shopDomain: 'example.myshopify.com',
      value: 'ASSIGNED'
    })).resolves.toEqual({
      noOp: 0,
      resolved: 1,
      selected: 3,
      skipped: 2,
      skippedByReason: { cancelled: 0, missing: 0, routeLocked: 2 },
      updated: 1
    });

    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'eligible-order' }
    }));
  });

  test('binds snapshots to shop, app, actor, unexpired time, and keyed token hash', async () => {
    const findFirst = vi.fn(() => Promise.resolve({
      consumedAt: null,
      expiresAt: new Date('2026-08-04T00:15:00.000Z'),
      id: 'snapshot-1',
      orders: [],
      selectedCount: 0,
      shopId: 'shop-1'
    }));
    const tx = {
      orderSelectionSnapshot: {
        findFirst,
        updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
      },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-1' })) }
    };
    const repository = new PrismaOrderQueryRepository({
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    } as unknown as PrismaClient, 'test-secret');

    await repository.consumeSelectionSnapshot({
      actor: 'actor-1',
      appId: 'clever',
      selectionToken: 'opaque',
      shopDomain: 'Example.MyShopify.com'
    });

    const shopLookupInput = firstCallArg(tx.shop.findUnique) as {
      select: { id: true };
      where: { appId_shopDomain: { appId: string; shopDomain: string } };
    };
    expect(shopLookupInput).toEqual({
      select: { id: true },
      where: { appId_shopDomain: { appId: 'clever', shopDomain: 'example.myshopify.com' } }
    });
    const snapshotLookupInput = firstCallArg(findFirst) as {
      include: { orders: true };
      where: {
        actorSubjectHash: string;
        appId: string;
        consumedAt: null;
        expiresAt: { gt: Date };
        shopId: string;
        tokenHash: string;
      };
    };
    expect(snapshotLookupInput.include).toEqual({ orders: true });
    expect(snapshotLookupInput.where.actorSubjectHash).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(snapshotLookupInput.where.appId).toBe('clever');
    expect(snapshotLookupInput.where.consumedAt).toBeNull();
    expect(snapshotLookupInput.where.expiresAt.gt).toBeInstanceOf(Date);
    expect(snapshotLookupInput.where.shopId).toBe('shop-1');
    expect(snapshotLookupInput.where.tokenHash).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    const lookupJson = JSON.stringify(snapshotLookupInput);
    expect(lookupJson).not.toContain('actor-1');
    expect(lookupJson).not.toContain('opaque');
  });

  test('rejects cross-shop, cross-app, cross-actor, tampered, and expired snapshots without leaking tokens', async () => {
    const tx = {
      orderSelectionSnapshot: { findFirst: vi.fn(() => Promise.resolve(null)) },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-1' })) }
    };
    const repository = new PrismaOrderQueryRepository({
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    } as unknown as PrismaClient, 'test-secret');

    for (const input of [
      { actor: 'other-actor', appId: 'clever', selectionToken: 'opaque', shopDomain: 'example.myshopify.com' },
      { actor: 'actor-1', appId: 'other-app', selectionToken: 'opaque', shopDomain: 'example.myshopify.com' },
      { actor: 'actor-1', appId: 'clever', selectionToken: 'tampered', shopDomain: 'example.myshopify.com' },
      { actor: 'actor-1', appId: 'clever', selectionToken: 'opaque', shopDomain: 'other.myshopify.com' }
    ]) {
      await expect(repository.consumeSelectionSnapshot(input)).rejects.toMatchObject({ code: 'INVALID_SELECTION_SNAPSHOT' });
    }

    expect(JSON.stringify(tx.orderSelectionSnapshot.findFirst.mock.calls)).not.toContain('opaque');
    expect(JSON.stringify(tx.orderSelectionSnapshot.findFirst.mock.calls)).not.toContain('tampered');
  });

  test('enforces single-use claim for replay and concurrent consumers', async () => {
    const tx = {
      orderSelectionSnapshot: {
        findFirst: vi.fn(() => Promise.resolve({
          consumedAt: null,
          expiresAt: new Date('2026-08-04T00:15:00.000Z'),
          id: 'snapshot-1',
          orders: [],
          selectedCount: 0,
          shopId: 'shop-1'
        })),
        updateMany: vi.fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 })
      },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-1' })) }
    };
    const repository = new PrismaOrderQueryRepository({
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    } as unknown as PrismaClient, 'test-secret');
    const input = { actor: 'actor-1', appId: 'clever', selectionToken: 'opaque', shopDomain: 'example.myshopify.com' };

    await expect(repository.consumeSelectionSnapshot(input)).resolves.toEqual([]);
    await expect(repository.consumeSelectionSnapshot(input)).rejects.toMatchObject({ code: 'SELECTION_SNAPSHOT_CONSUMED' });
  });

  test('lets the serializable transaction roll back order writes when a later bulk write fails', async () => {
    const tx = {
      deliveryStop: { upsert: vi.fn(() => Promise.reject(new Error('forced rollback'))) },
      order: {
        findMany: vi.fn(() => Promise.resolve([{ cancelledAt: null, deliveryStops: [], financialStatus: null, id: 'order-1', rawPayload: {} }])),
        update: vi.fn(() => Promise.resolve({ id: 'order-1' }))
      },
      orderSelectionSnapshot: {
        findFirst: vi.fn(() => Promise.resolve({
          consumedAt: null,
          expiresAt: new Date('2026-08-04T00:15:00.000Z'),
          id: 'snapshot-1',
          orders: [{ excludedAt: null, orderId: 'order-1' }],
          selectedCount: 1,
          shopId: 'shop-1'
        })),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
      },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-1' })) }
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
    const repository = new PrismaOrderQueryRepository({ $transaction: transaction } as unknown as PrismaClient, 'test-secret');

    await expect(repository.bulkPatchSelectionSnapshot({
      actor: 'actor-1',
      appId: 'clever',
      field: 'state',
      selectionToken: 'opaque',
      shopDomain: 'example.myshopify.com',
      value: 'ASSIGNED'
    })).rejects.toThrow('forced rollback');

    const orderUpdateCallOrder = tx.order.update.mock.invocationCallOrder[0];
    const stopUpsertCallOrder = tx.deliveryStop.upsert.mock.invocationCallOrder[0];
    expect(orderUpdateCallOrder).toBeDefined();
    expect(stopUpsertCallOrder).toBeDefined();
    if (orderUpdateCallOrder === undefined || stopUpsertCallOrder === undefined) throw new Error('Expected write calls');
    expect(orderUpdateCallOrder).toBeLessThan(stopUpsertCallOrder);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
  });

  test('cleanup is bounded and idempotent', async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([{ id: 'snapshot-1' }, { id: 'snapshot-2' }])
      .mockResolvedValueOnce([]);
    const deleteMany = vi.fn(() => Promise.resolve({ count: 2 }));
    const repository = new PrismaOrderQueryRepository({
      orderSelectionSnapshot: { deleteMany, findMany }
    } as unknown as PrismaClient, 'test-secret');

    await expect(repository.cleanupSelectionSnapshots(1_000)).resolves.toBe(2);
    await expect(repository.cleanupSelectionSnapshots(1_000)).resolves.toBe(0);

    const cleanupLookupInput = firstCallArg(findMany) as {
      select: { id: true };
      take: number;
      where: { OR: [{ expiresAt: { lt: Date } }, { consumedAt: { lt: Date } }] };
    };
    expect(cleanupLookupInput.select).toEqual({ id: true });
    expect(cleanupLookupInput.take).toBe(500);
    expect(cleanupLookupInput.where.OR[0].expiresAt.lt).toBeInstanceOf(Date);
    expect(cleanupLookupInput.where.OR[1].consumedAt.lt).toBeInstanceOf(Date);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['snapshot-1', 'snapshot-2'] } } });
    expect(deleteMany).toHaveBeenCalledOnce();
  });
});

function firstCallArg(mock: { mock: { calls: unknown[][] } }): unknown {
  const firstCall = mock.mock.calls[0];
  if (firstCall === undefined) throw new Error('Expected mock to be called');
  return firstCall[0];
}

function prismaHarness(input: { count?: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; missingSequence: { id: string } | null }): PrismaClient {
  return {
    order: {
      count: input.count ?? vi.fn(() => Promise.resolve(0)),
      findFirst: vi.fn(() => Promise.resolve(input.missingSequence)),
      findMany: input.findMany
    },
    shop: {
      findUnique: vi.fn(() => Promise.resolve({ id: '00000000-0000-0000-0000-000000000001' }))
    }
  } as unknown as PrismaClient;
}
