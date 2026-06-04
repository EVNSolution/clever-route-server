import { describe, expect, test, vi } from 'vitest';

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
    routeStop({ sequence: 1, latitude: 43.7764, longitude: -79.2571 }),
    routeStop({ sequence: 2, latitude: 43.8561, longitude: -79.3370 })
  ],
  routeGeometry: null,
  routeStopPoints: []
} satisfies RoutePlanDetail;

describe('RoutePlanAdminService route geometry', () => {
  test('enriches route detail with OSRM geometry using depot and ordered stops', async () => {
    const { repository, routeGeometryProvider } = createHarness(routePlanDetail);
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    const detail = await service.getRoutePlanDetail({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(routeGeometryProvider.buildRoute).toHaveBeenCalledWith({
      routePlan: routePlanDetail.routePlan,
      stops: routePlanDetail.stops,
      routeGeometry: null,
      routeStopPoints: []
    });
    expect(detail?.routeGeometry).toEqual({
      type: 'LineString',
      coordinates: [
        [-79.3832, 43.6532],
        [-79.2571, 43.7764],
        [-79.337, 43.8561]
      ]
    });
    expect(detail?.routeStopPoints).toEqual([
      expect.objectContaining({
        deliveryStopId: 'stop-1',
        sequence: 1,
        snappedCoordinates: [-79.2572, 43.7765]
      }),
      expect.objectContaining({
        deliveryStopId: 'stop-2',
        sequence: 2,
        snappedCoordinates: [-79.3372, 43.8562]
      })
    ]);
  });

  test('returns route detail without failing when route geometry generation fails', async () => {
    const { repository, routeGeometryProvider } = createHarness(routePlanDetail);
    routeGeometryProvider.buildRoute.mockRejectedValueOnce(new Error('OSRM unavailable'));
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    const detail = await service.getRoutePlanDetail({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(detail?.routePlan.id).toBe('route-plan-id');
    expect(detail?.routeGeometry).toBeNull();
    expect(detail?.routeStopPoints).toEqual([]);
  });

  test('enriches updated route stops with OSRM geometry after repository save', async () => {
    const { repository, routeGeometryProvider, updateRoutePlanStops } = createHarness(routePlanDetail);
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

    expect(updateRoutePlanStops).toHaveBeenCalledWith({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: {
        stops: [
          { shopifyOrderGid: 'gid://shopify/Order/102', sequence: 1 },
          { shopifyOrderGid: 'gid://shopify/Order/101', sequence: 2 }
        ]
      }
    });
    expect(routeGeometryProvider.buildRoute).toHaveBeenCalledWith(routePlanDetail);
    expect(detail?.routeGeometry).toEqual({
      type: 'LineString',
      coordinates: [
        [-79.3832, 43.6532],
        [-79.2571, 43.7764],
        [-79.337, 43.8561]
      ]
    });
    expect(detail?.routeStopPoints).toEqual([
      expect.objectContaining({
        deliveryStopId: 'stop-1',
        sequence: 1,
        snappedCoordinates: [-79.2572, 43.7765]
      }),
      expect.objectContaining({
        deliveryStopId: 'stop-2',
        sequence: 2,
        snappedCoordinates: [-79.3372, 43.8562]
      })
    ]);
  });

  test('enriches assigned route drivers with OSRM geometry after repository save', async () => {
    const { assignRoutePlanDriver, repository, routeGeometryProvider } = createHarness(routePlanDetail);
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
    expect(routeGeometryProvider.buildRoute).toHaveBeenCalledWith(routePlanDetail);
    expect(detail?.routeGeometry).toEqual({
      type: 'LineString',
      coordinates: [
        [-79.3832, 43.6532],
        [-79.2571, 43.7764],
        [-79.337, 43.8561]
      ]
    });
    expect(detail?.routeStopPoints).toEqual([
      expect.objectContaining({
        deliveryStopId: 'stop-1',
        sequence: 1,
        snappedCoordinates: [-79.2572, 43.7765]
      }),
      expect.objectContaining({
        deliveryStopId: 'stop-2',
        sequence: 2,
        snappedCoordinates: [-79.3372, 43.8562]
      })
    ]);
  });

  test('enriches published route detail with OSRM geometry after repository publish', async () => {
    const { publishRoutePlan, repository, routeGeometryProvider } = createHarness(routePlanDetail);
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    const detail = await service.publishRoutePlan({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });

    expect(publishRoutePlan).toHaveBeenCalledWith({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com'
    });
    expect(routeGeometryProvider.buildRoute).toHaveBeenCalledWith(routePlanDetail);
    expect(detail?.routeGeometry).toEqual({
      type: 'LineString',
      coordinates: [
        [-79.3832, 43.6532],
        [-79.2571, 43.7764],
        [-79.337, 43.8561]
      ]
    });
    expect(detail?.routeStopPoints).toEqual([
      expect.objectContaining({
        deliveryStopId: 'stop-1',
        sequence: 1,
        snappedCoordinates: [-79.2572, 43.7765]
      }),
      expect.objectContaining({
        deliveryStopId: 'stop-2',
        sequence: 2,
        snappedCoordinates: [-79.3372, 43.8562]
      })
    ]);
  });

  test('enriches route option changes with rebuilt OSRM geometry', async () => {
    const { repository, routeGeometryProvider, updateRoutePlanOptions } = createHarness(routePlanDetail);
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    const detail = await service.updateRoutePlanOptions({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { routeEndMode: 'RETURN_TO_DEPOT' }
    });

    expect(updateRoutePlanOptions).toHaveBeenCalledWith({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { routeEndMode: 'RETURN_TO_DEPOT' }
    });
    expect(routeGeometryProvider.buildRoute).toHaveBeenCalledWith(routePlanDetail);
    expect(detail?.routeGeometry).toEqual({
      type: 'LineString',
      coordinates: [
        [-79.3832, 43.6532],
        [-79.2571, 43.7764],
        [-79.337, 43.8561]
      ]
    });
  });

  test('returns updated route stops with null geometry and empty stop points when OSRM fails', async () => {
    const { repository, routeGeometryProvider } = createHarness(routePlanDetail);
    routeGeometryProvider.buildRoute.mockRejectedValueOnce(new Error('OSRM unavailable'));
    const service = new RoutePlanAdminService(repository, routeGeometryProvider);

    const detail = await service.updateRoutePlanStops({
      routePlanId: 'route-plan-id',
      shopDomain: 'example.myshopify.com',
      payload: { stops: [] }
    });

    expect(detail?.routePlan.id).toBe('route-plan-id');
    expect(detail?.routeGeometry).toBeNull();
    expect(detail?.routeStopPoints).toEqual([]);
  });
});

function createHarness(detail: RoutePlanDetail): {
  assignRoutePlanDriver: ReturnType<typeof vi.fn<RoutePlanRepository['assignRoutePlanDriver']>>;
  publishRoutePlan: ReturnType<typeof vi.fn<RoutePlanRepository['publishRoutePlan']>>;
  repository: RoutePlanRepository;
  routeGeometryProvider: {
    buildRoute: ReturnType<typeof vi.fn<RouteGeometryProvider['buildRoute']>>;
  };
  updateRoutePlanOptions: ReturnType<typeof vi.fn<RoutePlanRepository['updateRoutePlanOptions']>>;
  updateRoutePlanStops: ReturnType<typeof vi.fn<RoutePlanRepository['updateRoutePlanStops']>>;
} {
  const assignRoutePlanDriver = vi.fn<RoutePlanRepository['assignRoutePlanDriver']>().mockResolvedValue(detail);
  const publishRoutePlan = vi.fn<RoutePlanRepository['publishRoutePlan']>().mockResolvedValue(detail);
  const updateRoutePlanOptions = vi.fn<RoutePlanRepository['updateRoutePlanOptions']>().mockResolvedValue(detail);
  const updateRoutePlanStops = vi.fn<RoutePlanRepository['updateRoutePlanStops']>().mockResolvedValue(detail);
  const repository = {
    assignRoutePlanDriver,
    createRoutePlanDraft: vi.fn(),
    deleteRoutePlan: vi.fn(),
    findRoutePlanDetail: vi.fn().mockResolvedValue(detail),
    listRoutePlans: vi.fn(),
    publishRoutePlan,
    updateRoutePlanOptions,
    updateRoutePlanStops
  } satisfies RoutePlanRepository;

  const routeGeometryProvider = {
    buildRoute: vi.fn<RouteGeometryProvider['buildRoute']>(() => Promise.resolve({
      routeGeometry: {
        type: 'LineString',
        coordinates: [
          [-79.3832, 43.6532],
          [-79.2571, 43.7764],
          [-79.337, 43.8561]
        ]
      } satisfies RoutePlanRouteGeometry,
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
    } satisfies RoutePlanRouteResult))
  };

  return { assignRoutePlanDriver, publishRoutePlan, repository, routeGeometryProvider, updateRoutePlanOptions, updateRoutePlanStops };
}

function routeStop(input: { latitude: number; longitude: number; sequence: number }): RoutePlanDetail['stops'][number] {
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
    deliveryStopId: `stop-${input.sequence}`,
    financialStatus: 'PAID',
    fulfillmentStatus: 'OPEN',
    orderId: `order-${input.sequence}`,
    orderName: `#10${input.sequence}`,
    paymentStatus: 'PAID',
    recipientName: 'Customer',
    sequence: input.sequence,
    shopifyOrderGid: `gid://shopify/Order/10${input.sequence}`,
    status: 'PENDING'
  };
}
