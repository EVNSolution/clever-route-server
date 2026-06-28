import { describe, expect, test, vi } from 'vitest';

import { PrismaInventoryService, recordInventorySourceItemDeltas, syncRouteGroupingInventoryOrders } from '../src/modules/inventory/inventory.service.js';

describe('inventory service route-group follower behavior', () => {
  test('lists only route-group linked inventories', async () => {
    const findMany = vi.fn(async () => []);
    const service = new PrismaInventoryService({
      inventory: { findMany },
      shop: { findUnique: vi.fn(async () => ({ id: 'shop-1' })) }
    } as never);

    await service.listInventories({ appId: 'clever-route-dev', shopDomain: 'example.myshopify.com' });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { routeGroupingId: { not: null }, shopId: 'shop-1' }
    }));
  });

  test('creates a missing linked inventory from full current route-group membership', async () => {
    const createdInventoryOrders: unknown[] = [];
    const tx = {
      inventory: {
        findUnique: vi.fn(async () => null),
        update: vi.fn(async () => ({})),
        upsert: vi.fn(async () => ({ id: 'inventory-1' }))
      },
      inventoryEvent: { createMany: vi.fn(async () => ({ count: 2 })) },
      inventoryOrder: {
        createMany: vi.fn(async ({ data }) => { createdInventoryOrders.push(...data); return { count: data.length }; }),
        findMany: vi.fn(async () => [])
      },
      order: {
        findMany: vi.fn(async ({ where }) => where.id.in.map((id: string) => ({
          id,
          orderItems: [{ id: `item-${id}`, name: 'Kimchi', options: [], productId: 1, quantity: 1, sku: null, variationId: 0 }]
        })))
      },
      routeGroupingOrder: {
        findMany: vi.fn(async () => [{ orderId: 'existing-order' }, { orderId: 'new-order' }])
      }
    };

    await syncRouteGroupingInventoryOrders(tx as never, {
      actor: 'route-grouping-membership',
      addOrderIds: ['new-order'],
      groupingId: 'group-1',
      name: 'Route group',
      removeOrderIds: [],
      shopId: 'shop-1'
    });

    expect(tx.routeGroupingOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { groupingId: 'group-1', shopId: 'shop-1' }
    }));
    expect(createdInventoryOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderId: 'existing-order' }),
      expect.objectContaining({ orderId: 'new-order' })
    ]));
  });

  test('records source item deltas with canonical option identity', async () => {
    const events: unknown[] = [];
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      inventoryEvent: { createMany: vi.fn(async ({ data }) => { events.push(...data); return { count: data.length }; }) },
      inventoryOrder: { findMany: vi.fn(async () => [{ inventoryId: 'inventory-1' }]) },
      inventory: { updateMany }
    };

    await recordInventorySourceItemDeltas(tx as never, {
      actor: 'order-sync',
      currentItems: [{ id: 'current', name: 'Kimchi', options: [{ key: 'B', value: '2' }, { key: 'A', value: '1' }], productId: 1, quantity: 1, sku: null, variationId: 0 }],
      orderId: 'order-1',
      previousItems: [{ id: 'previous', name: 'Kimchi', options: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }], productId: 1, quantity: 1, sku: null, variationId: 0 }],
      shopId: 'shop-1'
    });
    expect(events).toHaveLength(0);

    await recordInventorySourceItemDeltas(tx as never, {
      actor: 'order-sync',
      currentItems: [{ id: 'current', name: 'Kimchi', options: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }], productId: 1, quantity: 3, sku: null, variationId: 0 }],
      orderId: 'order-1',
      previousItems: [{ id: 'previous', name: 'Kimchi', options: [{ key: 'B', value: '2' }, { key: 'A', value: '1' }], productId: 1, quantity: 1, sku: null, variationId: 0 }],
      shopId: 'shop-1'
    });

    expect(events).toEqual([expect.objectContaining({ action: 'CHANGE', orderId: 'order-1', quantity: 2, quantityDelta: 2 })]);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ updatedAt: expect.any(Date) }) }));
  });
});
