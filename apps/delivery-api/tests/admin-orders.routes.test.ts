import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { CanonicalOrderRow } from '../src/modules/shopify/order-sync.mapper.js';
import type { AdminOrdersDependencies } from '../src/routes/admin-orders.routes.js';

const canonicalOrder: CanonicalOrderRow = {
  cancelledAt: null,
  currencyCode: 'CAD',
  deliveryArea: 'Mississauga',
  deliveryBatchEndDate: '2026-05-09',
  deliveryBatchStartDate: '2026-05-07',
  deliveryDate: '2026-05-08',
  deliveryDateSource: 'LINE_ITEM_DATE_RANGE',
  deliveryDayRaw: 'Friday 5pm to 9pm *Check delivery map',
  deliverySession: 'EVENING',
  deliveryStopId: 'stop-id',
  deliveryStopStatus: 'PENDING',
  deliveryWeekday: 'FRIDAY',
  email: 'customer@example.com',
  financialStatus: 'PAID',
  fulfillmentStatus: 'UNFULFILLED',
  geocodeStatus: 'RESOLVED',
  hasCoordinates: true,
  latitude: 43.589,
  longitude: -79.644,
  name: '#1035',
  orderCreatedAt: '2026-05-05T14:00:00.000Z',
  orderDateLocal: '2026-05-05',
  orderId: 'order-id',
  phone: '+14165550000',
  pickup: false,
  planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Mississauga',
  planningStatus: 'UNPLANNED',
  processedAt: '2026-05-07T12:00:00.000Z',
  readiness: 'READY_TO_PLAN',
  recipientName: 'Noah Yoon',
  reviewReasons: [],
  routePlanId: null,
  routePlanName: null,
  routePlanStatus: null,
  routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
  serviceType: 'EVENING_DELIVERY',
  shippingAddress: {
    address1: '300 City Centre Dr',
    address2: '#08',
    city: 'Mississauga',
    countryCode: 'CA',
    postalCode: 'L5B 3C1',
    province: 'ON'
  },
  shopifyOrderGid: 'gid://shopify/Order/123',
  shopifyOrderLegacyId: '123',
  timeWindowEnd: '21:00',
  timeWindowStart: '17:00',
  totalPriceAmount: '95.00',
  updatedAtShopify: '2026-05-07T13:00:00.000Z'
};

describe('Admin orders routes', () => {
  test('rejects order sync without a Shopify session token', async () => {
    const { dependencies, syncOrdersSnapshot } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const response = await app.inject({
        method: 'PATCH',
        payload: orderSyncPayload(),
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing bearer session token' }
      });
      expect(syncOrdersSnapshot).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('syncs Shopify order snapshots for the token shop', async () => {
    const { dependencies, syncOrdersSnapshot } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: orderSyncPayload(),
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('rawWooGeocodeAddress');
      expect(response.json()).toEqual({
        data: {
          orders: [canonicalOrder],
          sync: {
            created: 1,
            needsReview: 0,
            readyToPlan: 1,
            received: 1,
            skipped: 0,
            unchanged: 0,
            updated: 0
          }
        },
        error: null
      });
      expect(syncOrdersSnapshot).toHaveBeenCalledOnce();
      const [syncInput] = syncOrdersSnapshot.mock.calls[0] ?? [];
      expect(syncInput).toBeDefined();
      if (syncInput === undefined) {
        throw new Error('Expected sync input');
      }
      expect(syncInput.reason).toBe('orders_page_open');
      expect(syncInput.shopDomain).toBe('example.myshopify.com');
      expect(syncInput.source).toBe('clever-app-orders');
      expect(syncInput.subject).toBe('shopify-user-id');
      expect(syncInput.orders[0]?.id).toBe('gid://shopify/Order/123');
      expect(syncInput.orders[0]?.customAttributes).toContainEqual({
        key: 'Delivery Day',
        value: 'Friday 5pm to 9pm *Check delivery map'
      });
    } finally {
      await app.close();
    }
  });

  test('accepts Shopify snapshots with blank custom attribute values', async () => {
    const { dependencies, syncOrdersSnapshot } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const payload = orderSyncPayload();
      const firstOrder = (payload.orders as Record<string, unknown>[])[0];
      if (firstOrder === undefined) {
        throw new Error('Expected order payload');
      }
      firstOrder.customAttributes = [
        { key: 'Delivery Area', value: 'Mississauga' },
        { key: 'Note (Customer)', value: '' },
        { key: 'Delivery Day', value: 'Friday 5pm to 9pm *Check delivery map' }
      ];

      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload,
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(200);
      expect(syncOrdersSnapshot).toHaveBeenCalledOnce();
      const [syncInput] = syncOrdersSnapshot.mock.calls[0] ?? [];
      expect(syncInput?.orders[0]?.customAttributes).toEqual([
        { key: 'Delivery Area', value: 'Mississauga' },
        { key: 'Delivery Day', value: 'Friday 5pm to 9pm *Check delivery map' }
      ]);
    } finally {
      await app.close();
    }
  });

  test('rejects malformed required order sync timestamp instead of skipping the snapshot', async () => {
    const { dependencies, syncOrdersSnapshot } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const payload = orderSyncPayload();
      const firstOrder = (payload.orders as Record<string, unknown>[])[0];
      if (firstOrder === undefined) {
        throw new Error('Expected order payload');
      }
      firstOrder.updatedAt = 'not-a-date';

      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload,
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'INVALID_ORDER_SYNC_PAYLOAD',
          details: [
            {
              field: 'updatedAt',
              orderIndex: 0,
              orderName: '#1035',
              reason: 'Expected ISO date string'
            }
          ],
          message: 'Invalid order sync timestamp'
        }
      });
      expect(syncOrdersSnapshot).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects the whole order sync payload when any snapshot has an invalid timestamp', async () => {
    const { dependencies, syncOrdersSnapshot } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const payload = orderSyncPayload();
      const orders = payload.orders as Record<string, unknown>[];
      const firstOrder = orders[0];
      if (firstOrder === undefined) {
        throw new Error('Expected order payload');
      }
      orders.push({
        ...firstOrder,
        id: 'gid://shopify/Order/456',
        legacyResourceId: '456',
        name: '#1036',
        updatedAt: 'not-a-date'
      });

      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload,
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'INVALID_ORDER_SYNC_PAYLOAD',
          details: [
            {
              field: 'updatedAt',
              orderIndex: 1,
              orderName: '#1036',
              reason: 'Expected ISO date string'
            }
          ],
          message: 'Invalid order sync timestamp'
        }
      });
      expect(syncOrdersSnapshot).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects optional order sync timestamp fields when they are malformed', async () => {
    const { dependencies, syncOrdersSnapshot } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const payload = orderSyncPayload();
      const firstOrder = (payload.orders as Record<string, unknown>[])[0];
      if (firstOrder === undefined) {
        throw new Error('Expected order payload');
      }
      firstOrder.createdAt = 'not-a-date';

      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload,
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'INVALID_ORDER_SYNC_PAYLOAD',
          details: [
            {
              field: 'createdAt',
              orderIndex: 0,
              orderName: '#1035',
              reason: 'Expected ISO date string'
            }
          ],
          message: 'Invalid order sync timestamp'
        }
      });
      expect(syncOrdersSnapshot).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('accepts nullable string fields as null without failing', async () => {
    const { dependencies, syncOrdersSnapshot } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const payload = orderSyncPayload();
      const firstOrder = (payload.orders as Record<string, unknown>[])[0];
      if (firstOrder === undefined) {
        throw new Error('Expected order payload');
      }
      firstOrder.phone = '';
      firstOrder.email = '  ';
      firstOrder.note = '';
      firstOrder.shippingAddress = {
        ...(firstOrder.shippingAddress as Record<string, unknown>),
        address1: '',
        zip: ''
      };

      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload,
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(200);
      const [syncInput] = syncOrdersSnapshot.mock.calls[0] ?? [];
      if (syncInput === undefined) {
        throw new Error('Expected sync input');
      }
      expect(syncInput.orders[0]?.phone).toBeNull();
      expect(syncInput.orders[0]?.email).toBeNull();
      expect(syncInput.orders[0]?.note).toBeNull();
    } finally {
      await app.close();
    }
  });

  test('accepts shipping coordinates as numeric strings', async () => {
    const { dependencies, syncOrdersSnapshot } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const payload = orderSyncPayload();
      const firstOrder = (payload.orders as Record<string, unknown>[])[0];
      if (firstOrder === undefined) {
        throw new Error('Expected order payload');
      }
      if (typeof firstOrder.shippingAddress !== 'object' || firstOrder.shippingAddress === null) {
        throw new Error('Expected shippingAddress object');
      }
      const shippingAddress = firstOrder.shippingAddress as Record<string, unknown>;
      shippingAddress.latitude = '43.589';
      shippingAddress.longitude = '-79.644';

      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload,
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(200);
      const [syncInput] = syncOrdersSnapshot.mock.calls[0] ?? [];
      if (syncInput === undefined) {
        throw new Error('Expected sync input');
      }
      expect(syncInput.orders[0]?.shippingAddress).toMatchObject({
        latitude: 43.589,
        longitude: -79.644
      });
    } finally {
      await app.close();
    }
  });

  test('accepts numeric-string line item quantities', async () => {
    const { dependencies, syncOrdersSnapshot } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const payload = orderSyncPayload();
      const firstOrder = (payload.orders as Record<string, unknown>[])[0];
      if (firstOrder === undefined) {
        throw new Error('Expected order payload');
      }
      const lineItems = firstOrder.lineItems as { nodes?: Array<Record<string, unknown>> } | undefined;
      if (lineItems === undefined || typeof lineItems !== 'object' || lineItems === null) {
        throw new Error('Expected lineItems');
      }
      const nodes = lineItems.nodes;
      if (nodes === undefined || nodes[0] === undefined) {
        throw new Error('Expected line item node');
      }
      nodes[0].quantity = '3';

      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload,
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(200);
      const [syncInput] = syncOrdersSnapshot.mock.calls[0] ?? [];
      if (syncInput === undefined) {
        throw new Error('Expected sync input');
      }
      expect(syncInput.orders[0]?.lineItems?.nodes?.[0]?.quantity).toBe(3);
    } finally {
      await app.close();
    }
  });

  test('normalizes numeric money amounts as strings', async () => {
    const { dependencies, syncOrdersSnapshot } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const payload = orderSyncPayload();
      const firstOrder = (payload.orders as Record<string, unknown>[])[0];
      if (firstOrder === undefined) {
        throw new Error('Expected order payload');
      }
      firstOrder.currentTotalPriceSet = { shopMoney: { amount: 95, currencyCode: 'CAD' } };

      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload,
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(200);
      const [syncInput] = syncOrdersSnapshot.mock.calls[0] ?? [];
      if (syncInput === undefined) {
        throw new Error('Expected sync input');
      }
      expect(syncInput.orders[0]?.currentTotalPriceSet?.shopMoney.amount).toBe('95');
    } finally {
      await app.close();
    }
  });

  test('accepts optional nullable fields missing', async () => {
    const { dependencies, syncOrdersSnapshot } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const payload = orderSyncPayload();
      const firstOrder = (payload.orders as Record<string, unknown>[])[0];
      if (firstOrder === undefined) {
        throw new Error('Expected order payload');
      }
      firstOrder.currentTotalPriceSet = null;
      firstOrder.shippingAddress = undefined;
      delete firstOrder.note;

      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload,
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(200);
      const [syncInput] = syncOrdersSnapshot.mock.calls[0] ?? [];
      if (syncInput === undefined) {
        throw new Error('Expected sync input');
      }
      expect(syncInput.orders[0]?.currentTotalPriceSet).toBeNull();
      expect(syncInput.orders[0]?.shippingAddress).toBeNull();
      expect(syncInput.orders[0]?.note).toBeNull();
    } finally {
      await app.close();
    }
  });

  test('returns parse details for top-level payload errors', async () => {
    const { dependencies } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: {
          source: 'clever-app-orders',
          reason: 'manual_refresh',
          orders: { not: 'an-array' }
        },
        url: '/admin/orders/sync'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'INVALID_ORDER_SYNC_PAYLOAD',
          message: 'Invalid order sync payload',
          details: [{ field: 'orders', orderIndex: -1, orderName: '#request', reason: 'Must be an array' }]
        }
      });
    } finally {
      await app.close();
    }
  });

  test('lists canonical orders with filters for the token shop', async () => {
    const { dependencies, listCanonicalOrders } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/orders?readiness=READY_TO_PLAN&planned=false&deliveryWeekday=FRIDAY&serviceType=EVENING_DELIVERY&geocodeStatus=RESOLVED&deliveryDate=2026-05-08&deliveryBatchStartDate=2026-05-07&deliveryBatchEndDate=2026-05-09&deliverySession=EVENING&routeScopeKey=2026-05-08%7CEVENING_DELIVERY%7C17%3A00%7C21%3A00&planningGroupKey=2026-05-08%7CEVENING_DELIVERY%7C17%3A00%7C21%3A00%7CMississauga&search=%231035'
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('rawWooGeocodeAddress');
      expect(response.json()).toEqual({ data: { orders: [canonicalOrder] }, error: null });
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: {
          deliveryBatchEndDate: '2026-05-09',
          deliveryBatchStartDate: '2026-05-07',
          deliveryDate: '2026-05-08',
          deliverySession: 'EVENING',
          deliveryWeekday: 'FRIDAY',
          geocodeStatus: 'RESOLVED',
          planned: false,
          planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Mississauga',
          readiness: 'READY_TO_PLAN',
          routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
          search: '#1035',
          serviceType: 'EVENING_DELIVERY'
        },
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('accepts full-week delivery weekday filters', async () => {
    const { dependencies, listCanonicalOrders } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/orders?deliveryWeekday=MONDAY'
      });

      expect(response.statusCode).toBe(200);
      expect(listCanonicalOrders).toHaveBeenCalledWith({
        filters: { deliveryWeekday: 'MONDAY' },
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects invalid delivery date and delivery session filters', async () => {
    const { dependencies, listCanonicalOrders } = createDependencyHarness();
    const app = await buildApp({ adminOrders: dependencies });

    try {
      const invalidDate = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/orders?deliveryDate=2026-02-31'
      });
      expect(invalidDate.statusCode).toBe(400);

      const invalidSession = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/orders?deliverySession=LATE_NIGHT'
      });
      expect(invalidSession.statusCode).toBe(400);
      expect(listCanonicalOrders).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

});

function createDependencyHarness(): {
  dependencies: AdminOrdersDependencies;
  listCanonicalOrders: ReturnType<
    typeof vi.fn<AdminOrdersDependencies['orderSyncService']['listCanonicalOrders']>
  >;
  syncOrdersSnapshot: ReturnType<
    typeof vi.fn<AdminOrdersDependencies['orderSyncService']['syncOrdersSnapshot']>
  >;
} {
  const verify = vi.fn(() => ({
    shopDomain: 'example.myshopify.com',
    subject: 'shopify-user-id'
  }));
  const syncOrdersSnapshot = vi.fn<AdminOrdersDependencies['orderSyncService']['syncOrdersSnapshot']>(
    () =>
      Promise.resolve({
        orders: [canonicalOrder],
        sync: {
          created: 1,
          needsReview: 0,
          readyToPlan: 1,
          received: 1,
          skipped: 0,
          unchanged: 0,
          updated: 0
        }
      })
  );
  const listCanonicalOrders = vi.fn<AdminOrdersDependencies['orderSyncService']['listCanonicalOrders']>(
    () =>
      Promise.resolve([
        {
          ...canonicalOrder,
          rawWooGeocodeAddress: {
            address1: 'Raw Woo Address',
            address2: null,
            city: 'Toronto',
            countryCode: 'CA',
            postalCode: 'M3J 2C3',
            province: 'ON'
          }
        }
      ])
  );

  return {
    dependencies: {
      orderSyncService: {
        listCanonicalOrders,
        syncOrdersSnapshot
      },
      sessionTokenVerifier: { verify }
    },
    listCanonicalOrders,
    syncOrdersSnapshot
  };
}

function orderSyncPayload(): Record<string, unknown> {
  return {
    orders: [
      {
        cancelledAt: null,
        createdAt: '2026-05-05T14:00:00.000Z',
        currentTotalPriceSet: { shopMoney: { amount: '95.00', currencyCode: 'CAD' } },
        customAttributes: [
          { key: 'Delivery Area', value: 'Mississauga' },
          { key: 'Delivery Day', value: 'Friday 5pm to 9pm *Check delivery map' }
        ],
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'UNFULFILLED',
        email: 'customer@example.com',
        id: 'gid://shopify/Order/123',
        legacyResourceId: '123',
        lineItems: { nodes: [{ title: 'Tomatono 5/7-5/9', name: 'Tomatono 5/7-5/9', variantTitle: null, quantity: 1, sku: 'TOMA' }] },
        name: '#1035',
        note: 'Leave at door',
        phone: '+14165550000',
        processedAt: '2026-05-07T12:00:00.000Z',
        shippingAddress: {
          address1: '300 City Centre Dr',
          address2: '#08',
          city: 'Mississauga',
          countryCodeV2: 'CA',
          latitude: 43.589,
          longitude: -79.644,
          name: 'Noah Yoon',
          phone: '+14165550000',
          province: 'ON',
          provinceCode: 'ON',
          zip: 'L5B 3C1'
        },
        updatedAt: '2026-05-07T13:00:00.000Z'
      }
    ],
    reason: 'orders_page_open',
    source: 'clever-app-orders'
  };
}
