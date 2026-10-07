import { visibleDsvRouteWhere, isVisibleDsvRoute } from '../dsv/dsv-test-visibility.js';
import type { PrismaClient } from '@prisma/client';
import {
  ROUTE_DRIVER_OPERATIONAL_STATUSES,
  toRouteExecutionStatus
} from '../route-plans/route-plan-lifecycle.js';
import {
  hasDeliveryNavigationGraceExpired,
  KFOOD_DELIVERY_APP_ID,
  KFOOD_DELIVERY_SHOP_DOMAIN
} from '../route-plans/kfood-delivery-completion.js';
import type {
  RouteGroupingChildDto,
  RouteGroupingDraftRouteInput,
  RouteGroupingService
} from '../route-grouping/route-grouping.types.js';

import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';
import { driverServiceDate, driverServiceDateAsDbDate } from './driver-route-timezone.js';
import type {
  DriverRouteAccessAmbiguousMatch,
  DriverRouteAccessCompanyGuidance,
  DriverRouteAccessInvitedRoute,
  DriverRouteAccessLookupInput,
  DriverRouteAccessLookupResult
} from './driver-route-access.types.js';
type DriverRouteAccessPrismaClient = Pick<
  PrismaClient,
  'driver' | 'routeGroupingChildVersion' | 'routePlan'
>;

type DriverRoutePlanRecord = {
  liveChangeState?: {
    assignmentGeneration: bigint;
    baselineRouteVersionId: string;
    driverId: string;
    latestPublicationId: string;
    latestSequence: number;
  } | null;
  assignmentGeneration?: bigint;
  constraints: unknown;
  driver: {
    account: {
      id: string;
      isStoreReviewAccount?: boolean;
      status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
      tokenVersion: number;
    } | null;
    accountId: string | null;
    authSubject: string | null;
    id: string;
    isStoreReviewData?: boolean;
    status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  } | null;
  id: string;
  deliveryWorkCompletedAt?: Date | null;
  deliveryWorkCompletedGeneration?: bigint | null;
  deliveryWorkCompletedVersionId?: string | null;
  driverNavigationUntil?: Date | null;
  isStoreReviewData?: boolean;
  name: string;
  planDate: Date;
  routeGroupingChildVersions?: Array<{ id: string; publishedAt: Date | null }>;
  shop: {
    appId: string;
    shopDomain: string;
  };
  status: string;
};

const routePlanSelect = {
  liveChangeState: {
    select: { assignmentGeneration: true, baselineRouteVersionId: true, driverId: true, latestPublicationId: true, latestSequence: true }
  },
  assignmentGeneration: true,
  constraints: true,
  deliveryWorkCompletedAt: true,
  deliveryWorkCompletedGeneration: true,
  deliveryWorkCompletedVersionId: true,
  driver: {
    select: {
      account: { select: { id: true, isStoreReviewAccount: true, status: true, tokenVersion: true } },
      accountId: true,
      authSubject: true,
      id: true,
      isStoreReviewData: true,
      status: true
    }
  },
  id: true,
  driverNavigationUntil: true,
  isStoreReviewData: true,
  name: true,
  planDate: true,
  routeGroupingChildVersions: {
    orderBy: { updatedAt: 'desc' as const },
    select: { id: true, publishedAt: true },
    take: 1,
    where: { status: 'CURRENT' as const, supersededAt: null }
  },
  shop: { select: { appId: true, shopDomain: true } },
  status: true
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHARED_SCOPE_PAGE_SIZE = 3;

export class PrismaDriverRouteAccessRepository {
  constructor(
    private readonly prisma: DriverRouteAccessPrismaClient,
    private readonly routeGroupingService?: RouteGroupingService,
    private readonly now: () => Date = () => new Date()
  ) {}

  async lookupRouteAccess(input: DriverRouteAccessLookupInput): Promise<DriverRouteAccessLookupResult> {
    const routeContext = input.routeContext;
    if (routeContext === null) {
      return this.lookupAccountRouteAccess(input.accountId);
    }

    if (!UUID_PATTERN.test(routeContext)) {
      return this.lookupRouteScopeAccess(input);
    }

    const routePlan = await this.prisma.routePlan.findUnique({
      select: routePlanSelect,
      where: {
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        id: routeContext,
        AND: [visibleDsvRouteWhere()],
        status: { in: [...ROUTE_DRIVER_OPERATIONAL_STATUSES] }
      }
    });

    if (routePlan === null || hasExpiredKfoodNavigation(routePlan, this.now())) {
      return { status: 'NOT_FOUND' };
    }

    return mapRoutePlan(routePlan, { accountId: input.accountId, routeContext });
  }

  private async lookupAccountRouteAccess(accountId: string): Promise<DriverRouteAccessLookupResult> {
    const routePlans = await this.prisma.routePlan.findMany({
      orderBy: [{ planDate: 'asc' }, { name: 'asc' }],
      select: routePlanSelect,
      where: {
        driver: { is: { accountId, authSubject: { not: null }, status: 'ACTIVE' } },
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        status: { in: [...ROUTE_DRIVER_OPERATIONAL_STATUSES] }
      }
    });

    const tenantVisiblePlans = routePlans.filter(plan => (
      isVisibleDsvRoute({ shopDomain: plan.shop.shopDomain }, plan.id)
    ));
    // An existing excluded route must not cause a presentation read to manufacture a new standby route.
    if (routePlans.length > 0 && tenantVisiblePlans.length === 0) return { status: 'NOT_FOUND' };
    const visiblePlans = tenantVisiblePlans.filter(plan => !hasExpiredKfoodNavigation(plan, this.now()));
    // An expired assignment still proves an authenticated driver relationship. Keep My Routes empty
    // without manufacturing a standby assignment after the navigation grace ends.
    if (tenantVisiblePlans.length > 0 && visiblePlans.length === 0) {
      return { status: 'ROUTES_FOUND', routes: [] };
    }
    const routes = visiblePlans.flatMap((routePlan): DriverRouteAccessInvitedRoute[] => {
      const result = mapRoutePlan(routePlan, { accountId, routeContext: routePlan.id });
      return result.status === 'INVITED' ? [result] : [];
    });

    if (routes.length > 0) {
      if (
        this.routeGroupingService !== undefined &&
        !routes.some((route) => route.companyGuidance.deliveryDate === driverServiceDate(this.now()))
      ) {
        const standbyStatus = await this.ensureStandbyRoute(accountId);
        if (standbyStatus === 'CREATED') {
          return this.lookupAccountRouteAccess(accountId);
        }
      }
      return {
        status: 'ROUTES_FOUND',
        routes
      };
    }

    const drivers = await this.prisma.driver.findMany({
      select: { authSubject: true, status: true },
      where: { accountId }
    });
    if (drivers.length === 0) {
      return { status: 'NOT_FOUND' };
    }

    if (drivers.some((driver) => driver.status === 'ACTIVE' && driver.authSubject !== null)) {
      const standbyStatus = await this.ensureStandbyRoute(accountId);
      if (standbyStatus === 'CREATED') {
        return this.lookupAccountRouteAccess(accountId);
      }
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

  private async ensureStandbyRoute(
    accountId: string
  ): Promise<'CREATED' | 'NO_PUBLIC_DELIVERY' | 'UNAVAILABLE'> {
    if (this.routeGroupingService === undefined) return 'UNAVAILABLE';

    const drivers = await this.prisma.driver.findMany({
      select: {
        id: true,
        isStoreReviewData: true,
        shop: { select: { id: true, shopDomain: true } }
      },
      where: {
        accountId,
        authSubject: { not: null },
        status: 'ACTIVE'
      }
    });

    for (const driver of drivers) {
      const publicRoute = await this.prisma.routeGroupingChildVersion.findFirst({
        orderBy: [
          { grouping: { planDate: 'desc' } },
          { updatedAt: 'desc' }
        ],
        select: { groupingId: true },
        where: {
          currentOrders: { some: { isStoreReviewData: driver.isStoreReviewData === true } },
          driverId: null,
          grouping: {
            planDate: driverServiceDateAsDbDate(this.now()),
            status: 'READY'
          },
          routePlanId: { not: null },
          routePlan: { isStoreReviewData: driver.isStoreReviewData === true },
          shopId: driver.shop.id,
          status: 'CURRENT',
          supersededAt: null
        }
      });
      if (publicRoute === null) continue;

      const grouping = await this.routeGroupingService.getGrouping({
        groupingId: publicRoute.groupingId,
        shopDomain: driver.shop.shopDomain
      });
      if (grouping === null) continue;
      if (grouping.children.some((child) => (
        child.driverId === driver.id &&
        child.displayStatus === 'READY' &&
        child.routePlanId !== null
      ))) continue;

      const saved = await this.routeGroupingService.saveDraft({
        expectedUpdatedAt: grouping.updatedAt,
        groupingId: grouping.id,
        routes: [
          ...grouping.children
            .filter((child) => child.routePlanId !== null || child.orderIds.length > 0)
            .map(toDraftRoute),
          {
            branchId: null,
            driverId: driver.id,
            label: null,
            orderIds: [],
            routePlanId: null,
            sortOrder: nextSortOrder(grouping.children),
            tempId: `standby:${driver.id}`,
            vehicleId: null
          }
        ],
        shopDomain: driver.shop.shopDomain
      });
      if (saved !== null) return 'CREATED';
    }

    return 'NO_PUBLIC_DELIVERY';
  }

  private async lookupRouteScopeAccess(input: DriverRouteAccessLookupInput): Promise<DriverRouteAccessLookupResult> {
    if (input.routeContext === null) {
      return { status: 'NOT_FOUND' };
    }

    const now = this.now();
    const visibleRoutePlans: DriverRoutePlanRecord[] = [];
    let cursorId: string | undefined;
    let expiryPaginationActive = false;
    while (true) {
      const page = await this.prisma.routePlan.findMany({
        ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
        orderBy: [{ planDate: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        select: routePlanSelect,
        take: SHARED_SCOPE_PAGE_SIZE,
        where: {
          ...visibleDsvRouteWhere(),
          OR: [
            { status: 'IN_PROGRESS' },
            {
              routeGroupingChildVersions: {
                some: { publishedAt: { not: null }, status: 'CURRENT', supersededAt: null }
              }
            }
          ],
          constraints: { path: ['routeScope', 'routeScopeKey'], equals: input.routeContext },
          driver: { is: { accountId: input.accountId, authSubject: { not: null }, status: 'ACTIVE' } },
          driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
          status: { in: [...ROUTE_DRIVER_OPERATIONAL_STATUSES] }
        }
      });
      const unexpiredPage = page.filter((routePlan) => !hasExpiredKfoodNavigation(routePlan, now));
      visibleRoutePlans.push(...unexpiredPage.filter(isDriverVisibleRoutePlan).slice(0, 3 - visibleRoutePlans.length));
      expiryPaginationActive ||= unexpiredPage.length !== page.length;
      if (
        visibleRoutePlans.length >= 2
        || page.length < SHARED_SCOPE_PAGE_SIZE
        || !expiryPaginationActive
      ) {
        break;
      }
      const nextCursorId = page.at(-1)?.id;
      if (nextCursorId === undefined || nextCursorId === cursorId) break;
      cursorId = nextCursorId;
    }

    if (visibleRoutePlans.length === 0) {
      return { status: 'NOT_FOUND' };
    }

    if (visibleRoutePlans.length === 1) {
      const routePlan = visibleRoutePlans[0];
      if (routePlan === undefined) {
        return { status: 'NOT_FOUND' };
      }

      return mapRoutePlan(routePlan, { ...input, routeContext: routePlan.id });
    }

    return {
      status: 'MULTIPLE_MATCHES',
      matches: visibleRoutePlans.slice(0, 2).map(buildAmbiguousMatch),
      resolutionHint: 'Use the account route list or contact dispatch.'
    };
  }
}

function mapRoutePlan(
  routePlan: DriverRoutePlanRecord,
  input: { accountId: string; routeContext: string }
): DriverRouteAccessLookupResult {
  if (
    routePlan.driver === null ||
    routePlan.driver.accountId !== input.accountId ||
    routePlan.driver.account?.id !== input.accountId
  ) {
    return { status: 'NOT_FOUND' };
  }

  if ((routePlan.isStoreReviewData === true) !== (routePlan.driver.isStoreReviewData === true)
    || (routePlan.driver.isStoreReviewData === true) !== (routePlan.driver.account.isStoreReviewAccount === true)) {
    return { status: 'NOT_FOUND' };
  }

  if (routePlan.driver.account.status === 'INACTIVE') {
    return { status: 'DISABLED' };
  }

  if (routePlan.driver.account.status === 'SUSPENDED') {
    return { status: 'BLOCKED' };
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

  const currentRouteVersion = routePlan.routeGroupingChildVersions?.[0];
  if (
    currentRouteVersion === undefined
    || routePlan.assignmentGeneration === undefined
    || !isDriverVisibleRoutePlan(routePlan)
  ) {
    return { status: 'NOT_FOUND' };
  }

  return {
    driverContext: {
      accountId: routePlan.driver.account.id,
      routePlanId: routePlan.id,
      tokenVersion: routePlan.driver.account.tokenVersion
    },
    status: 'INVITED',
    routeAccess: {
      assignmentGeneration: routePlan.assignmentGeneration.toString(),
      driverContractVersion: 2,
      expectedRouteVersionId: currentLivePublicationId(routePlan) ?? currentRouteVersion.id,
      nextState: 'consent_required',
      routeContext: input.routeContext,
      routePlanId: routePlan.id
    },
    companyGuidance: buildCompanyGuidance(routePlan)
  };
}

function currentLivePublicationId(route: DriverRoutePlanRecord): string | null {
  const state = route.liveChangeState;
  return state != null
    && state.latestSequence > 0
    && state.driverId === route.driver?.id
    && state.assignmentGeneration === route.assignmentGeneration
    && state.baselineRouteVersionId === route.routeGroupingChildVersions?.[0]?.id
    ? state.latestPublicationId : null;
}

function isDriverVisibleRoutePlan(routePlan: DriverRoutePlanRecord): boolean {
  const currentRouteVersion = routePlan.routeGroupingChildVersions?.[0];
  return currentRouteVersion !== undefined
    && (
      currentRouteVersion.publishedAt != null
      || toRouteExecutionStatus(routePlan.status) === 'IN_PROGRESS'
    );
}

function hasExpiredKfoodNavigation(routePlan: DriverRoutePlanRecord, now: Date): boolean {
  return routePlan.shop.appId === KFOOD_DELIVERY_APP_ID
    && routePlan.shop.shopDomain === KFOOD_DELIVERY_SHOP_DOMAIN
    && hasDeliveryNavigationGraceExpired(routePlan, now);
}

function buildCompanyGuidance(routePlan: DriverRoutePlanRecord): DriverRouteAccessCompanyGuidance {
  const constraints = objectOrNull(routePlan.constraints);
  const shopDomain = normalizeDriverCommerceDomain(routePlan.shop.shopDomain);
  const companyDisplayName = readString(constraints?.companyDisplayName) ?? displayNameFromShopDomain(shopDomain);

  return {
    companyDisplayName,
    deliveryDate: routePlan.planDate.toISOString().slice(0, 10),
    driverInstructions: readStringArray(constraints?.driverInstructions),
    executionStatus: toRouteExecutionStatus(routePlan.status) === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'READY',
    operatorSupportContact: readString(constraints?.operatorSupportContact),
    pickupGuidance: readString(constraints?.pickupGuidance),
    routeName: routePlan.name,
    shopDomain,
    timezone: readString(constraints?.timezone)
  };
}

function toDraftRoute(child: RouteGroupingChildDto): RouteGroupingDraftRouteInput {
  return {
    branchId: null,
    color: child.color,
    driverId: child.driverId,
    expectedChildUpdatedAt: child.updatedAt,
    ...(child.routePlan?.updatedAt === undefined
      ? {}
      : { expectedRoutePlanUpdatedAt: child.routePlan.updatedAt }),
    orderIds: child.orderIds,
    ...(child.routePlanId === null
      ? { tempId: `child:${child.updatedAt}:${child.sortOrder ?? child.routeIdx ?? 'null-route'}` }
      : {}),
    ...(child.routeIdx === null ? {} : { routeIdx: child.routeIdx }),
    routePlanId: child.routePlanId,
    ...(child.sortOrder === null ? {} : { sortOrder: child.sortOrder })
  };
}

function nextSortOrder(children: RouteGroupingChildDto[]): number {
  return children.reduce((highest, child) => Math.max(highest, child.sortOrder ?? 0), 0) + 1;
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
