import type { PrismaClient } from '@prisma/client';

import type { AdminRouteGroupDependencies } from '../../routes/admin-route-groups.routes.js';
import { loadGeocodingService, type GeocodingRuntimeEnv } from '../geocoding/geocoding.dependencies.js';
import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from '../shopify/shopify-app-credentials.js';
import { ShopifySessionTokenVerifier } from '../shopify/session-token-verifier.js';
import { OsrmRouteGeometryProvider } from '../route-plans/osrm-route-geometry.client.js';
import {
  CoverageAwareRouteGeometryProvider,
  CoverageAwareRouteOptimizationService,
  hasExplicitCoverageUrls,
  readConfiguredCoverageBaseUrls,
  readDefaultRouteEngineCoverage
} from '../route-plans/route-engine-coverage.js';
import { VroomRouteOptimizationClient } from '../route-plans/vroom-route-optimizer.client.js';
import { PrismaRoutePlanRepository } from '../route-plans/route-plan.repository.js';
import { RoutePlanAdminService } from '../route-plans/route-plan.service.js';
import { loadDriverPushProvider } from './driver-push.provider.js';
import {
  DEFAULT_MAX_CHILD_ROUTE_STOP_DISTANCE_FROM_DEPOT_METERS,
  PrismaRouteGroupingService
} from './route-grouping.service.js';
import type { RouteGroupingService } from './route-grouping.types.js';

export type AdminRouteGroupRuntimeEnv = ShopifyAppCredentialsEnv & GeocodingRuntimeEnv & Partial<Record<
  | 'FIREBASE_PROJECT_ID'
  | 'GOOGLE_APPLICATION_CREDENTIALS'
  | 'OSRM_BASE_URL'
  | 'OSRM_DEFAULT_COVERAGE'
  | 'OSRM_KOREA_BASE_URL'
  | 'OSRM_ONTARIO_BASE_URL'
  | 'OSRM_TIMEOUT_MS'
  | 'ROUTE_GROUPING_MAX_STOP_DISTANCE_METERS'
  | 'ROUTE_OPS_ROUTER_COVERAGE'
  | 'VROOM_BASE_URL'
  | 'VROOM_KOREA_BASE_URL'
  | 'VROOM_ONTARIO_BASE_URL'
  | 'VROOM_TIMEOUT_MS',
  string
>>;

export function loadAdminRouteGroupDependencies(input: {
  env: AdminRouteGroupRuntimeEnv;
  prisma: PrismaClient;
  routeGroupingService?: RouteGroupingService;
}): AdminRouteGroupDependencies | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env);
  if (appCredentials.length === 0) return undefined;

  return {
    geocodingService: loadGeocodingService({ env: input.env, prisma: input.prisma }),
    routeGroupingService: input.routeGroupingService ?? createRouteGroupingService(input),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ appCredentials })
  };
}

export function createRouteGroupingService(input: {
  env: AdminRouteGroupRuntimeEnv;
  prisma: PrismaClient;
}): RouteGroupingService {
  const routeGeometryProvider = readRouteGeometryProvider(input.env);
  const routeGeometryRefresher = routeGeometryProvider === undefined
    ? undefined
    : new RoutePlanAdminService(new PrismaRoutePlanRepository(input.prisma), routeGeometryProvider);
  return new PrismaRouteGroupingService(
    input.prisma,
    loadDriverPushProvider(input.env),
    routeGeometryRefresher,
    readRouteOptimizationService(input.env),
    routeGeometryProvider,
    { maxChildRouteStopDistanceFromDepotMeters: readOptionalNumber(input.env.ROUTE_GROUPING_MAX_STOP_DISTANCE_METERS) ?? DEFAULT_MAX_CHILD_ROUTE_STOP_DISTANCE_FROM_DEPOT_METERS }
  );
}

function readRouteOptimizationService(env: AdminRouteGroupRuntimeEnv) {
  if (hasExplicitCoverageUrls(env, 'VROOM')) {
    const services = Object.fromEntries(
      Object.entries(readConfiguredCoverageBaseUrls(env, 'VROOM')).map(([coverage, baseUrl]) => [
        coverage,
        new VroomRouteOptimizationClient({ baseUrl, ...optionalTimeout(env.VROOM_TIMEOUT_MS) })
      ])
    ) as ConstructorParameters<typeof CoverageAwareRouteOptimizationService>[0]['services'];
    return new CoverageAwareRouteOptimizationService({
      defaultCoverage: readDefaultRouteEngineCoverage(env),
      services
    });
  }

  const vroomBaseUrl = readOptional(env.VROOM_BASE_URL);
  return vroomBaseUrl === undefined
    ? undefined
    : new VroomRouteOptimizationClient({ baseUrl: vroomBaseUrl, ...optionalTimeout(env.VROOM_TIMEOUT_MS) });
}

function readRouteGeometryProvider(env: AdminRouteGroupRuntimeEnv) {
  if (hasExplicitCoverageUrls(env, 'OSRM')) {
    const providers = Object.fromEntries(
      Object.entries(readConfiguredCoverageBaseUrls(env, 'OSRM')).map(([coverage, baseUrl]) => [
        coverage,
        new OsrmRouteGeometryProvider({ baseUrl, ...optionalTimeout(env.OSRM_TIMEOUT_MS) })
      ])
    ) as ConstructorParameters<typeof CoverageAwareRouteGeometryProvider>[0]['providers'];
    return new CoverageAwareRouteGeometryProvider({
      defaultCoverage: readDefaultRouteEngineCoverage(env),
      providers
    });
  }

  const osrmBaseUrl = readOptional(env.OSRM_BASE_URL);
  return osrmBaseUrl === undefined
    ? undefined
    : new OsrmRouteGeometryProvider({ baseUrl: osrmBaseUrl, ...optionalTimeout(env.OSRM_TIMEOUT_MS) });
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

function readOptionalNumber(value: string | undefined): number | undefined {
  const normalized = readOptional(value);
  if (normalized === undefined) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalTimeout(value: string | undefined): { timeoutMs?: number } {
  const timeoutMs = readOptionalNumber(value);
  return timeoutMs === undefined ? {} : { timeoutMs };
}
