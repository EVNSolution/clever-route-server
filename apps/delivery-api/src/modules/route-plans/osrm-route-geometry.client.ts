import type {
  RoutePlanDetail,
  RoutePlanDetailStop,
  RoutePlanRouteGeometry,
  RoutePlanRouteResult,
  RoutePlanRouteStopPoint,
  RoutePlanSummary
} from './route-plan.types.js';
import type { RouteGeometryProvider } from './route-plan.service.js';

const DEFAULT_OSRM_BASE_URL = 'https://router.project-osrm.org';

type FetchLike = (url: string, init: { method: 'GET' }) => Promise<Response>;

type OsrmRouteGeometryProviderOptions = {
  baseUrl?: string | undefined;
  fetch?: FetchLike | undefined;
};

type RoutableRoutePoint =
  | { coordinate: [number, number]; kind: 'depot' }
  | { coordinate: [number, number]; kind: 'stop'; stop: RoutePlanDetailStop };

type OsrmWaypoint = {
  distance: number | null;
  location: [number, number] | null;
  name: string | null;
};

export class OsrmRouteGeometryProvider implements RouteGeometryProvider {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor(options: OsrmRouteGeometryProviderOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OSRM_BASE_URL);
    this.fetch = options.fetch ?? fetch;
  }

  async buildRoute(input: RoutePlanDetail): Promise<RoutePlanRouteResult> {
    const sortedStops = sortStopsBySequence(input.stops);
    const routePoints = getRoutableRoutePoints(input.routePlan, sortedStops);
    if (routePoints.length < 2) {
      return emptyRouteResult();
    }

    const response = await this.fetch(buildRouteUrl(this.baseUrl, routePoints.map((point) => point.coordinate)), { method: 'GET' });
    if (!response.ok) {
      return emptyRouteResult();
    }

    const payload = await response.json();
    if (!isOkOsrmPayload(payload)) {
      return emptyRouteResult();
    }

    return {
      routeGeometry: readOsrmRouteGeometry(payload),
      routeStopPoints: buildRouteStopPoints(sortedStops, routePoints, payload)
    };
  }

  async buildRouteGeometry(input: RoutePlanDetail): Promise<RoutePlanRouteGeometry | null> {
    return (await this.buildRoute(input)).routeGeometry;
  }
}

function getRoutableRoutePoints(
  routePlan: RoutePlanSummary,
  stops: RoutePlanDetailStop[]
): RoutableRoutePoint[] {
  const routePoints: RoutableRoutePoint[] = [];
  const depotCoordinate = toLngLat(routePlan.depot.latitude, routePlan.depot.longitude);
  if (depotCoordinate !== null) {
    routePoints.push({ coordinate: depotCoordinate, kind: 'depot' });
  }

  for (const stop of stops) {
    const stopCoordinate = toLngLat(stop.coordinates.latitude, stop.coordinates.longitude);
    if (stopCoordinate !== null) {
      routePoints.push({ coordinate: stopCoordinate, kind: 'stop', stop });
    }
  }

  return routePoints;
}

function toLngLat(latitude: number | null, longitude: number | null): [number, number] | null {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return null;
  }

  return [longitude, latitude];
}

function buildRouteUrl(baseUrl: string, coordinates: Array<[number, number]>): string {
  const coordinatePath = coordinates.map(([longitude, latitude]) => `${longitude},${latitude}`).join(';');
  return `${baseUrl}/route/v1/driving/${coordinatePath}?overview=full&geometries=geojson&steps=false`;
}

function emptyRouteResult(): RoutePlanRouteResult {
  return { routeGeometry: null, routeStopPoints: [] };
}

function sortStopsBySequence(stops: RoutePlanDetailStop[]): RoutePlanDetailStop[] {
  return [...stops].sort((left, right) => left.sequence - right.sequence);
}

function buildRouteStopPoints(
  sortedStops: RoutePlanDetailStop[],
  routePoints: RoutableRoutePoint[],
  payload: unknown
): RoutePlanRouteStopPoint[] {
  const waypoints = readOsrmWaypoints(payload);
  const waypointsByStopId = new Map<string, OsrmWaypoint>();

  routePoints.forEach((routePoint, routePointIndex) => {
    if (routePoint.kind !== 'stop') {
      return;
    }
    waypointsByStopId.set(routePoint.stop.deliveryStopId, waypoints[routePointIndex] ?? emptyWaypoint());
  });

  return sortedStops.map((stop) => {
    const waypoint = waypointsByStopId.get(stop.deliveryStopId) ?? emptyWaypoint();
    return {
      deliveryStopId: stop.deliveryStopId,
      inputCoordinates: toLngLat(stop.coordinates.latitude, stop.coordinates.longitude),
      name: waypoint.name,
      sequence: stop.sequence,
      shopifyOrderGid: stop.shopifyOrderGid,
      snapDistanceMeters: waypoint.distance,
      snappedCoordinates: waypoint.location
    };
  });
}

function readOsrmRouteGeometry(payload: unknown): RoutePlanRouteGeometry | null {
  const object = objectOrNull(payload);
  if (object?.code !== 'Ok' || !Array.isArray(object.routes)) {
    return null;
  }

  const geometry = objectOrNull(object.routes[0])?.geometry;
  const geometryObject = objectOrNull(geometry);
  if (geometryObject?.type !== 'LineString' || !Array.isArray(geometryObject.coordinates)) {
    return null;
  }

  const coordinates = geometryObject.coordinates.flatMap((coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) {
      return [];
    }

    const longitude = Number(coordinate[0]);
    const latitude = Number(coordinate[1]);
    return isValidLongitude(longitude) && isValidLatitude(latitude) ? [[longitude, latitude] as [number, number]] : [];
  });

  return coordinates.length >= 2 ? { type: 'LineString', coordinates } : null;
}

function readOsrmWaypoints(payload: unknown): OsrmWaypoint[] {
  const object = objectOrNull(payload);
  if (!Array.isArray(object?.waypoints)) {
    return [];
  }

  return object.waypoints.map((waypoint) => readOsrmWaypoint(waypoint));
}

function readOsrmWaypoint(value: unknown): OsrmWaypoint {
  const object = objectOrNull(value);
  if (object === null) {
    return emptyWaypoint();
  }

  return {
    distance: readDistanceMeters(object.distance),
    location: readWaypointLocation(object.location),
    name: readWaypointName(object.name)
  };
}

function readWaypointLocation(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }

  const longitude = Number(value[0]);
  const latitude = Number(value[1]);
  return isValidLongitude(longitude) && isValidLatitude(latitude) ? [longitude, latitude] : null;
}

function readDistanceMeters(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readWaypointName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function emptyWaypoint(): OsrmWaypoint {
  return { distance: null, location: null, name: null };
}

function isOkOsrmPayload(payload: unknown): boolean {
  return objectOrNull(payload)?.code === 'Ok';
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return (trimmed === '' ? DEFAULT_OSRM_BASE_URL : trimmed).replace(/\/+$/u, '');
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}
