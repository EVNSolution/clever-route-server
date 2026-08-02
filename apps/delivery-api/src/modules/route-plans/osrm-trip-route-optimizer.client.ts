import type { RoutePlanDetail, RoutePlanDetailStop } from './route-plan.types.js';
import type {
  RouteOptimizationFailureCode,
  RouteOptimizationInput,
  RouteOptimizationOutcome,
  RouteOptimizationResult,
  RouteOptimizationService,
} from './route-optimization.types.js';

type FetchLike = (url: string, init: { method: 'GET'; signal?: AbortSignal }) => Promise<Response>;

export type OsrmTripRouteOptimizationClientOptions = {
  baseUrl: string;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
};

type RoutableStop = {
  inputIndex: number;
  stop: RoutePlanDetailStop;
};

type OsrmTripWaypoint = {
  trips_index: number;
  waypoint_index: number;
};

type OsrmTripResponse = {
  code: string;
  trips: unknown[];
  waypoints: OsrmTripWaypoint[];
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TRIP_COORDINATES = 100;

export class OsrmTripRouteOptimizationClient implements RouteOptimizationService {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: OsrmTripRouteOptimizationClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  }

  async optimizeStopOrder(input: RouteOptimizationInput): Promise<RouteOptimizationResult | null> {
    const outcome = await this.optimizeStopOrderWithDiagnostics(input);
    return outcome.ok ? outcome.result : null;
  }

  async optimizeStopOrderWithDiagnostics(input: RouteOptimizationInput): Promise<RouteOptimizationOutcome> {
    const startedAt = Date.now();
    const request = buildTripRequest(input.detail);
    if (request === null) {
      return failureOutcome({
        code: 'invalid_input',
        elapsedMs: elapsedSince(startedAt),
        message: 'OSRM Trip requires depot coordinates and at least two routable stops within the configured location limit.',
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(buildTripUrl(this.baseUrl, input.detail, request.coordinates), {
        method: 'GET',
        signal: controller.signal,
      });
    } catch (error) {
      return failureOutcome({
        code: isAbortError(error) ? 'solver_timeout' : 'network_error',
        elapsedMs: elapsedSince(startedAt),
        message: isAbortError(error)
          ? 'OSRM Trip request timed out.'
          : 'OSRM Trip request failed before a response was received.',
      });
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const osrmCode = readOsrmCode(payload);
      return failureOutcome({
        code: classifyFailure(response.status, osrmCode),
        elapsedMs: elapsedSince(startedAt),
        httpStatus: response.status,
        message: describeFailure(response.status, osrmCode),
      });
    }
    if (!isOsrmTripResponse(payload) || payload.code !== 'Ok' || payload.trips.length === 0) {
      return failureOutcome({
        code: 'invalid_engine_payload',
        elapsedMs: elapsedSince(startedAt),
        message: 'OSRM Trip returned an invalid optimization payload.',
      });
    }

    const result = buildOptimizationResult(input.detail, request.routableStops, payload.waypoints);
    if (result === null) {
      return failureOutcome({
        code: 'invalid_engine_payload',
        elapsedMs: elapsedSince(startedAt),
        message: 'OSRM Trip waypoints did not produce an applicable stop sequence.',
      });
    }
    return { ok: true, result };
  }
}

function buildTripRequest(detail: RoutePlanDetail): {
  coordinates: Array<[number, number]>;
  routableStops: RoutableStop[];
} | null {
  const depot = toLngLat(detail.routePlan.depot.latitude, detail.routePlan.depot.longitude);
  if (depot === null) return null;

  const routableStops = detail.stops.flatMap((stop, index) => {
    const coordinate = toLngLat(stop.coordinates.latitude, stop.coordinates.longitude);
    return coordinate === null ? [] : [{ inputIndex: index + 1, stop }];
  });
  if (routableStops.length < 2 || routableStops.length + 1 > MAX_TRIP_COORDINATES) return null;

  return {
    coordinates: [
      depot,
      ...routableStops.map(({ stop }) => {
        const coordinate = toLngLat(stop.coordinates.latitude, stop.coordinates.longitude);
        if (coordinate === null) throw new Error('Routable OSRM Trip stop lost coordinates during request mapping.');
        return coordinate;
      }),
    ],
    routableStops,
  };
}

function buildTripUrl(
  baseUrl: string,
  detail: RoutePlanDetail,
  coordinates: Array<[number, number]>,
): string {
  const coordinatePath = coordinates
    .map(([longitude, latitude]) => `${longitude},${latitude}`)
    .join(';');
  const roundtrip = detail.routePlan.routeEndMode === 'RETURN_TO_DEPOT' ? 'true' : 'false';
  return `${baseUrl}/trip/v1/driving/${coordinatePath}?roundtrip=${roundtrip}&source=first&destination=any&overview=false&steps=false`;
}

function buildOptimizationResult(
  detail: RoutePlanDetail,
  routableStops: RoutableStop[],
  waypoints: OsrmTripWaypoint[],
): RouteOptimizationResult | null {
  if (waypoints.length !== routableStops.length + 1) return null;
  const depotWaypoint = waypoints[0];
  if (depotWaypoint === undefined || depotWaypoint.trips_index !== 0 || depotWaypoint.waypoint_index !== 0) {
    return null;
  }

  const ordered = routableStops
    .map((entry, index) => {
      const waypoint = waypoints[index + 1];
      return waypoint === undefined ? null : { entry, waypoint };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (
    ordered.length !== routableStops.length
    || ordered.some(({ waypoint }) => waypoint.trips_index !== 0 || waypoint.waypoint_index <= 0)
    || new Set(ordered.map(({ waypoint }) => waypoint.waypoint_index)).size !== ordered.length
  ) {
    return null;
  }
  ordered.sort((left, right) => left.waypoint.waypoint_index - right.waypoint.waypoint_index);

  const missingStops = detail.stops
    .filter((stop) => toLngLat(stop.coordinates.latitude, stop.coordinates.longitude) === null)
    .sort((left, right) => left.sequence - right.sequence || left.shopifyOrderGid.localeCompare(right.shopifyOrderGid));

  return {
    missingCoordinateStops: missingStops.length,
    source: 'osrm-trip',
    stops: [...ordered.map(({ entry }) => entry.stop), ...missingStops].map((stop, index) => ({
      deliveryStopId: stop.deliveryStopId,
      sequence: index + 1,
      shopifyOrderGid: stop.shopifyOrderGid,
    })),
  };
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, '');
  if (normalized === '') throw new Error('OSRM Trip base URL must be configured explicitly.');
  return normalized;
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(100, Math.floor(value));
}

function toLngLat(latitude: number | null, longitude: number | null): [number, number] | null {
  if (
    typeof latitude !== 'number'
    || !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || typeof longitude !== 'number'
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
  ) {
    return null;
  }
  return [longitude, latitude];
}

function isOsrmTripResponse(value: unknown): value is OsrmTripResponse {
  const object = objectOrNull(value);
  return object !== null
    && typeof object.code === 'string'
    && Array.isArray(object.trips)
    && Array.isArray(object.waypoints)
    && object.waypoints.every(isOsrmTripWaypoint);
}

function isOsrmTripWaypoint(value: unknown): value is OsrmTripWaypoint {
  const object = objectOrNull(value);
  return object !== null
    && Number.isInteger(object.trips_index)
    && Number.isInteger(object.waypoint_index);
}

function readOsrmCode(value: unknown): string | null {
  const object = objectOrNull(value);
  return object !== null && typeof object.code === 'string' ? object.code : null;
}

function classifyFailure(httpStatus: number, osrmCode: string | null): RouteOptimizationFailureCode {
  if (osrmCode === 'NoSegment' || osrmCode === 'NoTrips') return 'graph_not_ready';
  if (osrmCode === 'InvalidValue' || osrmCode === 'NotImplemented' || osrmCode === 'TooBig') return 'invalid_input';
  if (httpStatus === 408 || httpStatus === 504) return 'solver_timeout';
  if (httpStatus >= 500 || httpStatus === 429) return 'optimizer_unavailable';
  return 'invalid_engine_payload';
}

function describeFailure(httpStatus: number, osrmCode: string | null): string {
  return osrmCode === null
    ? `OSRM Trip request failed with HTTP ${httpStatus}.`
    : `OSRM Trip request failed with ${osrmCode} (HTTP ${httpStatus}).`;
}

function failureOutcome(input: {
  code: RouteOptimizationFailureCode;
  elapsedMs: number;
  httpStatus?: number | undefined;
  message: string;
}): RouteOptimizationOutcome {
  return {
    failure: {
      code: input.code,
      elapsedMs: input.elapsedMs,
      ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
      message: input.message,
    },
    ok: false,
  };
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
