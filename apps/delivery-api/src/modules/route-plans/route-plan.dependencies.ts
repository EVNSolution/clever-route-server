import type { PrismaClient } from '@prisma/client';

import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from '../shopify/shopify-app-credentials.js';
import { ShopifySessionTokenVerifier } from '../shopify/session-token-verifier.js';
import { OsrmRouteGeometryProvider } from './osrm-route-geometry.client.js';
import { PrismaRouteOptimizationJobRepository } from './route-optimization-job.repository.js';
import { RouteOptimizationJobService } from './route-optimization-job.service.js';
import { PrismaRoutePlanRepository } from './route-plan.repository.js';
import { RoutePlanAdminService } from './route-plan.service.js';
import type { AdminRoutePlanDependencies } from '../../routes/admin-route-plans.routes.js';

export type AdminRoutePlanRuntimeEnv = ShopifyAppCredentialsEnv & Partial<Record<'OSRM_BASE_URL', string>>;

export function loadAdminRoutePlanDependencies(input: {
  env: AdminRoutePlanRuntimeEnv;
  prisma: PrismaClient;
}): AdminRoutePlanDependencies | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env);

  if (appCredentials.length === 0) {
    return undefined;
  }

  const repository = new PrismaRoutePlanRepository(input.prisma);
  const osrmBaseUrl = readOptional(input.env.OSRM_BASE_URL);
  const routeGeometryProvider =
    osrmBaseUrl === undefined ? undefined : new OsrmRouteGeometryProvider({ baseUrl: osrmBaseUrl });
  const routeOptimizationJobService = new RouteOptimizationJobService(
    new PrismaRouteOptimizationJobRepository(input.prisma)
  );
  return {
    routePlanService: new RoutePlanAdminService(repository, routeGeometryProvider, routeOptimizationJobService),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ appCredentials })
  };
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}
