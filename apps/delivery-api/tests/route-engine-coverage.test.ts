import { describe, expect, test, vi } from 'vitest';

import {
  CoverageAwareRouteGeometryProvider,
  CoverageAwareRouteOptimizationService,
  readConfiguredCoverageBaseUrls,
  readRouteEngineRegistrySummary,
  selectCoverageForRoutePlan,
} from '../src/modules/route-plans/route-engine-coverage.js';
import type { RoutePlanDetail } from '../src/modules/route-plans/route-plan.types.js';
import type { RouteOptimizationService } from '../src/modules/route-plans/route-optimization.types.js';

type DiagnosticOptimizer = RouteOptimizationService & {
  optimizeStopOrderWithDiagnostics: NonNullable<RouteOptimizationService['optimizeStopOrderWithDiagnostics']>;
};

describe('route engine coverage registry', () => {
  test('selects Korea when every valid route point is in the Korea coverage bounds', () => {
    const selection = selectCoverageForRoutePlan(koreaDetail(), ['ontario', 'korea'], 'korea');

    expect(selection).toEqual({ coverage: 'korea', ok: true });
  });

  test('fails closed when a route spans multiple configured coverages', async () => {
    const koreaService = fakeOptimizationService();
    const ontarioService = fakeOptimizationService();
    const service = new CoverageAwareRouteOptimizationService({
      services: { korea: koreaService, ontario: ontarioService },
    });

    const outcome = await service.optimizeStopOrderWithDiagnostics({
      detail: mixedKoreaOntarioDetail(),
      shopDomain: 'tenant-a.example.test',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected mixed coverage failure');
    expect(outcome.failure.code).toBe('invalid_input');
    expect(outcome.failure.message).toContain('multiple configured routing coverages');
    expect(koreaService.optimizeStopOrderWithDiagnostics).not.toHaveBeenCalled();
    expect(ontarioService.optimizeStopOrderWithDiagnostics).not.toHaveBeenCalled();
  });

  test('routes geometry requests to the selected coverage provider', async () => {
    const koreaProvider = { buildRoute: vi.fn().mockResolvedValue(routeResult()) };
    const ontarioProvider = { buildRoute: vi.fn().mockResolvedValue(routeResult()) };
    const provider = new CoverageAwareRouteGeometryProvider({
      defaultCoverage: 'korea',
      providers: { korea: koreaProvider, ontario: ontarioProvider },
    });

    await expect(provider.buildRoute(koreaDetail())).resolves.toEqual(routeResult());

    expect(koreaProvider.buildRoute).toHaveBeenCalledTimes(1);
    expect(ontarioProvider.buildRoute).not.toHaveBeenCalled();
  });

  test('keeps legacy single-url env compatible while allowing explicit Korea addition', () => {
    expect(readRouteEngineRegistrySummary({
      OSRM_BASE_URL: 'http://osrm-ontario:5000',
      ROUTE_OPS_ROUTER_COVERAGE: 'ontario',
    })).toEqual({
      coverage: 'ontario',
      provider: 'osrm',
      status: 'configured',
    });

    expect(readConfiguredCoverageBaseUrls({
      OSRM_BASE_URL: 'http://osrm-ontario:5000',
      OSRM_KOREA_BASE_URL: 'http://osrm-korea:5000',
      ROUTE_OPS_ROUTER_COVERAGE: 'ontario',
    }, 'OSRM')).toEqual({
      korea: 'http://osrm-korea:5000',
      ontario: 'http://osrm-ontario:5000',
    });
  });

  test('summarizes multi-coverage router state without exposing private engine URLs', () => {
    const summary = readRouteEngineRegistrySummary({
      OSRM_DEFAULT_COVERAGE: 'korea',
      OSRM_KOREA_BASE_URL: 'http://osrm-korea:5000',
      OSRM_ONTARIO_BASE_URL: 'http://osrm-ontario:5000',
    });

    expect(summary).toEqual({
      coverage: 'korea',
      coverages: ['ontario', 'korea'],
      provider: 'osrm',
      status: 'configured',
    });
    expect(JSON.stringify(summary)).not.toContain('osrm-korea');
    expect(JSON.stringify(summary)).not.toContain('5000');
  });
});

function fakeOptimizationService(): DiagnosticOptimizer {
  return {
    optimizeStopOrder: vi.fn().mockResolvedValue(null),
    optimizeStopOrderWithDiagnostics: vi.fn().mockResolvedValue({
      ok: true,
      result: { missingCoordinateStops: 0, source: 'vroom', stops: [] },
    }),
  };
}

function routeResult() {
  return {
    routeGeometry: null,
    routeMetrics: null,
    routeStopPoints: [],
  };
}

function koreaDetail(): RoutePlanDetail {
  return routeDetail({
    depot: { latitude: 37.5665, longitude: 126.978 },
    stops: [
      { latitude: 37.4979, longitude: 127.0276 },
      { latitude: 37.5519, longitude: 126.9918 },
    ],
  });
}

function mixedKoreaOntarioDetail(): RoutePlanDetail {
  return routeDetail({
    depot: { latitude: 37.5665, longitude: 126.978 },
    stops: [
      { latitude: 43.6532, longitude: -79.3832 },
    ],
  });
}

function routeDetail(input: {
  depot: { latitude: number; longitude: number };
  stops: Array<{ latitude: number; longitude: number }>;
}): RoutePlanDetail {
  return {
    routeGeometry: null,
    routeMetrics: null,
    routePlan: {
      createdAt: '2026-07-06T00:00:00.000Z',
      deliveryAreas: [],
      deliveryDays: [],
      depot: input.depot,
      id: 'route-plan-id',
      missingCoordinates: 0,
      name: 'Coverage route',
      planDate: '2026-07-06',
      routeEndMode: 'END_AT_LAST_STOP',
      status: 'DRAFT',
      stopsCount: input.stops.length,
      updatedAt: '2026-07-06T00:00:00.000Z',
    },
    routeStopPoints: [],
    stops: input.stops.map((coordinates, index) => ({
      address: {
        address1: '123 Test Street',
        address2: null,
        city: 'Test City',
        countryCode: index === 0 ? 'KR' : 'CA',
        postalCode: '00000',
        province: null,
      },
      attributes: [],
      coordinates,
      deliveryArea: null,
      deliveryDay: null,
      deliveryStopId: `stop-${index + 1}`,
      financialStatus: 'paid',
      fulfillmentStatus: null,
      orderId: `order-${index + 1}`,
      orderName: `#${index + 1}`,
      paymentStatus: 'PAID',
      recipientName: 'Recipient',
      sequence: index + 1,
      shopifyOrderGid: `gid://shopify/Order/${index + 1}`,
      sourceCreatedAt: null,
      status: 'UNASSIGNED',
    })),
  };
}
