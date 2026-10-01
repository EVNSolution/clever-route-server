import { describe, expect, test, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AdminOrdersDependencies } from '../src/routes/admin-orders.routes.js';
import { ORDERS_SORT } from '../src/modules/shopify/order-pagination.js';

describe('authenticated v2 Orders resource boundary', () => {
  test('repeated arrays and snapshot JSON arrays reach one normalized contract', async () => {
    const calls: unknown[] = [];
    const capture = (input: unknown) => {
      calls.push(input);
      return Promise.resolve({});
    };
    const list = vi.fn<AdminOrdersDependencies['orderSyncService']['listCanonicalOrders']>(() =>
      Promise.resolve([]),
    );
    const deps: AdminOrdersDependencies = {
      sessionTokenVerifier: {
        verify: () => ({ shopDomain: 'fixture.example.test', subject: 'synthetic-user' }),
      },
      orderSyncService: {
        listCanonicalOrders: list,
        syncOrdersSnapshot: () => Promise.reject(new Error('not invoked')),
        listCanonicalOrdersPage: (input) => {
          calls.push(input);
          return Promise.resolve({
            count: 0,
            countPrecision: 'exact',
            filterHash: 'test',
            pageInfo: {
              endCursor: null,
              startCursor: null,
              hasNextPage: false,
              hasPreviousPage: false,
              readWatermark: '2026-10-01T12:00:00Z',
            },
            rows: [],
            sort: ORDERS_SORT,
          });
        },
        listCanonicalOrderFacets: capture,
        listCanonicalOrderMapPoints: capture,
        createOrderSelectionSnapshot: capture,
      },
    };
    const app = await buildApp({ adminOrders: deps });
    const filters = {
      filterVersion: '2',
      serviceTypes: ['DELIVERY', 'PICKUP'],
      paymentStatuses: ['PENDING', 'PAID'],
      scheduledWeekdays: ['FRIDAY'],
      orderedDateTimeZone: 'America/Toronto',
      cancelled: 'false',
    };
    const query = new URLSearchParams();
    for (const [key, values] of Object.entries(filters))
      for (const value of Array.isArray(values) ? values : [values]) query.append(key, value);
    try {
      for (const resource of ['page', 'facets', 'map-points']) {
        const extra =
          resource === 'page'
            ? '&pageSize=50&sort=id_desc&page=1'
            : resource === 'map-points'
              ? '&limit=100'
              : '';
        const response = await app.inject({
          url: `/admin/orders/${resource}?${query.toString()}${extra}`,
          headers: { authorization: 'Bearer synthetic-token' },
        });
        expect(response.statusCode).toBe(200);
      }
      const response = await app.inject({
        method: 'POST',
        url: '/admin/orders/selection-snapshots',
        headers: { authorization: 'Bearer synthetic-token' },
        payload: { filters },
      });
      expect(response.statusCode).toBe(201);
      for (const input of calls) {
        const args = input as { shopDomain: string; filters: unknown };
        expect(args.shopDomain).toBe('fixture.example.test');
        expect(args.filters).toEqual({
          ...filters,
          serviceTypes: ['DELIVERY', 'PICKUP'],
          paymentStatuses: ['PAID', 'PENDING'],
          cancelled: false,
        });
      }
      expect(calls.length).toBe(4);
      const mixed = await app.inject({
        url: `/admin/orders/facets?filterVersion=2&deliveryState=planned`,
        headers: { authorization: 'Bearer synthetic-token' },
      });
      expect(mixed.statusCode).toBe(400);
      const unauthorized = await app.inject({ url: `/admin/orders/facets?${query.toString()}` });
      expect(unauthorized.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
  test('legacy state query is preserved without conversion to v2', async () => {
    const list = vi.fn<AdminOrdersDependencies['orderSyncService']['listCanonicalOrders']>(() =>
      Promise.resolve([]),
    );
    const app = await buildApp({
      adminOrders: {
        sessionTokenVerifier: {
          verify: () => ({ shopDomain: 'fixture.example.test', subject: 'synthetic-user' }),
        },
        orderSyncService: {
          listCanonicalOrders: list,
          syncOrdersSnapshot: () => Promise.reject(new Error('not invoked')),
        },
      },
    });
    try {
      const response = await app.inject({
        url: '/admin/orders?deliveryState=planned&deliveryWeekday=MONDAY&serviceCategory=PICKUP',
        headers: { authorization: 'Bearer synthetic-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(list.mock.calls[0]?.[0].filters).toEqual({
        deliveryState: 'planned',
        deliveryWeekday: 'MONDAY',
        serviceCategory: 'PICKUP',
      });
    } finally {
      await app.close();
    }
  });
});
