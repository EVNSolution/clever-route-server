import type { PrismaClient } from '@prisma/client';

import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';
import type {
  DriverRouteAccessAmbiguousMatch,
  DriverRouteAccessCompanyGuidance,
  DriverRouteAccessInvitedRoute,
  DriverRouteAccessLookupInput,
  DriverRouteAccessLookupResult
} from './driver-route-access.types.js';

type DriverRouteAccessPrismaClient = Pick<PrismaClient, 'driver' | 'routePlan'>;

type DriverRoutePlanRecord = {
  constraints: unknown;
  driver: {
    authSubject: string | null;
    id: string;
    phone: string | null;
    status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
    tokenVersion: number;
  } | null;
  id: string;
  name: string;
  planDate: Date;
  shop: {
    shopDomain: string;
  };
};

const routePlanSelect = {
  constraints: true,
  driver: { select: { authSubject: true, id: true, phone: true, status: true, tokenVersion: true } },
  id: true,
  name: true,
  planDate: true,
  shop: { select: { shopDomain: true } }
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class PrismaDriverRouteAccessRepository {
  constructor(private readonly prisma: DriverRouteAccessPrismaClient) {}

  async lookupRouteAccess(input: DriverRouteAccessLookupInput): Promise<DriverRouteAccessLookupResult> {
    const routeContext = input.routeContext;
    if (routeContext === null) {
      return this.lookupPhoneRouteAccess(input.phoneE164);
    }

    if (!UUID_PATTERN.test(routeContext)) {
      return this.lookupRouteScopeAccess(input);
    }

    const routePlan = await this.prisma.routePlan.findUnique({
      select: routePlanSelect,
      where: { id: routeContext }
    });

    if (routePlan === null) {
      return { status: 'NOT_FOUND' };
    }

    return mapRoutePlan(routePlan, { phoneE164: input.phoneE164, routeContext });
  }

  private async lookupPhoneRouteAccess(phoneE164: string): Promise<DriverRouteAccessLookupResult> {
    const routePlans = await this.prisma.routePlan.findMany({
      orderBy: [{ planDate: 'asc' }, { name: 'asc' }],
      select: routePlanSelect,
      where: {
        driver: { is: { authSubject: { not: null }, phone: phoneE164, status: 'ACTIVE' } },
        status: { in: ['ASSIGNED', 'IN_PROGRESS', 'OPTIMIZED'] }
      }
    });

    const routes = routePlans.flatMap((routePlan): DriverRouteAccessInvitedRoute[] => {
      const result = mapRoutePlan(routePlan, { phoneE164, routeContext: routePlan.id });
      return result.status === 'INVITED' ? [result] : [];
    });

    if (routes.length > 0) {
      return {
        status: 'ROUTES_FOUND',
        routes
      };
    }

    const drivers = await this.prisma.driver.findMany({
      select: { authSubject: true, status: true },
      where: { phone: phoneE164 }
    });
    if (drivers.length === 0) {
      return { status: 'NOT_FOUND' };
    }

    if (drivers.some((driver) => driver.status === 'ACTIVE' && driver.authSubject !== null)) {
      return {
        status: 'ROUTES_FOUND',
        routes: []
      };
    }

    if (drivers.some((driver) => driver.status === 'SUSPENDED')) {
      return { status: 'BLOCKED' };
    }

    if (drivers.some((driver) => driver.status === 'ACTIVE')) {
      return { status: 'NOT_FOUND' };
    }

  return {
      status: 'DISABLED'
    };
  }

  private async lookupRouteScopeAccess(input: DriverRouteAccessLookupInput): Promise<DriverRouteAccessLookupResult> {
    if (input.routeContext === null) {
      return { status: 'NOT_FOUND' };
    }

    const routePlans = await this.prisma.routePlan.findMany({
      orderBy: [{ planDate: 'asc' }, { name: 'asc' }],
      select: routePlanSelect,
      take: 3,
      where: {
        constraints: { path: ['routeScope', 'routeScopeKey'], equals: input.routeContext },
        driver: { is: { authSubject: { not: null }, phone: input.phoneE164, status: 'ACTIVE' } }
      }
    });

    if (routePlans.length === 0) {
      return { status: 'NOT_FOUND' };
    }

    if (routePlans.length === 1) {
      const routePlan = routePlans[0];
      if (routePlan === undefined) {
        return { status: 'NOT_FOUND' };
      }

      return mapRoutePlan(routePlan, { ...input, routeContext: routePlan.id });
    }

    return {
      status: 'MULTIPLE_MATCHES',
      matches: routePlans.slice(0, 2).map(buildAmbiguousMatch),
      resolutionHint: 'Use the phone-only route list or contact dispatch.'
    };
  }
}

function mapRoutePlan(
  routePlan: DriverRoutePlanRecord,
  input: { phoneE164: string; routeContext: string }
): DriverRouteAccessLookupResult {
  if (routePlan.driver === null || routePlan.driver.phone !== input.phoneE164) {
    return { status: 'NOT_FOUND' };
  }

  if (routePlan.driver.status === 'INACTIVE') {
    return { status: 'DISABLED' };
  }

  if (routePlan.driver.status === 'SUSPENDED') {
    return { status: 'BLOCKED' };
  }

  if (routePlan.driver.authSubject === null) {
    return { status: 'NOT_FOUND' };
  }

    return {
    driverContext: {
      driverId: routePlan.driver.id,
      shopDomain: normalizeDriverCommerceDomain(routePlan.shop.shopDomain),
      tokenVersion: routePlan.driver.tokenVersion
    },
    status: 'INVITED',
    routeAccess: {
      nextState: 'consent_required',
      routeContext: input.routeContext,
      routePlanId: routePlan.id
    },
    companyGuidance: buildCompanyGuidance(routePlan)
  };
}

function buildCompanyGuidance(routePlan: DriverRoutePlanRecord): DriverRouteAccessCompanyGuidance {
  const constraints = objectOrNull(routePlan.constraints);
  const shopDomain = normalizeDriverCommerceDomain(routePlan.shop.shopDomain);
  const companyDisplayName = readString(constraints?.companyDisplayName) ?? displayNameFromShopDomain(shopDomain);

  return {
    companyDisplayName,
    deliveryDate: routePlan.planDate.toISOString().slice(0, 10),
    driverInstructions: readStringArray(constraints?.driverInstructions),
    operatorSupportContact: readString(constraints?.operatorSupportContact),
    pickupGuidance: readString(constraints?.pickupGuidance),
    routeName: routePlan.name,
    shopDomain,
    timezone: readString(constraints?.timezone)
  };
}

function buildAmbiguousMatch(routePlan: DriverRoutePlanRecord): DriverRouteAccessAmbiguousMatch {
  const guidance = buildCompanyGuidance(routePlan);
  return {
    companyDisplayName: guidance.companyDisplayName,
    deliveryDate: guidance.deliveryDate,
    operatorSupportContact: guidance.operatorSupportContact,
    pickupGuidance: guidance.pickupGuidance,
    routeName: guidance.routeName,
    shopDomain: guidance.shopDomain,
    timezone: guidance.timezone
  };
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const text = readString(item);
    return text === null ? [] : [text];
  });
}

function displayNameFromShopDomain(shopDomain: string): string {
  return shopDomain.replace(/\.myshopify\.com$/u, '');
}

export type DriverRouteAccessServiceApi = Pick<PrismaDriverRouteAccessRepository, 'lookupRouteAccess'>;
