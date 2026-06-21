import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildOrdersMapFeatureCollection, buildRouteDropoffPointFeatureCollection, buildRouteGeometryFeature, buildRouteStopMarkerFeatureCollection, fitBoundsForPoints, getRouteDropoffPoints, getRouteFitPoints, getRouteMapPoints } from '../src/maps/geojson';
import { auditStyleEndpoints, extractStyleEndpointUrls, mapReadiness, providerStatusLabel } from '../src/maps/provider';
import { installPmtilesProtocol } from '../src/maps/pmtiles';
import type { BootstrapPayload, CanonicalOrderDto, RoutePlanDetailDto } from '../src/types';

describe('route ops map helpers', () => {
  test('builds order GeoJSON with candidate/review pin classification and filters invalid coordinates', () => {
    const collection = buildOrdersMapFeatureCollection([
      order({ orderId: 'ready', orderName: '#1001' }),
      order({ blockerReasons: ['missing_coordinates'], orderId: 'review', orderName: '#1002' }),
      order({ orderId: 'history', orderName: '#1003' }),
      order({ coordinates: { latitude: null, longitude: -79.4 }, orderId: 'bad' })
    ], new Map([
      ['ready', { pinKind: 'candidate', sequence: 1 }],
      ['review', { markerOpacity: 0.5, pinKind: 'review' }],
      ['history', { pinKind: 'history' }]
    ]));

    expect(collection.features).toHaveLength(3);
    expect(collection.features.map((feature) => [feature.properties.orderId, feature.properties.pinKind, feature.properties.label, feature.properties.markerOpacity])).toEqual([
      ['ready', 'candidate', '', 1],
      ['review', 'review', '', 0.5],
      ['history', 'history', '', 1]
    ]);
    expect(collection.features.map((feature) => feature.properties.pinImage)).toEqual([
      'orders-map-pin-planned',
      'orders-map-pin-review',
      'orders-map-pin-history'
    ]);
    expect(collection.features.some((feature) => 'plannedLabel' in feature.properties)).toBe(false);
  });

  test('keeps the order pin shape while applying split group marker colors', () => {
    const collection = buildOrdersMapFeatureCollection([
      order({ orderId: 'assigned', orderName: '#1004' })
    ], new Map([
      ['assigned', { markerColor: '#2563eb', pinKind: 'candidate' }]
    ]));

    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.properties).toMatchObject({
      markerColor: '#2563eb',
      pinImage: 'orders-map-pin-color-2563eb',
      pinKind: 'candidate'
    });
  });



  test('marks active split draft candidates with a highlighted pin image', () => {
    const collection = buildOrdersMapFeatureCollection([
      order({ orderId: 'candidate', orderName: '#1005' })
    ], new Map([
      ['candidate', { markerColor: '#16a34a', markerHighlightColor: '#b6ff00', pinKind: 'candidate' }]
    ]));

    expect(collection.features[0]?.properties).toMatchObject({
      markerColor: '#16a34a',
      markerHighlightColor: '#b6ff00',
      pinImage: 'orders-map-pin-color-16a34a-highlight-b6ff00',
      pinKind: 'candidate'
    });
  });

  test('uses the Shopify CLEVER lite map style instead of the temporary five-layer fallback', () => {
    const style = JSON.parse(readFileSync(join(process.cwd(), 'public/vendor/openfreemap-clever-lite.json'), 'utf8')) as {
      glyphs?: string;
      metadata?: { cleverRoutePublicHosts?: string[]; cleverRouteSource?: string };
      layers?: Array<{ id?: string; minzoom?: number; paint?: Record<string, unknown>; source?: string; type?: string; ['source-layer']?: string }>;
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
      'building_footprints',
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
    expect(style.layers?.find((layer) => layer.id === 'building_footprints')).toMatchObject({
      minzoom: 15,
      source: 'openmaptiles',
      'source-layer': 'building',
      type: 'fill'
    });
    expect(style.layers?.find((layer) => layer.id === 'building_footprints')?.paint?.['fill-opacity']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      15,
      0,
      16,
      0.22,
      19,
      0.3
    ]);
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

  test('uses OSRM snapped route stop points for numbered markers after optimization', () => {
    const detail: RoutePlanDetailDto = {
      ...routeDetail(),
      routeStopPoints: [
        { deliveryStopId: 'a', inputCoordinates: [-79.3, 43.6], items: [], name: 'Road A', sequence: 1, snapDistanceMeters: 12.3, snappedCoordinates: [-79.31, 43.61], sourceOrderId: 'source-a' },
        { deliveryStopId: 'b', inputCoordinates: [-79.4, 43.65], items: [], name: null, sequence: 2, snapDistanceMeters: null, snappedCoordinates: null, sourceOrderId: 'source-b' }
      ]
    };
    const points = getRouteMapPoints(detail);
    const dropoffPoints = getRouteDropoffPoints(detail);

    expect(points).toEqual([
      { id: 'route-1:depot', kind: 'depot', label: 'D', latitude: 43.7, longitude: -79.5 },
      { addressLabel: 'Road A', id: 'a', kind: 'stop', label: '1', latitude: 43.61, longitude: -79.31, preview: true, sequence: 1 },
      { addressLabel: undefined, id: 'b', kind: 'stop', label: '2', latitude: 43.65, longitude: -79.4, preview: true, sequence: 2 }
    ]);
    expect(dropoffPoints).toEqual([
      { addressLabel: 'Road A', id: 'a:dropoff', kind: 'dropoff', label: '1', latitude: 43.61, longitude: -79.31 }
    ]);
    expect(fitBoundsForPoints([...points, ...dropoffPoints])).toEqual({ east: -79.31, north: 43.7, south: 43.61, west: -79.5 });
    expect(fitBoundsForPoints(getRouteFitPoints(detail, points, dropoffPoints))).toEqual({ east: -79.31, north: 43.65, south: 43.61, west: -79.4 });
    expect(buildRouteStopMarkerFeatureCollection(points)).toEqual({
      features: [
        { geometry: { coordinates: [-79.31, 43.61], type: 'Point' }, properties: { color: '#006fbb', id: 'a', label: '1', preview: true, selected: false, sortKey: 10001 }, type: 'Feature' },
        { geometry: { coordinates: [-79.4, 43.65], type: 'Point' }, properties: { color: '#006fbb', id: 'b', label: '2', preview: true, selected: false, sortKey: 10002 }, type: 'Feature' }
      ],
      type: 'FeatureCollection'
    });
    expect(buildRouteDropoffPointFeatureCollection(dropoffPoints)).toEqual({
      features: [
        { geometry: { coordinates: [-79.31, 43.61], type: 'Point' }, properties: { id: 'a:dropoff', sortKey: 0 }, type: 'Feature' }
      ],
      type: 'FeatureCollection'
    });
  });

  test('marks draft route order points as blue preview markers with topmost sort keys', () => {
    const detail = routeDetail();
    const draftStops = [
      { ...detail.stops[1]!, sequence: 1 },
      { ...detail.stops[0]!, sequence: 2 }
    ];
    const points = getRouteMapPoints(detail, draftStops);
    const collection = buildRouteStopMarkerFeatureCollection(points);

    expect(points.map((point) => `${point.kind}:${point.label}:${point.preview === true ? 'preview' : 'saved'}`)).toEqual([
      'depot:D:saved',
      'stop:1:preview',
      'stop:2:preview'
    ]);
    expect(collection.features.map((feature) => [feature.properties.id, feature.properties.color, feature.properties.sortKey])).toEqual([
      ['b', '#006fbb', 10001],
      ['a', '#006fbb', 10002]
    ]);
  });


  test('fits draft route maps to stop coordinates before depot when geometry cache is missing', () => {
    const detail = { ...routeDetail(), routeGeometry: null, routeStopPoints: [] };
    const routePoints = getRouteMapPoints(detail);
    const fitPoints = getRouteFitPoints(detail, routePoints, getRouteDropoffPoints(detail));

    expect(routePoints.map((point) => `${point.kind}:${point.label}:${point.preview === true ? 'draft' : 'saved'}`)).toEqual([
      'depot:D:saved',
      'stop:1:draft',
      'stop:2:draft'
    ]);
    expect(fitPoints.map((point) => `${point.kind}:${point.label}`)).toEqual(['stop:1', 'stop:2']);
    expect(fitBoundsForPoints(fitPoints)).toEqual({ east: -79.3, north: 43.65, south: 43.6, west: -79.4 });
  });

  test('excludes impossible geocode outliers from route detail fit bounds', () => {
    const detail: RoutePlanDetailDto = {
      ...routeDetail(),
      routeGeometry: null,
      routeStopPoints: [],
      stops: [
        ...routeDetail().stops,
        { ...routeDetail().stops[0]!, coordinates: { latitude: 35.6624721, longitude: 139.6962707 }, deliveryStopId: 'tokyo', orderId: 'order-tokyo', orderName: '#tokyo', sequence: 3, sourceOrderId: 'source-tokyo' }
      ]
    };
    const routePoints = getRouteMapPoints(detail);
    const fitPoints = getRouteFitPoints(detail, routePoints, []);

    expect(routePoints.map((point) => `${point.kind}:${point.label}`)).toEqual(['depot:D', 'stop:1', 'stop:2', 'stop:3']);
    expect(fitPoints.map((point) => `${point.kind}:${point.label}`)).toEqual(['stop:1', 'stop:2']);
    expect(fitBoundsForPoints(fitPoints)).toEqual({ east: -79.3, north: 43.65, south: 43.6, west: -79.4 });
  });

  test('keeps published route stops neutral while still fitting to stops before depot', () => {
    const detail: RoutePlanDetailDto = {
      ...routeDetail(),
      routePlan: { ...routeDetail().routePlan, status: 'ASSIGNED' },
      routeGeometry: null,
      routeStopPoints: []
    };
    const routePoints = getRouteMapPoints(detail);
    const collection = buildRouteStopMarkerFeatureCollection(routePoints);

    expect(collection.features.map((feature) => [feature.properties.id, feature.properties.color, feature.properties.preview])).toEqual([
      ['a', '#303030', false],
      ['b', '#303030', false]
    ]);
    expect(getRouteFitPoints(detail, routePoints, []).map((point) => `${point.kind}:${point.label}`)).toEqual(['stop:1', 'stop:2']);
  });

  test('marks selected route stop marker data without changing marker shape', () => {
    const detail = routeDetail();
    const points = getRouteMapPoints(detail);
    const collection = buildRouteStopMarkerFeatureCollection(points, 'b');

    expect(collection.features.map((feature) => [feature.properties.id, feature.properties.selected, feature.properties.sortKey])).toEqual([
      ['a', false, 10001],
      ['b', true, 30002]
    ]);
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
    sourceCreatedAt: '2026-05-27T12:00:00.000Z',
    sourceCreatedDate: '2026-05-27',
    sourcePlatform: 'WOOCOMMERCE',
    sourceUpdatedAt: '2026-05-27T12:00:00.000Z',
    sourceUpdatedDate: '2026-05-27',
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
      routeEndMode: 'END_AT_LAST_STOP',
      status: 'DRAFT',
      stopsCount: 2,
      updatedAt: ''
    },
    routeStopPoints: [],
    stops: [
      { addressLabel: 'A', coordinates: { latitude: 43.6, longitude: -79.3 }, deliveryArea: 'Toronto', deliveryStopId: 'a', items: [], orderId: 'order-a', orderName: '#1', recipientName: 'A', sequence: 1, sourceOrderId: 'source-a', status: 'PENDING' },
      { addressLabel: 'B', coordinates: { latitude: 43.65, longitude: -79.4 }, deliveryArea: 'Toronto', deliveryStopId: 'b', items: [], orderId: 'order-b', orderName: '#2', recipientName: 'B', sequence: 2, sourceOrderId: 'source-b', status: 'PENDING' }
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
