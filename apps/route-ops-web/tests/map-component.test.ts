import { describe, expect, test, vi } from 'vitest';

import { syncOrdersLayer } from '../src/components/maps/RouteOpsMap';
import { buildOrdersMapFeatureCollection } from '../src/maps/geojson';
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
});

function createMapStub(): {
  map: Parameters<typeof syncOrdersLayer>[0];
  sources: Map<string, { data: unknown; setData: ReturnType<typeof vi.fn> }>;
} {
  const sources = new Map<string, { data: unknown; setData: ReturnType<typeof vi.fn> }>();
  const layers = new Set<string>();
  const map = {
    addLayer: (layer: { id: string }) => {
      layers.add(layer.id);
    },
    addSource: (id: string, source: { data: unknown }) => {
      sources.set(id, { data: source.data, setData: vi.fn() });
    },
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    getSource: (id: string) => sources.get(id)
  } as unknown as Parameters<typeof syncOrdersLayer>[0];
  return { map, sources };
}

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
