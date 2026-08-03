import type { PrismaClient } from '@prisma/client';

import { parseAllowedShopDomains } from '../commerce/admin-commerce-auth.js';
import { createRouteGroupingService, type AdminRouteGroupRuntimeEnv } from '../route-grouping/route-grouping.dependencies.js';
import type { RouteGroupingService } from '../route-grouping/route-grouping.types.js';
import { OsrmRouteGeometryProvider } from '../route-plans/osrm-route-geometry.client.js';
import { OsrmTripRouteOptimizationClient } from '../route-plans/osrm-trip-route-optimizer.client.js';
import { PrismaRouteOptimizationJobRepository } from '../route-plans/route-optimization-job.repository.js';
import { RouteOptimizationJobService } from '../route-plans/route-optimization-job.service.js';
import { PrismaRoutePlanRepository } from '../route-plans/route-plan.repository.js';
import { RoutePlanAdminService } from '../route-plans/route-plan.service.js';
import { DsvAssignmentCommandService } from './dsv-assignment-command.service.js';
import {
  PrismaDsvAdminAccountRepository,
  type DsvAdminAccountAuthenticator,
} from './dsv-admin-account.repository.js';
import { PrismaDsvControlRepository } from './dsv-control.repository.js';
import { PrismaDsvDispatchImportService } from './dsv-dispatch-import.service.js';
import {
  loadDsvManualEmailService,
  type DsvManualEmailRuntimeEnv,
} from './dsv-manual-email.service.js';
import { PrismaDsvResourceService } from './dsv-resource.service.js';
import type { DsvControlDependencies } from '../../routes/dsv-control.routes.js';
import { isStrongAdminWebSecret } from '../../routes/admin-ui-session.js';
import { PrismaAdminStoreSettingsService } from '../commerce/admin-store-settings.service.js';
import {
  loadGeocodingService,
  type GeocodingRuntimeEnv,
} from '../geocoding/geocoding.dependencies.js';
import {
  loadDsvAddressCanonicalizer,
} from './dsv-address-canonicalization.js';
import { DsvRouteOptimizationScheduler } from './dsv-route-optimization.scheduler.js';

export type DsvControlRuntimeEnv = AdminRouteGroupRuntimeEnv
  & DsvManualEmailRuntimeEnv
  & GeocodingRuntimeEnv
  & Partial<Record<
  | 'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS'
  | 'CLEVER_ADMIN_WEB_SESSION_SECRET'
  | 'CLEVER_DSV_ENABLED'
  | 'CLEVER_DSV_ROUTE_OPTIMIZATION_DEBOUNCE_MS'
  | 'CLEVER_DSV_ROUTE_OPTIMIZATION_ENABLED'
  | 'CLEVER_DSV_WEB_COOKIE_NAME',
  string
>>;

export function loadDsvControlDependencies(input: {
  adminAccounts?: DsvAdminAccountAuthenticator;
  env: DsvControlRuntimeEnv;
  nodeEnv: string;
  prisma: PrismaClient;
  routeGroupingService?: RouteGroupingService;
}): DsvControlDependencies | undefined {
  const isProduction = input.nodeEnv === 'production';
  const dsvEnabled = readBoolean(input.env.CLEVER_DSV_ENABLED);
  if (isProduction && dsvEnabled !== true) return undefined;

  const sessionSecret = readOptional(input.env.CLEVER_ADMIN_WEB_SESSION_SECRET);
  const allowedShopDomains = parseAllowedShopDomains(input.env.CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS);

  if (isProduction) {
    if (!isStrongAdminWebSecret(sessionSecret)) {
      throw new Error('CLEVER_DSV_ENABLED=true requires a strong CLEVER_ADMIN_WEB_SESSION_SECRET in production');
    }
    if (allowedShopDomains === '*' || allowedShopDomains.length === 0) {
      throw new Error('CLEVER_DSV_ENABLED=true requires explicit non-wildcard CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS in production');
    }
  } else if (!isStrongAdminWebSecret(sessionSecret)) {
    return undefined;
  }

  const routeGroupingService = input.routeGroupingService ?? createRouteGroupingService(input);
  const geocodingService = loadGeocodingService({ env: input.env, prisma: input.prisma });
  const addressCanonicalizer = loadDsvAddressCanonicalizer({
    geocodingService,
  });
  const manualEmailService = loadDsvManualEmailService(input.env);
  const routeOptimizationScheduler = loadDsvRouteOptimizationScheduler(input);

  return {
    addressCanonicalizer,
    adminAccounts: input.adminAccounts ?? new PrismaDsvAdminAccountRepository(input.prisma),
    allowedShopDomains,
    assignmentCommandService: new DsvAssignmentCommandService(
      input.prisma,
      routeGroupingService,
      routeOptimizationScheduler,
    ),
    cookieName: readOptional(input.env.CLEVER_DSV_WEB_COOKIE_NAME) ?? 'clever_dsv_admin',
    dispatchImportService: new PrismaDsvDispatchImportService(input.prisma, { addressCanonicalizer }),
    geocodingService,
    manualEmailService,
    repository: new PrismaDsvControlRepository(input.prisma),
    resourceService: new PrismaDsvResourceService(input.prisma),
    secureCookies: input.nodeEnv !== 'development' && input.nodeEnv !== 'test',
    sessionSecret,
    settingsService: new PrismaAdminStoreSettingsService(input.prisma),
  };
}

function loadDsvRouteOptimizationScheduler(input: {
  env: DsvControlRuntimeEnv;
  nodeEnv: string;
  prisma: PrismaClient;
}): DsvRouteOptimizationScheduler | undefined {
  const enabled = readBoolean(input.env.CLEVER_DSV_ROUTE_OPTIMIZATION_ENABLED, 'CLEVER_DSV_ROUTE_OPTIMIZATION_ENABLED');
  if (enabled === false) return undefined;

  const configuredBaseUrl = readOptional(input.env.OSRM_KOREA_BASE_URL) ?? readOptional(input.env.OSRM_BASE_URL);
  const baseUrl = configuredBaseUrl ?? (input.nodeEnv === 'development' ? 'https://router.project-osrm.org' : undefined);
  if (baseUrl === undefined) {
    if (enabled === true) {
      throw new Error('CLEVER_DSV_ROUTE_OPTIMIZATION_ENABLED=true requires OSRM_KOREA_BASE_URL or OSRM_BASE_URL in production');
    }
    return undefined;
  }

  const timeoutMs = readOptionalPositiveNumber(input.env.OSRM_TIMEOUT_MS);
  const optimizer = new OsrmTripRouteOptimizationClient({
    baseUrl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const routeOptimizationJobService = new RouteOptimizationJobService(
    new PrismaRouteOptimizationJobRepository(input.prisma),
  );
  const routePlanService = new RoutePlanAdminService(
    new PrismaRoutePlanRepository(input.prisma, { allowAnyShopDomain: true }),
    new OsrmRouteGeometryProvider({
      baseUrl,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
    routeOptimizationJobService,
  );
  const debounceMs = readOptionalPositiveNumber(input.env.CLEVER_DSV_ROUTE_OPTIMIZATION_DEBOUNCE_MS);
  return new DsvRouteOptimizationScheduler({
    routeOptimizationJobService,
    routeOptimizationService: optimizer,
    routePlanService,
  }, {
    ...(debounceMs === undefined ? {} : { debounceMs }),
    ...(timeoutMs === undefined ? {} : { timeoutBudgetMs: Math.max(30_000, timeoutMs * 2 + 5_000) }),
  });
}

function readOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

function readBoolean(value: string | undefined, name = 'CLEVER_DSV_ENABLED'): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return undefined;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function readOptionalPositiveNumber(value: string | undefined): number | undefined {
  const normalized = readOptional(value);
  if (normalized === undefined) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
