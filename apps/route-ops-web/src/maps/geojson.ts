import type { CanonicalOrderDto, RoutePlanDetailDto, RouteStopDto } from '../types';

export type LngLat = [number, number];

export type RouteOpsPoint = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  kind: 'depot' | 'order' | 'stop';
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
  orderId: string;
  orderName: string;
  pinKind: 'planned' | 'review' | 'unplanned';
  planned: boolean;
  sortKey: number;
}>;

export type RouteLineFeature = Feature<LineStringGeometry, { kind: 'road_geometry' | 'sequence_preview' }>;

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

export function buildOrdersMapFeatureCollection(orders: CanonicalOrderDto[], plannedOrderIds: ReadonlySet<string>): OrderMapFeatureCollection {
  const features: OrderMapFeatureCollection['features'] = [];
  orders.forEach((order, index) => {
    const lngLat = toLngLat(order.coordinates);
    if (lngLat === null) return;
    const planned = plannedOrderIds.has(order.orderId) || order.routePlanId !== null || order.planningStatus !== 'UNPLANNED';
    features.push({
      geometry: { coordinates: lngLat, type: 'Point' },
      properties: {
        label: String(index + 1),
        orderId: order.orderId,
        orderName: order.orderName,
        pinKind: order.blockerReasons.length > 0 ? 'review' : planned ? 'planned' : 'unplanned',
        planned,
        sortKey: planned ? index + 1000 : index
      },
      type: 'Feature'
    });
  });
  return { features, type: 'FeatureCollection' };
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

export function buildSequenceLineFeature(points: RouteOpsPoint[]): RouteLineFeature | null {
  const coordinates = points.map((point): LngLat => [point.longitude, point.latitude]);
  if (coordinates.length < 2) return null;
  return {
    geometry: { coordinates, type: 'LineString' },
    properties: { kind: 'sequence_preview' },
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

export function getRouteMapPoints(detail: RoutePlanDetailDto | null): RouteOpsPoint[] {
  if (detail === null) return [];
  const points: RouteOpsPoint[] = [];
  const depotLngLat = toLngLat(detail.routePlan.depot);
  if (depotLngLat !== null) {
    points.push({ id: `${detail.routePlan.id}:depot`, kind: 'depot', label: 'D', latitude: depotLngLat[1], longitude: depotLngLat[0] });
  }
  for (const stop of [...detail.stops].sort((left, right) => left.sequence - right.sequence)) {
    const stopPoint = routeStopToPoint(stop);
    if (stopPoint !== null) points.push(stopPoint);
  }
  return points;
}

export function routeStopToPoint(stop: RouteStopDto): RouteOpsPoint | null {
  const lngLat = toLngLat(stop.coordinates);
  if (lngLat === null) return null;
  return { id: stop.deliveryStopId, kind: 'stop', label: String(stop.sequence), latitude: lngLat[1], longitude: lngLat[0] };
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
