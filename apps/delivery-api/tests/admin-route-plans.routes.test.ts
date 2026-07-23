import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { RouteOptimizationJobActiveError } from '../src/modules/route-plans/route-optimization-job.types.js';
import {
  RoutePlanGeometryRefreshFailedError,
  RoutePlanOrderAlreadyPlannedError,
  RoutePlanRefreshNotAllowedError,
  RoutePlanStopUpdateInvalidError
} from '../src/modules/route-plans/route-plan.types.js';
import type {
  RoutePlanDetailStop,
  RoutePlanRouteStopPoint
} from '../src/modules/route-plans/route-plan.types.js';
import type { AdminRoutePlanDependencies } from '../src/routes/admin-route-plans.routes.js';

const routePlanSummary = {
  createdAt: '2026-05-07T12:30:00.000Z',
  deliveryAreas: ['Mississauga'],
  deliveryDays: ['Thursday'],
  depot: {
    latitude: 43.6532,
    longitude: -79.3832
  },
  id: 'route-plan-id',
  missingCoordinates: 0,
  name: 'CLEVER route draft',
  planDate: '2026-05-08',
  routeEndMode: 'END_AT_LAST_STOP' as const,
  status: 'DRAFT',
  stopsCount: 1,
  updatedAt: '2026-05-07T12:30:00.000Z'
};

type SaveRoutePlan = NonNullable<AdminRoutePlanDependencies['routePlanService']['saveRoutePlan']>;

describe('Admin route plan routes', () => {
  test('refreshes route geometry and ETA from the latest canonical order data', async () => {
    const { dependencies, refreshRouteGeometryForRoutePlan } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        url: '/admin/route-plans/route-plan-id/refresh-order-data'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: { routePlan: { id: 'route-plan-id' } },
        error: null
      });
      expect(refreshRouteGeometryForRoutePlan).toHaveBeenCalledWith({
        appId: 'clever',
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com',
        source: 'ORDER_DATA_REFRESH'
      });
    } finally {
      await app.close();
    }
  });

  test('returns conflict when route order-data refresh overlaps optimization', async () => {
    const { dependencies, refreshRouteGeometryForRoutePlan } = createDependencyHarness();
    refreshRouteGeometryForRoutePlan.mockRejectedValueOnce(new RouteOptimizationJobActiveError());
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        url: '/admin/route-plans/route-plan-id/refresh-order-data'
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'ROUTE_OPTIMIZATION_JOB_ACTIVE' } });
    } finally {
      await app.close();
    }
  });

  test('returns conflict when route status forbids order-data refresh', async () => {
    const { dependencies, refreshRouteGeometryForRoutePlan } = createDependencyHarness();
    refreshRouteGeometryForRoutePlan.mockRejectedValueOnce(new RoutePlanRefreshNotAllowedError('COMPLETED'));
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        url: '/admin/route-plans/route-plan-id/refresh-order-data'
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'ROUTE_REFRESH_NOT_ALLOWED' } });
    } finally {
      await app.close();
    }
  });

  test('returns unprocessable entity without replacing geometry when strict refresh fails', async () => {
    const { dependencies, refreshRouteGeometryForRoutePlan } = createDependencyHarness();
    refreshRouteGeometryForRoutePlan.mockRejectedValueOnce(new RoutePlanGeometryRefreshFailedError());
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        url: '/admin/route-plans/route-plan-id/refresh-order-data'
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'ROUTE_REFRESH_GEOMETRY_FAILED' } });
    } finally {
      await app.close();
    }
  });

  test('rejects route order-data refresh without a Shopify session token', async () => {
    const { dependencies, refreshRouteGeometryForRoutePlan } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/route-plans/route-plan-id/refresh-order-data'
      });

      expect(response.statusCode).toBe(401);
      expect(refreshRouteGeometryForRoutePlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects route plan creation without a Shopify session token', async () => {
    const { createRoutePlan, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        method: 'POST',
        payload: routePlanPayload(),
        url: '/admin/route-plans'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing bearer session token' }
      });
      expect(createRoutePlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('transitions one child stop through the admin stop action service without using bulk stop reorder', async () => {
    const { dependencies, transitionAdminRouteStop, updateRoutePlanStops } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: {
          idempotencyKey: 'admin-stop-action-key',
          status: 'COMPLETED'
        },
        url: '/admin/route-plans/route-plan-id/stops/stop-1/transition'
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        data: {
          duplicate: false,
          notification: {
            idempotencyKey: 'admin-stop-action-key:customer-notification',
            status: 'QUEUED'
          },
          status: {
            deliveryStopStatus: 'DELIVERED',
            uiStatus: 'COMPLETED'
          }
        },
        error: null
      });
      expect(transitionAdminRouteStop).toHaveBeenCalledWith({
        actor: 'shopify-user-id',
        appId: 'clever',
        deliveryStopId: 'stop-1',
        payload: {
          idempotencyKey: 'admin-stop-action-key',
          status: 'COMPLETED'
        },
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      });
      expect(updateRoutePlanStops).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('updates one delivery stop operational override in CLEVER DB scope', async () => {
    const { dependencies, updateAdminRouteStopOverride } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: {
          address1: '42 Admin Rd',
          address2: null,
          city: 'Toronto',
          countryCode: 'CA',
          instructions: 'Leave with concierge',
          latitude: 43.6426,
          longitude: -79.3871,
          phone: '+14165550100',
          postalCode: 'M5V 2T6',
          province: 'ON',
          recipientName: 'Jane Admin',
          serviceMinutes: 8,
          timeWindowEnd: '18:00',
          timeWindowStart: '14:00'
        },
        url: '/admin/route-plans/route-plan-id/stops/stop-1/override'
      });

      expect(response.statusCode).toBe(200);
      expect(updateAdminRouteStopOverride).toHaveBeenCalledWith({
        actor: 'shopify-user-id',
        appId: 'clever',
        deliveryStopId: 'stop-1',
        payload: {
          address1: '42 Admin Rd',
          address2: null,
          city: 'Toronto',
          countryCode: 'CA',
          instructions: 'Leave with concierge',
          latitude: 43.6426,
          longitude: -79.3871,
          phone: '+14165550100',
          postalCode: 'M5V 2T6',
          province: 'ON',
          recipientName: 'Jane Admin',
          serviceMinutes: 8,
          timeWindowEnd: '18:00',
          timeWindowStart: '14:00'
        },
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      });
      expect(response.json()).toMatchObject({
        data: { geometry: { status: 'stale' } },
        error: null
      });
    } finally {
      await app.close();
    }
  });

  test('rejects legacy nested stop override payloads instead of silently ignoring them', async () => {
    const { dependencies, updateAdminRouteStopOverride } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: {
          address: { address1: '42 Admin Rd' },
          coordinates: { latitude: 43.6426, longitude: -79.3871 }
        },
        url: '/admin/route-plans/route-plan-id/stops/stop-1/override'
      });

      expect(response.statusCode).toBe(400);
      expect(updateAdminRouteStopOverride).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects invalid route plan payloads before persisting', async () => {
    const { createRoutePlan, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { name: '', orders: [] },
        url: '/admin/route-plans'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid route plan payload' }
      });
      expect(createRoutePlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('creates a draft route plan for the token shop', async () => {
    const { createRoutePlan, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: routePlanPayload(),
        url: '/admin/route-plans'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        data: {
          routePlan: routePlanSummary
        },
        error: null
      });
      expect(createRoutePlan).toHaveBeenCalledWith({
        appId: 'clever',
        createdBy: 'shopify-user-id',
        payload: {
          ...routePlanPayload(),
          orders: [
            expect.objectContaining({
              processedAt: new Date('2026-05-07T12:00:00.000Z'),
              shopifyOrderGid: 'gid://shopify/Order/123'
            })
          ]
        },
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });


  test('creates a route plan when every order matches the requested route scope', async () => {
    const { createRoutePlan, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });
    const payload = scopedRoutePlanPayload();

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload,
        url: '/admin/route-plans'
      });

      expect(response.statusCode).toBe(201);
      expect(createRoutePlan).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test('returns a conflict when selected orders already belong to a route plan', async () => {
    const { createRoutePlan, dependencies } = createDependencyHarness();
    createRoutePlan.mockRejectedValueOnce(new RoutePlanOrderAlreadyPlannedError(['#1035']));
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: routePlanPayload(),
        url: '/admin/route-plans'
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'ROUTE_ORDER_ALREADY_PLANNED',
          message:
            '이미 Route에 등록된 주문이 포함되어 있어 새 Route를 만들지 않았습니다. Orders의 기본 Un-routed view에서 아직 Route에 없는 주문만 선택해주세요.'
        }
      });
    } finally {
      await app.close();
    }
  });

  test('accepts route scope keys from top-level route-plan orders', async () => {
    const { createRoutePlan, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });
    const payload = scopedRoutePlanPayload();
    const orders = payload.orders as Record<string, unknown>[];
    for (const order of orders) {
      order.rawPayload = {};
      order.deliveryDate = '2026-05-08';
      order.deliverySession = 'EVENING';
      order.routeScopeKey = '2026-05-08|EVENING_DELIVERY|17:00|21:00';
      order.serviceType = 'EVENING_DELIVERY';
      order.timeWindowEnd = '21:00';
      order.timeWindowStart = '17:00';
    }

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload,
        url: '/admin/route-plans'
      });

      expect(response.statusCode).toBe(201);
      expect(createRoutePlan).toHaveBeenCalledOnce();
      const createRoutePlanInput = createRoutePlan.mock.calls[0]?.[0];
      expect(createRoutePlanInput?.payload.orders.map((order) => order.routeScopeKey)).toEqual([
        '2026-05-08|EVENING_DELIVERY|17:00|21:00',
        '2026-05-08|EVENING_DELIVERY|17:00|21:00'
      ]);
    } finally {
      await app.close();
    }
  });

  test('keeps the legacy admin route-plan API constrained to built-in route-scope values', async () => {
    const { createRoutePlan, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });
    const payload = scopedRoutePlanPayload();
    const routeScope = payload.routeScope as Record<string, unknown>;
    routeScope.deliverySession = 'MORNING';
    routeScope.routeScopeKey = '2026-05-08|MORNING_DELIVERY|08:00|12:00';
    routeScope.serviceType = 'MORNING_DELIVERY';
    routeScope.timeWindowEnd = '12:00';
    routeScope.timeWindowStart = '08:00';

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload,
        url: '/admin/route-plans'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid route plan payload' }
      });
      expect(createRoutePlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects route plans that mix Friday day and Friday evening scopes', async () => {
    const { createRoutePlan, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });
    const payload = scopedRoutePlanPayload({
      secondOrderRawPayload: { routeScopeKey: '2026-05-08|DELIVERY||' }
    });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload,
        url: '/admin/route-plans'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'ROUTE_SCOPE_MISMATCH',
          message: 'Route plan contains orders from different delivery scopes.'
        }
      });
      expect(createRoutePlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('allows multiple delivery areas within the same route scope', async () => {
    const { createRoutePlan, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });
    const payload = scopedRoutePlanPayload({ secondOrderArea: 'Thornhill' });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload,
        url: '/admin/route-plans'
      });

      expect(response.statusCode).toBe(201);
      expect(createRoutePlan).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test('lists route plans for the token shop', async () => {
    const { dependencies, listRoutePlans } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/route-plans'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          routePlans: [routePlanSummary]
        },
        error: null
      });
      expect(listRoutePlans).toHaveBeenCalledWith({ appId: 'clever', shopDomain: 'example.myshopify.com' });
    } finally {
      await app.close();
    }
  });

  test('returns route plan detail stops in sequence order', async () => {
    const { dependencies, getRoutePlanDetail } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/route-plans/route-plan-id'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          routePlan: routePlanSummary,
          routeGeometry: null,
          routeMetrics: null,
          routeStopPoints: routePlanStopPoints(),
          stops: [
            expect.objectContaining({ orderName: '#1035', sequence: 1 }),
            expect.objectContaining({ orderName: '#1036', sequence: 2 })
          ]
        },
        error: null
      });
      expect(getRoutePlanDetail).toHaveBeenCalledWith({
        appId: 'clever',
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('does not expose another shop route plan detail', async () => {
    const { dependencies, getRoutePlanDetail } = createDependencyHarness();
    getRoutePlanDetail.mockResolvedValueOnce(null);
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/route-plans/other-shop-route-plan-id'
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'NOT_FOUND', message: 'Route plan not found' }
      });
    } finally {
      await app.close();
    }
  });

  test('rejects route plan deletion without a Shopify session token', async () => {
    const { dependencies, deleteRoutePlan } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/admin/route-plans/route-plan-id'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing bearer session token' }
      });
      expect(deleteRoutePlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects route stop updates without a Shopify session token', async () => {
    const { dependencies, updateRoutePlanStops } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        method: 'PATCH',
        payload: { stops: [] },
        url: '/admin/route-plans/route-plan-id/stops'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing bearer session token' }
      });
      expect(updateRoutePlanStops).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects invalid route stop update payloads before calling the service', async () => {
    const { dependencies, updateRoutePlanStops } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { stops: [{ shopifyOrderGid: '', sequence: 0 }] },
        url: '/admin/route-plans/route-plan-id/stops'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid route stop update payload' }
      });
      expect(updateRoutePlanStops).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });


  test('updates route plan stops for the token shop', async () => {
    const { dependencies, updateRoutePlanStops } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: {
          stops: [
            { deliveryStopId: 'stop-2', shopifyOrderGid: 'gid://shopify/Order/2', sequence: 10 },
            { shopifyOrderGid: 'gid://shopify/Order/1', sequence: 20 }
          ]
        },
        url: '/admin/route-plans/route-plan-id/stops'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          routePlan: routePlanSummary,
          routeGeometry: null,
          routeMetrics: null,
          routeStopPoints: routePlanStopPoints(),
          stops: [
            routePlanStop({ orderName: '#1035', sequence: 1 }),
            routePlanStop({ orderName: '#1036', sequence: 2 })
          ]
        },
        error: null
      });
      expect(updateRoutePlanStops).toHaveBeenCalledWith({
        appId: 'clever',
        payload: {
          stops: [
            { deliveryStopId: 'stop-2', shopifyOrderGid: 'gid://shopify/Order/2', sequence: 10 },
            { shopifyOrderGid: 'gid://shopify/Order/1', sequence: 20 }
          ]
        },
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('returns not found when updating stops for a route outside the token shop', async () => {
    const { dependencies, updateRoutePlanStops } = createDependencyHarness();
    updateRoutePlanStops.mockResolvedValueOnce(null);
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { stops: [] },
        url: '/admin/route-plans/other-shop-route-plan-id/stops'
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'NOT_FOUND', message: 'Route plan not found' }
      });
      expect(updateRoutePlanStops).toHaveBeenCalledWith({
        appId: 'clever',
        payload: { stops: [] },
        routePlanId: 'other-shop-route-plan-id',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects duplicate route stop update payload orders', async () => {
    const { dependencies, updateRoutePlanStops } = createDependencyHarness();
    updateRoutePlanStops.mockRejectedValueOnce(new RoutePlanStopUpdateInvalidError('Route stop update payload contains duplicate orders.'));
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: {
          stops: [
            { shopifyOrderGid: 'gid://shopify/Order/1', sequence: 1 },
            { shopifyOrderGid: 'gid://shopify/Order/1', sequence: 2 }
          ]
        },
        url: '/admin/route-plans/route-plan-id/stops'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'ROUTE_STOP_UPDATE_INVALID',
          message: 'Route stop update payload contains duplicate orders.'
        }
      });
    } finally {
      await app.close();
    }
  });

  test('rejects route stop update orders that do not belong to the token shop', async () => {
    const { dependencies, updateRoutePlanStops } = createDependencyHarness();
    updateRoutePlanStops.mockRejectedValueOnce(
      new RoutePlanStopUpdateInvalidError('Route stops can only include orders from the current shop.')
    );
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { stops: [{ shopifyOrderGid: 'gid://shopify/Order/other-shop', sequence: 1 }] },
        url: '/admin/route-plans/route-plan-id/stops'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'ROUTE_STOP_UPDATE_INVALID',
          message: 'Route stops can only include orders from the current shop.'
        }
      });
    } finally {
      await app.close();
    }
  });

  test('rejects wrong-date route stop update orders with a friendly message', async () => {
    const { dependencies, updateRoutePlanStops } = createDependencyHarness();
    updateRoutePlanStops.mockRejectedValueOnce(
      new RoutePlanStopUpdateInvalidError(
        'Route stops must share the same delivery date as the route. Choose orders for the route delivery date before saving stops.'
      )
    );
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { stops: [{ shopifyOrderGid: 'gid://shopify/Order/1', sequence: 1 }] },
        url: '/admin/route-plans/route-plan-id/stops'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'ROUTE_STOP_UPDATE_INVALID',
          message: 'Route stops must share the same delivery date as the route. Choose orders for the route delivery date before saving stops.'
        }
      });
    } finally {
      await app.close();
    }
  });

  test('updates route options for the token shop', async () => {
    const { dependencies, updateRoutePlanOptions } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { routeEndMode: 'RETURN_TO_DEPOT' },
        url: '/admin/route-plans/route-plan-id/options'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          routePlan: {
            id: 'route-plan-id',
            routeEndMode: 'RETURN_TO_DEPOT'
          }
        },
        error: null
      });
      expect(updateRoutePlanOptions).toHaveBeenCalledWith({
        appId: 'clever',
        payload: { routeEndMode: 'RETURN_TO_DEPOT' },
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('returns conflict when route options are changed during an active optimization job', async () => {
    const { dependencies, updateRoutePlanOptions } = createDependencyHarness();
    updateRoutePlanOptions.mockRejectedValueOnce(new RouteOptimizationJobActiveError());
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { routeEndMode: 'RETURN_TO_DEPOT' },
        url: '/admin/route-plans/route-plan-id/options'
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'ROUTE_OPTIMIZATION_JOB_ACTIVE',
          message: 'A route optimization job is already active for this route.'
        }
      });
    } finally {
      await app.close();
    }
  });

  test('assigns a route plan driver for the token shop', async () => {
    const { dependencies } = createDependencyHarness();
    const assignRoutePlanDriver = vi.fn(() =>
      Promise.resolve({
        routePlan: {
          ...routePlanSummary,
          driver: {
            authStatus: 'INVITE_PENDING',
            authSubject: null,
            createdAt: '2026-05-07T12:30:00.000Z',
            displayName: 'Mina Driver',
            id: 'driver-id',
            lastSeenAt: null,
            phone: '+14165550000',
            recentEventsCount: 0,
            status: 'PENDING',
            updatedAt: '2026-05-07T12:30:00.000Z'
          },
          driverId: 'driver-id'
        },
        routeGeometry: null,
        routeMetrics: null,
        routeStopPoints: routePlanStopPoints(),
        stops: [
          routePlanStop({ orderName: '#1035', sequence: 1 }),
          routePlanStop({ orderName: '#1036', sequence: 2 })
        ]
      })
    );
    (
      dependencies.routePlanService as unknown as {
        assignRoutePlanDriver: typeof assignRoutePlanDriver;
      }
    ).assignRoutePlanDriver = assignRoutePlanDriver;
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { driverId: 'driver-id' },
        url: '/admin/route-plans/route-plan-id/driver'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          routePlan: {
            driver: {
              displayName: 'Mina Driver',
              id: 'driver-id',
              phone: '+14165550000'
            },
            driverId: 'driver-id',
            id: 'route-plan-id'
          }
        },
        error: null
      });
      expect(assignRoutePlanDriver).toHaveBeenCalledWith({
        appId: 'clever',
        payload: { driverId: 'driver-id' },
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects invalid route plan driver payloads before saving', async () => {
    const { dependencies } = createDependencyHarness();
    const assignRoutePlanDriver = vi.fn();
    (
      dependencies.routePlanService as unknown as {
        assignRoutePlanDriver: typeof assignRoutePlanDriver;
      }
    ).assignRoutePlanDriver = assignRoutePlanDriver;
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { driverId: 42 },
        url: '/admin/route-plans/route-plan-id/driver'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid route driver assignment payload' }
      });
      expect(assignRoutePlanDriver).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('saves a route plan departure time for the token shop', async () => {
    const { dependencies, saveRoutePlan } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { departureTime: '08:30' },
        url: '/admin/route-plans/route-plan-id/departure-time'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: { routePlan: { departureTime: '08:30', id: 'route-plan-id' } },
        error: null
      });
      expect(saveRoutePlan).toHaveBeenCalledWith({
        appId: 'clever',
        payload: { departureTime: '08:30' },
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('saves a complete scheduled route start instant for the token shop', async () => {
    const { dependencies, saveRoutePlan } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { scheduledStartAt: '2026-07-16T12:30:00.000Z' },
        url: '/admin/route-plans/route-plan-id/start-time'
      });

      expect(response.statusCode).toBe(200);
      expect(saveRoutePlan).toHaveBeenCalledWith({
        appId: 'clever',
        payload: { scheduledStartAt: '2026-07-16T12:30:00.000Z' },
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('allows a scheduled route start to be cleared without inferring the plan date', async () => {
    const { dependencies, saveRoutePlan } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { scheduledStartAt: null },
        url: '/admin/route-plans/route-plan-id/start-time'
      });

      expect(response.statusCode).toBe(200);
      expect(saveRoutePlan).toHaveBeenCalledWith(expect.objectContaining({
        payload: { scheduledStartAt: null }
      }));
    } finally {
      await app.close();
    }
  });

  test('rejects a route start date without an explicit time', async () => {
    const { dependencies, saveRoutePlan } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { scheduledStartAt: '2026-07-16' },
        url: '/admin/route-plans/route-plan-id/start-time'
      });

      expect(response.statusCode).toBe(400);
      expect(saveRoutePlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects a route start date-time without an explicit timezone', async () => {
    const { dependencies, saveRoutePlan } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { scheduledStartAt: '2026-07-16T12:30' },
        url: '/admin/route-plans/route-plan-id/start-time'
      });

      expect(response.statusCode).toBe(400);
      expect(saveRoutePlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects invalid route plan departure times before saving', async () => {
    const { dependencies, saveRoutePlan } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { departureTime: '25:00' },
        url: '/admin/route-plans/route-plan-id/departure-time'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid route departure time payload' }
      });
      expect(saveRoutePlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects adding a stop already assigned to another route plan', async () => {
    const { dependencies, updateRoutePlanStops } = createDependencyHarness();
    updateRoutePlanStops.mockRejectedValueOnce(new RoutePlanOrderAlreadyPlannedError());
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { stops: [{ shopifyOrderGid: 'gid://shopify/Order/1', sequence: 1 }] },
        url: '/admin/route-plans/route-plan-id/stops'
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'ROUTE_ORDER_ALREADY_PLANNED',
          message: '이미 다른 Route에 등록된 주문이 포함되어 있어 Route stops를 저장하지 않았습니다. 아직 Route에 없는 주문만 추가해주세요.'
        }
      });
    } finally {
      await app.close();
    }
  });

  test('deletes a route plan for the token shop', async () => {
    const { dependencies, deleteRoutePlan } = createDependencyHarness();
    const app = await buildApp({ adminRoutePlans: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'DELETE',
        url: '/admin/route-plans/route-plan-id'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          routePlanId: 'route-plan-id',
          deleted: true
        },
        error: null
      });
      expect(deleteRoutePlan).toHaveBeenCalledWith({
        appId: 'clever',
        routePlanId: 'route-plan-id',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });
});

function createDependencyHarness(): {
  assignRoutePlanDriver: ReturnType<
    typeof vi.fn<AdminRoutePlanDependencies['routePlanService']['assignRoutePlanDriver']>
  >;
  createRoutePlan: ReturnType<
    typeof vi.fn<AdminRoutePlanDependencies['routePlanService']['createRoutePlan']>
  >;
  dependencies: AdminRoutePlanDependencies;
  getRoutePlanDetail: ReturnType<
    typeof vi.fn<AdminRoutePlanDependencies['routePlanService']['getRoutePlanDetail']>
  >;
  deleteRoutePlan: ReturnType<
    typeof vi.fn<AdminRoutePlanDependencies['routePlanService']['deleteRoutePlan']>
  >;
  listRoutePlans: ReturnType<
    typeof vi.fn<AdminRoutePlanDependencies['routePlanService']['listRoutePlans']>
  >;
  publishRoutePlan: ReturnType<
    typeof vi.fn<AdminRoutePlanDependencies['routePlanService']['publishRoutePlan']>
  >;
  refreshRouteGeometryForRoutePlan: ReturnType<
    typeof vi.fn<NonNullable<AdminRoutePlanDependencies['routePlanService']['refreshRouteGeometryForRoutePlan']>>
  >;
  saveRoutePlan: ReturnType<
    typeof vi.fn<SaveRoutePlan>
  >;
  updateRoutePlanOptions: ReturnType<
    typeof vi.fn<AdminRoutePlanDependencies['routePlanService']['updateRoutePlanOptions']>
  >;
  transitionAdminRouteStop: ReturnType<
    typeof vi.fn<NonNullable<AdminRoutePlanDependencies['routePlanService']['transitionAdminRouteStop']>>
  >;
  updateAdminRouteStopOverride: ReturnType<
    typeof vi.fn<NonNullable<AdminRoutePlanDependencies['routePlanService']['updateAdminRouteStopOverride']>>
  >;
  updateRoutePlanStops: ReturnType<
    typeof vi.fn<AdminRoutePlanDependencies['routePlanService']['updateRoutePlanStops']>
  >;
} {
  const verify = vi.fn(() => ({
    shopDomain: 'example.myshopify.com',
    subject: 'shopify-user-id'
  }));
  const createRoutePlan = vi.fn<AdminRoutePlanDependencies['routePlanService']['createRoutePlan']>(
    () => Promise.resolve(routePlanSummary)
  );
  const assignRoutePlanDriver = vi.fn<
    AdminRoutePlanDependencies['routePlanService']['assignRoutePlanDriver']
  >(() =>
    Promise.resolve({
      routePlan: routePlanSummary,
      routeGeometry: null,
      routeMetrics: null,
      routeStopPoints: routePlanStopPoints(),
      stops: [
        routePlanStop({ orderName: '#1035', sequence: 1 }),
        routePlanStop({ orderName: '#1036', sequence: 2 })
      ]
    })
  );
  const listRoutePlans = vi.fn<AdminRoutePlanDependencies['routePlanService']['listRoutePlans']>(
    () => Promise.resolve([routePlanSummary])
  );
  const getRoutePlanDetail = vi.fn<
    AdminRoutePlanDependencies['routePlanService']['getRoutePlanDetail']
  >(() =>
    Promise.resolve({
      routePlan: routePlanSummary,
      routeGeometry: null,
      routeMetrics: null,
      routeStopPoints: routePlanStopPoints(),
      stops: [
        routePlanStop({ orderName: '#1035', sequence: 1 }),
        routePlanStop({ orderName: '#1036', sequence: 2 })
      ]
    })
  );
  const deleteRoutePlan = vi.fn<
    AdminRoutePlanDependencies['routePlanService']['deleteRoutePlan']
  >(() => Promise.resolve({ routePlanId: 'route-plan-id', deleted: true }));
  const publishRoutePlan = vi.fn<
    AdminRoutePlanDependencies['routePlanService']['publishRoutePlan']
  >(() =>
    Promise.resolve({
      routePlan: { ...routePlanSummary, status: 'ASSIGNED' },
      routeGeometry: null,
      routeMetrics: null,
      routeStopPoints: routePlanStopPoints(),
      stops: [
        routePlanStop({ orderName: '#1035', sequence: 1 }),
        routePlanStop({ orderName: '#1036', sequence: 2 })
      ]
    })
  );
  const refreshRouteGeometryForRoutePlan = vi.fn<
    NonNullable<AdminRoutePlanDependencies['routePlanService']['refreshRouteGeometryForRoutePlan']>
  >(() =>
    Promise.resolve({
      routePlan: routePlanSummary,
      routeGeometry: null,
      routeMetrics: null,
      routeStopPoints: routePlanStopPoints(),
      stops: [
        routePlanStop({ orderName: '#1035', sequence: 1 }),
        routePlanStop({ orderName: '#1036', sequence: 2 })
      ]
    })
  );
  const saveRoutePlan = vi.fn<SaveRoutePlan>(() =>
    Promise.resolve({
      detail: {
        routePlan: { ...routePlanSummary, departureTime: '08:30' },
        routeGeometry: null,
        routeMetrics: null,
        routeStopPoints: routePlanStopPoints(),
        stops: [
          routePlanStop({ orderName: '#1035', sequence: 1 }),
          routePlanStop({ orderName: '#1036', sequence: 2 })
        ]
      },
      operations: []
    })
  );
  const updateRoutePlanStops = vi.fn<
    AdminRoutePlanDependencies['routePlanService']['updateRoutePlanStops']
  >(() =>
    Promise.resolve({
      routePlan: routePlanSummary,
      routeGeometry: null,
      routeMetrics: null,
      routeStopPoints: routePlanStopPoints(),
      stops: [
        routePlanStop({ orderName: '#1035', sequence: 1 }),
        routePlanStop({ orderName: '#1036', sequence: 2 })
      ]
    })
  );
  const updateRoutePlanOptions = vi.fn<
    AdminRoutePlanDependencies['routePlanService']['updateRoutePlanOptions']
  >(() =>
    Promise.resolve({
      routePlan: { ...routePlanSummary, routeEndMode: 'RETURN_TO_DEPOT' },
      routeGeometry: null,
      routeMetrics: null,
      routeStopPoints: routePlanStopPoints(),
      stops: [
        routePlanStop({ orderName: '#1035', sequence: 1 }),
        routePlanStop({ orderName: '#1036', sequence: 2 })
      ]
    })
  );
  const transitionAdminRouteStop = vi.fn<
    NonNullable<AdminRoutePlanDependencies['routePlanService']['transitionAdminRouteStop']>
  >(() =>
    Promise.resolve({
      duplicate: false,
      notification: {
        idempotencyKey: 'admin-stop-action-key:customer-notification',
        orderId: 'order-1',
        recipientEmail: 'customer@example.com',
        status: 'QUEUED'
      },
      routePlan: {
        routePlan: routePlanSummary,
        routeGeometry: null,
        routeMetrics: null,
        routeStopPoints: routePlanStopPoints(),
        stops: [
          routePlanStop({ orderName: '#1035', sequence: 1, status: 'DELIVERED' }),
          routePlanStop({ orderName: '#1036', sequence: 2 })
        ]
      },
      status: {
        deliveryStopStatus: 'DELIVERED',
        uiStatus: 'COMPLETED'
      }
    })
  );
  const updateAdminRouteStopOverride = vi.fn<
    NonNullable<AdminRoutePlanDependencies['routePlanService']['updateAdminRouteStopOverride']>
  >(() =>
    Promise.resolve({
      geometry: { status: 'stale' },
      routePlan: {
        routePlan: routePlanSummary,
        routeGeometry: null,
        routeMetrics: null,
        routeStopPoints: routePlanStopPoints(),
        stops: [
          routePlanStop({ orderName: '#1035', sequence: 1 }),
          routePlanStop({ orderName: '#1036', sequence: 2 })
        ]
      }
    })
  );

  return {
    assignRoutePlanDriver,
    createRoutePlan,
    dependencies: {
      routePlanService: {
        assignRoutePlanDriver,
        createRoutePlan,
        deleteRoutePlan,
        getRoutePlanDetail,
        listRoutePlans,
        publishRoutePlan,
        refreshRouteGeometryForRoutePlan,
        saveRoutePlan,
        transitionAdminRouteStop,
        updateAdminRouteStopOverride,
        updateRoutePlanOptions,
        updateRoutePlanStops
      },
      sessionTokenVerifier: {
        verify
      }
    },
    getRoutePlanDetail,
    deleteRoutePlan,
    listRoutePlans,
    publishRoutePlan,
    refreshRouteGeometryForRoutePlan,
    saveRoutePlan,
    transitionAdminRouteStop,
    updateAdminRouteStopOverride,
    updateRoutePlanOptions,
    updateRoutePlanStops
  };
}


function scopedRoutePlanPayload(input: {
  secondOrderArea?: string;
  secondOrderRawPayload?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const routeScope = {
    deliveryDate: '2026-05-08',
    deliverySession: 'EVENING',
    routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
    serviceType: 'EVENING_DELIVERY',
    timeWindowEnd: '21:00',
    timeWindowStart: '17:00'
  };
  const payload = routePlanPayload();
  const orders = payload.orders as Record<string, unknown>[];
  const first = orders[0] ?? {};
  first.rawPayload = { routeScopeKey: routeScope.routeScopeKey };
  orders.push({
    ...first,
    deliveryArea: input.secondOrderArea ?? 'Mississauga',
    name: '#1036',
    rawPayload: input.secondOrderRawPayload ?? { routeScopeKey: routeScope.routeScopeKey },
    shopifyOrderGid: 'gid://shopify/Order/124'
  });
  return { ...payload, planDate: '2026-05-08', routeScope };
}

function routePlanPayload(): Record<string, unknown> {
  return {
    depot: {
      address: 'Shopify departure location',
      latitude: 43.6532,
      longitude: -79.3832
    },
    name: 'CLEVER route draft',
    orders: [
      {
        attributes: [{ key: 'Delivery Area', value: 'Mississauga' }],
        currencyCode: 'CAD',
        deliveryArea: 'Mississauga',
        deliveryDay: 'Thursday',
        email: 'customer@example.com',
        financialStatus: 'PENDING',
        fulfillmentStatus: 'UNFULFILLED',
        latitude: 43.589,
        longitude: -79.644,
        name: '#1035',
        phone: '+14165550000',
        processedAt: '2026-05-07T12:00:00.000Z',
        rawPayload: {},
        recipientName: 'Noah Yoon',
        shippingAddress: {
          address1: '300 City Centre Dr',
          address2: '#08',
          city: 'Mississauga',
          countryCode: 'CA',
          postalCode: 'L5B 3C1',
          province: 'ON'
        },
        shopifyOrderGid: 'gid://shopify/Order/123',
        totalPriceAmount: '95.00'
      }
    ],
    planDate: '2026-05-08'
  };
}

function routePlanStop(input: { orderName: string; sequence: number; status?: string }): RoutePlanDetailStop {
  return {
    address: {
      address1: '300 City Centre Dr',
      address2: '#08',
      city: 'Mississauga',
      countryCode: 'CA',
      postalCode: 'L5B 3C1',
      province: 'ON'
    },
    attributes: [{ key: 'Delivery Area', value: 'Mississauga' }],
    coordinates: {
      latitude: 43.589,
      longitude: -79.644
    },
    deliveryArea: 'Mississauga',
    deliveryDay: 'Thursday',
    deliveryStopId: `stop-${input.sequence}`,
    financialStatus: 'PENDING',
    fulfillmentStatus: 'UNFULFILLED',
    orderId: `order-${input.sequence}`,
    orderName: input.orderName,
    paymentStatus: 'PENDING',
    recipientName: 'Noah Yoon',
    sequence: input.sequence,
    shopifyOrderGid: `gid://shopify/Order/${input.sequence}`,
    status: input.status ?? 'PENDING'
  };
}

function routePlanStopPoints(): RoutePlanRouteStopPoint[] {
  return [
    {
      deliveryStopId: 'stop-1',
      inputCoordinates: [-79.644, 43.589],
      name: 'Duke of York Boulevard',
      sequence: 1,
      shopifyOrderGid: 'gid://shopify/Order/1',
      snapDistanceMeters: 54.16,
      snappedCoordinates: [-79.643565, 43.589371]
    },
    {
      deliveryStopId: 'stop-2',
      inputCoordinates: [-79.644, 43.589],
      name: 'Duke of York Boulevard',
      sequence: 2,
      shopifyOrderGid: 'gid://shopify/Order/2',
      snapDistanceMeters: 22.1,
      snappedCoordinates: [-79.6437, 43.5895]
    }
  ];
}
