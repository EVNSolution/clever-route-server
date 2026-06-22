import type { RoutePlanDetail } from './route-plan.types.js';
import type {
  RouteOptimizationFailure,
  RouteOptimizationFailureCode,
  RouteOptimizationInput,
  RouteOptimizationOutcome,
  RouteOptimizationResult,
  RouteOptimizationService,
} from './route-optimization.types.js';

type FetchLike = (
  url: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: 'POST';
    signal?: AbortSignal;
  },
) => Promise<Response>;

type VroomRouteOptimizationClientOptions = {
  baseUrl: string;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
};

type RoutableStop = {
  jobId: number;
  stop: RoutePlanDetail['stops'][number];
};

type VroomSolveRequest = {
  jobs: Array<{
    delivery: [number];
    id: number;
    location: [number, number];
    service: number;
  }>;
  vehicles: Array<{
    capacity: [number];
    end?: [number, number];
    id: number;
    profile: 'car';
    start: [number, number];
  }>;
};

type VroomSolveResponse = {
  code: number;
  routes: Array<{
    steps: Array<{
      id?: number;
      job?: number;
      type: string;
    }>;
  }>;
  unassigned: Array<{ id: number }>;
};

const DEFAULT_TIMEOUT_MS = 180000;
const MAX_SOLVER_STOPS = 1000;

export class VroomRouteOptimizationClient implements RouteOptimizationService {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: VroomRouteOptimizationClientOptions) {
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
    const request = buildSolveRequest(input.detail);
    if (request === null) {
      return failureOutcome({
        code: 'invalid_input',
        elapsedMs: elapsedSince(startedAt),
        message: 'Route cannot be optimized by VROOM because depot/stops are missing valid coordinates or exceed supported limits.',
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/`, {
        body: JSON.stringify(request.body),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: controller.signal,
      });
    } catch (error) {
      return failureOutcome({
        code: isAbortError(error) ? 'solver_timeout' : 'network_error',
        elapsedMs: elapsedSince(startedAt),
        message: isAbortError(error) ? 'VROOM request timed out.' : 'VROOM request failed before a response was received.',
      });
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return failureOutcome({
        code: classifyHttpFailure(response.status),
        elapsedMs: elapsedSince(startedAt),
        httpStatus: response.status,
        message: describeHttpFailure(response.status, payload),
      });
    }

    if (!isVroomSolveResponse(payload)) {
      return failureOutcome({
        code: 'invalid_engine_payload',
        elapsedMs: elapsedSince(startedAt),
        message: 'VROOM returned an invalid solve payload.',
      });
    }
    if (payload.code !== 0 || payload.unassigned.length > 0) {
      return failureOutcome({
        code: 'invalid_engine_payload',
        elapsedMs: elapsedSince(startedAt),
        message: 'VROOM returned unassigned jobs; no partial route was applied.',
      });
    }

    const result = buildOptimizationResult(input.detail, request.routableStops, payload);
    if (result === null) {
      return failureOutcome({
        code: 'invalid_engine_payload',
        elapsedMs: elapsedSince(startedAt),
        message: 'VROOM solve payload did not produce an applicable stop sequence.',
      });
    }

    return { ok: true, result };
  }
}

function buildSolveRequest(detail: RoutePlanDetail): { body: VroomSolveRequest; routableStops: RoutableStop[] } | null {
  const depot = readDepotCoordinates(detail);
  if (depot === null) return null;

  const routableStops = detail.stops.flatMap((stop, index) => {
    if (readStopCoordinates(stop) === null) return [];
    return [{ jobId: index + 1, stop }];
  });
  if (routableStops.length === 0 || routableStops.length > MAX_SOLVER_STOPS) return null;

  const depotLocation = toVroomLocation(depot);
  return {
    body: {
      jobs: routableStops.map(({ jobId, stop }) => {
        const coordinates = readStopCoordinates(stop);
        if (coordinates === null) {
          throw new Error('Routable VROOM stop lost coordinates during request mapping.');
        }
        return {
          delivery: [1],
          id: jobId,
          location: toVroomLocation(coordinates),
          service: 0,
        };
      }),
      vehicles: [
        {
          capacity: [Math.max(1, routableStops.length)],
          ...(detail.routePlan.routeEndMode === 'RETURN_TO_DEPOT' ? { end: depotLocation } : {}),
          id: 1,
          profile: 'car',
          start: depotLocation,
        },
      ],
    },
    routableStops,
  };
}

function buildOptimizationResult(
  detail: RoutePlanDetail,
  routableStops: RoutableStop[],
  payload: VroomSolveResponse,
): RouteOptimizationResult | null {
  const routableByJobId = new Map(routableStops.map((entry) => [entry.jobId, entry.stop]));
  const seen = new Set<number>();
  const orderedStops: RoutePlanDetail['stops'] = [];

  for (const route of payload.routes) {
    for (const step of route.steps) {
      if (step.type !== 'job') continue;
      const jobId = step.job ?? step.id;
      if (jobId === undefined || seen.has(jobId)) return null;
      const stop = routableByJobId.get(jobId);
      if (stop === undefined) return null;
      orderedStops.push(stop);
      seen.add(jobId);
    }
  }

  if (seen.size !== routableStops.length) return null;

  const missingStops = detail.stops
    .filter((stop) => readStopCoordinates(stop) === null)
    .sort((left, right) => left.sequence - right.sequence || left.shopifyOrderGid.localeCompare(right.shopifyOrderGid));

  return {
    missingCoordinateStops: missingStops.length,
    source: 'vroom',
    stops: [...orderedStops, ...missingStops].map((stop, index) => ({
      deliveryStopId: stop.deliveryStopId,
      sequence: index + 1,
      shopifyOrderGid: stop.shopifyOrderGid,
    })),
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error('VROOM_BASE_URL must be configured explicitly.');
  }
  return trimmed.replace(/\/+$/u, '');
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(DEFAULT_TIMEOUT_MS, Math.max(100, Math.floor(value)));
}

function toVroomLocation(coordinates: { latitude: number; longitude: number }): [number, number] {
  return [coordinates.longitude, coordinates.latitude];
}

function readDepotCoordinates(detail: RoutePlanDetail): { latitude: number; longitude: number } | null {
  const latitude = detail.routePlan.depot.latitude;
  const longitude = detail.routePlan.depot.longitude;
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  return { latitude, longitude };
}

function readStopCoordinates(stop: RoutePlanDetail['stops'][number]): { latitude: number; longitude: number } | null {
  const latitude = stop.coordinates.latitude;
  const longitude = stop.coordinates.longitude;
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  return { latitude, longitude };
}

function isValidLatitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

function isVroomSolveResponse(value: unknown): value is VroomSolveResponse {
  const object = objectOrNull(value);
  return (
    object !== null &&
    typeof object.code === 'number' &&
    Array.isArray(object.routes) &&
    object.routes.every(isVroomRoute) &&
    Array.isArray(object.unassigned) &&
    object.unassigned.every(isVroomUnassignedJob)
  );
}

function isVroomRoute(value: unknown): value is VroomSolveResponse['routes'][number] {
  const object = objectOrNull(value);
  return object !== null && Array.isArray(object.steps) && object.steps.every(isVroomStep);
}

function isVroomStep(value: unknown): value is VroomSolveResponse['routes'][number]['steps'][number] {
  const object = objectOrNull(value);
  if (object === null || typeof object.type !== 'string') return false;
  if (object.type !== 'job') return true;
  const jobId = object.job ?? object.id;
  return typeof jobId === 'number' && Number.isInteger(jobId) && jobId > 0;
}

function isVroomUnassignedJob(value: unknown): value is VroomSolveResponse['unassigned'][number] {
  const object = objectOrNull(value);
  return object !== null && typeof object.id === 'number' && Number.isInteger(object.id) && object.id > 0;
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

function classifyHttpFailure(status: number): RouteOptimizationFailureCode {
  if (status === 400 || status === 422) return 'invalid_input';
  if (status === 408 || status === 504) return 'solver_timeout';
  return 'optimizer_unavailable';
}

function describeHttpFailure(status: number, payload: unknown): string {
  const message = readVroomErrorMessage(payload);
  return message === '' ? `VROOM responded with HTTP ${status}.` : `VROOM responded with HTTP ${status}: ${message}`;
}

function readVroomErrorMessage(payload: unknown): string {
  const object = objectOrNull(payload);
  const error = object?.error;
  if (typeof error === 'string') return error.trim();
  if (typeof object?.message === 'string') return object.message.trim();
  return '';
}
