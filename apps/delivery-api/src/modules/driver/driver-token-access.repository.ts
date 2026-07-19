import type { PrismaClient } from '@prisma/client';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';
import {
  ROUTE_DRIVER_OPERATIONAL_STATUSES,
  ROUTE_DRIVER_VISIBLE_STATUSES
} from '../route-plans/route-plan-lifecycle.js';

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
  constructor(private readonly prisma: DriverTokenAccessPrismaClient) {}

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
        driver: {
          select: { accountId: true, authSubject: true, id: true, status: true }
        },
        id: true,
        shop: { select: { id: true, shopDomain: true } }
      },
      where: {
        id: input.routePlanId,
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
      routePlan.driver === null ||
      routePlan.driver.accountId !== input.accountId ||
      routePlan.driver.authSubject === null ||
      routePlan.driver.status !== 'ACTIVE'
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
