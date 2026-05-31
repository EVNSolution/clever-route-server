import type { CanonicalOrderDto, RoutePlanDetailDto, RouteStopDto } from '../types';

export type LngLat = [number, number];

export type RouteOpsPoint = {
  addressLabel?: string;
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  kind: 'depot' | 'order' | 'stop';
};

type RouteStopPointDto = RoutePlanDetailDto['routeStopPoints'][number];

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
  pinImage: string;
  planned: boolean;
  sortKey: number;
}>;

export type RouteLineFeature = Feature<LineStringGeometry, { kind: 'road_geometry' }>;

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
    const pinKind = order.blockerReasons.length > 0 ? 'review' : planned ? 'planned' : 'unplanned';
    features.push({
      geometry: { coordinates: lngLat, type: 'Point' },
      properties: {
        label: String(index + 1),
        orderId: order.orderId,
        orderName: order.orderName,
        pinImage: pinImageForKind(pinKind),
        pinKind,
        planned,
        sortKey: planned ? index + 1000 : index
      },
      type: 'Feature'
    });
  });
  return { features, type: 'FeatureCollection' };
}

function pinImageForKind(kind: OrderMapFeatureCollection['features'][number]['properties']['pinKind']): string {
  if (kind === 'planned') return 'orders-map-pin-planned';
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

export function getRouteMapPoints(detail: RoutePlanDetailDto | null): RouteOpsPoint[] {
  if (detail === null) return [];
  const points: RouteOpsPoint[] = [];
  const depotLngLat = toLngLat(detail.routePlan.depot);
  if (depotLngLat !== null) {
    points.push({ id: `${detail.routePlan.id}:depot`, kind: 'depot', label: 'D', latitude: depotLngLat[1], longitude: depotLngLat[0] });
  }
  for (const stop of [...detail.stops].sort((left, right) => left.sequence - right.sequence)) {
    const stopPoint = routeStopToPoint(stop, detail.routeStopPoints);
    if (stopPoint !== null) points.push(stopPoint);
  }
  return points;
}

export function routeStopToPoint(stop: RouteStopDto, routeStopPoints: readonly RouteStopPointDto[] = []): RouteOpsPoint | null {
  const lngLat = resolveRouteStopDisplayLngLat(stop, routeStopPoints);
  if (lngLat === null) return null;
  return { id: stop.deliveryStopId, kind: 'stop', label: String(stop.sequence), latitude: lngLat[1], longitude: lngLat[0] };
}

function resolveRouteStopDisplayLngLat(stop: RouteStopDto, routeStopPoints: readonly RouteStopPointDto[]): LngLat | null {
  const snappedLngLat = findRouteStopPoint(stop, routeStopPoints)?.snappedCoordinates;
  if (isLngLat(snappedLngLat)) return snappedLngLat;
  return toLngLat(stop.coordinates);
}

function findRouteStopPoint(stop: RouteStopDto, routeStopPoints: readonly RouteStopPointDto[]): RouteStopPointDto | null {
  return routeStopPoints.find((point) => point.deliveryStopId === stop.deliveryStopId || point.sourceOrderId === stop.sourceOrderId)
    ?? routeStopPoints.find((point) => point.sequence === stop.sequence)
    ?? null;
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
