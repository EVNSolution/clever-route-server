import type { CanonicalOrderDto, RoutePlanDetailDto, RouteStopDto } from '../types';

export type LngLat = [number, number];

export type RouteOpsPoint = {
  addressLabel?: string;
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  kind: 'depot' | 'dropoff' | 'order' | 'stop';
  preview?: boolean;
  selected?: boolean;
  sequence?: number;
};

type Feature<Geometry, Properties extends Record<string, unknown>> = {
  geometry: Geometry;
  properties: Properties;
  type: 'Feature';
};

type FeatureCollection<Geometry, Properties extends Record<string, unknown>> = {
  features: Array<Feature<Geometry, Properties>>;
  type: 'FeatureCollection';
};

type PointGeometry = { coordinates: LngLat; type: 'Point' };
type LineStringGeometry = { coordinates: LngLat[]; type: 'LineString' };

export type OrderMapFeatureCollection = FeatureCollection<PointGeometry, {
  label: string;
  markerOpacity: number;
  orderId: string;
  orderName: string;
  pinKind: OrderMapPinKind;
  pinImage: string;
  planned: boolean;
  sortKey: number;
}>;

export type OrderMapPinKind = 'candidate' | 'history' | 'review' | 'unplanned';

export type OrderMapMarkerState = {
  markerOpacity?: number;
  pinKind?: OrderMapPinKind;
  sequence?: number | null;
};

export type RouteLineFeature = Feature<LineStringGeometry, { kind: 'road_geometry' }>;
export type RouteDropoffPointFeatureCollection = FeatureCollection<PointGeometry, {
  id: string;
  sortKey: number;
}>;
export type RouteStopMarkerFeatureCollection = FeatureCollection<PointGeometry, {
  color: string;
  id: string;
  label: string;
  preview: boolean;
  selected: boolean;
  sortKey: number;
}>;

export function toLngLat(coordinates: { latitude: number | null; longitude: number | null }): LngLat | null {
  const { latitude, longitude } = coordinates;
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  return [longitude, latitude];
}

export function isValidLatitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function buildOrdersMapFeatureCollection(orders: CanonicalOrderDto[], markerState: ReadonlyMap<string, OrderMapMarkerState> | ReadonlySet<string>): OrderMapFeatureCollection {
  const features: OrderMapFeatureCollection['features'] = [];
  orders.forEach((order, index) => {
    const lngLat = toLngLat(order.coordinates);
    if (lngLat === null) return;
    const state = readOrderMarkerState(order.orderId, markerState);
    const planned = state.pinKind === 'candidate' || order.routePlanId !== null || order.planningStatus !== 'UNPLANNED';
    const pinKind = state.pinKind ?? (order.blockerReasons.length > 0 ? 'review' : 'unplanned');
    const markerOpacity = normalizeMarkerOpacity(state.markerOpacity);
    const sequence = state.sequence ?? null;
    features.push({
      geometry: { coordinates: lngLat, type: 'Point' },
      properties: {
        label: sequence === null ? '' : String(sequence),
        markerOpacity,
        orderId: order.orderId,
        orderName: order.orderName,
        pinImage: pinImageForKind(pinKind),
        pinKind,
        planned,
        sortKey: sequence === null ? planned ? index + 1000 : index : 2000 + sequence
      },
      type: 'Feature'
    });
  });
  return { features, type: 'FeatureCollection' };
}

function readOrderMarkerState(orderId: string, markerState: ReadonlyMap<string, OrderMapMarkerState> | ReadonlySet<string>): OrderMapMarkerState {
  if ('get' in markerState) return markerState.get(orderId) ?? {};
  return markerState.has(orderId) ? { pinKind: 'candidate' } : {};
}

function normalizeMarkerOpacity(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function pinImageForKind(kind: OrderMapPinKind): string {
  if (kind === 'candidate') return 'orders-map-pin-planned';
  if (kind === 'history') return 'orders-map-pin-history';
  if (kind === 'review') return 'orders-map-pin-review';
  return 'orders-map-pin';
}

export function buildRouteGeometryFeature(detail: RoutePlanDetailDto | null): RouteLineFeature | null {
  const coordinates = detail?.routeGeometry?.coordinates.filter(([longitude, latitude]) => isValidLongitude(longitude) && isValidLatitude(latitude)) ?? [];
  if (coordinates.length < 2) return null;
  return {
    geometry: { coordinates, type: 'LineString' },
    properties: { kind: 'road_geometry' },
    type: 'Feature'
  };
}

export function getOrderMapPoints(orders: CanonicalOrderDto[]): RouteOpsPoint[] {
  return orders.flatMap((order, index) => {
    const lngLat = toLngLat(order.coordinates);
    if (lngLat === null) return [];
    return [{ id: order.orderId, kind: 'order', label: String(index + 1), latitude: lngLat[1], longitude: lngLat[0] }];
  });
}

export function getRouteMapPoints(detail: RoutePlanDetailDto | null, draftStops?: RouteStopDto[]): RouteOpsPoint[] {
  if (detail === null) return [];
  const points: RouteOpsPoint[] = [];
  const depotLngLat = toLngLat(detail.routePlan.depot);
  if (depotLngLat !== null) {
    points.push({ id: `${detail.routePlan.id}:depot`, kind: 'depot', label: 'D', latitude: depotLngLat[1], longitude: depotLngLat[0] });
  }
  const savedSequenceByStopId = new Map(detail.stops.map((stop) => [stop.deliveryStopId, stop.sequence]));
  const sourceStops = draftStops ?? detail.stops;
  for (const stop of [...sourceStops].sort((left, right) => left.sequence - right.sequence)) {
    const stopPoint = routeStopToPoint(stop, savedSequenceByStopId.get(stop.deliveryStopId) !== stop.sequence);
    if (stopPoint !== null) points.push(stopPoint);
  }
  return points;
}

export function getRouteDropoffPoints(detail: RoutePlanDetailDto | null): RouteOpsPoint[] {
  if (detail === null) return [];
  return [...detail.routeStopPoints]
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((point) => {
      const snappedCoordinates = point.snappedCoordinates;
      if (!isLngLat(snappedCoordinates)) return [];
      const [longitude, latitude] = snappedCoordinates;
      return [{
        addressLabel: point.name ?? undefined,
        id: `${point.deliveryStopId}:dropoff`,
        kind: 'dropoff' as const,
        label: String(point.sequence),
        latitude,
        longitude
      }];
    });
}

export function buildRouteDropoffPointFeatureCollection(points: readonly RouteOpsPoint[]): RouteDropoffPointFeatureCollection {
  const dropoffPoints = points.filter((point) => point.kind === 'dropoff');
  return {
    features: dropoffPoints.map((point, index) => ({
      geometry: { coordinates: [point.longitude, point.latitude], type: 'Point' },
      properties: {
        id: point.id,
        sortKey: index
      },
      type: 'Feature'
    })),
    type: 'FeatureCollection'
  };
}

export function buildRouteStopMarkerFeatureCollection(points: readonly RouteOpsPoint[], selectedRouteStopId: string | null = null): RouteStopMarkerFeatureCollection {
  const stopPoints = points.filter((point) => point.kind === 'stop');
  return {
    features: stopPoints.map((point, index) => {
      const selected = point.id === selectedRouteStopId || point.selected === true;
      return {
        geometry: { coordinates: [point.longitude, point.latitude], type: 'Point' },
        properties: {
          color: point.preview === true ? '#006fbb' : '#303030',
          id: point.id,
          label: point.label,
          preview: point.preview === true,
          selected,
          sortKey: (selected ? 20000 : 0) + (point.preview === true ? 10000 : 0) + (point.sequence ?? index + 1)
        },
        type: 'Feature'
      };
    }),
    type: 'FeatureCollection'
  };
}

export function routeStopToPoint(stop: RouteStopDto, preview = false): RouteOpsPoint | null {
  const lngLat = toLngLat(stop.coordinates);
  if (lngLat === null) return null;
  return { id: stop.deliveryStopId, kind: 'stop', label: String(stop.sequence), latitude: lngLat[1], longitude: lngLat[0], preview, sequence: stop.sequence };
}

function isLngLat(value: LngLat | null | undefined): value is LngLat {
  if (value === null || value === undefined) return false;
  const [longitude, latitude] = value;
  return isValidLongitude(longitude) && isValidLatitude(latitude);
}

export function fitBoundsForPoints(points: RouteOpsPoint[]): { east: number; north: number; south: number; west: number } | null {
  if (points.length === 0) return null;
  return points.reduce(
    (bounds, point) => ({
      east: Math.max(bounds.east, point.longitude),
      north: Math.max(bounds.north, point.latitude),
      south: Math.min(bounds.south, point.latitude),
      west: Math.min(bounds.west, point.longitude)
    }),
    { east: points[0]?.longitude ?? 0, north: points[0]?.latitude ?? 0, south: points[0]?.latitude ?? 0, west: points[0]?.longitude ?? 0 }
  );
}
