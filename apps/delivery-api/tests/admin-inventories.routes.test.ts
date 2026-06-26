import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { InventoryDto } from '../src/modules/inventory/inventory.types.js';
import type { AdminInventoryDependencies } from '../src/routes/admin-inventories.routes.js';

const inventory: InventoryDto = {
  createdAt: '2026-06-26T00:00:00.000Z',
  id: 'inventory-id',
  itemSummary: {
    changedSincePublish: false,
    fingerprint: 'fingerprint',
    itemTypes: 1,
    items: [{ name: 'Kimchi', options: [], productId: 1, quantity: 3, sku: null, variationId: 0 }],
    totalQuantity: 3
  },
  lastChange: [{ action: 'ADD', name: 'Kimchi', options: [], orderId: 'order-1', productId: 1, quantity: 3, quantityDelta: 3, sku: null, variationId: 0 }],
  name: 'Prep batch',
  note: null,
  orderIds: ['order-1'],
  ordersCount: 1,
  updatedAt: '2026-06-26T00:00:00.000Z'
};

describe('Admin inventory routes', () => {
  test('creates inventory with token app/shop scope', async () => {
    const { createInventory, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminInventories: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'clever-route-dev' },
        method: 'POST',
        payload: { name: 'Prep batch', orderIds: ['order-1'] },
        url: '/admin/inventories'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ data: { inventory }, error: null });
      expect(createInventory).toHaveBeenCalledWith({
        actor: 'shopify-user-id',
        appId: 'clever-route-dev',
        name: 'Prep batch',
        orderIds: ['order-1'],
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('updates inventory order membership', async () => {
    const { dependencies, updateInventoryOrders } = createDependencyHarness();
    const app = await buildApp({ adminInventories: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { addOrderIds: ['order-2'], removeOrderIds: ['order-1'] },
        url: '/admin/inventories/inventory-id/orders'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { inventory }, error: null });
      expect(updateInventoryOrders).toHaveBeenCalledWith({
        actor: 'shopify-user-id',
        addOrderIds: ['order-2'],
        appId: 'clever',
        inventoryId: 'inventory-id',
        removeOrderIds: ['order-1'],
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });
});

function createDependencyHarness(): {
  createInventory: ReturnType<typeof vi.fn<AdminInventoryDependencies['inventoryService']['createInventory']>>;
  dependencies: AdminInventoryDependencies;
  updateInventoryOrders: ReturnType<typeof vi.fn<AdminInventoryDependencies['inventoryService']['updateInventoryOrders']>>;
} {
  const verify = vi.fn((_token: string, options?: object) => ({
    appId: options !== undefined && 'expectedAppId' in options ? String(options.expectedAppId) : 'clever',
    shopDomain: 'example.myshopify.com',
    subject: 'shopify-user-id'
  }));
  const createInventory = vi.fn<AdminInventoryDependencies['inventoryService']['createInventory']>(() => Promise.resolve(inventory));
  const deleteInventory = vi.fn<AdminInventoryDependencies['inventoryService']['deleteInventory']>(() => Promise.resolve({ deleted: true, inventoryId: 'inventory-id' }));
  const getInventory = vi.fn<AdminInventoryDependencies['inventoryService']['getInventory']>(() => Promise.resolve(inventory));
  const listInventories = vi.fn<AdminInventoryDependencies['inventoryService']['listInventories']>(() => Promise.resolve([inventory]));
  const updateInventoryOrders = vi.fn<AdminInventoryDependencies['inventoryService']['updateInventoryOrders']>(() => Promise.resolve(inventory));

  return {
    createInventory,
    dependencies: {
      inventoryService: {
        createInventory,
        deleteInventory,
        getInventory,
        listInventories,
        updateInventoryOrders
      },
      sessionTokenVerifier: { verify }
    },
    updateInventoryOrders
  };
}
