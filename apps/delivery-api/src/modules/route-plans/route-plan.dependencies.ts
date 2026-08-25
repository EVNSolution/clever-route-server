import type { PrismaClient } from '@prisma/client';

import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from '../shopify/shopify-app-credentials.js';
import { ShopifySessionTokenVerifier } from '../shopify/session-token-verifier.js';
import { OsrmRouteGeometryProvider } from './osrm-route-geometry.client.js';
import {
  CoverageAwareRouteGeometryProvider,
  hasExplicitCoverageUrls,
  readConfiguredCoverageBaseUrls,
  readDefaultRouteEngineCoverage,
  type RouteEngineRuntimeEnv,
} from './route-engine-coverage.js';
import { PrismaRouteOptimizationJobRepository } from './route-optimization-job.repository.js';
import { RouteOptimizationJobService } from './route-optimization-job.service.js';
import { PrismaRoutePlanRepository } from './route-plan.repository.js';
import { RoutePlanAdminService } from './route-plan.service.js';
import type { AdminRoutePlanDependencies } from '../../routes/admin-route-plans.routes.js';
import { PrismaRouteTrackingService } from '../route-tracking/route-tracking.service.js';
import { OsrmRouteTrackingRoadMatchProvider } from '../route-tracking/route-tracking.road-match.js';
import type { RouteTrackingStreamHub } from '../route-tracking/route-tracking.stream.js';
import { PrismaDriverSyncHealthService } from '../driver/driver-sync-health.service.js';
import type { PrismaOperationalAlertRepository } from '../notifications/operational-alert.repository.js';
import { PrismaRouteOperationalStateService } from '../route-tracking/route-operational-state.service.js';

export type AdminRoutePlanRuntimeEnv = ShopifyAppCredentialsEnv & RouteEngineRuntimeEnv & Partial<Record<'OSRM_TIMEOUT_MS', string>>;

export function loadAdminRoutePlanDependencies(input: {
  env: AdminRoutePlanRuntimeEnv;
  prisma: PrismaClient;
  operationalAlertRepository: PrismaOperationalAlertRepository;
  routeTrackingStreamHub?: RouteTrackingStreamHub;
}): AdminRoutePlanDependencies | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env);

  if (appCredentials.length === 0) {
    return undefined;
  }

  const repository = new PrismaRoutePlanRepository(input.prisma);
  const routeGeometryProvider = createAdminRouteGeometryProvider(input.env);
  const routeOptimizationJobService = new RouteOptimizationJobService(
    new PrismaRouteOptimizationJobRepository(input.prisma)
  );
  const syncHealthService = new PrismaDriverSyncHealthService(input.prisma, input.operationalAlertRepository);
  return {
    routePlanService: new RoutePlanAdminService(
      repository,
      routeGeometryProvider,
      routeOptimizationJobService,
      input.routeTrackingStreamHub
    ),
    routeTrackingService: new PrismaRouteTrackingService(input.prisma, {
      roadMatchProvider: createRouteTrackingRoadMatchProvider(input.env)
    }),
    operationalStateService: new PrismaRouteOperationalStateService(input.prisma, syncHealthService, input.operationalAlertRepository),
    ...(input.routeTrackingStreamHub === undefined ? {} : { routeTrackingStreamHub: input.routeTrackingStreamHub }),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ appCredentials })
  };
}

export function createAdminRouteGeometryProvider(env: AdminRoutePlanRuntimeEnv) {
  if (hasExplicitCoverageUrls(env, 'OSRM')) {
    const providers = Object.fromEntries(
      Object.entries(readConfiguredCoverageBaseUrls(env, 'OSRM')).map(([coverage, baseUrl]) => [
        coverage,
        new OsrmRouteGeometryProvider({ baseUrl, ...optionalTimeout(env.OSRM_TIMEOUT_MS) }),
      ]),
    ) as ConstructorParameters<typeof CoverageAwareRouteGeometryProvider>[0]['providers'];
    return new CoverageAwareRouteGeometryProvider({
      defaultCoverage: readDefaultRouteEngineCoverage(env),
      providers,
    });
  }

  const osrmBaseUrl = readOptional(env.OSRM_BASE_URL);
  return osrmBaseUrl === undefined
    ? undefined
    : new OsrmRouteGeometryProvider({ baseUrl: osrmBaseUrl, ...optionalTimeout(env.OSRM_TIMEOUT_MS) });
}

function createRouteTrackingRoadMatchProvider(env: AdminRoutePlanRuntimeEnv): OsrmRouteTrackingRoadMatchProvider | undefined {
  const baseUrls = readConfiguredCoverageBaseUrls(env, 'OSRM');
  if (Object.keys(baseUrls).length === 0) return undefined;
  return new OsrmRouteTrackingRoadMatchProvider({
    baseUrls,
    ...optionalTimeout(env.OSRM_TIMEOUT_MS)
  });
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}

function optionalTimeout(value: string | undefined): { timeoutMs?: number } {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? { timeoutMs: parsed } : {};
}
