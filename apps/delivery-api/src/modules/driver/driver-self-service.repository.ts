import { RoutePlanStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

import {
  DriverSelfServiceScopeError,
  DriverRouteHistoryCursorError,
  type DriverAccountDeletionRequestInput,
  type DriverAccountDeletionRequestResult,
  type DriverEarningsResult,
  type DriverRouteHistoryItem,
  type DriverRouteHistoryStatus,
  type DriverSelfProfile,
  type DriverSelfServiceContract,
  type DriverSelfServiceScopeInput,
  type GetDriverEarningsInput,
  type ListDriverRoutesInput,
  type ListDriverRoutesResult,
  type SubmitDriverRouteFeedbackInput,
  type SubmitDriverRouteFeedbackResult,
  type UpdateDriverProfileInput
} from './driver-self-service.types.js';
import { coerceIanaTimezone } from './driver-route-timezone.js';

export type DriverSelfServicePrismaClient = Pick<
  PrismaClient,
  'driver' | 'driverAccountDeletionRequest' | 'driverRouteFeedback' | 'routePlan' | 'shop'
>;

type ScopedDriverRecord = {
  driver: DriverSelfProfile;
  shop: {
    id: string;
    shopDomain: string;
  };
};

type RoutePlanHistoryRecord = {
  constraints: unknown;
  driverEvents: { occurredAt: Date }[];
  id: string;
  name: string;
  planDate: Date;
  routeStops: { deliveryStop: { status: string } }[];
  shop: { shopDomain: string };
  status: string;
};

const DEFAULT_ROUTE_HISTORY_LIMIT = 25;
const ROUTE_HISTORY_LIMIT_PLUS_ONE = DEFAULT_ROUTE_HISTORY_LIMIT + 1;
const SUPPORTED_ROUTE_STATUSES: RoutePlanStatus[] = [
  RoutePlanStatus.OPTIMIZED,
  RoutePlanStatus.ASSIGNED,
  RoutePlanStatus.IN_PROGRESS,
  RoutePlanStatus.COMPLETED
];

export class PrismaDriverSelfServiceRepository implements DriverSelfServiceContract {
  constructor(private readonly prisma: DriverSelfServicePrismaClient) {}

  async listDriverRoutes(input: ListDriverRoutesInput): Promise<ListDriverRoutesResult> {
    const scoped = await this.resolveScopedDriver(input);
    const cursor = decodeRouteHistoryCursor(input.cursor);
    const routePlans = await this.prisma.routePlan.findMany({
      include: routeHistoryIncludeFor(input.driverId),
      orderBy: [{ planDate: 'asc' }, { id: 'asc' }],
      take: ROUTE_HISTORY_LIMIT_PLUS_ONE,
      where: {
        driverId: input.driverId,
        planDate: {
          ...(input.from === null ? {} : { gte: input.from }),
          ...(input.to === null ? {} : { lte: input.to })
        },
        shopId: scoped.shop.id,
        status: { in: routePlanStatusesFor(input.status) },
        ...(cursor === null ? {} : {
          OR: [
            { planDate: { gt: cursor.planDate } },
            { planDate: cursor.planDate, id: { gt: cursor.id } }
          ]
        })
      }
    });

    const pageItems: RoutePlanHistoryRecord[] = routePlans.slice(0, DEFAULT_ROUTE_HISTORY_LIMIT);
    const hasNextPage = routePlans.length > DEFAULT_ROUTE_HISTORY_LIMIT;
    const lastItem = pageItems.at(-1) ?? null;

    return {
      routes: pageItems.map(toRouteHistoryItem),
      pageInfo: {
        endCursor: lastItem === null ? null : encodeRouteHistoryCursor(lastItem),
        hasNextPage
      }
    };
  }

  async submitRouteFeedback(input: SubmitDriverRouteFeedbackInput): Promise<SubmitDriverRouteFeedbackResult> {
    const scoped = await this.resolveScopedDriver(input);
    const routePlan = await this.prisma.routePlan.findFirst({
      select: { id: true },
      where: {
        driverId: input.driverId,
        id: input.routePlanId,
        shopId: scoped.shop.id,
        status: { in: [...SUPPORTED_ROUTE_STATUSES] }
      }
    });

    if (routePlan === null) {
      throw new DriverSelfServiceScopeError('Route not assigned to driver');
    }

    const feedback = await this.prisma.driverRouteFeedback.create({
      data: {
        driverId: input.driverId,
        reviewNote: input.reviewNote,
        routePlanId: input.routePlanId,
        shopId: scoped.shop.id,
        submittedAt: input.submittedAt
      }
    });

    return {
      feedbackId: feedback.id,
      reviewNote: feedback.reviewNote,
      routePlanId: feedback.routePlanId,
      submittedAt: feedback.submittedAt.toISOString()
    };
  }

  async getDriverProfile(input: DriverSelfServiceScopeInput): Promise<{ driver: DriverSelfProfile }> {
    const scoped = await this.resolveScopedDriver(input);
    return { driver: scoped.driver };
  }

  async updateDriverProfile(input: UpdateDriverProfileInput): Promise<{ driver: DriverSelfProfile }> {
    const scoped = await this.resolveScopedDriver(input);
    const driver = await this.prisma.driver.update({
      data: { displayName: input.displayName },
      select: driverProfileSelect,
      where: { id: scoped.driver.id }
    });

    return { driver: toDriverProfile(driver) };
  }

  async requestAccountDeletion(input: DriverAccountDeletionRequestInput): Promise<DriverAccountDeletionRequestResult> {
    const scoped = await this.resolveScopedDriver(input);
    const request = await this.prisma.driverAccountDeletionRequest.create({
      data: {
        driverId: input.driverId,
        driverDisplayName: scoped.driver.displayName,
        driverPhone: scoped.driver.phone,
        reason: input.reason,
        requestedAt: input.requestedAt,
        shopDomain: scoped.shop.shopDomain,
        shopId: scoped.shop.id,
        status: 'REQUESTED'
      }
    });

    return {
      requestId: request.id,
      status: request.status
    };
  }

  async getDriverEarnings(input: GetDriverEarningsInput): Promise<DriverEarningsResult> {
    const scoped = await this.resolveScopedDriver(input);
    const { end, start } = monthRange(input.period);
    const routePlans = await this.prisma.routePlan.findMany({
      include: {
        routeStops: {
          include: {
            deliveryStop: {
              select: { status: true }
            }
          }
        }
      },
      where: {
        driverId: input.driverId,
        planDate: { gte: start, lt: end },
        shopId: scoped.shop.id,
        status: RoutePlanStatus.COMPLETED
      }
    });

    const completedStops = routePlans.reduce(
      (sum, routePlan) => sum + routePlan.routeStops.filter((stop) => stop.deliveryStop.status === 'DELIVERED').length,
      0
    );

    return {
      currency: readCurrency(routePlans.map((routePlan) => routePlan.constraints)),
      items: [],
      period: input.period,
      summary: {
        adjustments: 0,
        completedRoutes: routePlans.length,
        completedStops,
        estimatedPayout: 0,
        grossAmount: 0
      }
    };
  }

  private async resolveScopedDriver(input: DriverSelfServiceScopeInput): Promise<ScopedDriverRecord> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({
      select: { id: true, shopDomain: true },
      where: { shopDomain }
    });

    if (shop === null) {
      throw new DriverSelfServiceScopeError(`Shop not installed: ${shopDomain}`);
    }

    const driver = await this.prisma.driver.findFirst({
      select: driverProfileSelect,
      where: {
        id: input.driverId,
        shopId: shop.id,
        status: 'ACTIVE'
      }
    });

    if (driver === null) {
      throw new DriverSelfServiceScopeError(`Driver not found for shop: ${input.driverId}`);
    }

    return { driver: toDriverProfile(driver), shop };
  }
}

const driverProfileSelect = {
  displayName: true,
  id: true,
  phone: true,
  status: true
} as const;

function routeHistoryIncludeFor(driverId: string) {
  return {
    driverEvents: {
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
      take: 1,
      where: {
        driverId,
        eventType: 'ROUTE_COMPLETED'
      }
    },
    routeStops: {
      include: {
        deliveryStop: {
          select: { status: true }
        }
      }
    },
    shop: { select: { shopDomain: true } }
  } as const;
}

function toDriverProfile(driver: {
  displayName: string;
  id: string;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
}): DriverSelfProfile {
  return {
    displayName: driver.displayName,
    id: driver.id,
    phone: driver.phone,
    status: driver.status
  };
}

function toRouteHistoryItem(routePlan: RoutePlanHistoryRecord): DriverRouteHistoryItem {
  const stopStatuses = routePlan.routeStops.map((stop) => stop.deliveryStop.status);
  return {
    completedAt: routePlan.driverEvents[0]?.occurredAt.toISOString() ?? null,
    completedStopCount: stopStatuses.filter((status) => status === 'DELIVERED').length,
    deliveryDate: formatDateOnly(routePlan.planDate),
    failedStopCount: stopStatuses.filter((status) => status === 'FAILED').length,
    name: routePlan.name,
    routePlanId: routePlan.id,
    shopDomain: normalizeShopDomain(routePlan.shop.shopDomain),
    companyDisplayName: readCompanyDisplayName(routePlan.constraints, routePlan.shop.shopDomain),
    status: toHistoryStatus(routePlan.status),
    stopCount: stopStatuses.length,
    timezone: readIanaTimezone(routePlan.constraints),
  };
}

function toHistoryStatus(status: string): DriverRouteHistoryStatus {
  if (status === 'COMPLETED') {
    return 'completed';
  }
  if (status === 'IN_PROGRESS') {
    return 'active';
  }
  return 'pending';
}

function routePlanStatusesFor(status: DriverRouteHistoryStatus | null): RoutePlanStatus[] {
  if (status === 'completed') {
    return [RoutePlanStatus.COMPLETED];
  }
  if (status === 'active') {
    return [RoutePlanStatus.IN_PROGRESS];
  }
  if (status === 'pending') {
    return [RoutePlanStatus.OPTIMIZED, RoutePlanStatus.ASSIGNED];
  }

  return [...SUPPORTED_ROUTE_STATUSES];
}

function readCompanyDisplayName(value: unknown, shopDomain: string): string {
  const constraints = objectOrNull(value);
  return readString(constraints?.companyDisplayName) ?? displayNameFromShopDomain(shopDomain);
}

function readCurrency(values: unknown[]): string {
  for (const value of values) {
    const constraints = objectOrNull(value);
    const currency = readString(constraints?.currency);
    if (currency !== null && /^[A-Z]{3}$/u.test(currency)) {
      return currency;
    }
  }

  return 'CAD';
}

function readIanaTimezone(value: unknown): string {
  const constraints = objectOrNull(value);
  const routeScope = objectOrNull(constraints?.routeScope);
  return coerceIanaTimezone(readString(constraints?.timezone) ?? readString(routeScope?.timezone));
}
function encodeRouteHistoryCursor(routePlan: RoutePlanHistoryRecord): string {
  return Buffer.from(JSON.stringify({ id: routePlan.id, planDate: formatDateOnly(routePlan.planDate) }), 'utf8').toString('base64url');
}

function decodeRouteHistoryCursor(value: string | null): { id: string; planDate: Date } | null {
  if (value === null) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { id?: unknown; planDate?: unknown };
    if (typeof decoded.id !== 'string' || typeof decoded.planDate !== 'string') {
      throw new Error('Invalid cursor');
    }
    return { id: decoded.id, planDate: parseDateOnly(decoded.planDate) };
  } catch (error) {
    throw new DriverRouteHistoryCursorError('Invalid route history cursor', { cause: error });
  }
}

function monthRange(period: string): { end: Date; start: Date } {
  const match = /^(\d{4})-(\d{2})$/u.exec(period);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error('Invalid earnings period');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) {
    throw new Error('Invalid earnings period');
  }

  return {
    end: new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1)),
    start: new Date(Date.UTC(year, month - 1, 1))
  };
}

function parseDateOnly(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error('Invalid date');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || formatDateOnly(date) !== value) {
    throw new Error('Invalid date');
  }
  return date;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
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

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '').replace(/\/$/u, '');

  if (!withoutProtocol.endsWith('.myshopify.com')) {
    throw new Error('Shop domain must end with .myshopify.com');
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(withoutProtocol)) {
    throw new Error('Shop domain is not a valid myshopify.com domain');
  }

  return withoutProtocol;
}

function displayNameFromShopDomain(shopDomain: string): string {
  return normalizeShopDomain(shopDomain).replace(/\.myshopify\.com$/u, '');
}
