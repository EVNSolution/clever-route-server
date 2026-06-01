import type { PrismaClient } from '@prisma/client';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';

import type {
  DriverAssignedRouteInput,
  DriverAssignedRouteResult,
  DriverAssignedRouteStop
} from './driver-assigned-route.types.js';
import { coerceIanaTimezone } from './driver-route-timezone.js';

type DriverAssignedRoutePrismaClient = Pick<PrismaClient, 'driver' | 'routePlan' | 'shop'>;

type AssignedRoutePlanRecord = {
  constraints: unknown;
  id: string;
  name: string;
  planDate: Date;
  routeStops: AssignedRoutePlanStopRecord[];
  shop: {
    shopDomain: string;
  };
  status: string;
};

type AssignedRoutePlanStopRecord = {
  deliveryStop: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    countryCode: string | null;
    id: string;
    latitude: unknown;
    longitude: unknown;
    order: {
      name: string;
      shopifyOrderGid: string;
    };
    phone: string | null;
    postalCode: string | null;
    province: string | null;
    recipientName: string | null;
    status: string;
  };
  sequence: number;
};

const assignedRouteInclude = {
  routeStops: {
    include: {
      deliveryStop: {
        include: {
          order: true
        }
      }
    },
    orderBy: {
      sequence: 'asc'
    }
  },
  shop: {
    select: {
      shopDomain: true
    }
  }
} as const;

export class PrismaDriverAssignedRouteRepository {
  constructor(private readonly prisma: DriverAssignedRoutePrismaClient) {}

  async getAssignedRoute(input: DriverAssignedRouteInput): Promise<DriverAssignedRouteResult> {
    const shopDomain = normalizeDriverCommerceDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({ where: { shopDomain } });
    if (shop === null) {
      throw new Error(`Shop not installed: ${shopDomain}`);
    }

    const driver = await this.prisma.driver.findUnique({ where: { id: input.driverId } });
    if (driver === null || driver.shopId !== shop.id) {
      throw new Error(`Driver not found for shop: ${input.driverId}`);
    }

    const routePlan = await this.prisma.routePlan.findFirst({
      include: assignedRouteInclude,
      orderBy: { planDate: 'desc' },
      where: {
        driverId: input.driverId,
        ...(input.routeContext === null ? {} : { id: input.routeContext }),
        shopId: shop.id,
        status: { in: ['ASSIGNED', 'IN_PROGRESS', 'OPTIMIZED'] }
      }
    });

    if (routePlan === null) {
      return { status: 'NO_ASSIGNED_ROUTE' };
    }

    return toAssignedRouteResult(routePlan);
  }
}

function toAssignedRouteResult(routePlan: AssignedRoutePlanRecord): DriverAssignedRouteResult {
  return {
    status: 'ASSIGNED_ROUTE',
    route: {
      deliveryDate: formatDateOnly(routePlan.planDate),
      id: routePlan.id,
      name: routePlan.name,
      shopDomain: normalizeDriverCommerceDomain(routePlan.shop.shopDomain),
      stops: [...routePlan.routeStops]
        .sort((left, right) => left.sequence - right.sequence)
        .map(toAssignedRouteStop),
      timezone: readTimezone(routePlan.constraints)
    }
  };
}

function toAssignedRouteStop(routeStop: AssignedRoutePlanStopRecord): DriverAssignedRouteStop {
  const deliveryStop = routeStop.deliveryStop;
  return {
    address: {
      address1: deliveryStop.address1,
      address2: deliveryStop.address2,
      city: deliveryStop.city,
      countryCode: deliveryStop.countryCode,
      postalCode: deliveryStop.postalCode,
      province: deliveryStop.province
    },
    coordinates: {
      latitude: decimalNumber(deliveryStop.latitude),
      longitude: decimalNumber(deliveryStop.longitude)
    },
    deliveryStopId: deliveryStop.id,
    orderName: deliveryStop.order.name,
    phone: deliveryStop.phone,
    recipientName: deliveryStop.recipientName,
    sequence: routeStop.sequence,
    status: deliveryStop.status
  };
}

function readTimezone(value: unknown): string {
  const constraints = objectOrNull(value);
  const routeScope = objectOrNull(constraints?.routeScope);
  return coerceIanaTimezone(readString(constraints?.timezone) ?? readString(routeScope?.timezone));
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

function decimalNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (hasToNumber(value)) {
    const parsed = value.toNumber();
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function hasToNumber(value: unknown): value is { toNumber: () => unknown } {
  if (typeof value !== 'object' || value === null || !('toNumber' in value)) {
    return false;
  }

  return typeof (value as { toNumber?: unknown }).toNumber === 'function';
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
