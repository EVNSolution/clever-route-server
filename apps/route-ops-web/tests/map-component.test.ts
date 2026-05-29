import { describe, expect, test, vi } from 'vitest';

import { syncOrdersLayer, syncRouteLayers } from '../src/components/maps/RouteOpsMap';
import { buildOrdersMapFeatureCollection, buildSequenceLineFeature } from '../src/maps/geojson';
import type { CanonicalOrderDto } from '../src/types';

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

  test('renders Orders map pins without sequence labels', () => {
    const { layers, map } = createMapStub();
    const collection = buildOrdersMapFeatureCollection([order({ orderId: 'order-1', routePlanId: 'route-1' })], new Set());

    syncOrdersLayer(map, collection);

    const orderLayer = layers.get('route-ops-order-pins') as { layout?: Record<string, unknown> } | undefined;
    expect(orderLayer).toBeDefined();
    expect(orderLayer?.layout ?? {}).not.toHaveProperty('text-field');
    expect(orderLayer?.layout ?? {}).not.toHaveProperty('text-offset');
  });


  test('clears the route line source when a filter leaves fewer than two points', () => {
    const { map, sources } = createMapStub();
    const line = buildSequenceLineFeature([
      { id: 'a', kind: 'order', label: '1', latitude: 43.6, longitude: -79.3 },
      { id: 'b', kind: 'order', label: '2', latitude: 43.7, longitude: -79.4 }
    ]);
    expect(line).not.toBeNull();

    syncRouteLayers(map, line);
    expect(sources.get('route-ops-route-line')?.data).toEqual(line);

    syncRouteLayers(map, null);
    expect(sources.get('route-ops-route-line')?.setData).toHaveBeenCalledWith({ features: [], type: 'FeatureCollection' });
  });


  test('ignores MapLibre style teardown races during SPA tab navigation', () => {
    const map = createStyleTeardownMapStub();
    const collection = buildOrdersMapFeatureCollection([order({ orderId: 'order-1' })], new Set());
    const line = buildSequenceLineFeature([
      { id: 'a', kind: 'order', label: '1', latitude: 43.6, longitude: -79.3 },
      { id: 'b', kind: 'order', label: '2', latitude: 43.7, longitude: -79.4 }
    ]);

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
