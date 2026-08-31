import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { CustomOrderReferenceCopyNotAllowedError, RouteGroupingBranchLockConflictError, RouteGroupingCopyLockedError, RouteGroupingDeleteBlockedError } from '../src/modules/route-grouping/route-grouping.types.js';
import type { AdminRouteGroupDependencies } from '../src/routes/admin-route-groups.routes.js';

const routeGroup = {
  assignments: [],
  branches: [],
  children: [],
  currentVersion: 1,
  dateRangeEnd: '2026-06-27',
  dateRangeStart: '2026-06-25',
  displayStatus: 'READY' as const,
  id: 'route-group-id',
  linkedInventoryId: 'inventory-id',
  name: 'June delivery group',
  planDate: '2026-06-25',
  polygons: [],
  status: 'DRAFT',
  totalOrders: 2,
  unresolvedOrders: 2,
  updatedAt: '2026-06-24T12:00:00.000Z',
  warningState: []
};

describe('Admin route group routes', () => {
  test('copies a route group only after an explicit provider-neutral mode selection', async () => {
    const { copyGrouping, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'clever-route-dev' },
        method: 'POST',
        payload: { expectedUpdatedAt: '2026-06-24T12:00:00.000Z', mode: 'VIRTUAL' },
        url: '/admin/route-groups/route-group-id/copies'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ data: { routeGroup }, error: null });
      expect(copyGrouping).toHaveBeenCalledWith({
        actor: 'shopify-user-id',
        appId: 'clever-route-dev',
        expectedUpdatedAt: '2026-06-24T12:00:00.000Z',
        groupingId: 'route-group-id',
        mode: 'VIRTUAL',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects missing and invalid copy modes without calling the service', async () => {
    const { copyGrouping, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });
    try {
      for (const mode of [undefined, 'CLONE']) {
        const response = await app.inject({
          headers: { authorization: 'Bearer session-token' },
          method: 'POST',
          payload: { expectedUpdatedAt: '2026-06-24T12:00:00.000Z', ...(mode === undefined ? {} : { mode }) },
          url: '/admin/route-groups/route-group-id/copies'
        });
        expect(response.statusCode).toBe(400);
      }
      expect(copyGrouping).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('returns locked source order ids when REFERENCE copy cannot proceed', async () => {
    const { copyGrouping, dependencies } = createDependencyHarness();
    copyGrouping.mockRejectedValueOnce(new RouteGroupingCopyLockedError(['order-1']));
    const app = await buildApp({ adminRouteGroups: dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { expectedUpdatedAt: '2026-06-24T12:00:00.000Z', mode: 'REFERENCE' },
        url: '/admin/route-groups/route-group-id/copies'
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: { orderIds: ['order-1'] },
        error: { code: 'ROUTE_GROUPING_COPY_LOCKED', message: 'One or more source orders are locked by a started or completed route.' }
      });
    } finally {
      await app.close();
    }
  });

  test('returns a stable code when REFERENCE copy contains a CUSTOM order', async () => {
    const { copyGrouping, dependencies } = createDependencyHarness();
    copyGrouping.mockRejectedValueOnce(new CustomOrderReferenceCopyNotAllowedError());
    const app = await buildApp({ adminRouteGroups: dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { expectedUpdatedAt: '2026-06-24T12:00:00.000Z', mode: 'REFERENCE' },
        url: '/admin/route-groups/route-group-id/copies'
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'CUSTOM_ORDER_REFERENCE_COPY_NOT_ALLOWED',
          message: 'REFERENCE copy cannot include CUSTOM orders; choose VIRTUAL mode.'
        }
      });
    } finally {
      await app.close();
    }
  });

  test('returns 409 when foreign CUSTOM associations block route-group deletion', async () => {
    const { deleteGrouping, dependencies } = createDependencyHarness();
    deleteGrouping.mockRejectedValueOnce(new RouteGroupingDeleteBlockedError([
      'owned CUSTOM orders are linked to another route group',
      'owned CUSTOM stops are linked to another route plan'
    ]));
    const app = await buildApp({ adminRouteGroups: dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'DELETE',
        url: '/admin/route-groups/route-group-id'
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'ROUTE_GROUPING_DELETE_BLOCKED',
          message: 'owned CUSTOM orders are linked to another route group; owned CUSTOM stops are linked to another route plan'
        }
      });
    } finally {
      await app.close();
    }
  });

  test('creates a tenant-scoped custom stop without a Shopify operation', async () => {
    const { createCustomStop, dependencies, geocode } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'clever-route-dev' },
        method: 'POST',
        payload: {
          address1: '123 Main St',
          city: 'Toronto',
          countryCode: 'CA',
          expectedUpdatedAt: '2026-06-24T12:00:00.000Z',
          postalCode: 'M5H 2N2',
          priority: 10,
          recipientName: 'Receiving desk',
          serviceMinutes: 15,
          stopName: 'Warehouse pickup',
          targetRoutePlanId: 'route-plan-2',
          timeWindowEnd: '2026-06-25T15:00:00.000Z',
          timeWindowStart: '2026-06-25T13:00:00.000Z'
        },
        url: '/admin/route-groups/route-group-id/stops/custom'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ data: { routeGroup }, error: null });
      expect(createCustomStop).toHaveBeenCalledWith({
        actor: 'shopify-user-id',
        address1: '123 Main St',
        appId: 'clever-route-dev',
        city: 'Toronto',
        countryCode: 'CA',
        expectedUpdatedAt: '2026-06-24T12:00:00.000Z',
        groupingId: 'route-group-id',
        latitude: 43.7,
        longitude: -79.4,
        postalCode: 'M5H 2N2',
        priority: 10,
        recipientName: 'Receiving desk',
        serviceMinutes: 15,
        shopDomain: 'example.myshopify.com',
        stopName: 'Warehouse pickup',
        targetRoutePlanId: 'route-plan-2',
        timeWindowEnd: '2026-06-25T15:00:00.000Z',
        timeWindowStart: '2026-06-25T13:00:00.000Z'
      });
      expect(geocode).toHaveBeenCalledWith({
        address: {
          address1: '123 Main St',
          address2: null,
          city: 'Toronto',
          countryCode: 'CA',
          postalCode: 'M5H 2N2',
          province: null
        },
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects incomplete or malformed custom stop locations before calling the service', async () => {
    const { createCustomStop, dependencies, geocode } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });
    const validLocation = { address1: '123 Main St', countryCode: 'CA' };
    const cases = [
      { message: 'custom stop address1 is required', payload: { ...validLocation, address1: undefined } },
      { message: 'custom stop address1 is required', payload: { ...validLocation, address1: null } },
      { message: 'custom stop address1 is required', payload: { ...validLocation, address1: '   ' } },
      { message: 'custom stop countryCode is required', payload: { ...validLocation, countryCode: undefined } },
      { message: 'custom stop countryCode must be a two-letter ISO country code', payload: { ...validLocation, countryCode: 'CAN' } }
    ];

    try {
      for (const entry of cases) {
        const response = await app.inject({
          headers: { authorization: 'Bearer session-token' },
          method: 'POST',
          payload: { ...entry.payload, stopName: 'Invalid custom stop' },
          url: '/admin/route-groups/route-group-id/stops/custom'
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          data: null,
          error: { code: 'ROUTE_GROUPING_INVALID', message: entry.message }
        });
      }
      expect(createCustomStop).not.toHaveBeenCalled();
      expect(geocode).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('geocodes address updates and ignores caller-supplied coordinates', async () => {
    const { dependencies, geocode, updateCustomStop } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const updated = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: {
          address1: '456 Queen St',
          city: 'Toronto',
          countryCode: 'CA',
          latitude: 0,
          longitude: 0,
          postalCode: 'M5V 2B6'
        },
        url: '/admin/route-groups/route-group-id/stops/stop-id/custom'
      });
      expect(updated.statusCode).toBe(200);
      expect(updateCustomStop).toHaveBeenCalledWith({
        address1: '456 Queen St',
        appId: 'clever',
        city: 'Toronto',
        countryCode: 'CA',
        deliveryStopId: 'stop-id',
        groupingId: 'route-group-id',
        latitude: 43.7,
        longitude: -79.4,
        postalCode: 'M5V 2B6',
        shopDomain: 'example.myshopify.com'
      });
      expect(geocode).toHaveBeenCalledWith({
        address: {
          address1: '456 Queen St',
          address2: null,
          city: 'Toronto',
          countryCode: 'CA',
          postalCode: 'M5V 2B6',
          province: null
        },
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('does not persist a custom stop when server geocoding fails', async () => {
    const { createCustomStop, dependencies, geocode } = createDependencyHarness();
    geocode.mockResolvedValueOnce({ code: 'GEOCODER_NO_RESULT', message: 'No geocoding result was found.', ok: false });
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { address1: 'Unknown address', countryCode: 'CA', stopName: 'Unknown stop' },
        url: '/admin/route-groups/route-group-id/stops/custom'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'ROUTE_GROUPING_INVALID',
          message: 'custom stop address could not be geocoded: No geocoding result was found.'
        }
      });
      expect(createCustomStop).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('updates and deletes only a custom stop in the authenticated tenant group', async () => {
    const { deleteCustomStop, dependencies, geocode, updateCustomStop } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const updated = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { expectedUpdatedAt: '2026-06-24T12:00:00.000Z', instructions: 'Use loading dock 2', stopName: 'Warehouse return' },
        url: '/admin/route-groups/route-group-id/stops/stop-id/custom'
      });
      const deleted = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'DELETE',
        url: '/admin/route-groups/route-group-id/stops/stop-id/custom'
      });

      expect(updated.statusCode).toBe(200);
      expect(deleted.statusCode).toBe(200);
      expect(updateCustomStop).toHaveBeenCalledWith({
        appId: 'clever',
        deliveryStopId: 'stop-id',
        expectedUpdatedAt: '2026-06-24T12:00:00.000Z',
        groupingId: 'route-group-id',
        instructions: 'Use loading dock 2',
        shopDomain: 'example.myshopify.com',
        stopName: 'Warehouse return'
      });
      expect(deleteCustomStop).toHaveBeenCalledWith({
        appId: 'clever',
        deliveryStopId: 'stop-id',
        groupingId: 'route-group-id',
        shopDomain: 'example.myshopify.com'
      });
      expect(geocode).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects route group creation without a Shopify session token', async () => {
    const { createGrouping, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({ method: 'POST', payload: createPayload(), url: '/admin/route-groups' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing bearer session token' }
      });
      expect(createGrouping).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('creates a route group with token app/shop scope and date range', async () => {
    const { createGrouping, dependencies } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'clever-route-dev' },
        method: 'POST',
        payload: createPayload(),
        url: '/admin/route-groups'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ data: { routeGroup }, error: null });
      expect(createGrouping).toHaveBeenCalledWith({
        appId: 'clever-route-dev',
        createdBy: 'shopify-user-id',
        dateRangeEnd: '2026-06-27',
        dateRangeStart: '2026-06-25',
        depot: { address: '123 Main St', latitude: 43.7, longitude: -79.4 },
        name: 'June delivery group',
        orderIds: ['order-1', 'order-2'],
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('lists route groups with overlap date range query', async () => {
    const { dependencies, listGroupings } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'GET',
        url: '/admin/route-groups?dateRangeStart=2026-06-25&dateRangeEnd=2026-06-27'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { routeGroups: [routeGroup] }, error: null });
      expect(listGroupings).toHaveBeenCalledWith({
        appId: 'clever',
        dateRangeEnd: '2026-06-27',
        dateRangeStart: '2026-06-25',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('returns next shop-global route index for a route group', async () => {
    const { dependencies, nextRouteIdx } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'clever-route-dev' },
        method: 'GET',
        url: '/admin/route-groups/route-group-id/next-route-idx'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { nextRouteIdx: 7 }, error: null });
      expect(nextRouteIdx).toHaveBeenCalledWith({
        appId: 'clever-route-dev',
        groupingId: 'route-group-id',
        shopDomain: 'example.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('updates route group membership without generating child routes', async () => {
    const { dependencies, generateChildRoutes, updateGroupingOrders } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { addOrderIds: ['order-3'], removeOrderIds: ['order-1'] },
        url: '/admin/route-groups/route-group-id/orders'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { routeGroup }, error: null });
      expect(updateGroupingOrders).toHaveBeenCalledWith({
        addOrderIds: ['order-3'],
        appId: 'clever',
        groupingId: 'route-group-id',
        removeOrderIds: ['order-1'],
        shopDomain: 'example.myshopify.com'
      });
      expect(generateChildRoutes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('passes a target child route when orders must be added atomically', async () => {
    const { dependencies, updateGroupingOrders } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: {
          addOrderIds: ['order-3'],
          expectedUpdatedAt: '2026-06-24T12:00:00.000Z',
          targetRoutePlanId: 'route-plan-2'
        },
        url: '/admin/route-groups/route-group-id/orders'
      });

      expect(response.statusCode).toBe(200);
      expect(updateGroupingOrders).toHaveBeenCalledWith({
        addOrderIds: ['order-3'],
        appId: 'clever',
        expectedUpdatedAt: '2026-06-24T12:00:00.000Z',
        groupingId: 'route-group-id',
        shopDomain: 'example.myshopify.com',
        targetRoutePlanId: 'route-plan-2'
      });
    } finally {
      await app.close();
    }
  });

  test('creates branch locks without generating child routes', async () => {
    const { createBranch, dependencies, generateChildRoutes } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { color: '#006fbb', driverId: 'driver-id', label: 'Driver A', orderIds: ['order-1'], sortOrder: 2 },
        url: '/admin/route-groups/route-group-id/branches'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ data: { routeGroup }, error: null });
      expect(createBranch).toHaveBeenCalledWith({
        actor: 'shopify-user-id',
        appId: 'clever',
        color: '#006fbb',
        driverId: 'driver-id',
        groupingId: 'route-group-id',
        label: 'Driver A',
        orderIds: ['order-1'],
        shopDomain: 'example.myshopify.com',
        sortOrder: 2
      });
      expect(generateChildRoutes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('returns conflict details when a branch already owns an order', async () => {
    const { createBranch, dependencies } = createDependencyHarness();
    createBranch.mockRejectedValueOnce(new RouteGroupingBranchLockConflictError(['order-1']));
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { orderIds: ['order-1'] },
        url: '/admin/route-groups/route-group-id/branches'
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: { orderIds: ['order-1'] },
        error: { code: 'ROUTE_GROUPING_BRANCH_LOCK_CONFLICT', message: 'One or more orders already belong to another branch.' }
      });
    } finally {
      await app.close();
    }
  });


  test('updates branch draft metadata without generating child routes', async () => {
    const { dependencies, generateChildRoutes, updateBranch } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { color: '#16a34a', driverId: null, label: 'Route B', sortOrder: 3 },
        url: '/admin/route-groups/route-group-id/branches/branch-id'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { routeGroup }, error: null });
      expect(updateBranch).toHaveBeenCalledWith({
        appId: 'clever',
        branchId: 'branch-id',
        color: '#16a34a',
        driverId: null,
        groupingId: 'route-group-id',
        label: 'Route B',
        shopDomain: 'example.myshopify.com',
        sortOrder: 3
      });
      expect(generateChildRoutes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('updates branch orders without generating child routes', async () => {
    const { dependencies, generateChildRoutes, updateBranchOrders } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { addOrderIds: ['order-2'], removeOrderIds: ['order-1'] },
        url: '/admin/route-groups/route-group-id/branches/branch-id/orders'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { routeGroup }, error: null });
      expect(updateBranchOrders).toHaveBeenCalledWith({
        addOrderIds: ['order-2'],
        appId: 'clever',
        branchId: 'branch-id',
        groupingId: 'route-group-id',
        removeOrderIds: ['order-1'],
        shopDomain: 'example.myshopify.com'
      });
      expect(generateChildRoutes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('saves child-only route draft allocation with routeIdx assertions', async () => {
    const { dependencies, generateChildRoutes, saveDraft } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: {
          deletedRoutePlanIds: ['route-plan-delete'],
          expectedUpdatedAt: '2026-07-20T09:00:00-04:00',
          mode: 'MANUAL_ORDER',
          removedOrderIds: ['order-remove'],
          routes: [{ driverId: null, expectedChildUpdatedAt: '2026-07-20T09:10:00-04:00', expectedRoutePlanUpdatedAt: '2026-07-20T09:20:00-04:00', orderIds: ['order-1'], routeIdx: 1, routePlanId: 'route-plan-1', scheduledStartAt: '2026-07-20T09:30:00-04:00', scheduledStartTimeZone: 'America/Toronto' }, { driverId: 'driver-2', orderIds: ['order-2'], routeIdx: 2, scheduledStartAt: null, scheduledStartTimeZone: null, tempId: 'temp-2' }]
        },
        url: '/admin/route-groups/route-group-id/draft'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { routeGroup }, error: null });
      expect(saveDraft).toHaveBeenCalledWith({
        appId: 'clever',
        deletedRoutePlanIds: ['route-plan-delete'],
        expectedUpdatedAt: '2026-07-20T13:00:00.000Z',
        groupingId: 'route-group-id',
        mode: 'MANUAL_ORDER',
        removedOrderIds: ['order-remove'],
        routes: [{ branchId: null, driverId: null, expectedChildUpdatedAt: '2026-07-20T13:10:00.000Z', expectedRoutePlanUpdatedAt: '2026-07-20T13:20:00.000Z', orderIds: ['order-1'], routeIdx: 1, routePlanId: 'route-plan-1', scheduledStartAt: '2026-07-20T13:30:00.000Z', scheduledStartTimeZone: 'America/Toronto' }, { branchId: null, driverId: 'driver-2', orderIds: ['order-2'], routeIdx: 2, scheduledStartAt: null, scheduledStartTimeZone: null, tempId: 'temp-2' }],
        shopDomain: 'example.myshopify.com'
      });
      expect(generateChildRoutes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects unsupported route draft save modes', async () => {
    const { dependencies, saveDraft } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { mode: 'OPTIMIZE_ORDER', routes: [{ orderIds: ['order-1'], routePlanId: 'route-plan-1' }] },
        url: '/admin/route-groups/route-group-id/draft'
      });

      expect(response.statusCode).toBe(400);
      expect(saveDraft).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects unsupported route draft IANA timezones', async () => {
    const { dependencies, saveDraft } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { routes: [{ orderIds: ['order-1'], routePlanId: 'route-plan-1', scheduledStartTimeZone: 'Mars/Olympus' }] },
        url: '/admin/route-groups/route-group-id/draft'
      });

      expect(response.statusCode).toBe(400);
      expect(saveDraft).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('rejects route draft start times without an explicit timezone', async () => {
    const { dependencies, saveDraft } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'PATCH',
        payload: { routes: [{ orderIds: ['order-1'], routeIdx: 1, routePlanId: 'route-plan-1', scheduledStartAt: '2026-07-20T09:30' }] },
        url: '/admin/route-groups/route-group-id/draft'
      });

      expect(response.statusCode).toBe(400);
      expect(saveDraft).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('previews route optimization without saving draft changes', async () => {
    const { dependencies, generateChildRoutes, previewOptimization, reOptimizeRoutes, saveDraft } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const payload = {
        mode: 'OPTIMIZE_ORDER',
        routes: [{ branchId: null, color: '#0070bb', label: 'Route 1', orderIds: ['order-1'], routeIdx: 1, routePlanId: 'route-plan-1', sortOrder: 1 }]
      };
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token', 'x-clever-app-id': 'clever-route-dev' },
        method: 'POST',
        payload,
        url: '/admin/route-groups/route-group-id/optimize-preview'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { preview: { routes: [] } }, error: null });
      expect(previewOptimization).toHaveBeenCalledWith({
        appId: 'clever-route-dev',
        groupingId: 'route-group-id',
        mode: 'OPTIMIZE_ORDER',
        routes: payload.routes,
        shopDomain: 'example.myshopify.com'
      });
      expect(generateChildRoutes).not.toHaveBeenCalled();
      expect(reOptimizeRoutes).not.toHaveBeenCalled();
      expect(saveDraft).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });


  test('re-optimizes current group routes without generating child routes', async () => {
    const { dependencies, generateChildRoutes, reOptimizeRoutes } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'POST',
        payload: { confirmRisk: true },
        url: '/admin/route-groups/route-group-id/re-optimize'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { routeGroup }, error: null });
      expect(reOptimizeRoutes).toHaveBeenCalledWith({
        actor: 'shopify-user-id',
        appId: 'clever',
        confirmRisk: true,
        groupingId: 'route-group-id',
        shopDomain: 'example.myshopify.com'
      });
      expect(generateChildRoutes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('deletes a branch without generating child routes', async () => {
    const { deleteBranch, dependencies, generateChildRoutes } = createDependencyHarness();
    const app = await buildApp({ adminRouteGroups: dependencies });

    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer session-token' },
        method: 'DELETE',
        url: '/admin/route-groups/route-group-id/branches/branch-id'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { routeGroup }, error: null });
      expect(deleteBranch).toHaveBeenCalledWith({
        appId: 'clever',
        branchId: 'branch-id',
        groupingId: 'route-group-id',
        shopDomain: 'example.myshopify.com'
      });
      expect(generateChildRoutes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

function createDependencyHarness(): {
  copyGrouping: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['copyGrouping']>>;
  createBranch: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['createBranch']>>;
  createCustomStop: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['createCustomStop']>>;
  createGrouping: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['createGrouping']>>;
  deleteBranch: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['deleteBranch']>>;
  deleteCustomStop: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['deleteCustomStop']>>;
  deleteGrouping: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['deleteGrouping']>>;
  dependencies: AdminRouteGroupDependencies;
  generateChildRoutes: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['generateChildRoutes']>>;
  geocode: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['geocodingService']['geocode']>>;
  nextRouteIdx: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['nextRouteIdx']>>;
  previewOptimization: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['previewOptimization']>>;
  reOptimizeRoutes: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['reOptimizeRoutes']>>;
  saveDraft: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['saveDraft']>>;
  listGroupings: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['listGroupings']>>;
  updateBranch: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateBranch']>>;
  updateBranchOrders: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateBranchOrders']>>;
  updateCustomStop: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateCustomStop']>>;
  updateGroupingOrders: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateGroupingOrders']>>;
} {
  const verify = vi.fn((_token: string, options?: object) => ({
    appId: options !== undefined && 'expectedAppId' in options ? String(options.expectedAppId) : 'clever',
    shopDomain: 'example.myshopify.com',
    subject: 'shopify-user-id'
  }));
  const createBranch = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['createBranch']>(() => Promise.resolve(routeGroup));
  const geocode = vi.fn<AdminRouteGroupDependencies['geocodingService']['geocode']>(() => Promise.resolve({
    cached: false,
    ok: true,
    result: {
      addressLabel: '123 Main St, Toronto, ON',
      latitude: 43.7,
      longitude: -79.4,
      provider: 'test',
      providerPlaceId: 'test-place',
      rawLabel: '123 Main St, Toronto, ON'
    }
  }));
  const copyGrouping = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['copyGrouping']>(() => Promise.resolve(routeGroup));
  const createCustomStop = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['createCustomStop']>(() => Promise.resolve(routeGroup));
  const createGrouping = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['createGrouping']>(() => Promise.resolve(routeGroup));
  const deleteBranch = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['deleteBranch']>(() => Promise.resolve(routeGroup));
  const deleteCustomStop = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['deleteCustomStop']>(() => Promise.resolve(routeGroup));
  const listGroupings = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['listGroupings']>(() => Promise.resolve([routeGroup]));
  const getGrouping = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['getGrouping']>(() => Promise.resolve(routeGroup));
  const updateBranch = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateBranch']>(() => Promise.resolve(routeGroup));
  const updateBranchOrders = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateBranchOrders']>(() => Promise.resolve(routeGroup));
  const updateGroupingOrders = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateGroupingOrders']>(() => Promise.resolve(routeGroup));
  const updateCustomStop = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateCustomStop']>(() => Promise.resolve(routeGroup));
  const savePolygons = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['savePolygons']>(() => Promise.resolve(routeGroup));
  const resolveAssignments = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['resolveAssignments']>(() => Promise.resolve(routeGroup));
  const generateChildRoutes = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['generateChildRoutes']>(() => Promise.resolve(routeGroup));
  const nextRouteIdx = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['nextRouteIdx']>(() => Promise.resolve(7));
  const reOptimizeRoutes = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['reOptimizeRoutes']>(() => Promise.resolve(routeGroup));
  const previewOptimization = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['previewOptimization']>(() => Promise.resolve({ preview: { routes: [] } }));
  const saveDraft = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['saveDraft']>(() => Promise.resolve(routeGroup));
  const deleteGrouping = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['deleteGrouping']>(() => Promise.resolve({ deleted: true, deletedChildRoutePlanCount: 0, groupingId: 'route-group-id' }));
  const rollback = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['rollback']>(() => Promise.resolve(routeGroup));
  const recordChildRoutePublished = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['recordChildRoutePublished']>(() => Promise.resolve());

  return {
    createBranch,
    copyGrouping,
    createCustomStop,
    createGrouping,
    deleteBranch,
    deleteCustomStop,
    deleteGrouping,
    dependencies: {
      geocodingService: { geocode },
      routeGroupingService: {
        copyGrouping,
        createBranch,
        createCustomStop,
        createGrouping,
        deleteBranch,
        deleteCustomStop,
        deleteGrouping,
        generateChildRoutes,
        getGrouping,
        listGroupings,
        nextRouteIdx,
        recordChildRoutePublished,
        previewOptimization,
        reOptimizeRoutes,
        resolveAssignments,
        rollback,
        saveDraft,
        savePolygons,
        updateBranch,
        updateBranchOrders,
        updateCustomStop,
        updateGroupingOrders
      },
      sessionTokenVerifier: { verify }
    },
    generateChildRoutes,
    geocode,
    nextRouteIdx,
    previewOptimization,
    reOptimizeRoutes,
    saveDraft,
    listGroupings,
    updateBranch,
    updateBranchOrders,
    updateCustomStop,
    updateGroupingOrders
  };
}

function createPayload(): Record<string, unknown> {
  return {
    dateRangeEnd: '2026-06-27',
    dateRangeStart: '2026-06-25',
    depot: { address: '123 Main St', latitude: 43.7, longitude: -79.4 },
    name: 'June delivery group',
    orderIds: ['order-1', 'order-2']
  };
}
