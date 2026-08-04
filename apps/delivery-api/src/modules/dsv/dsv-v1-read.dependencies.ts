import type { PrismaClient } from '@prisma/client';

import { canAccessShopDomain, parseAllowedShopDomains } from '../commerce/admin-commerce-auth.js';
import type { AdminCommerceActor } from '../commerce/admin-commerce-auth.js';
import {
  createDsvAdminPrincipal,
  createDsvCustomerUserPrincipalFromAccount,
} from './dsv-principal.js';
import {
  PrismaDsvAdminAccountRepository,
  type DsvAdminAccountAuthenticator,
} from './dsv-admin-account.repository.js';
import { parseDsvAdminSessionSubject } from './dsv-admin-session-subject.js';
import type { DsvPrincipal } from './dsv-principal.js';
import {
  PrismaDsvV1ReadQueryService,
  type DsvV1ReadQueryService,
} from './dsv-v1-read-query.service.js';
import { PrismaDsvTimeConstraintCommandService } from './dsv-time-constraint-command.service.js';
import {
  loadDsvRouteOptimizationScheduler,
  type DsvControlRuntimeEnv,
} from './dsv-control.dependencies.js';
import { loadDsvMapProfileFromEnv, type DsvMapProfileEnv } from './dsv-map-profile.config.js';
import { PrismaRoutePlanRepository } from '../route-plans/route-plan.repository.js';
import { OsrmRouteGeometryProvider } from '../route-plans/osrm-route-geometry.client.js';
import { RoutePlanAdminService } from '../route-plans/route-plan.service.js';
import type {
  DsvV1ReadDependencies,
  DsvV1SessionResolver,
} from '../../routes/dsv-v1-read.routes.js';
import {
  DsvV1AuthenticationError,
  DsvV1ForbiddenError,
} from '../../routes/dsv-v1-read.routes.js';
import { isStrongAdminWebSecret } from '../../routes/admin-ui-session.js';

const customerSubjectPrefix = 'dsv-customer-account:';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type DsvV1ReadRuntimeEnv = DsvMapProfileEnv & Pick<
  DsvControlRuntimeEnv,
  | 'CLEVER_DSV_ROUTE_OPTIMIZATION_DEBOUNCE_MS'
  | 'CLEVER_DSV_ROUTE_OPTIMIZATION_ENABLED'
  | 'OSRM_BASE_URL'
  | 'OSRM_KOREA_BASE_URL'
  | 'OSRM_TIMEOUT_MS'
> & Partial<Record<
  | 'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS'
  | 'CLEVER_ADMIN_WEB_SESSION_SECRET'
  | 'CLEVER_DSV_ENABLED'
  | 'CLEVER_DSV_WEB_COOKIE_NAME',
  string
>>;

export function loadDsvV1ReadDependencies(input: {
  env: DsvV1ReadRuntimeEnv;
  nodeEnv: string;
  prisma: PrismaClient;
  queryService?: DsvV1ReadQueryService;
}): DsvV1ReadDependencies | undefined {
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
  const mapProfile = loadDsvMapProfileFromEnv(input.env);
  const routeOptimizationScheduler = loadDsvRouteOptimizationScheduler(input);
  const routeGeometryProvider = loadCustomerRouteGeometryProvider(input);
  return {
    cookieName: readOptional(input.env.CLEVER_DSV_WEB_COOKIE_NAME) ?? 'clever_dsv_admin',
    ...(mapProfile === undefined ? {} : { mapProfile }),
    queryService: input.queryService ?? new PrismaDsvV1ReadQueryService(input.prisma),
    ...(routeGeometryProvider === undefined ? {} : { routeGeometryProvider }),
    routePlanService: new RoutePlanAdminService(
      new PrismaRoutePlanRepository(input.prisma, { allowAnyShopDomain: true }),
    ),
    secureCookies: input.nodeEnv !== 'development' && input.nodeEnv !== 'test',
    sessionResolver: new PrismaDsvV1SessionResolver({
      allowedShopDomains,
      prisma: input.prisma,
    }),
    sessionSecret,
    timeConstraintCommandService: new PrismaDsvTimeConstraintCommandService(input.prisma, routeOptimizationScheduler),
  };
}

function loadCustomerRouteGeometryProvider(input: {
  env: DsvV1ReadRuntimeEnv;
  nodeEnv: string;
}): OsrmRouteGeometryProvider | undefined {
  const configuredBaseUrl = readOptional(input.env.OSRM_KOREA_BASE_URL) ?? readOptional(input.env.OSRM_BASE_URL);
  const baseUrl = configuredBaseUrl ?? (input.nodeEnv === 'development' ? 'https://router.project-osrm.org' : undefined);
  if (baseUrl === undefined) return undefined;
  const timeoutMs = readOptionalPositiveNumber(input.env.OSRM_TIMEOUT_MS);
  return new OsrmRouteGeometryProvider({
    baseUrl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

class PrismaDsvV1SessionResolver implements DsvV1SessionResolver {
  private readonly adminAccounts: DsvAdminAccountAuthenticator;
  private readonly allowedShopDomains: AdminCommerceActor['allowedShopDomains'];
  private readonly prisma: PrismaClient;

  constructor(input: { allowedShopDomains: AdminCommerceActor['allowedShopDomains']; prisma: PrismaClient }) {
    this.adminAccounts = new PrismaDsvAdminAccountRepository(input.prisma);
    this.allowedShopDomains = input.allowedShopDomains;
    this.prisma = input.prisma;
  }

  async resolve(subject: string): Promise<DsvPrincipal> {
    const adminSubject = parseDsvAdminSessionSubject(subject);
    if (adminSubject !== null) return this.resolveAdmin(adminSubject);
    if (subject.startsWith(customerSubjectPrefix)) {
      return this.resolveCustomer(subject.slice(customerSubjectPrefix.length));
    }
    throw new DsvV1AuthenticationError();
  }

  private async resolveAdmin(subject: NonNullable<ReturnType<typeof parseDsvAdminSessionSubject>>): Promise<DsvPrincipal> {
    const shopDomain = subject.shopDomain;
    if (!this.canAccessShopDomain(shopDomain)) throw new DsvV1AuthenticationError();
    const shop = await this.prisma.shop.findFirst({
      select: { id: true, shopDomain: true },
      where: { appId: 'clever', shopDomain },
    });
    if (shop === null) throw new DsvV1AuthenticationError();
    if (subject.kind === 'legacy') {
      return createDsvAdminPrincipal({ shopDomain: shop.shopDomain, shopId: shop.id });
    }
    const account = await this.adminAccounts.resolveSession({
      accountId: subject.accountId,
      tokenVersion: subject.tokenVersion,
    });
    if (account === null) throw new DsvV1AuthenticationError();
    return createDsvAdminPrincipal({
      actorId: account.accountId,
      ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
      scopes: account.scopes,
      shopDomain: shop.shopDomain,
      shopId: shop.id,
    });
  }

  private async resolveCustomer(accountId: string): Promise<DsvPrincipal> {
    if (!uuidPattern.test(accountId)) throw new DsvV1AuthenticationError();
    const account = await this.prisma.customerAccount.findUnique({
      select: {
        customer: { select: { id: true, shopId: true } },
        customerId: true,
        id: true,
        issuer: true,
        shop: { select: { id: true, shopDomain: true } },
        shopId: true,
        status: true,
        subject: true,
      },
      where: { id: accountId },
    });
    if (account === null) throw new DsvV1AuthenticationError();
    if (account.status !== 'ACTIVE') throw new DsvV1ForbiddenError('DSV customer account is inactive');
    if (account.shop.id !== account.shopId || account.customer.id !== account.customerId || account.customer.shopId !== account.shopId) {
      throw new DsvV1ForbiddenError('DSV customer account scope is invalid');
    }
    return createDsvCustomerUserPrincipalFromAccount({ account, shopDomain: account.shop.shopDomain });
  }

  private canAccessShopDomain(shopDomain: string): boolean {
    return canAccessShopDomain({ allowedShopDomains: this.allowedShopDomains, subject: 'dsv-v1-session' }, shopDomain);
  }
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

function readOptionalPositiveNumber(value: string | undefined): number | undefined {
  const normalized = readOptional(value);
  if (normalized === undefined) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
