import type { PrismaClient } from '@prisma/client';

import { parseAllowedShopDomains } from '../commerce/admin-commerce-auth.js';
import { createRouteGroupingService, type AdminRouteGroupRuntimeEnv } from '../route-grouping/route-grouping.dependencies.js';
import type { RouteGroupingService } from '../route-grouping/route-grouping.types.js';
import { DsvAssignmentCommandService } from './dsv-assignment-command.service.js';
import {
  PrismaDsvAdminAccountRepository,
  type DsvAdminAccountAuthenticator,
} from './dsv-admin-account.repository.js';
import { PrismaDsvControlRepository } from './dsv-control.repository.js';
import { PrismaDsvDispatchImportService } from './dsv-dispatch-import.service.js';
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

export type DsvControlRuntimeEnv = AdminRouteGroupRuntimeEnv & GeocodingRuntimeEnv & Partial<Record<
  | 'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS'
  | 'CLEVER_ADMIN_WEB_SESSION_SECRET'
  | 'CLEVER_DSV_ENABLED'
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
  const geocodingService = loadGeocodingService({ env: input.env });
  const addressCanonicalizer = loadDsvAddressCanonicalizer({
    geocodingService,
  });

  return {
    addressCanonicalizer,
    adminAccounts: input.adminAccounts ?? new PrismaDsvAdminAccountRepository(input.prisma),
    allowedShopDomains,
    assignmentCommandService: new DsvAssignmentCommandService(input.prisma, routeGroupingService),
    cookieName: readOptional(input.env.CLEVER_DSV_WEB_COOKIE_NAME) ?? 'clever_dsv_admin',
    dispatchImportService: new PrismaDsvDispatchImportService(input.prisma, { addressCanonicalizer }),
    geocodingService,
    repository: new PrismaDsvControlRepository(input.prisma),
    resourceService: new PrismaDsvResourceService(input.prisma),
    secureCookies: input.nodeEnv !== 'development' && input.nodeEnv !== 'test',
    sessionSecret,
    settingsService: new PrismaAdminStoreSettingsService(input.prisma),
  };
}

function readOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

function readBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return undefined;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error('CLEVER_DSV_ENABLED must be true or false');
}
