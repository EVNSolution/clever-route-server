import { describe, expect, test } from 'vitest';

import { withWorkspaceQuery } from '../src/api';
import { buildOrderQuery, createDefaultOrderFilters, deriveRouteStats, geometryLabel, hideSetupActions, mapReadiness, moveStop, moveStopBefore, summarizeSelection } from '../src/state';
import type { BootstrapPayload, CanonicalOrderDto, RoutePlanDetailDto, RouteStopDto } from '../src/types';

describe('route ops web state helpers', () => {
  test('serializes order filters without empty/all values', () => {
    expect(buildOrderQuery({ deliveryArea: 'Toronto', deliveryDate: '2026-05-27', deliveryStatus: 'all', health: '', search: '#1001', status: 'planned' })).toBe('deliveryDate=2026-05-27&deliveryArea=Toronto&status=planned&search=%231001');
  });

  test('shows imported unplanned orders by default instead of hiding them behind today filter', () => {
    expect(buildOrderQuery(createDefaultOrderFilters())).toBe('status=unplanned');
  });



  test('carries the current shop domain into Route Ops API calls for internal admin sessions', () => {
    expect(withWorkspaceQuery('/admin/ui/app/api/orders?deliveryDate=2026-05-27', '?shopDomain=tenant.example.test')).toBe(
      '/admin/ui/app/api/orders?deliveryDate=2026-05-27&shopDomain=tenant.example.test'
    );
    expect(withWorkspaceQuery('/admin/ui/app/api/routes?shopDomain=explicit.example.test', '?shopDomain=tenant.example.test')).toBe(
      '/admin/ui/app/api/routes?shopDomain=explicit.example.test'
    );
    expect(withWorkspaceQuery('/admin/ui/app/api/bootstrap', '')).toBe('/admin/ui/app/api/bootstrap');
  });

  test('summarizes selected ready orders and blockers', () => {
    const orders = [order({ orderId: 'ready' }), order({ blockerReasons: ['missing_coordinates'], orderId: 'blocked', planningStatus: 'UNPLANNED' })];
    const result = summarizeSelection(orders, new Set(['ready', 'blocked']));
    expect(result.readySelected.map((item) => item.orderId)).toEqual(['ready']);
    expect(result.blockers).toEqual(['#1001: missing_coordinates']);
  });

  test('moves stops using keyboard-compatible reorder helper', () => {
    const stops = [stop('a', 1), stop('b', 2), stop('c', 3)];
    expect(moveStop(stops, 'b', -1).map((item) => `${item.deliveryStopId}:${item.sequence}`)).toEqual(['b:1', 'a:2', 'c:3']);
    expect(moveStop(stops, 'c', 1)).toBe(stops);
  });



  test('supports drag/drop stop insertion before a target stop', () => {
    const stops = [stop('a', 1), stop('b', 2), stop('c', 3), stop('d', 4)];
    expect(moveStopBefore(stops, 'd', 'b').map((item) => `${item.deliveryStopId}:${item.sequence}`)).toEqual(['a:1', 'd:2', 'b:3', 'c:4']);
    expect(moveStopBefore(stops, 'b', 'd').map((item) => `${item.deliveryStopId}:${item.sequence}`)).toEqual(['a:1', 'c:2', 'b:3', 'd:4']);
    expect(moveStopBefore(stops, 'x', 'd')).toBe(stops);
  });

  test('derives route stats and geometry labels honestly', () => {
    const detail: RoutePlanDetailDto = {
      routeGeometry: null,
      routePlan: {
        createdAt: '',
        deliveryAreas: [],
        deliveryDate: '2026-05-27',
        depot: { latitude: 43.7, longitude: -79.4 },
        driverId: null,
        id: 'route-1',
        missingCoordinates: 1,
        name: 'Route 1',
        planDate: '2026-05-27',
        status: 'DRAFT',
        stopsCount: 2,
        updatedAt: ''
      },
      routeStopPoints: [],
      stops: [stop('a', 1, 'COMPLETED'), stop('b', 2, 'ATTEMPTED', null, null)]
    };
    expect(deriveRouteStats(detail)).toEqual({ attempted: 1, completed: 1, missingCoordinates: 1, stops: 2 });
    expect(geometryLabel(detail, 'not_configured')).toBe('Sequence preview');
    expect(geometryLabel({ ...detail, routeGeometry: { coordinates: [[-79, 43]], type: 'LineString' } }, 'configured')).toBe('Road geometry');
  });

  test('keeps map/provider states explicit and plugin mode hides setup actions', () => {
    expect(mapReadiness({ coordinatesCount: 0, mapStatus: 'configured' })).toBe('no_coordinates');
    expect(mapReadiness({ coordinatesCount: 3, mapStatus: 'not_configured' })).toBe('provider_not_configured');
    expect(mapReadiness({ coordinatesCount: 3, mapStatus: 'configured' })).toBe('interactive_map');
    expect(hideSetupActions(bootstrap('plugin'))).toBe(true);
    expect(hideSetupActions(bootstrap('internal-admin'))).toBe(false);
  });
});

function order(overrides: Partial<CanonicalOrderDto> = {}): CanonicalOrderDto {
  return {
    blockerReasons: [],
    coordinates: { latitude: 43.6, longitude: -79.3 },
    deliveryArea: 'Toronto',
    deliveryDate: '2026-05-27',
    deliverySession: 'DAY',
    deliveryStatus: 'ready',
    health: 'normal',
    orderId: 'order-1',
    orderName: '#1001',
    phone: null,
    planningStatus: 'UNPLANNED',
    recipientName: 'Customer',
    routePlanId: null,
    routePlanName: null,
    sourceOrderId: '1001',
    sourceOrderNumber: '1001',
    sourcePlatform: 'WOOCOMMERCE',
    status: 'unfulfilled',
    stopId: 'stop-1',
    ...overrides
  };
}

function stop(deliveryStopId: string, sequence: number, status = 'PENDING', latitude: number | null = 43.6, longitude: number | null = -79.3): RouteStopDto {
  return {
    addressLabel: '100 King St W, Toronto, ON',
    coordinates: { latitude, longitude },
    deliveryArea: 'Toronto',
    deliveryStopId,
    orderId: `order-${deliveryStopId}`,
    orderName: `#100${sequence}`,
    recipientName: 'Customer',
    sequence,
    sourceOrderId: `source-${deliveryStopId}`,
    status
  };
}

function bootstrap(mode: BootstrapPayload['mode']): BootstrapPayload {
  return {
    appUrls: { dashboard: '', drivers: '', orders: '', routes: '', settings: '' },
    csrfToken: 'csrf',
    mapConfig: { allowedHosts: [], attribution: null, providerMode: null, status: 'not_configured', styleAudit: null, styleUrl: null },
    mode,
    routerConfig: { status: 'not_configured' },
    shopDomain: 'tenant.example.test'
  };
}
