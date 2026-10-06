import { visibleDsvRouteWhere } from '../dsv/dsv-test-visibility.js';
import type { PrismaClient } from '@prisma/client';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';
import {
  ROUTE_DRIVER_OPERATIONAL_STATUSES,
  ROUTE_DRIVER_VISIBLE_STATUSES,
  toRouteExecutionStatus
} from '../route-plans/route-plan-lifecycle.js';
import {
  hasDeliveryNavigationGraceExpired,
  KFOOD_DELIVERY_APP_ID,
  KFOOD_DELIVERY_SHOP_DOMAIN
} from '../route-plans/kfood-delivery-completion.js';

export type DriverTokenAccessPrismaClient = Pick<PrismaClient, 'driver' | 'driverAccount' | 'routePlan'>;

export type DriverAccountTokenAccessCheckInput = {
  accountId: string;
  tokenVersion: number;
};

export type DriverTokenAccessCheckInput = {
  driverId: string;
  shopDomain: string;
  tokenVersion: number;
};

export type DriverRouteTokenAccessCheckInput = {
  accountId: string;
  routePlanId: string;
  tokenVersion: number;
};

export type DriverRouteAccessScope = {
  accountId: string;
  driverId: string;
  routePlanId: string;
  shopDomain: string;
  shopId: string;
};

export class PrismaDriverTokenAccessRepository {
  constructor(
    private readonly prisma: DriverTokenAccessPrismaClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  async isDriverAccountAccessTokenActive(input: DriverAccountTokenAccessCheckInput): Promise<boolean> {
    const account = await this.prisma.driverAccount.findUnique({
      select: { status: true, tokenVersion: true },
      where: { id: input.accountId }
    });

    return account?.status === 'ACTIVE' && account.tokenVersion === input.tokenVersion;
  }

  async isDriverAccessTokenActive(input: DriverTokenAccessCheckInput): Promise<boolean> {
    const driver = await this.prisma.driver.findFirst({
      select: { tokenVersion: true },
      where: {
        authSubject: { not: null },
        isStoreReviewData: false,
        id: input.driverId,
        shop: { shopDomain: normalizeDriverCommerceDomain(input.shopDomain) },
        status: 'ACTIVE'
      }
    });

    return driver !== null && driver.tokenVersion === input.tokenVersion;
  }

  async resolveDriverRouteAccess(
    input: DriverRouteTokenAccessCheckInput,
    options: { allowCompleted?: boolean } = {}
  ): Promise<DriverRouteAccessScope | null> {
    if (!(await this.isDriverAccountAccessTokenActive(input))) {
      return null;
    }

    const routePlan = await this.prisma.routePlan.findFirst({
      select: {
        assignmentGeneration: true,
        deliveryWorkCompletedAt: true,
        deliveryWorkCompletedGeneration: true,
        deliveryWorkCompletedVersionId: true,
        driver: {
          select: {
            account: { select: { isStoreReviewAccount: true } },
            accountId: true, authSubject: true, id: true, isStoreReviewData: true, status: true,
          }
        },
        id: true,
        driverNavigationUntil: true,
        isStoreReviewData: true,
        routeGroupingChildVersions: {
          orderBy: { updatedAt: 'desc' as const },
          select: { publishedAt: true },
          take: 1,
          where: { status: 'CURRENT' as const, supersededAt: null }
        },
        shop: { select: { appId: true, id: true, shopDomain: true } },
        status: true
      },
      where: {
        id: input.routePlanId,
        ...visibleDsvRouteWhere(),
        ...(options.allowCompleted === true
          ? { status: { in: [...ROUTE_DRIVER_VISIBLE_STATUSES] } }
          : {
              driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
              status: { in: [...ROUTE_DRIVER_OPERATIONAL_STATUSES] }
            })
      }
    });

    if (
      routePlan === null ||
      (routePlan.shop.appId === KFOOD_DELIVERY_APP_ID
        && routePlan.shop.shopDomain === KFOOD_DELIVERY_SHOP_DOMAIN
        && hasDeliveryNavigationGraceExpired(routePlan, this.now())) ||
      routePlan.driver === null ||
      routePlan.driver.accountId !== input.accountId ||
      routePlan.driver.authSubject === null ||
      routePlan.driver.status !== 'ACTIVE'
    ) {
      return null;
    }

    if ((routePlan.isStoreReviewData === true) !== (routePlan.driver.isStoreReviewData === true)
      || (routePlan.driver.isStoreReviewData === true) !== (routePlan.driver.account?.isStoreReviewAccount === true)) {
      return null;
    }

    if (
      toRouteExecutionStatus(routePlan.status) === 'READY'
      && routePlan.routeGroupingChildVersions?.[0]?.publishedAt == null
    ) {
      return null;
    }

    return {
      accountId: input.accountId,
      driverId: routePlan.driver.id,
      routePlanId: routePlan.id,
      shopDomain: normalizeDriverCommerceDomain(routePlan.shop.shopDomain),
      shopId: routePlan.shop.id
    };
  }
}

export type DriverTokenAccessRepositoryApi = Pick<
  PrismaDriverTokenAccessRepository,
  'isDriverAccessTokenActive' | 'isDriverAccountAccessTokenActive' | 'resolveDriverRouteAccess'
>;
