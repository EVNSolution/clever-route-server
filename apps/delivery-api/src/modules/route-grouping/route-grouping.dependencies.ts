import type { PrismaClient } from '@prisma/client';

import type { AdminRouteGroupDependencies } from '../../routes/admin-route-groups.routes.js';
import { loadShopifyAppCredentials, type ShopifyAppCredentialsEnv } from '../shopify/shopify-app-credentials.js';
import { ShopifySessionTokenVerifier } from '../shopify/session-token-verifier.js';
import { OsrmRouteGeometryProvider } from '../route-plans/osrm-route-geometry.client.js';
import { VroomRouteOptimizationClient } from '../route-plans/vroom-route-optimizer.client.js';
import { loadDriverPushProvider } from './driver-push.provider.js';
import {
  DEFAULT_MAX_CHILD_ROUTE_STOP_DISTANCE_FROM_DEPOT_METERS,
  PrismaRouteGroupingService
} from './route-grouping.service.js';

export type AdminRouteGroupRuntimeEnv = ShopifyAppCredentialsEnv & Partial<Record<
  | 'FIREBASE_PROJECT_ID'
  | 'GOOGLE_APPLICATION_CREDENTIALS'
  | 'OSRM_BASE_URL'
  | 'OSRM_TIMEOUT_MS'
  | 'ROUTE_GROUPING_MAX_STOP_DISTANCE_METERS'
  | 'VROOM_BASE_URL'
  | 'VROOM_TIMEOUT_MS',
  string
>>;

export function loadAdminRouteGroupDependencies(input: {
  env: AdminRouteGroupRuntimeEnv;
  prisma: PrismaClient;
}): AdminRouteGroupDependencies | undefined {
  const appCredentials = loadShopifyAppCredentials(input.env);
  if (appCredentials.length === 0) return undefined;

  const vroomBaseUrl = readOptional(input.env.VROOM_BASE_URL);
  const osrmBaseUrl = readOptional(input.env.OSRM_BASE_URL);

  return {
    routeGroupingService: new PrismaRouteGroupingService(
      input.prisma,
      loadDriverPushProvider(input.env),
      undefined,
      vroomBaseUrl === undefined
        ? undefined
        : new VroomRouteOptimizationClient({ baseUrl: vroomBaseUrl, ...optionalTimeout(input.env.VROOM_TIMEOUT_MS) }),
      osrmBaseUrl === undefined
        ? undefined
        : new OsrmRouteGeometryProvider({ baseUrl: osrmBaseUrl, ...optionalTimeout(input.env.OSRM_TIMEOUT_MS) }),
      { maxChildRouteStopDistanceFromDepotMeters: readOptionalNumber(input.env.ROUTE_GROUPING_MAX_STOP_DISTANCE_METERS) ?? DEFAULT_MAX_CHILD_ROUTE_STOP_DISTANCE_FROM_DEPOT_METERS }
    ),
    sessionTokenVerifier: new ShopifySessionTokenVerifier({ appCredentials })
  };
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
