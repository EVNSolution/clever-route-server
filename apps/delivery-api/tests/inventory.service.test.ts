import { describe, expect, test, vi } from 'vitest';

import { PrismaInventoryService, recordInventorySourceItemDeltas, syncRouteGroupingInventoryOrders } from '../src/modules/inventory/inventory.service.js';

type CreateManyArgs = { data: Array<Record<string, unknown>> };
type FindOrdersArgs = { where: { id: { in: string[] } } };
type UpdateManyArgs = { data: { updatedAt: Date } };

describe('inventory service route-group follower behavior', () => {
  test('lists standalone and route-group inventories for the shop', async () => {
    const findMany = vi.fn((args?: { include?: Record<string, unknown> }) => {
      void args;
      return [];
    });
    const service = new PrismaInventoryService({
      inventory: { findMany },
      shop: { findUnique: vi.fn(() => ({ id: 'shop-1' })) }
    } as never);

    await service.listInventories({ appId: 'clever-route-dev', shopDomain: 'example.myshopify.com' });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: 'shop-1' }
    }));
    const include = findMany.mock.calls[0]?.[0]?.include as {
      events?: { include?: unknown };
      orders?: { include?: { order?: { include?: { deliveryStops?: unknown } } } };
    } | undefined;
    expect(include?.events?.include).toBeUndefined();
    expect(include?.orders?.include?.order?.include?.deliveryStops).toBeUndefined();
  });

  test('hydrates detail items from raw Shopify line items when persisted order items are missing', async () => {
    const service = new PrismaInventoryService({
      inventory: {
        findFirst: vi.fn(() => ({
          createdAt: new Date('2026-07-02T00:00:00Z'),
          events: [{
            action: 'ADD',
            createdAt: new Date('2026-07-02T01:00:00Z'),
            name: 'Kimchi Box',
            options: [],
            order: {
              deliveryStops: [],
              name: '#1001',
              rawPayload: { recipientName: 'Raw Direct Recipient', shippingAddress: { name: 'Raw Recipient' } }
            },
            orderId: 'order-1',
            productId: 1,
            quantity: 4,
            quantityDelta: 4,
            sku: 'KIMCHI',
            variationId: 0
          }],
          id: 'inventory-1',
          name: 'Thu 07/02 orders',
          note: null,
          orders: [{
            order: {
              deliveryFacts: [{ deliveryDate: new Date('2026-07-02T00:00:00Z') }],
              deliveryStops: [{ recipientName: 'Delivery Stop Recipient' }],
              name: '#1001',
              orderItems: [],
              processedAt: new Date('2026-07-01T12:00:00Z'),
              rawPayload: {
                lineItems: {
                  nodes: [{ name: 'Kimchi Box', quantity: 4, sku: 'KIMCHI', title: 'Kimchi Box', variantTitle: 'Large' }]
                }
              }
            },
            orderId: 'order-1'
          }],
          routeGroupingId: null,
          updatedAt: new Date('2026-07-02T00:00:00Z')
        }))
      },
      shop: { findUnique: vi.fn(() => ({ id: 'shop-1' })) }
    } as never);

    const detail = await service.getInventory({ appId: 'clever-route-dev', inventoryId: 'inventory-1', shopDomain: 'example.myshopify.com' });

    expect(detail?.orders[0]?.items).toEqual([expect.objectContaining({
      name: 'Kimchi Box',
      options: [{ key: 'Variant', value: 'Large' }],
      quantity: 4,
      sku: 'KIMCHI'
    })]);
    expect(detail?.orders[0]?.recipientName).toBe('Delivery Stop Recipient');
    expect(detail?.lastChange[0]).toEqual(expect.objectContaining({
      orderName: '#1001',
      recipientName: 'Raw Direct Recipient'
    }));
    expect(detail?.itemSummary.totalQuantity).toBe(4);
  });

  test('hydrates recipient from raw payload when no delivery stop recipient exists', async () => {
    const service = new PrismaInventoryService({
      inventory: {
        findFirst: vi.fn(() => ({
          createdAt: new Date('2026-07-02T00:00:00Z'),
          events: [],
          id: 'inventory-1',
          name: 'Thu 07/02 orders',
          note: null,
          orders: [{
            order: {
              deliveryFacts: [],
              deliveryStops: [],
              name: '#1002',
              orderItems: [{ id: 'item-1', name: 'Kimchi', options: [], productId: 1, quantity: 1, sku: null, variationId: 0 }],
              processedAt: new Date('2026-07-01T12:00:00Z'),
              rawPayload: { recipientName: 'Raw Payload Recipient' }
            },
            orderId: 'order-2'
          }],
          routeGroupingId: null,
          updatedAt: new Date('2026-07-02T00:00:00Z')
        }))
      },
      shop: { findUnique: vi.fn(() => ({ id: 'shop-1' })) }
    } as never);

    const detail = await service.getInventory({ appId: 'clever-route-dev', inventoryId: 'inventory-1', shopDomain: 'example.myshopify.com' });

    expect(detail?.orders[0]?.recipientName).toBe('Raw Payload Recipient');
  });

  test('normalizes inventory customer notes from delivery instructions and source payload fallbacks', async () => {
    const findFirst = vi.fn(() => ({
      createdAt: new Date('2026-07-02T00:00:00Z'),
      events: [],
      id: 'inventory-1',
      name: 'Thu 07/02 orders',
      note: null,
      orders: [
        {
          order: {
            deliveryFacts: [],
            deliveryStops: [{ instructions: 'Use the side entrance.', recipientName: 'Recipient One' }],
            name: '#1001',
            orderItems: [],
            processedAt: null,
            rawPayload: { note: 'Stale source note' }
          },
          orderId: 'order-1'
        },
        {
          order: {
            deliveryFacts: [],
            deliveryStops: [{ instructions: null, recipientName: 'Recipient Two' }],
            name: '#1002',
            orderItems: [],
            processedAt: null,
            rawPayload: { customerNote: 'Call before arrival.' }
          },
          orderId: 'order-2'
        },
        {
          order: {
            deliveryFacts: [],
            deliveryStops: [],
            name: '#1003',
            orderItems: [],
            processedAt: null,
            rawPayload: { customer: { note: 'Leave with concierge.' } }
          },
          orderId: 'order-3'
        }
      ],
      routeGrouping: null,
      routeGroupingId: null,
      updatedAt: new Date('2026-07-02T00:00:00Z')
    }));
    const service = new PrismaInventoryService({
      inventory: { findFirst },
      shop: { findUnique: vi.fn(() => ({ id: 'shop-1' })) }
    } as never);

    const detail = await service.getInventoryOrderView({ appId: 'clever-route-dev', inventoryId: 'inventory-1', shopDomain: 'example.myshopify.com' });

    expect(detail?.orders.map((order) => order.customerNote)).toEqual([
      'Use the side entrance.',
      'Call before arrival.',
      'Leave with concierge.'
    ]);
    const findFirstCalls = (findFirst as unknown as { mock: { calls: Array<[{ include?: unknown }]> } }).mock.calls;
    const include = findFirstCalls[0]?.[0]?.include as {
      orders?: { include?: { order?: { include?: { deliveryStops?: { select?: Record<string, boolean> } } } } };
    } | undefined;
    expect(include?.orders?.include?.order?.include?.deliveryStops?.select?.instructions).toBe(true);
  });

  test('hydrates order-view route fields from the linked route group', async () => {
    const service = new PrismaInventoryService({
      inventory: {
        findFirst: vi.fn(() => ({
          createdAt: new Date('2026-07-02T00:00:00Z'),
          events: [],
          id: 'inventory-1',
          name: 'Thu 07/02 orders',
          note: null,
          orders: [{
            order: {
              currencyCode: 'CAD',
              deliveryFacts: [],
              deliveryStops: [{
                address1: '200 Church St',
                address2: null,
                city: 'Markham',
                countryCode: 'CA',
                phone: '555-0101',
                postalCode: 'L3P 2M7',
                province: 'Ontario',
                recipientName: 'Lee Hana'
              }],
              financialStatus: 'PAID',
              name: '#1001',
              orderItems: [{ id: 'item-1', name: 'Kimchi', options: [], productId: 1, quantity: 2, sku: null, variationId: 0 }],
              phone: null,
              processedAt: new Date('2026-07-01T12:00:00Z'),
              rawPayload: {},
              shippingAddress: null,
              totalPriceAmount: '42.00'
            },
            orderId: 'order-1'
          }],
          routeGrouping: {
            childVersions: [{
              driver: { displayName: 'Driver One', id: 'driver-1', phone: '555-driver' },
              routePlan: {
                constraints: { departureTime: '09:00' },
                driver: null,
                id: 'route-1',
                name: 'Route A',
                routeStops: [{
                  deliveryStop: { orderId: 'order-1', serviceMinutes: 7 },
                  durationFromPreviousSeconds: 600,
                  estimatedArrivalAt: new Date('2026-07-02T09:15:00Z'),
                  sequence: 1
                }]
              },
              status: 'CURRENT'
            }]
          },
          routeGroupingId: 'group-1',
          updatedAt: new Date('2026-07-02T00:00:00Z')
        }))
      },
      shop: { findUnique: vi.fn(() => ({ id: 'shop-1' })) }
    } as never);

    const detail = await service.getInventoryOrderView({ appId: 'clever-route-dev', inventoryId: 'inventory-1', shopDomain: 'example.myshopify.com' });

    expect(detail?.linkedRoutes[0]).toEqual(expect.objectContaining({
      driverName: 'Driver One',
      name: 'Route A',
      startTime: '09:00'
    }));
    expect(detail?.orders[0]).toEqual(expect.objectContaining({
      address: '200 Church St, Markham, Ontario, L3P 2M7, CA',
      driveTimeMinutes: 10,
      eta: '09:15',
      financialStatus: 'PAID',
      phone: '555-0101',
      stopTimeMinutes: 7,
      totalPriceAmount: '42.00'
    }));
  });

  test('returns linked inventory order-view rows in route delivery order', async () => {
    const inventoryOrder = (orderId: string, name: string) => ({
      order: {
        currencyCode: 'CAD',
        deliveryFacts: [],
        deliveryStops: [],
        financialStatus: 'PAID',
        name,
        orderItems: [],
        phone: null,
        processedAt: null,
        rawPayload: {},
        shippingAddress: null,
        totalPriceAmount: '10.00'
      },
      orderId
    });
    const routeStop = (orderId: string, sequence: number) => ({
      deliveryStop: { orderId, serviceMinutes: 5 },
      durationFromPreviousSeconds: sequence * 60,
      estimatedArrivalAt: new Date(`2026-07-02T09:0${sequence}:00Z`),
      sequence
    });
    const service = new PrismaInventoryService({
      inventory: {
        findFirst: vi.fn(() => ({
          createdAt: new Date('2026-07-02T00:00:00Z'),
          events: [],
          id: 'inventory-1',
          name: 'Route group inventory',
          note: null,
          orders: [
            inventoryOrder('order-2', '#1002'),
            inventoryOrder('order-unassigned', '#9999'),
            inventoryOrder('order-1', '#1001')
          ],
          routeGrouping: {
            childVersions: [
              {
                driver: null,
                routePlan: { constraints: {}, driver: null, id: 'route-b', name: 'Route B', routeStops: [routeStop('order-2', 1)] },
                snapshot: { routeIdx: 2, sortOrder: 2 },
                status: 'CURRENT'
              },
              {
                driver: null,
                routePlan: { constraints: {}, driver: null, id: 'route-a', name: 'Route A', routeStops: [routeStop('order-1', 1)] },
                snapshot: { routeIdx: 1, sortOrder: 1 },
                status: 'CURRENT'
              }
            ]
          },
          routeGroupingId: 'group-1',
          updatedAt: new Date('2026-07-02T00:00:00Z')
        }))
      },
      shop: { findUnique: vi.fn(() => ({ id: 'shop-1' })) }
    } as never);

    const detail = await service.getInventoryOrderView({ appId: 'clever-route-dev', inventoryId: 'inventory-1', shopDomain: 'example.myshopify.com' });

    expect(detail?.linkedRoutes.map((route) => route.name)).toEqual(['Route A', 'Route B']);
    expect(detail?.orders.map((order) => order.id)).toEqual(['order-1', 'order-2', 'order-unassigned']);
    expect(detail?.orders.map((order) => order.routeStop?.sequence ?? null)).toEqual([1, 1, null]);
  });

  test('creates a missing linked inventory from full current route-group membership', async () => {
    const createdInventoryOrders: unknown[] = [];
    const tx = {
      inventory: {
        findUnique: vi.fn(() => null),
        update: vi.fn(() => ({})),
        upsert: vi.fn(() => ({ id: 'inventory-1' }))
      },
      inventoryEvent: { createMany: vi.fn(() => ({ count: 2 })) },
      inventoryOrder: {
        createMany: vi.fn(({ data }: CreateManyArgs) => { createdInventoryOrders.push(...data); return { count: data.length }; }),
        findMany: vi.fn(() => [])
      },
      order: {
        findMany: vi.fn(({ where }: FindOrdersArgs) => where.id.in.map((id) => ({
          id,
          orderItems: [{ id: `item-${id}`, name: 'Kimchi', options: [], productId: 1, quantity: 1, sku: null, variationId: 0 }]
        })))
      },
      routeGroupingOrder: {
        findMany: vi.fn(() => [{ orderId: 'existing-order' }, { orderId: 'new-order' }])
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
    const updateMany = vi.fn((input: UpdateManyArgs) => { void input; return { count: 1 }; });
    const tx = {
      inventoryEvent: { createMany: vi.fn(({ data }: CreateManyArgs) => { events.push(...data); return { count: data.length }; }) },
      inventoryOrder: { findMany: vi.fn(() => [{ inventoryId: 'inventory-1' }]) },
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
    expect(updateMany).toHaveBeenCalledTimes(1);
    const updateManyInput = updateMany.mock.calls[0]?.[0];
    expect(updateManyInput?.data.updatedAt).toBeInstanceOf(Date);
  });
});
