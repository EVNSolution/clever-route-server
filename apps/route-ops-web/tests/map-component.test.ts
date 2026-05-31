import { describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { resolveMapHomePoint, RouteOpsMap, syncOrdersLayer, syncRouteLayers } from '../src/components/maps/RouteOpsMap';
import { buildOrdersMapFeatureCollection, buildRouteGeometryFeature } from '../src/maps/geojson';
import type { BootstrapPayload, CanonicalOrderDto, RoutePlanDetailDto, RouteStopDto } from '../src/types';

describe('RouteOpsMap layer lifecycle', () => {
  test('updates the orders GeoJSON source to an empty collection instead of leaving stale pins', () => {
    const { map, sources } = createMapStub();
    const first = buildOrdersMapFeatureCollection([order({ orderId: 'order-1' })], new Set());
    const empty = buildOrdersMapFeatureCollection([], new Set());

    syncOrdersLayer(map, first);
    expect(sources.get('route-ops-orders')?.data).toEqual(first);

    syncOrdersLayer(map, empty);
    expect(sources.get('route-ops-orders')?.setData).toHaveBeenCalledWith(empty);
  });

  test('prefers the store depot as the Orders map home point over visible order coordinates', () => {
    const depot = { id: 'settings-store-depot', kind: 'depot' as const, label: 'Store', latitude: 43.78, longitude: -79.41 };
    const outOfAreaOrder = { id: 'order-1', kind: 'order' as const, label: '1', latitude: 42.98, longitude: -81.25 };

    expect(resolveMapHomePoint(null, depot, [depot, outOfAreaOrder])).toBe(depot);
    expect(resolveMapHomePoint(null, null, [outOfAreaOrder])).toBe(outOfAreaOrder);
  });

  test('renders Orders map pins without sequence labels', () => {
    const { layers, map } = createMapStub();
    const collection = buildOrdersMapFeatureCollection([order({ orderId: 'order-1', routePlanId: 'route-1' })], new Set());

    syncOrdersLayer(map, collection);

    const orderLayer = layers.get('route-ops-order-pins') as { layout?: Record<string, unknown> } | undefined;
    expect(orderLayer).toBeDefined();
    expect(orderLayer?.layout ?? {}).not.toHaveProperty('text-field');
    expect(orderLayer?.layout ?? {}).not.toHaveProperty('text-offset');
  });


  test('uses the Shopify Route Builder red road-geometry line theme', () => {
    const { layers, map } = createMapStub();
    const line = buildRouteGeometryFeature(routeDetail());
    expect(line).not.toBeNull();

    syncRouteLayers(map, line);

    expect((layers.get('route-ops-route-line') as { paint?: Record<string, unknown> } | undefined)?.paint).toEqual({
      'line-color': '#e11900',
      'line-dasharray': [1, 0],
      'line-opacity': 0.78,
      'line-width': 4
    });
  });

  test('clears the route line source when route geometry becomes unavailable', () => {
    const { map, sources } = createMapStub();
    const line = buildRouteGeometryFeature(routeDetail());
    expect(line).not.toBeNull();

    syncRouteLayers(map, line);
    expect(sources.get('route-ops-route-line')?.data).toEqual(line);

    syncRouteLayers(map, null);
    expect(sources.get('route-ops-route-line')?.setData).toHaveBeenCalledWith({ features: [], type: 'FeatureCollection' });
  });

  test('does not draw a synthetic route polyline in provider fallback preview', () => {
    const detail = routeDetail({
      routeGeometry: null,
      stops: [
        routeStop('stop-1', 1, 43.6, -79.3),
        routeStop('stop-2', 2, 43.7, -79.4)
      ]
    });

    const html = renderToStaticMarkup(createElement(RouteOpsMap, {
      bootstrap: bootstrapNotConfigured(),
      detail,
      subtitle: 'Preview',
      title: 'Route'
    }));

    expect(html).toContain('Marker-only coordinate preview');
    expect(html).not.toContain('<polyline');
    expect(html).not.toContain('route-line');
  });


  test('ignores MapLibre style teardown races during SPA tab navigation', () => {
    const map = createStyleTeardownMapStub();
    const collection = buildOrdersMapFeatureCollection([order({ orderId: 'order-1' })], new Set());
    const line = buildRouteGeometryFeature(routeDetail());

    expect(() => syncOrdersLayer(map, collection)).not.toThrow();
    expect(() => syncRouteLayers(map, line)).not.toThrow();
    expect(() => syncRouteLayers(map, null)).not.toThrow();
  });
});

function createMapStub(): {
  layers: Map<string, unknown>;
  map: Parameters<typeof syncOrdersLayer>[0] & Parameters<typeof syncRouteLayers>[0];
  sources: Map<string, { data: unknown; setData: ReturnType<typeof vi.fn> }>;
} {
  const sources = new Map<string, { data: unknown; setData: ReturnType<typeof vi.fn> }>();
  const layers = new Map<string, unknown>();
  const map = {
    addLayer: (layer: { id: string }) => {
      layers.set(layer.id, layer);
    },
    addSource: (id: string, source: { data: unknown }) => {
      sources.set(id, { data: source.data, setData: vi.fn() });
    },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => sources.get(id),
    setPaintProperty: vi.fn()
  } as unknown as Parameters<typeof syncOrdersLayer>[0];
  return { layers, map, sources };
}


function createStyleTeardownMapStub(): Parameters<typeof syncOrdersLayer>[0] & Parameters<typeof syncRouteLayers>[0] {
  const throwStyleTeardown = (): never => {
    throw new TypeError("undefined is not an object (evaluating 'this.style.getLayer')");
  };
  return {
    addLayer: throwStyleTeardown,
    addSource: throwStyleTeardown,
    getLayer: throwStyleTeardown,
    getSource: throwStyleTeardown,
    getStyle: throwStyleTeardown,
    hasImage: throwStyleTeardown,
    setPaintProperty: throwStyleTeardown
  } as unknown as Parameters<typeof syncOrdersLayer>[0] & Parameters<typeof syncRouteLayers>[0];
}

function order(overrides: Partial<CanonicalOrderDto> = {}): CanonicalOrderDto {
  return {
    blockerReasons: [],
    coordinates: { latitude: 43.6, longitude: -79.3 },
    deliveryArea: 'Toronto',
    deliveryDate: '2026-05-27',
    deliverySession: 'DAY',
    deliveryStatus: 'ready',
    geocodeStatus: 'RESOLVED',
    health: 'normal',
    orderId: 'order-1',
    orderName: '#1001',
    phone: null,
    planningStatus: 'UNPLANNED',
    recipientName: 'Customer',
    routePlanId: null,
    routePlanName: null,
    serviceType: 'DELIVERY',
    shippingAddress: { address1: null, address2: null, city: null, countryCode: null, postalCode: null, province: null },
    sourceOrderId: '1001',
    sourceOrderNumber: '1001',
    sourcePlatform: 'WOOCOMMERCE',
    status: 'unfulfilled',
    stopId: 'stop-1',
    timeWindowEnd: null,
    timeWindowStart: null,
    ...overrides
  };
}

function routeDetail(overrides: Partial<RoutePlanDetailDto> = {}): RoutePlanDetailDto {
  return {
    routeGeometry: { coordinates: [[-79.5, 43.7], [-79.4, 43.65]], type: 'LineString' },
    routePlan: {
      createdAt: '',
      deliveryAreas: ['Toronto'],
      deliveryDate: '2026-05-27',
      depot: { latitude: 43.7, longitude: -79.5 },
      driverId: null,
      id: 'route-1',
      missingCoordinates: 0,
      name: 'Route 1',
      planDate: '2026-05-27',
      status: 'DRAFT',
      stopsCount: 0,
      updatedAt: ''
    },
    routeStopPoints: [],
    stops: [],
    ...overrides
  };
}

function routeStop(id: string, sequence: number, latitude: number, longitude: number): RouteStopDto {
  return {
    addressLabel: `${sequence} Test Street, Toronto, ON`,
    coordinates: { latitude, longitude },
    deliveryArea: 'Toronto',
    deliveryStopId: id,
    orderId: `order-${sequence}`,
    orderName: `#10${sequence}`,
    recipientName: `Customer ${sequence}`,
    sequence,
    sourceOrderId: `source-${sequence}`,
    status: 'PENDING'
  };
}

function bootstrapNotConfigured(): BootstrapPayload {
  return {
    appUrls: {
      dashboard: '/admin/ui/app',
      drivers: '/admin/ui/app/drivers',
      orders: '/admin/ui/app/orders',
      routes: '/admin/ui/app/routes',
      settings: '/admin/ui/app/settings'
    },
    csrfToken: 'csrf',
    mapConfig: {
      allowedHosts: [],
      attribution: null,
      providerMode: null,
      status: 'not_configured',
      styleAudit: null,
      styleUrl: null
    },
    mode: 'internal-admin',
    routerConfig: { coverage: null, provider: null, status: 'not_configured' },
    shopDomain: 'tenant.example.test'
  };
}
