import { describe, expect, test, vi } from 'vitest';

import { RouteOptimizationJobActiveError } from '../src/modules/route-plans/route-optimization-job.types.js';
import { computeRouteShapeSignature } from '../src/modules/route-plans/route-plan-geometry-cache.js';
import { RoutePlanAdminService } from '../src/modules/route-plans/route-plan.service.js';
import type { RouteGeometryProvider, RoutePlanRepository } from '../src/modules/route-plans/route-plan.service.js';
import type {
  RoutePlanDetail,
  RoutePlanRouteGeometry,
  RoutePlanRouteResult
} from '../src/modules/route-plans/route-plan.types.js';

const routePlanDetail = {
  routePlan: {
    createdAt: '2026-05-07T12:30:00.000Z',
    deliveryAreas: ['Scarborough'],
    deliveryDays: ['Friday'],
    depot: { latitude: 43.6532, longitude: -79.3832 },
    id: 'route-plan-id',
    missingCoordinates: 0,
    name: 'Friday route',
    planDate: '2026-05-15',
    routeEndMode: 'END_AT_LAST_STOP',
    status: 'DRAFT',
    stopsCount: 2,
    updatedAt: '2026-05-07T12:30:00.000Z'
  },
  stops: [
    routeStop({ sequence: 1, latitude: 43.7764, longitude: -79.2571, order: 101 }),
    routeStop({ sequence: 2, latitude: 43.8561, longitude: -79.3370, order: 102 })
  ],
  routeGeometry: null,
  routeGeometryGeneratedAt: null,
  routeGeometrySource: null,
  routeGeometryStatus: 'missing',
  routeMetrics: null,
  routeShapeSignature: '',
  routeStopPoints: []
} satisfies RoutePlanDetail;

function detailWithComputedSignature(detail: RoutePlanDetail): RoutePlanDetail {
  return { ...detail, routeShapeSignature: computeRouteShapeSignature(detail) };
}

const baseDetail = detailWithComputedSignature(routePlanDetail);

const changedShapeDetail = detailWithComputedSignature({
  ...baseDetail,
  stops: [
    routeStop({ sequence: 1, latitude: 43.8561, longitude: -79.3370, order: 102 }),
    routeStop({ sequence: 2, latitude: 43.7764, longitude: -79.2571, order: 101 })
  ]
});

describe('RoutePlanAdminService route geometry policy', () => {
  test('route detail read returns repository detail without OSRM generation', async () => {
    const { findRoutePlanDetail, repository, routeGeometryProvider } = createHarness(baseDetail);
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    const detail = await service.getRoutePlanDetail({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(findRoutePlanDetail).toHaveBeenCalledWith({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });
    expect(routeGeometryProvider.buildRoute).not.toHaveBeenCalled();
    expect(detail).toEqual(baseDetail);
  });

  test('cheap route existence uses repository routePlanExists without loading route detail', async () => {
    const { findRoutePlanDetail, repository, routePlanExists } = createHarness(baseDetail);
    const service = new RoutePlanAdminService(repository);

    await expect(service.routePlanExists({ routePlanId: 'route-plan-id', shopDomain: 'example.myshopify.com' })).resolves.toBe(true);

    expect(routePlanExists).toHaveBeenCalledWith({ routePlanId: 'route-plan-id', shopDomain: 'example.myshopify.com' });
    expect(findRoutePlanDetail).not.toHaveBeenCalled();
  });

  test('driver assignment does not call OSRM because it is not a shape mutation', async () => {
    const { assignRoutePlanDriver, repository, routeGeometryProvider } = createHarness(baseDetail);
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    const detail = await service.assignRoutePlanDriver({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { driverId: 'driver-id' }
    });

    expect(assignRoutePlanDriver).toHaveBeenCalledWith({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { driverId: 'driver-id' }
    });
    expect(routeGeometryProvider.buildRoute).not.toHaveBeenCalled();
    expect(detail).toEqual(baseDetail);
  });

  test('publish does not call OSRM because it is not a shape mutation', async () => {
    const { publishRoutePlan, repository, routeGeometryProvider } = createHarness(baseDetail);
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    await service.publishRoutePlan({ routePlanId: 'route-plan-id', shopDomain: 'example.myshopify.com' });

    expect(publishRoutePlan).toHaveBeenCalledWith({ routePlanId: 'route-plan-id', shopDomain: 'example.myshopify.com' });
    expect(routeGeometryProvider.buildRoute).not.toHaveBeenCalled();
  });

  test('shape mutation refreshes and persists geometry only when shape signature changes', async () => {
    const { repository, routeGeometryProvider, updateRoutePlanStops, upsertRouteGeometryCache } = createHarness(baseDetail, {
      updateRoutePlanStopsDetail: changedShapeDetail
    });
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    const detail = await service.updateRoutePlanStops({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: {
        stops: [
          { shopifyOrderGid: 'gid://shopify/Order/102', sequence: 1 },
          { shopifyOrderGid: 'gid://shopify/Order/101', sequence: 2 }
        ]
      }
    });

    expect(updateRoutePlanStops).toHaveBeenCalled();
    expect(routeGeometryProvider.buildRoute).toHaveBeenCalledWith(changedShapeDetail);
    expect(upsertRouteGeometryCache).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'osrm',
      routePlanId: 'route-plan-id',
      shapeSignature: computeRouteShapeSignature(changedShapeDetail),
      source: 'SHAPE_MUTATION'
    }));
    expect(detail?.routeGeometry).toEqual(routeResult.routeGeometry);
    expect(detail?.routeGeometryStatus).toBe('fresh');
  });

  test('shape endpoint does not refresh geometry when before and after shape signatures match', async () => {
    const { repository, routeGeometryProvider, upsertRouteGeometryCache } = createHarness(baseDetail, {
      updateRoutePlanOptionsDetail: baseDetail
    });
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    const detail = await service.updateRoutePlanOptions({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { routeEndMode: 'END_AT_LAST_STOP' }
    });

    expect(routeGeometryProvider.buildRoute).not.toHaveBeenCalled();
    expect(upsertRouteGeometryCache).not.toHaveBeenCalled();
    expect(detail).toEqual(baseDetail);
  });

  test('aggregate driver-only save does not call OSRM even though it shares the route save endpoint', async () => {
    const { repository, routeGeometryProvider, saveRoutePlan, upsertRouteGeometryCache } = createHarness(baseDetail);
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    await service.saveRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { driverId: 'driver-id' }
    });

    expect(saveRoutePlan).toHaveBeenCalledWith({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { driverId: 'driver-id' }
    });
    expect(routeGeometryProvider.buildRoute).not.toHaveBeenCalled();
    expect(upsertRouteGeometryCache).not.toHaveBeenCalled();
  });

  test('create route refreshes geometry as explicit route work', async () => {
    const { createRoutePlanDraft, repository, routeGeometryProvider, upsertRouteGeometryCache } = createHarness(baseDetail);
    createRoutePlanDraft.mockResolvedValueOnce(baseDetail.routePlan);
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    const summary = await service.createRoutePlan({
      createdBy: 'admin',
      shopDomain: 'example.myshopify.com',
      payload: {
        depot: { address: null, latitude: 43.6532, longitude: -79.3832 },
        name: 'Friday route',
        orders: [],
        planDate: '2026-05-15'
      }
    });

    expect(summary.id).toBe('route-plan-id');
    expect(routeGeometryProvider.buildRoute).toHaveBeenCalledWith(baseDetail);
    expect(upsertRouteGeometryCache).toHaveBeenCalledWith(expect.objectContaining({
      routePlanId: 'route-plan-id',
      source: 'CREATE_ROUTE'
    }));
  });

  test('returns unavailable geometry without overwriting cache when explicit OSRM refresh fails', async () => {
    const { repository, routeGeometryProvider, upsertRouteGeometryCache } = createHarness(baseDetail, {
      updateRoutePlanStopsDetail: changedShapeDetail
    });
    routeGeometryProvider.buildRoute.mockRejectedValueOnce(new Error('OSRM unavailable'));
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    const detail = await service.updateRoutePlanStops({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { stops: [] }
    });

    expect(detail?.routePlan.id).toBe('route-plan-id');
    expect(detail?.routeGeometry).toBeNull();
    expect(detail?.routeGeometryStatus).toBe('unavailable');
    expect(detail?.routeMetrics).toBeNull();
    expect(detail?.routeStopPoints).toEqual([]);
    expect(upsertRouteGeometryCache).not.toHaveBeenCalled();
  });

  test('blocks user route stop mutation while an optimization job is active', async () => {
    const { repository, updateRoutePlanStops } = createHarness(baseDetail);
    const routeOptimizationJobGuard = {
      findLatestJob: vi.fn().mockResolvedValue({ status: 'RUNNING' }),
      reconcileStaleActiveJobs: vi.fn().mockResolvedValue([])
    };
    const service = new RoutePlanAdminService(repository, undefined, routeOptimizationJobGuard);

    await expect(service.updateRoutePlanStops({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { stops: [] }
    })).rejects.toBeInstanceOf(RouteOptimizationJobActiveError);

    expect(routeOptimizationJobGuard.reconcileStaleActiveJobs).toHaveBeenCalledWith({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });
    expect(updateRoutePlanStops).not.toHaveBeenCalled();
  });

  test('blocks route option changes while an optimization job is active', async () => {
    const { repository, updateRoutePlanOptions } = createHarness(baseDetail);
    const routeOptimizationJobGuard = {
      findLatestJob: vi.fn().mockResolvedValue({ status: 'RUNNING' }),
      reconcileStaleActiveJobs: vi.fn().mockResolvedValue([])
    };
    const service = new RoutePlanAdminService(repository, undefined, routeOptimizationJobGuard);

    await expect(service.updateRoutePlanOptions({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { routeEndMode: 'RETURN_TO_DEPOT' }
    })).rejects.toBeInstanceOf(RouteOptimizationJobActiveError);

    expect(routeOptimizationJobGuard.reconcileStaleActiveJobs).toHaveBeenCalledWith({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });
    expect(updateRoutePlanOptions).not.toHaveBeenCalled();
  });

  test('allows job-owned route stop apply while an optimization job is active', async () => {
    const { repository, routeGeometryProvider, updateRoutePlanStops } = createHarness(baseDetail, {
      updateRoutePlanStopsDetail: changedShapeDetail
    });
    const routeOptimizationJobGuard = {
      findLatestJob: vi.fn().mockResolvedValue({ status: 'RUNNING' }),
      reconcileStaleActiveJobs: vi.fn().mockResolvedValue([])
    };
    const service = new RoutePlanAdminService(repository, routeGeometryProvider, routeOptimizationJobGuard);

    await service.updateRoutePlanStops({
      mutationContext: { jobId: 'job-id', source: 'route_optimization_job' },
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { stops: [] }
    });

    expect(routeOptimizationJobGuard.findLatestJob).not.toHaveBeenCalled();
    expect(updateRoutePlanStops).toHaveBeenCalled();
    expect(routeGeometryProvider.buildRoute).toHaveBeenCalledWith(changedShapeDetail);
  });

  test('blocks aggregate route save with stops while an optimization job is queued', async () => {
    const { repository, saveRoutePlan } = createHarness(baseDetail);
    const routeOptimizationJobGuard = {
      findLatestJob: vi.fn().mockResolvedValue({ status: 'QUEUED' }),
      reconcileStaleActiveJobs: vi.fn().mockResolvedValue([])
    };
    const service = new RoutePlanAdminService(repository, undefined, routeOptimizationJobGuard);

    await expect(service.saveRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { stops: [] }
    })).rejects.toBeInstanceOf(RouteOptimizationJobActiveError);

    expect(saveRoutePlan).not.toHaveBeenCalled();
  });

  test('blocks aggregate route save with driver changes while an optimization job is queued', async () => {
    const { repository, saveRoutePlan } = createHarness(baseDetail);
    const routeOptimizationJobGuard = {
      findLatestJob: vi.fn().mockResolvedValue({ status: 'QUEUED' }),
      reconcileStaleActiveJobs: vi.fn().mockResolvedValue([])
    };
    const service = new RoutePlanAdminService(repository, undefined, routeOptimizationJobGuard);

    await expect(service.saveRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { driverId: 'driver-id' }
    })).rejects.toBeInstanceOf(RouteOptimizationJobActiveError);

    expect(saveRoutePlan).not.toHaveBeenCalled();
  });
});

function createHarness(detail: RoutePlanDetail, options: {
  updateRoutePlanOptionsDetail?: RoutePlanDetail;
  updateRoutePlanStopsDetail?: RoutePlanDetail;
} = {}): {
  assignRoutePlanDriver: ReturnType<typeof vi.fn<RoutePlanRepository['assignRoutePlanDriver']>>;
  createRoutePlanDraft: ReturnType<typeof vi.fn<RoutePlanRepository['createRoutePlanDraft']>>;
  publishRoutePlan: ReturnType<typeof vi.fn<RoutePlanRepository['publishRoutePlan']>>;
  findRoutePlanDetail: ReturnType<typeof vi.fn<RoutePlanRepository['findRoutePlanDetail']>>;
  repository: RoutePlanRepository;
  routeGeometryProvider: {
    buildRoute: ReturnType<typeof vi.fn<RouteGeometryProvider['buildRoute']>>;
  };
  routePlanExists: ReturnType<typeof vi.fn<NonNullable<RoutePlanRepository['routePlanExists']>>>;
  saveRoutePlan: ReturnType<typeof vi.fn<RoutePlanRepository['saveRoutePlan']>>;
  updateRoutePlanOptions: ReturnType<typeof vi.fn<RoutePlanRepository['updateRoutePlanOptions']>>;
  updateRoutePlanStops: ReturnType<typeof vi.fn<RoutePlanRepository['updateRoutePlanStops']>>;
  upsertRouteGeometryCache: ReturnType<typeof vi.fn<NonNullable<RoutePlanRepository['upsertRouteGeometryCache']>>>;
} {
  const assignRoutePlanDriver = vi.fn<RoutePlanRepository['assignRoutePlanDriver']>().mockResolvedValue(detail);
  const createRoutePlanDraft = vi.fn<RoutePlanRepository['createRoutePlanDraft']>().mockResolvedValue(detail.routePlan);
  const publishRoutePlan = vi.fn<RoutePlanRepository['publishRoutePlan']>().mockResolvedValue(detail);
  const saveRoutePlan = vi.fn<RoutePlanRepository['saveRoutePlan']>().mockResolvedValue({
    detail,
    operations: [
      { name: 'options', reason: 'unchanged', status: 'skipped' },
      { name: 'stops', reason: 'unchanged', status: 'skipped' },
      { name: 'driver', reason: 'not_provided', status: 'skipped' },
      { name: 'publish', reason: 'missing_driver', status: 'skipped' }
    ]
  });
  const updateRoutePlanOptions = vi.fn<RoutePlanRepository['updateRoutePlanOptions']>().mockResolvedValue(options.updateRoutePlanOptionsDetail ?? detail);
  const updateRoutePlanStops = vi.fn<RoutePlanRepository['updateRoutePlanStops']>().mockResolvedValue(options.updateRoutePlanStopsDetail ?? detail);
  const routePlanExists = vi.fn<NonNullable<RoutePlanRepository['routePlanExists']>>().mockResolvedValue(true);
  const findRoutePlanDetail = vi.fn<RoutePlanRepository['findRoutePlanDetail']>().mockResolvedValue(detail);
  const upsertRouteGeometryCache = vi.fn<NonNullable<RoutePlanRepository['upsertRouteGeometryCache']>>().mockResolvedValue(undefined);
  const repository = {
    assignRoutePlanDriver,
    createRoutePlanDraft,
    deleteRoutePlan: vi.fn(),
    findRoutePlanDetail,
    listRoutePlans: vi.fn(),
    publishRoutePlan,
    routePlanExists,
    saveRoutePlan,
    updateRoutePlanOptions,
    updateRoutePlanStops,
    upsertRouteGeometryCache
  } satisfies RoutePlanRepository;

  const routeGeometryProvider = {
    buildRoute: vi.fn<RouteGeometryProvider['buildRoute']>(() => Promise.resolve(routeResult))
  };

  return { assignRoutePlanDriver, createRoutePlanDraft, findRoutePlanDetail, publishRoutePlan, repository, routeGeometryProvider, routePlanExists, saveRoutePlan, updateRoutePlanOptions, updateRoutePlanStops, upsertRouteGeometryCache };
}

const routeResult = {
  routeGeometry: {
    type: 'LineString',
    coordinates: [
      [-79.3832, 43.6532],
      [-79.2571, 43.7764],
      [-79.337, 43.8561]
    ]
  } satisfies RoutePlanRouteGeometry,
  routeMetrics: { distanceMeters: 12345.6, durationSeconds: 1800.5 },
  routeStopPoints: [
    {
      deliveryStopId: 'stop-1',
      inputCoordinates: [-79.2571, 43.7764],
      name: 'McCowan Road',
      sequence: 1,
      shopifyOrderGid: 'gid://shopify/Order/101',
      snapDistanceMeters: 12.3,
      snappedCoordinates: [-79.2572, 43.7765]
    },
    {
      deliveryStopId: 'stop-2',
      inputCoordinates: [-79.337, 43.8561],
      name: 'Yonge Street',
      sequence: 2,
      shopifyOrderGid: 'gid://shopify/Order/102',
      snapDistanceMeters: 54.16,
      snappedCoordinates: [-79.3372, 43.8562]
    }
  ]
} satisfies RoutePlanRouteResult;

function routeStop(input: { latitude: number; longitude: number; order: number; sequence: number }): RoutePlanDetail['stops'][number] {
  return {
    address: {
      address1: '200 Town Centre Ct',
      address2: null,
      city: 'Scarborough',
      countryCode: 'CA',
      postalCode: 'M1P 4Y7',
      province: 'ON'
    },
    attributes: [],
    coordinates: { latitude: input.latitude, longitude: input.longitude },
    deliveryArea: 'Scarborough',
    deliveryDay: 'Friday',
    deliveryStopId: `stop-${input.order === 101 ? 1 : 2}`,
    financialStatus: 'PAID',
    fulfillmentStatus: 'OPEN',
    orderId: `order-${input.order}`,
    orderName: `#${input.order}`,
    paymentStatus: 'PAID',
    recipientName: 'Customer',
    sequence: input.sequence,
    shopifyOrderGid: `gid://shopify/Order/${input.order}`,
    status: 'PENDING'
  };
}
