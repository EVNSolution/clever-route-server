import type { RoutePlanDetail } from './route-plan.types.js';

type FetchLike = (
  url: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: 'POST';
    signal?: AbortSignal;
  }
) => Promise<Response>;

export type RouteEngineMode = 'fixture' | 'road_graph';
export type RouteEngineObjective = 'minimize_distance' | 'minimize_duration';

export type RouteOptimizationStopSequence = {
  deliveryStopId: string;
  sequence: number;
  shopifyOrderGid: string;
};

export type RouteOptimizationResult = {
  missingCoordinateStops: number;
  source: 'route_engine';
  stops: RouteOptimizationStopSequence[];
};

export type RouteOptimizationFailureCode =
  | 'fallback_not_applied'
  | 'graph_not_ready'
  | 'invalid_engine_payload'
  | 'invalid_input'
  | 'network_error'
  | 'route_engine_unavailable'
  | 'solver_timeout';

export type RouteOptimizationFailure = {
  code: RouteOptimizationFailureCode;
  elapsedMs: number;
  httpStatus?: number | undefined;
  message: string;
};

export type RouteOptimizationOutcome =
  | { failure: RouteOptimizationFailure; ok: false }
  | { ok: true; result: RouteOptimizationResult };

export type RouteOptimizationInput = {
  detail: RoutePlanDetail;
  shopDomain: string;
};

export type RouteOptimizationService = {
  optimizeStopOrder(input: RouteOptimizationInput): Promise<RouteOptimizationResult | null>;
  optimizeStopOrderWithDiagnostics?(input: RouteOptimizationInput): Promise<RouteOptimizationOutcome>;
};

type RouteEngineRouteOptimizationClientOptions = {
  baseUrl: string;
  fetch?: FetchLike | undefined;
  internalToken: string;
  mode?: RouteEngineMode | undefined;
  objective?: RouteEngineObjective | undefined;
  serviceRegion?: string | undefined;
  timeoutMs?: number | undefined;
};

type RoutableStop = {
  stop: RoutePlanDetail['stops'][number];
  stopId: string;
};

type RouteEngineSolveRequest = {
  request_id: string;
  tenant: {
    tenant_id: string;
    service_region?: string;
  };
  depot: {
    depot_id: string;
    lat: number;
    lng: number;
  };
  drivers: Array<{
    capacity: number;
    driver_id: string;
  }>;
  stops: Array<{
    demand: number;
    lat: number;
    lng: number;
    service_seconds: number;
    stop_id: string;
  }>;
  options: {
    mode: RouteEngineMode;
    objective: RouteEngineObjective;
    timeout_ms: number;
  };
};

type RouteEngineSolveResponse = {
  request_id: string;
  result: {
    routes: Array<{
      stop_sequence: Array<{
        sequence: number;
        stop_id: string;
      }>;
    }>;
    unassigned_stop_ids: string[];
  };
  status: 'solved';
};

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_SOLVER_STOPS = 1000;
const ROUTE_ENGINE_CONTRACT_ID_MAX_LENGTH = 128;

export class RouteEngineRouteOptimizationClient implements RouteOptimizationService {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly internalToken: string;
  private readonly mode: RouteEngineMode;
  private readonly objective: RouteEngineObjective;
  private readonly serviceRegion: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: RouteEngineRouteOptimizationClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetch = options.fetch ?? fetch;
    this.internalToken = normalizeInternalToken(options.internalToken);
    this.mode = options.mode ?? 'road_graph';
    this.objective = options.objective ?? 'minimize_duration';
    this.serviceRegion = normalizeOptionalContractValue(options.serviceRegion);
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  }

  async optimizeStopOrder(input: RouteOptimizationInput): Promise<RouteOptimizationResult | null> {
    const outcome = await this.optimizeStopOrderWithDiagnostics(input);
    return outcome.ok ? outcome.result : null;
  }

  async optimizeStopOrderWithDiagnostics(input: RouteOptimizationInput): Promise<RouteOptimizationOutcome> {
    const startedAt = Date.now();
    const request = buildSolveRequest({
      detail: input.detail,
      mode: this.mode,
      objective: this.objective,
      serviceRegion: this.serviceRegion,
      shopDomain: input.shopDomain,
      timeoutMs: this.timeoutMs
    });
    if (request === null) {
      return failureOutcome({
        code: 'invalid_input',
        elapsedMs: elapsedSince(startedAt),
        message: 'Route cannot be optimized because depot/stops are missing valid coordinates or exceed supported limits.'
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/v1/solve`, {
        body: JSON.stringify(request.body),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.internalToken}`,
          'Content-Type': 'application/json',
          'X-Request-Id': request.body.request_id,
          'X-Request-Timeout-Ms': String(this.timeoutMs)
        },
        method: 'POST',
        signal: controller.signal
      });
    } catch (error) {
      return failureOutcome({
        code: isAbortError(error) ? 'solver_timeout' : 'network_error',
        elapsedMs: elapsedSince(startedAt),
        message: isAbortError(error) ? 'route_engine request timed out.' : 'route_engine request failed before a response was received.'
      });
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return failureOutcome({
        code: classifyHttpFailure(response.status, payload),
        elapsedMs: elapsedSince(startedAt),
        httpStatus: response.status,
        message: `route_engine responded with HTTP ${response.status}.`
      });
    }

    if (!isRouteEngineSolveResponse(payload)) {
      return failureOutcome({
        code: 'invalid_engine_payload',
        elapsedMs: elapsedSince(startedAt),
        message: 'route_engine returned an invalid solve payload.'
      });
    }

    const result = buildOptimizationResult(input.detail, request.routableStops, payload);
    if (result === null) {
      return failureOutcome({
        code: 'invalid_engine_payload',
        elapsedMs: elapsedSince(startedAt),
        message: 'route_engine solve payload did not produce an applicable stop sequence.'
      });
    }

    return { ok: true, result };
  }
}

function buildSolveRequest(input: {
  detail: RoutePlanDetail;
  mode: RouteEngineMode;
  objective: RouteEngineObjective;
  serviceRegion: string | undefined;
  shopDomain: string;
  timeoutMs: number;
}): { body: RouteEngineSolveRequest; routableStops: RoutableStop[] } | null {
  const depot = readDepotCoordinates(input.detail);
  if (depot === null) {
    return null;
  }

  const routableStops = input.detail.stops.flatMap((stop, index) => {
    const coordinates = readStopCoordinates(stop);
    if (coordinates === null) {
      return [];
    }
    return [{ stop, stopId: `route-stop-${index + 1}` }];
  });
  if (routableStops.length === 0 || routableStops.length > MAX_SOLVER_STOPS) {
    return null;
  }

  const tenant = {
    tenant_id: toContractIdentifier(input.shopDomain, 'tenant'),
    ...(input.serviceRegion === undefined ? {} : { service_region: input.serviceRegion })
  };

  return {
    body: {
      request_id: toContractIdentifier(`route-plan:${input.detail.routePlan.id}:optimize`, 'request'),
      tenant,
      depot: {
        depot_id: toContractIdentifier(`depot:${input.detail.routePlan.id}`, 'depot'),
        lat: depot.latitude,
        lng: depot.longitude
      },
      drivers: [
        {
          capacity: Math.max(1, routableStops.length),
          driver_id: 'driver-1'
        }
      ],
      stops: routableStops.map(({ stop, stopId }) => {
        const coordinates = readStopCoordinates(stop);
        if (coordinates === null) {
          throw new Error('Routable route_engine stop lost coordinates during request mapping.');
        }
        return {
          demand: 1,
          lat: coordinates.latitude,
          lng: coordinates.longitude,
          service_seconds: 0,
          stop_id: stopId
        };
      }),
      options: {
        mode: input.mode,
        objective: input.objective,
        timeout_ms: input.timeoutMs
      }
    },
    routableStops
  };
}

function buildOptimizationResult(
  detail: RoutePlanDetail,
  routableStops: RoutableStop[],
  payload: RouteEngineSolveResponse
): RouteOptimizationResult | null {
  const routableByStopId = new Map(routableStops.map((entry) => [entry.stopId, entry.stop]));
  const seen = new Set<string>();
  const orderedStops: RoutePlanDetail['stops'] = [];

  for (const route of payload.result.routes) {
    const routeStops = [...route.stop_sequence].sort((left, right) => left.sequence - right.sequence || left.stop_id.localeCompare(right.stop_id));
    for (const routeStop of routeStops) {
      appendRoutableStop(routeStop.stop_id, routableByStopId, seen, orderedStops);
    }
  }

  for (const stopId of payload.result.unassigned_stop_ids) {
    appendRoutableStop(stopId, routableByStopId, seen, orderedStops);
  }

  for (const { stop, stopId } of routableStops) {
    if (!seen.has(stopId)) {
      orderedStops.push(stop);
      seen.add(stopId);
    }
  }

  if (orderedStops.length === 0) {
    return null;
  }

  const missingStops = detail.stops
    .filter((stop) => readStopCoordinates(stop) === null)
    .sort((left, right) => left.sequence - right.sequence || left.shopifyOrderGid.localeCompare(right.shopifyOrderGid));

  return {
    missingCoordinateStops: missingStops.length,
    source: 'route_engine',
    stops: [...orderedStops, ...missingStops].map((stop, index) => ({
      deliveryStopId: stop.deliveryStopId,
      sequence: index + 1,
      shopifyOrderGid: stop.shopifyOrderGid
    }))
  };
}

function appendRoutableStop(
  stopId: string,
  routableByStopId: Map<string, RoutePlanDetail['stops'][number]>,
  seen: Set<string>,
  orderedStops: RoutePlanDetail['stops']
): void {
  if (seen.has(stopId)) {
    return;
  }
  const stop = routableByStopId.get(stopId);
  if (stop === undefined) {
    return;
  }
  orderedStops.push(stop);
  seen.add(stopId);
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error('ROUTE_ENGINE_BASE_URL must be configured explicitly.');
  }
  return trimmed.replace(/\/+$/u, '');
}

function normalizeInternalToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error('ROUTE_ENGINE_INTERNAL_TOKEN is required when ROUTE_ENGINE_BASE_URL is set.');
  }
  return trimmed;
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(120000, Math.max(100, Math.floor(value)));
}

function normalizeOptionalContractValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  return toContractIdentifier(trimmed, 'region');
}

function toContractIdentifier(value: string, fallbackPrefix: string): string {
  const trimmed = value.trim();
  const normalized = trimmed === '' ? fallbackPrefix : trimmed;
  return normalized.length <= ROUTE_ENGINE_CONTRACT_ID_MAX_LENGTH
    ? normalized
    : `${fallbackPrefix}:${normalized.slice(normalized.length - (ROUTE_ENGINE_CONTRACT_ID_MAX_LENGTH - fallbackPrefix.length - 1))}`;
}

function readDepotCoordinates(detail: RoutePlanDetail): { latitude: number; longitude: number } | null {
  const latitude = detail.routePlan.depot.latitude;
  const longitude = detail.routePlan.depot.longitude;
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return null;
  }
  return { latitude, longitude };
}

function readStopCoordinates(stop: RoutePlanDetail['stops'][number]): { latitude: number; longitude: number } | null {
  const latitude = stop.coordinates.latitude;
  const longitude = stop.coordinates.longitude;
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return null;
  }
  return { latitude, longitude };
}

function isValidLatitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

function isRouteEngineSolveResponse(value: unknown): value is RouteEngineSolveResponse {
  const object = objectOrNull(value);
  const result = objectOrNull(object?.result);
  return (
    object?.status === 'solved' &&
    typeof object.request_id === 'string' &&
    result !== null &&
    Array.isArray(result.routes) &&
    result.routes.every(isRouteEngineRoute) &&
    Array.isArray(result.unassigned_stop_ids) &&
    result.unassigned_stop_ids.every((stopId) => typeof stopId === 'string')
  );
}

function isRouteEngineRoute(value: unknown): value is RouteEngineSolveResponse['result']['routes'][number] {
  const object = objectOrNull(value);
  return object !== null && Array.isArray(object.stop_sequence) && object.stop_sequence.every(isRouteEngineRouteStop);
}

function isRouteEngineRouteStop(value: unknown): value is RouteEngineSolveResponse['result']['routes'][number]['stop_sequence'][number] {
  const object = objectOrNull(value);
  if (object === null || typeof object.stop_id !== 'string') {
    return false;
  }
  const sequence = object.sequence;
  return typeof sequence === 'number' && Number.isInteger(sequence) && sequence >= 1;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function failureOutcome(failure: RouteOptimizationFailure): RouteOptimizationOutcome {
  return { failure, ok: false };
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function classifyHttpFailure(status: number, payload: unknown): RouteOptimizationFailureCode {
  if (status === 408 || status === 504) {
    return 'solver_timeout';
  }
  if (status === 503 && payloadText(payload).toLowerCase().includes('graph')) {
    return 'graph_not_ready';
  }
  if (status === 503) {
    return 'route_engine_unavailable';
  }
  return 'route_engine_unavailable';
}

function payloadText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
