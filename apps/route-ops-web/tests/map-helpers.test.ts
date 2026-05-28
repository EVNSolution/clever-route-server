import { describe, expect, test, vi } from 'vitest';

import { buildOrdersMapFeatureCollection, buildRouteGeometryFeature, fitBoundsForPoints, getRouteMapPoints } from '../src/maps/geojson';
import { auditStyleEndpoints, extractStyleEndpointUrls, providerStatusLabel } from '../src/maps/provider';
import { installPmtilesProtocol } from '../src/maps/pmtiles';
import type { BootstrapPayload, CanonicalOrderDto, RoutePlanDetailDto } from '../src/types';

describe('route ops map helpers', () => {
  test('builds order GeoJSON with planned/review pin classification and filters invalid coordinates', () => {
    const collection = buildOrdersMapFeatureCollection([
      order({ orderId: 'ready', orderName: '#1001' }),
      order({ blockerReasons: ['missing_coordinates'], orderId: 'review', orderName: '#1002' }),
      order({ coordinates: { latitude: null, longitude: -79.4 }, orderId: 'bad' })
    ], new Set(['ready']));

    expect(collection.features).toHaveLength(2);
    expect(collection.features.map((feature) => [feature.properties.orderId, feature.properties.pinKind])).toEqual([
      ['ready', 'planned'],
      ['review', 'review']
    ]);
  });

  test('builds route geometry and fit-bound locations with depot + numbered stops', () => {
    const detail = routeDetail();
    expect(buildRouteGeometryFeature(detail)?.geometry.coordinates).toEqual([[-79.5, 43.7], [-79.4, 43.65]]);
    const points = getRouteMapPoints(detail);
    expect(points.map((point) => `${point.kind}:${point.label}`)).toEqual(['depot:D', 'stop:1', 'stop:2']);
    expect(fitBoundsForPoints(points)).toEqual({ east: -79.3, north: 43.7, south: 43.6, west: -79.5 });
  });

  test('extracts style manifest endpoints and classifies public vs self-hosted hosts', () => {
    const endpoints = extractStyleEndpointUrls({
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      sources: {
        local: { tiles: ['/admin/ui/app/vendor/tiles/{z}/{x}/{y}.pbf'] },
        pmtiles: { url: 'pmtiles://https://example.test/world.pmtiles' }
      },
      sprite: '/admin/ui/app/vendor/sprites/clever'
    });
    expect(endpoints).toContain('https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf');
    expect(endpoints).toContain('https://example.test/world.pmtiles');
    expect(auditStyleEndpoints(endpoints, ['tiles.openfreemap.org']).isAllowed).toBe(false);
    expect(auditStyleEndpoints(endpoints, ['tiles.openfreemap.org', 'example.test'])).toEqual({
      externalHosts: ['example.test', 'tiles.openfreemap.org'],
      isAllowed: true,
      providerMode: 'public_allowlisted'
    });
  });

  test('does not double-install PMTiles protocol in one browser session', () => {
    const originalWindow = (globalThis as { window?: Window }).window;
    (globalThis as { window?: Partial<Window> }).window = { __cleverRouteOpsPmtilesProtocolInstalled: false };
    try {
      const addProtocol = vi.fn();
      class Protocol { tile = vi.fn(); }
      expect(installPmtilesProtocol({ addProtocol }, Protocol)).toBe(true);
      expect(installPmtilesProtocol({ addProtocol }, Protocol)).toBe(false);
      expect(addProtocol).toHaveBeenCalledOnce();
    } finally {
      (globalThis as { window?: Window }).window = originalWindow;
    }
  });

  test('labels configured and fallback provider states', () => {
    expect(providerStatusLabel(bootstrap({ providerMode: 'public_allowlisted', status: 'configured' }))).toBe('Public map provider allowlisted');
    expect(providerStatusLabel(bootstrap({ disabledReason: 'public_provider_mode_not_enabled', providerMode: null, status: 'not_configured' }))).toBe('public_provider_mode_not_enabled');
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

function routeDetail(): RoutePlanDetailDto {
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
      stopsCount: 2,
      updatedAt: ''
    },
    routeStopPoints: [],
    stops: [
      { addressLabel: 'A', coordinates: { latitude: 43.6, longitude: -79.3 }, deliveryArea: 'Toronto', deliveryStopId: 'a', orderId: 'order-a', orderName: '#1', recipientName: 'A', sequence: 1, sourceOrderId: 'source-a', status: 'PENDING' },
      { addressLabel: 'B', coordinates: { latitude: 43.65, longitude: -79.4 }, deliveryArea: 'Toronto', deliveryStopId: 'b', orderId: 'order-b', orderName: '#2', recipientName: 'B', sequence: 2, sourceOrderId: 'source-b', status: 'PENDING' }
    ]
  };
}

function bootstrap(mapConfig: Partial<BootstrapPayload['mapConfig']>): BootstrapPayload['mapConfig'] {
  return {
    allowedHosts: [],
    attribution: null,
    providerMode: null,
    status: 'not_configured',
    styleAudit: null,
    styleUrl: null,
    ...mapConfig
  };
}
