import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildOrdersMapFeatureCollection, buildRouteGeometryFeature, buildRouteStopMarkerFeatureCollection, fitBoundsForPoints, getRouteMapPoints } from '../src/maps/geojson';
import { auditStyleEndpoints, extractStyleEndpointUrls, mapReadiness, providerStatusLabel } from '../src/maps/provider';
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
    expect(collection.features.map((feature) => feature.properties.pinImage)).toEqual([
      'orders-map-pin-planned',
      'orders-map-pin-review'
    ]);
    expect(collection.features.some((feature) => 'plannedLabel' in feature.properties)).toBe(false);
  });

  test('uses the Shopify CLEVER lite map style instead of the temporary five-layer fallback', () => {
    const style = JSON.parse(readFileSync(join(process.cwd(), 'public/vendor/openfreemap-clever-lite.json'), 'utf8')) as {
      glyphs?: string;
      metadata?: { cleverRoutePublicHosts?: string[]; cleverRouteSource?: string };
      layers?: Array<{ id?: string; paint?: Record<string, unknown>; source?: string; type?: string }>;
      sources?: Record<string, { url?: string }>;
    };
    const layerIds = style.layers?.map((layer) => layer.id) ?? [];
    expect(layerIds).toEqual([
      'background',
      'natural_earth',
      'park',
      'park_outline',
      'waterway_river',
      'waterway_other',
      'water',
      'road_link',
      'road_minor',
      'road_secondary_tertiary',
      'road_trunk_primary',
      'road_motorway',
      'bridge_link',
      'bridge_street',
      'bridge_secondary_tertiary',
      'bridge_trunk_primary',
      'bridge_motorway',
      'highway-name-path',
      'highway-name-minor',
      'highway-name-major',
      'label_town',
      'label_city',
      'label_city_capital'
    ]);
    expect(style.sources?.overture_buildings).toBeUndefined();
    expect(style.glyphs).toBe('https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf');
    expect(style.layers?.find((layer) => layer.id === 'road_link')?.paint?.['line-color']).toBe('#ead9bd');
    expect(style.layers?.find((layer) => layer.id === 'road_trunk_primary')?.paint?.['line-color']).toBe('#e6cda7');
    expect(style.layers?.find((layer) => layer.id === 'bridge_motorway')?.paint?.['line-color']).toBe('#e2b282');
    expect(style.layers?.some((layer) => layer.id === 'building' || layer.source === 'overture_buildings')).toBe(false);
    expect(style.metadata?.cleverRouteSource).toContain('shopify-clever');
    expect(style.metadata?.cleverRouteSource).toContain('openfreemap-clever-lite.json');
    expect(style.metadata?.cleverRoutePublicHosts).toEqual(['tiles.openfreemap.org']);
  });

  test('builds route geometry and fit-bound locations with depot + numbered stops', () => {
    const detail = routeDetail();
    expect(buildRouteGeometryFeature(detail)?.geometry.coordinates).toEqual([[-79.5, 43.7], [-79.4, 43.65]]);
    const points = getRouteMapPoints(detail);
    expect(points.map((point) => `${point.kind}:${point.label}`)).toEqual(['depot:D', 'stop:1', 'stop:2']);
    expect(fitBoundsForPoints(points)).toEqual({ east: -79.3, north: 43.7, south: 43.6, west: -79.5 });
  });

  test('does not synthesize fake route lines when OSRM geometry is unavailable', () => {
    const detail = { ...routeDetail(), routeGeometry: null };
    expect(buildRouteGeometryFeature(detail)).toBeNull();
    expect(getRouteMapPoints(detail).map((point) => `${point.kind}:${point.label}`)).toEqual(['depot:D', 'stop:1', 'stop:2']);
  });

  test('uses OSRM snapped stop coordinates for the numbered route detail markers', () => {
    const points = getRouteMapPoints({
      ...routeDetail(),
      routeStopPoints: [
        { deliveryStopId: 'a', inputCoordinates: [-79.3, 43.6], name: 'Road A', sequence: 1, snapDistanceMeters: 12.3, snappedCoordinates: [-79.31, 43.61], sourceOrderId: 'source-a' },
        { deliveryStopId: 'b', inputCoordinates: [-79.4, 43.65], name: null, sequence: 2, snapDistanceMeters: null, snappedCoordinates: null, sourceOrderId: 'source-b' }
      ]
    });

    expect(points).toEqual([
      { id: 'route-1:depot', kind: 'depot', label: 'D', latitude: 43.7, longitude: -79.5 },
      { id: 'a', kind: 'stop', label: '1', latitude: 43.61, longitude: -79.31 },
      { id: 'b', kind: 'stop', label: '2', latitude: 43.65, longitude: -79.4 }
    ]);
    expect(fitBoundsForPoints(points)).toEqual({ east: -79.31, north: 43.7, south: 43.61, west: -79.5 });
    expect(buildRouteStopMarkerFeatureCollection(points)).toEqual({
      features: [
        { geometry: { coordinates: [-79.31, 43.61], type: 'Point' }, properties: { id: 'a', label: '1', sortKey: 0 }, type: 'Feature' },
        { geometry: { coordinates: [-79.4, 43.65], type: 'Point' }, properties: { id: 'b', label: '2', sortKey: 1 }, type: 'Feature' }
      ],
      type: 'FeatureCollection'
    });
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

  test('keeps configured providers interactive before markers exist', () => {
    expect(mapReadiness({ coordinatesCount: 0, mapStatus: 'not_configured' })).toBe('provider_not_configured');
    expect(mapReadiness({ coordinatesCount: 0, mapStatus: 'configured' })).toBe('interactive_map');
    expect(mapReadiness({ coordinatesCount: 2, mapStatus: 'configured' })).toBe('interactive_map');
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
