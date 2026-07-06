import type { RouteOptimizationInput, RouteOptimizationOutcome, RouteOptimizationResult, RouteOptimizationService } from './route-optimization.types.js';
import type { RouteGeometryProvider } from './route-plan.service.js';
import type { RoutePlanDetail, RoutePlanRouteResult } from './route-plan.types.js';

export type RouteEngineCoverage = 'ontario' | 'korea';

export type RouteEngineCoverageDefinition = {
  bounds: {
    maxLatitude: number;
    maxLongitude: number;
    minLatitude: number;
    minLongitude: number;
  };
  id: RouteEngineCoverage;
  label: string;
};

export type RouteEngineRuntimeEnv = Partial<Record<
  | 'OSRM_BASE_URL'
  | 'OSRM_DEFAULT_COVERAGE'
  | 'OSRM_KOREA_BASE_URL'
  | 'OSRM_ONTARIO_BASE_URL'
  | 'ROUTE_OPS_ROUTER_COVERAGE'
  | 'VROOM_BASE_URL'
  | 'VROOM_KOREA_BASE_URL'
  | 'VROOM_ONTARIO_BASE_URL',
  string
>>;

export type CoverageAwareRouteGeometryProviderOptions = {
  defaultCoverage?: RouteEngineCoverage | undefined;
  providers: Partial<Record<RouteEngineCoverage, RouteGeometryProvider>>;
};

export type CoverageAwareRouteOptimizationServiceOptions = {
  defaultCoverage?: RouteEngineCoverage | undefined;
  services: Partial<Record<RouteEngineCoverage, RouteOptimizationService>>;
};

export type RouteEngineRegistrySummary = {
  coverage: string | null;
  coverages?: string[] | undefined;
  provider: 'osrm' | null;
  status: 'configured' | 'not_configured';
};

type Coordinate = {
  latitude: number;
  longitude: number;
};

type CoverageSelection =
  | { coverage: RouteEngineCoverage; ok: true }
  | { code: 'mixed_coverage' | 'unsupported_coverage' | 'coverage_not_configured'; message: string; ok: false };

export const ROUTE_ENGINE_COVERAGES: Record<RouteEngineCoverage, RouteEngineCoverageDefinition> = {
  ontario: {
    bounds: {
      maxLatitude: 57.6,
      maxLongitude: -74.0,
      minLatitude: 41.0,
      minLongitude: -95.5,
    },
    id: 'ontario',
    label: 'Ontario',
  },
  korea: {
    bounds: {
      maxLatitude: 39.6,
      maxLongitude: 132.0,
      minLatitude: 33.0,
      minLongitude: 124.0,
    },
    id: 'korea',
    label: 'South Korea',
  },
};

export const ROUTE_ENGINE_COVERAGE_ORDER: readonly RouteEngineCoverage[] = ['ontario', 'korea'];

export class CoverageAwareRouteGeometryProvider implements RouteGeometryProvider {
  private readonly defaultCoverage: RouteEngineCoverage | undefined;
  private readonly providers: Partial<Record<RouteEngineCoverage, RouteGeometryProvider>>;

  constructor(options: CoverageAwareRouteGeometryProviderOptions) {
    this.providers = { ...options.providers };
    this.defaultCoverage = options.defaultCoverage;
  }

  async buildRoute(input: RoutePlanDetail): Promise<RoutePlanRouteResult> {
    const selection = selectCoverageForRoutePlan(input, configuredCoverageIds(this.providers), this.defaultCoverage);
    if (!selection.ok) {
      throw new Error(selection.message);
    }
    const provider = this.providers[selection.coverage];
    if (provider === undefined) {
      throw new Error(`Route geometry coverage is not configured: ${selection.coverage}`);
    }
    return provider.buildRoute(input);
  }
}

export class CoverageAwareRouteOptimizationService implements RouteOptimizationService {
  private readonly defaultCoverage: RouteEngineCoverage | undefined;
  private readonly services: Partial<Record<RouteEngineCoverage, RouteOptimizationService>>;

  constructor(options: CoverageAwareRouteOptimizationServiceOptions) {
    this.services = { ...options.services };
    this.defaultCoverage = options.defaultCoverage;
  }

  async optimizeStopOrder(input: RouteOptimizationInput): Promise<RouteOptimizationResult | null> {
    const outcome = await this.optimizeStopOrderWithDiagnostics(input);
    return outcome.ok ? outcome.result : null;
  }

  async optimizeStopOrderWithDiagnostics(input: RouteOptimizationInput): Promise<RouteOptimizationOutcome> {
    const startedAt = Date.now();
    const selection = selectCoverageForRoutePlan(input.detail, configuredCoverageIds(this.services), this.defaultCoverage);
    if (!selection.ok) {
      return {
        failure: {
          code: selection.code === 'coverage_not_configured' ? 'optimizer_unavailable' : 'invalid_input',
          elapsedMs: Math.max(0, Date.now() - startedAt),
          message: selection.message,
        },
        ok: false,
      };
    }
    const service = this.services[selection.coverage];
    if (service === undefined) {
      return {
        failure: {
          code: 'optimizer_unavailable',
          elapsedMs: Math.max(0, Date.now() - startedAt),
          message: `Route optimization coverage is not configured: ${selection.coverage}`,
        },
        ok: false,
      };
    }
    if (service.optimizeStopOrderWithDiagnostics !== undefined) {
      return service.optimizeStopOrderWithDiagnostics(input);
    }
    const result = await service.optimizeStopOrder(input);
    if (result === null) {
      return {
        failure: {
          code: 'fallback_not_applied',
          elapsedMs: Math.max(0, Date.now() - startedAt),
          message: `Route optimization for ${selection.coverage} did not return an optimizer result.`,
        },
        ok: false,
      };
    }
    return { ok: true, result };
  }
}

export function hasExplicitCoverageUrls(env: RouteEngineRuntimeEnv, prefix: 'OSRM' | 'VROOM'): boolean {
  return ROUTE_ENGINE_COVERAGE_ORDER.some((coverage) => readCoverageBaseUrl(env, prefix, coverage) !== undefined);
}

export function readDefaultRouteEngineCoverage(env: RouteEngineRuntimeEnv): RouteEngineCoverage | undefined {
  return parseRouteEngineCoverage(env.OSRM_DEFAULT_COVERAGE) ?? parseRouteEngineCoverage(env.ROUTE_OPS_ROUTER_COVERAGE);
}

export function readLegacyRouteEngineCoverage(env: RouteEngineRuntimeEnv): RouteEngineCoverage {
  return readDefaultRouteEngineCoverage(env) ?? 'ontario';
}

export function readRouteEngineRegistrySummary(env: RouteEngineRuntimeEnv): RouteEngineRegistrySummary {
  const explicitCoverages = readConfiguredCoverages(env, 'OSRM');
  if (explicitCoverages.length > 0) {
    return {
      coverage: readDefaultRouteEngineCoverage(env) ?? explicitCoverages[0] ?? null,
      coverages: explicitCoverages,
      provider: 'osrm',
      status: 'configured',
    };
  }

  if (readOptional(env.OSRM_BASE_URL) !== undefined) {
    return {
      coverage: readLegacyRouteEngineCoverage(env),
      provider: 'osrm',
      status: 'configured',
    };
  }

  return { coverage: null, provider: null, status: 'not_configured' };
}

export function readConfiguredCoverageBaseUrls(
  env: RouteEngineRuntimeEnv,
  prefix: 'OSRM' | 'VROOM',
): Partial<Record<RouteEngineCoverage, string>> {
  const urls: Partial<Record<RouteEngineCoverage, string>> = {};
  for (const coverage of ROUTE_ENGINE_COVERAGE_ORDER) {
    const explicit = readCoverageBaseUrl(env, prefix, coverage);
    if (explicit !== undefined) {
      urls[coverage] = explicit;
    }
  }

  const legacy = readOptional(prefix === 'OSRM' ? env.OSRM_BASE_URL : env.VROOM_BASE_URL);
  if (legacy !== undefined) {
    const legacyCoverage = readLegacyRouteEngineCoverage(env);
    urls[legacyCoverage] ??= legacy;
  }

  return urls;
}

export function selectCoverageForRoutePlan(
  detail: RoutePlanDetail,
  configuredCoverages: readonly RouteEngineCoverage[],
  defaultCoverage?: RouteEngineCoverage,
): CoverageSelection {
  if (configuredCoverages.length === 0) {
    return {
      code: 'coverage_not_configured',
      message: 'No route engine coverage is configured.',
      ok: false,
    };
  }

  const coordinates = collectValidRouteCoordinates(detail);
  if (coordinates.length === 0) {
    const fallback = chooseDefaultCoverage(configuredCoverages, defaultCoverage);
    return fallback === undefined
      ? {
          code: 'coverage_not_configured',
          message: 'No default route engine coverage is configured for routes without valid coordinates.',
          ok: false,
        }
      : { coverage: fallback, ok: true };
  }

  const candidates = configuredCoverages.filter((coverage) => coordinates.every((coordinate) => coordinateInCoverage(coordinate, coverage)));
  if (candidates.length > 0) {
    return { coverage: chooseDefaultCoverage(candidates, defaultCoverage) ?? candidates[0]!, ok: true };
  }

  const perPointMatches = coordinates.map((coordinate) => configuredCoverages.filter((coverage) => coordinateInCoverage(coordinate, coverage)));
  if (perPointMatches.every((matches) => matches.length > 0)) {
    return {
      code: 'mixed_coverage',
      message: 'Route points span multiple configured routing coverages; split the route before optimizing.',
      ok: false,
    };
  }

  return {
    code: 'unsupported_coverage',
    message: 'Route points are outside the configured routing coverages.',
    ok: false,
  };
}

export function coordinateInCoverage(coordinate: Coordinate, coverage: RouteEngineCoverage): boolean {
  const { bounds } = ROUTE_ENGINE_COVERAGES[coverage];
  return (
    coordinate.latitude >= bounds.minLatitude &&
    coordinate.latitude <= bounds.maxLatitude &&
    coordinate.longitude >= bounds.minLongitude &&
    coordinate.longitude <= bounds.maxLongitude
  );
}

export function parseRouteEngineCoverage(value: string | undefined): RouteEngineCoverage | undefined {
  const normalized = readOptional(value)?.toLowerCase();
  if (normalized === undefined) return undefined;
  return (ROUTE_ENGINE_COVERAGE_ORDER as readonly string[]).includes(normalized)
    ? normalized as RouteEngineCoverage
    : undefined;
}

function readConfiguredCoverages(env: RouteEngineRuntimeEnv, prefix: 'OSRM' | 'VROOM'): string[] {
  return ROUTE_ENGINE_COVERAGE_ORDER.filter((coverage) => readCoverageBaseUrl(env, prefix, coverage) !== undefined);
}

function readCoverageBaseUrl(
  env: RouteEngineRuntimeEnv,
  prefix: 'OSRM' | 'VROOM',
  coverage: RouteEngineCoverage,
): string | undefined {
  const key = `${prefix}_${coverage.toUpperCase()}_BASE_URL` as keyof RouteEngineRuntimeEnv;
  return readOptional(env[key]);
}

function configuredCoverageIds<T>(record: Partial<Record<RouteEngineCoverage, T>>): RouteEngineCoverage[] {
  return ROUTE_ENGINE_COVERAGE_ORDER.filter((coverage) => record[coverage] !== undefined);
}

function chooseDefaultCoverage(
  candidates: readonly RouteEngineCoverage[],
  defaultCoverage: RouteEngineCoverage | undefined,
): RouteEngineCoverage | undefined {
  if (defaultCoverage !== undefined && candidates.includes(defaultCoverage)) return defaultCoverage;
  return candidates[0];
}

function collectValidRouteCoordinates(detail: RoutePlanDetail): Coordinate[] {
  const coordinates: Coordinate[] = [];
  pushCoordinate(coordinates, detail.routePlan.depot.latitude, detail.routePlan.depot.longitude);
  for (const stop of detail.stops) {
    pushCoordinate(coordinates, stop.coordinates.latitude, stop.coordinates.longitude);
  }
  return coordinates;
}

function pushCoordinate(output: Coordinate[], latitude: number | null, longitude: number | null): void {
  if (isValidLatitude(latitude) && isValidLongitude(longitude)) {
    output.push({ latitude, longitude });
  }
}

function isValidLatitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}
