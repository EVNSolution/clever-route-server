import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { RouteGroupingBranchLockConflictError } from '../src/modules/route-grouping/route-grouping.types.js';
import type { AdminRouteGroupDependencies } from '../src/routes/admin-route-groups.routes.js';

const routeGroup = {
  assignments: [],
  branches: [],
  children: [],
  currentVersion: 1,
  dateRangeEnd: '2026-06-27',
  dateRangeStart: '2026-06-25',
  displayStatus: 'DRAFT' as const,
  id: 'route-group-id',
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


  test('re-optimizes by reusing child-route generation service', async () => {
    const { dependencies, generateChildRoutes } = createDependencyHarness();
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
      expect(generateChildRoutes).toHaveBeenCalledWith({
        actor: 'shopify-user-id',
        appId: 'clever',
        confirmRisk: true,
        groupingId: 'route-group-id',
        shopDomain: 'example.myshopify.com'
      });
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
  createBranch: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['createBranch']>>;
  createGrouping: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['createGrouping']>>;
  deleteBranch: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['deleteBranch']>>;
  dependencies: AdminRouteGroupDependencies;
  generateChildRoutes: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['generateChildRoutes']>>;
  listGroupings: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['listGroupings']>>;
  updateBranch: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateBranch']>>;
  updateBranchOrders: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateBranchOrders']>>;
  updateGroupingOrders: ReturnType<typeof vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateGroupingOrders']>>;
} {
  const verify = vi.fn((_token: string, options?: object) => ({
    appId: options !== undefined && 'expectedAppId' in options ? String(options.expectedAppId) : 'clever',
    shopDomain: 'example.myshopify.com',
    subject: 'shopify-user-id'
  }));
  const createBranch = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['createBranch']>(() => Promise.resolve(routeGroup));
  const createGrouping = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['createGrouping']>(() => Promise.resolve(routeGroup));
  const deleteBranch = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['deleteBranch']>(() => Promise.resolve(routeGroup));
  const listGroupings = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['listGroupings']>(() => Promise.resolve([routeGroup]));
  const getGrouping = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['getGrouping']>(() => Promise.resolve(routeGroup));
  const updateBranch = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateBranch']>(() => Promise.resolve(routeGroup));
  const updateBranchOrders = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateBranchOrders']>(() => Promise.resolve(routeGroup));
  const updateGroupingOrders = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['updateGroupingOrders']>(() => Promise.resolve(routeGroup));
  const savePolygons = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['savePolygons']>(() => Promise.resolve(routeGroup));
  const resolveAssignments = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['resolveAssignments']>(() => Promise.resolve(routeGroup));
  const generateChildRoutes = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['generateChildRoutes']>(() => Promise.resolve(routeGroup));
  const deleteGrouping = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['deleteGrouping']>(() => Promise.resolve({ deleted: true, deletedChildRoutePlanCount: 0, groupingId: 'route-group-id' }));
  const rollback = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['rollback']>(() => Promise.resolve(routeGroup));
  const recordChildRoutePublished = vi.fn<AdminRouteGroupDependencies['routeGroupingService']['recordChildRoutePublished']>(() => Promise.resolve());

  return {
    createBranch,
    createGrouping,
    deleteBranch,
    dependencies: {
      routeGroupingService: {
        createBranch,
        createGrouping,
        deleteBranch,
        deleteGrouping,
        generateChildRoutes,
        getGrouping,
        listGroupings,
        recordChildRoutePublished,
        resolveAssignments,
        rollback,
        savePolygons,
        updateBranch,
        updateBranchOrders,
        updateGroupingOrders
      },
      sessionTokenVerifier: { verify }
    },
    generateChildRoutes,
    listGroupings,
    updateBranch,
    updateBranchOrders,
    updateGroupingOrders
  };
}

function createPayload(): Record<string, unknown> {
  return {
    dateRangeEnd: '2026-06-27',
    dateRangeStart: '2026-06-25',
    name: 'June delivery group',
    orderIds: ['order-1', 'order-2']
  };
}
