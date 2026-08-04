import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AdminOrdersDependencies } from '../src/routes/admin-orders.routes.js';

describe('admin orders pagination resources', () => {
  test('normalizes the app filter grammar before invoking the page query', async () => {
    const listCanonicalOrdersPage = vi.fn(() => Promise.resolve({
      filterHash: 'hmac-sha256:filter',
      pageInfo: { endCursor: null, hasNextPage: false, hasPreviousPage: false, readWatermark: '2026-08-04T00:00:00.000Z', startCursor: null },
      rows: [],
      sort: 'id_desc' as const
    }));
    const app = await buildApp({ adminOrders: dependencies({ listCanonicalOrdersPage }) });
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/orders/page?pageSize=50&sort=id_desc&deliveryState=planned&orderedDateFrom=2026-05-01&orderedDateTo=2026-05-31&scope=planning&tab=unplanned&routeOpsToday=2026-08-04'
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        data: {
          freshness: {},
          pageInfo: {
            endCursor: null,
            hasNextPage: false,
            hasPreviousPage: false,
            pageSize: 50,
            readWatermark: '2026-08-04T00:00:00.000Z',
            sort: 'id_desc',
            startCursor: null
          },
          result: {
            count: null,
            countPrecision: 'unknown',
            filterHash: 'hmac-sha256:filter',
            readWatermark: '2026-08-04T00:00:00.000Z'
          },
          rows: []
        },
        error: null
      });
      expect(listCanonicalOrdersPage).toHaveBeenCalledWith({
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
    } finally { await app.close(); }
  });

  test('rejects unknown filters and ambiguous cursor direction before repository invocation', async () => {
    const listCanonicalOrdersPage = vi.fn();
    const app = await buildApp({ adminOrders: dependencies({ listCanonicalOrdersPage }) });
    try {
      const unknown = await app.inject({ headers: { authorization: 'Bearer session-token' }, method: 'GET', url: '/admin/orders/page?pageSize=50&sort=id_desc&unknown=value' });
      const ambiguous = await app.inject({ headers: { authorization: 'Bearer session-token' }, method: 'GET', url: '/admin/orders/page?pageSize=50&sort=id_desc&after=a&before=b' });
      const missingToday = await app.inject({ headers: { authorization: 'Bearer session-token' }, method: 'GET', url: '/admin/orders/page?pageSize=50&sort=id_desc&scope=planning' });
      expect(unknown.statusCode).toBe(400);
      expect(ambiguous.statusCode).toBe(400);
      expect(missingToday.statusCode).toBe(400);
      expect(JSON.parse(missingToday.body) as unknown).toEqual({
        data: null,
        error: {
          code: 'ROUTE_OPS_TODAY_REQUIRED',
          message: 'Planning scope requires an explicit routeOpsToday date'
        }
      });
      expect(listCanonicalOrdersPage).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('keeps map cursors out of the compact projection contract', async () => {
    const listCanonicalOrderMapPoints = vi.fn();
    const app = await buildApp({ adminOrders: dependencies({ listCanonicalOrderMapPoints }) });
    try {
      const response = await app.inject({ headers: { authorization: 'Bearer session-token' }, method: 'GET', url: '/admin/orders/map-points?after=secret' });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('secret');
      expect(listCanonicalOrderMapPoints).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('accepts snapshot exclusions only in request bodies', async () => {
    const createOrderSelectionSnapshot = vi.fn(() => Promise.resolve({ selectionToken: 'opaque', selectedCount: 2 }));
    const replaceOrderSelectionExclusions = vi.fn(() => Promise.resolve({ selectedCount: 1 }));
    const app = await buildApp({ adminOrders: dependencies({ createOrderSelectionSnapshot, replaceOrderSelectionExclusions }) });
    try {
      const create = await app.inject({ headers: { authorization: 'Bearer session-token' }, method: 'POST', payload: { filters: { routeOpsToday: '2026-08-04', scope: 'planning' }, sort: 'id_desc' }, url: '/admin/orders/selection-snapshots' });
      const patch = await app.inject({ headers: { authorization: 'Bearer session-token' }, method: 'PATCH', payload: { excludeOrderIds: ['order-1'], selectionToken: 'opaque' }, url: '/admin/orders/selection-snapshots' });
      expect(create.statusCode).toBe(201);
      expect(patch.statusCode).toBe(200);
      expect(replaceOrderSelectionExclusions).toHaveBeenCalledWith(expect.objectContaining({ actor: 'shopify-user-id', excludeOrderIds: ['order-1'], selectionToken: 'opaque' }));
    } finally { await app.close(); }
  });

  test('resolves and consumes snapshot bulk updates in one repository transaction', async () => {
    const bulkPatchCanonicalOrderStatus = vi.fn();
    const bulkPatchOrderSelectionSnapshot = vi.fn(() => Promise.resolve({
      noOp: 0,
      resolved: 2,
      selected: 3,
      skipped: 1,
      skippedByReason: { cancelled: 0, missing: 1, routeLocked: 0 },
      updated: 2
    }));
    const app = await buildApp({ adminOrders: dependencies({
      bulkPatchCanonicalOrderStatus,
      bulkPatchOrderSelectionSnapshot
    }) });
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { field: 'state', selectionToken: 'opaque', value: 'ASSIGNED' },
        url: '/admin/orders/bulk-update'
      });
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body) as { data: unknown };
      expect(payload.data).toEqual({
        noOp: 0,
        orders: [],
        resolved: 2,
        selected: 3,
        skipped: 1,
        skippedByReason: { cancelled: 0, missing: 1, routeLocked: 0 },
        updated: 2
      });
      expect(response.body).not.toContain('opaque');
      expect(response.body).not.toContain('order-');
      expect(response.body).not.toContain('shopify-user-id');
      expect(bulkPatchOrderSelectionSnapshot).toHaveBeenCalledWith({
        actor: 'shopify-user-id',
        appId: 'clever',
        field: 'state',
        selectionToken: 'opaque',
        shopDomain: 'example.myshopify.com',
        value: 'ASSIGNED'
      });
      expect(bulkPatchCanonicalOrderStatus).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('returns not found for paged resources when rollback disables the server capability', async () => {
    const listCanonicalOrdersPage = vi.fn();
    const app = await buildApp({ adminOrders: {
      ...dependencies({ listCanonicalOrdersPage }),
      ordersPaginationEnabled: false
    } });
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/orders/page?pageSize=50&sort=id_desc&scope=planning&routeOpsToday=2026-08-04'
      });
      expect(response.statusCode).toBe(404);
      expect(listCanonicalOrdersPage).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('keeps map and snapshot capabilities independently subordinate to pagination', async () => {
    const listCanonicalOrderMapPoints = vi.fn(() => Promise.resolve({ points: [] }));
    const createOrderSelectionSnapshot = vi.fn(() => Promise.resolve({ selectionToken: 'opaque' }));
    const app = await buildApp({ adminOrders: {
      ...dependencies({ createOrderSelectionSnapshot, listCanonicalOrderMapPoints }),
      ordersMapProjectionEnabled: false,
      ordersPaginationEnabled: true,
      ordersSelectionSnapshotsEnabled: false
    } });
    try {
      const map = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/orders/map-points'
      });
      const snapshot = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { filters: {}, sort: 'id_desc' },
        url: '/admin/orders/selection-snapshots'
      });
      expect(map.statusCode).toBe(404);
      expect(snapshot.statusCode).toBe(404);
      expect(listCanonicalOrderMapPoints).not.toHaveBeenCalled();
      expect(createOrderSelectionSnapshot).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

function dependencies(overrides: Partial<AdminOrdersDependencies['orderSyncService']>): AdminOrdersDependencies {
  return {
    orderSyncService: {
      listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      syncOrdersSnapshot: vi.fn(() => Promise.resolve({ orders: [], sync: { created: 0, needsReview: 0, readyToPlan: 0, received: 0, skipped: 0, unchanged: 0, updated: 0 } })),
      ...overrides
    },
    sessionTokenVerifier: {
      verify: vi.fn(() => ({ appId: 'clever', shopDomain: 'example.myshopify.com', subject: 'shopify-user-id' }))
    }
  };
}
