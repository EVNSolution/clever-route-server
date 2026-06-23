import type {
  RoutePlanDetail,
  RoutePlanDetailStop,
  RoutePlanRouteGeometry,
  RoutePlanRouteMetrics,
  RoutePlanRouteResult,
  RoutePlanRouteStopPoint,
  RoutePlanSummary
} from './route-plan.types.js';
import type { RouteGeometryProvider } from './route-plan.service.js';

type FetchLike = (url: string, init: { method: 'GET'; signal?: AbortSignal }) => Promise<Response>;

type OsrmRouteGeometryProviderOptions = {
  baseUrl: string;
  fetch?: FetchLike | undefined;
  timeoutMs?: number;
};

type RoutableRoutePoint =
  | { coordinate: [number, number]; kind: 'depot' }
  | { coordinate: [number, number]; kind: 'stop'; stop: RoutePlanDetailStop };

type OsrmWaypoint = {
  distance: number | null;
  location: [number, number] | null;
  name: string | null;
};

type OsrmLeg = {
  distance: number | null;
  duration: number | null;
};

export class OsrmRouteGeometryProvider implements RouteGeometryProvider {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: OsrmRouteGeometryProviderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1000, Math.floor(options.timeoutMs))
        : 10000;
  }

  async buildRoute(input: RoutePlanDetail): Promise<RoutePlanRouteResult> {
    const sortedStops = sortStopsBySequence(input.stops);
    const routePoints = getRoutableRoutePoints(input.routePlan, sortedStops);
    if (routePoints.length < 2) {
      return emptyRouteResult();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(buildRouteUrl(this.baseUrl, routePoints.map((point) => point.coordinate)), {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OSRM route request failed with HTTP ${response.status}`);
      }
    } catch (error) {
      throw error instanceof Error ? error : new Error('OSRM route request failed');
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => null);
    if (!isOkOsrmPayload(payload)) {
      throw new Error('OSRM route response was invalid.');
    }

    const routeGeometry = readOsrmRouteGeometry(payload);
    if (routeGeometry === null) {
      throw new Error('OSRM route response did not include usable geometry.');
    }

    return {
      routeGeometry,
      routeMetrics: readOsrmRouteMetrics(payload),
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

  if (routePlan.routeEndMode === 'RETURN_TO_DEPOT' && depotCoordinate !== null && routePoints.some((point) => point.kind === 'stop')) {
    routePoints.push({ coordinate: depotCoordinate, kind: 'depot' });
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
  return { routeGeometry: null, routeMetrics: null, routeStopPoints: [] };
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
  const legs = readOsrmLegs(payload);
  const waypointsByStopId = new Map<string, OsrmWaypoint>();
  const legsByStopId = new Map<string, OsrmLeg>();

  routePoints.forEach((routePoint, routePointIndex) => {
    if (routePoint.kind !== 'stop') {
      return;
    }
    waypointsByStopId.set(routePoint.stop.deliveryStopId, waypoints[routePointIndex] ?? emptyWaypoint());
    legsByStopId.set(routePoint.stop.deliveryStopId, legs[routePointIndex - 1] ?? emptyLeg());
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
      snappedCoordinates: waypoint.location,
      distanceFromPreviousMeters: legsByStopId.get(stop.deliveryStopId)?.distance ?? null,
      durationFromPreviousSeconds: legsByStopId.get(stop.deliveryStopId)?.duration ?? null
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

function readOsrmRouteMetrics(payload: unknown): RoutePlanRouteMetrics | null {
  const object = objectOrNull(payload);
  if (object?.code !== 'Ok' || !Array.isArray(object.routes)) {
    return null;
  }

  const route = objectOrNull(object.routes[0]);
  if (route === null) {
    return null;
  }

  const distanceMeters = readDistanceMeters(route.distance);
  const durationSeconds = readDurationSeconds(route.duration);
  if (distanceMeters === null && durationSeconds === null) {
    return null;
  }

  return { distanceMeters, durationSeconds };
}

function readOsrmLegs(payload: unknown): OsrmLeg[] {
  const object = objectOrNull(payload);
  if (object?.code !== 'Ok' || !Array.isArray(object.routes)) {
    return [];
  }
  const route = objectOrNull(object.routes[0]);
  if (!Array.isArray(route?.legs)) {
    return [];
  }
  return route.legs.map((leg) => readOsrmLeg(leg));
}

function readOsrmLeg(value: unknown): OsrmLeg {
  const object = objectOrNull(value);
  if (object === null) {
    return emptyLeg();
  }
  return {
    distance: readDistanceMeters(object.distance),
    duration: readDurationSeconds(object.duration)
  };
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

function readDurationSeconds(value: unknown): number | null {
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

function emptyLeg(): OsrmLeg {
  return { distance: null, duration: null };
}

function isOkOsrmPayload(payload: unknown): boolean {
  return objectOrNull(payload)?.code === 'Ok';
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error('OSRM base URL must be configured explicitly.');
  }
  return trimmed.replace(/\/+$/u, '');
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
