import type { PrismaClient } from '@prisma/client';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';

import type {
  DriverAssignedRouteInput,
  DriverAssignedRouteResult,
  DriverAssignedRouteStop,
  DriverAssignedRouteStopPoint
} from './driver-assigned-route.types.js';
import { coerceIanaTimezone } from './driver-route-timezone.js';
import type {
  RoutePlanDetail,
  RoutePlanDetailStop,
  RoutePlanEndMode,
  RoutePlanRouteResult,
  RoutePlanRouteStopPoint
} from '../route-plans/route-plan.types.js';
import { applyCachedRouteGeometry, computeRouteShapeSignature } from '../route-plans/route-plan-geometry-cache.js';
import type { RouteGeometryCacheRead } from '../route-plans/route-plan-geometry-cache.js';
import { readNormalizedPaymentStatus } from '../payments/normalized-payment-status.js';
import {
  aggregateOrderItems,
  toOrderItemDto,
  type OrderItemRecordLike
} from '../order-items/order-items.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';

type DriverAssignedRoutePrismaClient = Pick<PrismaClient, 'driver' | 'routePlan' | 'routePlanGeometryCache' | 'shop'>;

type AssignedRoutePlanRecord = {
  createdAt: Date;
  constraints: unknown;
  depotLatitude: unknown;
  depotLongitude: unknown;
  id: string;
  metrics: unknown;
  name: string;
  planDate: Date;
  routeStops: AssignedRoutePlanStopRecord[];
  shop: {
    shopDomain: string;
  };
  status: string;
  updatedAt: Date;
};


type RoutePlanGeometryCacheRecord = {
  generatedAt: Date;
  geometry: unknown;
  metrics: unknown;
  provider: string;
  providerVersion: string | null;
  shapeSignature: string;
  source: string;
  stopPoints: unknown;
};

type RoutePlanGeometryCacheMetadataRecord = Omit<RoutePlanGeometryCacheRecord, 'geometry' | 'metrics' | 'stopPoints'>;

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
      financialStatus: string | null;
      fulfillmentStatus: string | null;
      id: string;
      name: string;
      orderItems?: OrderItemRecordLike[];
      rawPayload: unknown;
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
          order: {
            include: {
              orderItems: {
                orderBy: { lineIndex: 'asc' }
              }
            }
          }
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
    const shop = await this.prisma.shop.findUnique({ where: appScopedShopWhere({ shopDomain }) });
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

    return toAssignedRouteResult(routePlan, await this.readCachedRouteResult(routePlan));
  }

  private readCachedRouteResult(routePlan: AssignedRoutePlanRecord): Promise<RoutePlanRouteResult> {
    return readCachedRouteResult(this.prisma, routePlan);
  }
}

async function readCachedRouteResult(
  client: Pick<DriverAssignedRoutePrismaClient, 'routePlanGeometryCache'>,
  routePlan: AssignedRoutePlanRecord
): Promise<RoutePlanRouteResult> {
  const detail = toRoutePlanDetailForCache(routePlan);
  const cachedDetail = applyCachedRouteGeometry(
    detail,
    await readMatchingRouteGeometryCache(client, detail)
  );
  return {
    routeGeometry: cachedDetail.routeGeometry,
    routeMetrics: cachedDetail.routeMetrics,
    routeStopPoints: cachedDetail.routeStopPoints
  };
}

async function readMatchingRouteGeometryCache(
  client: Pick<DriverAssignedRoutePrismaClient, 'routePlanGeometryCache'>,
  detail: RoutePlanDetail
): Promise<RouteGeometryCacheRead | null> {
  const shapeSignature = computeRouteShapeSignature(detail);
  const matching = await client.routePlanGeometryCache.findUnique({
    select: routeGeometryCacheSelect(),
    where: {
      routePlanId_shapeSignature: {
        routePlanId: detail.routePlan.id,
        shapeSignature
      }
    }
  }) as RoutePlanGeometryCacheRecord | null;
  if (matching !== null) return matching;

  const latest = await client.routePlanGeometryCache.findFirst({
    orderBy: { generatedAt: 'desc' },
    select: routeGeometryCacheMetadataSelect(),
    where: { routePlanId: detail.routePlan.id }
  });
  return toStaleRouteGeometryCacheRead(latest);
}

function routeGeometryCacheSelect() {
  return {
    generatedAt: true,
    geometry: true,
    metrics: true,
    provider: true,
    providerVersion: true,
    shapeSignature: true,
    source: true,
    stopPoints: true
  } as const;
}

function routeGeometryCacheMetadataSelect() {
  return {
    generatedAt: true,
    geometry: false,
    metrics: false,
    provider: true,
    providerVersion: true,
    shapeSignature: true,
    source: true,
    stopPoints: false
  } as const;
}

function toStaleRouteGeometryCacheRead(record: RoutePlanGeometryCacheMetadataRecord | null): RouteGeometryCacheRead | null {
  if (record === null) return null;
  return {
    ...record,
    geometry: null,
    metrics: null,
    stopPoints: []
  };
}

function toAssignedRouteResult(
  routePlan: AssignedRoutePlanRecord,
  routeResult: RoutePlanRouteResult = emptyRouteResult()
): DriverAssignedRouteResult {
  return {
    status: 'ASSIGNED_ROUTE',
    route: {
      deliveryDate: formatDateOnly(routePlan.planDate),
      id: routePlan.id,
      name: routePlan.name,
      routeGeometry: routeResult.routeGeometry,
      routeMapPreview: null,
      routeMetrics: routeResult.routeMetrics,
      routeStopPoints: routeResult.routeStopPoints.map(toAssignedRouteStopPoint),
      shopDomain: normalizeDriverCommerceDomain(routePlan.shop.shopDomain),
      stops: [...routePlan.routeStops]
        .sort((left, right) => left.sequence - right.sequence)
        .map(toAssignedRouteStop),
      timezone: readTimezone(routePlan.constraints)
    }
  };
}

function toRoutePlanDetailForCache(routePlan: AssignedRoutePlanRecord): RoutePlanDetail {
  const sortedStops = [...routePlan.routeStops].sort((left, right) => left.sequence - right.sequence);
  const itemSummary = aggregateOrderItems(routeItemDtosFromStops(sortedStops));
  return {
    routePlan: {
      createdAt: routePlan.createdAt.toISOString(),
      deliveryAreas: [],
      deliveryDays: [],
      depot: {
        latitude: decimalNumber(routePlan.depotLatitude),
        longitude: decimalNumber(routePlan.depotLongitude)
      },
      id: routePlan.id,
      itemSummary,
      missingCoordinates: sortedStops.filter((routeStop) => {
        const stop = routeStop.deliveryStop;
        return decimalNumber(stop.latitude) === null || decimalNumber(stop.longitude) === null;
      }).length,
      name: routePlan.name,
      planDate: formatDateOnly(routePlan.planDate),
      routeEndMode: readRouteEndMode(routePlan.constraints),
      status: routePlan.status,
      stopsCount: sortedStops.length,
      updatedAt: routePlan.updatedAt.toISOString()
    },
    routeGeometry: null,
    routeMetrics: null,
    routeStopPoints: [],
    stops: sortedStops.map(toRoutePlanDetailStop)
  };
}

function toAssignedRouteStop(routeStop: AssignedRoutePlanStopRecord): DriverAssignedRouteStop {
  const deliveryStop = routeStop.deliveryStop;
  const rawPayload = objectOrNull(deliveryStop.order.rawPayload);
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
    items: (deliveryStop.order.orderItems ?? []).map((item) => toOrderItemDto(item)),
    normalizedPaymentStatus: readNormalizedPaymentStatus(rawPayload?.normalizedPaymentStatus),
    orderName: deliveryStop.order.name,
    phone: deliveryStop.phone,
    recipientName: deliveryStop.recipientName,
    sequence: routeStop.sequence,
    status: deliveryStop.status
  };
}

function toAssignedRouteStopPoint(routeStopPoint: RoutePlanRouteStopPoint): DriverAssignedRouteStopPoint {
  return {
    deliveryStopId: routeStopPoint.deliveryStopId,
    inputCoordinates: routeStopPoint.inputCoordinates,
    name: routeStopPoint.name,
    sequence: routeStopPoint.sequence,
    snapDistanceMeters: routeStopPoint.snapDistanceMeters,
    snappedCoordinates: routeStopPoint.snappedCoordinates
  };
}

function toRoutePlanDetailStop(routeStop: AssignedRoutePlanStopRecord): RoutePlanDetailStop {
  const deliveryStop = routeStop.deliveryStop;
  const rawPayload = objectOrNull(deliveryStop.order.rawPayload);
  return {
    address: {
      address1: deliveryStop.address1,
      address2: deliveryStop.address2,
      city: deliveryStop.city,
      countryCode: deliveryStop.countryCode,
      postalCode: deliveryStop.postalCode,
      province: deliveryStop.province
    },
    attributes: [],
    coordinates: {
      latitude: decimalNumber(deliveryStop.latitude),
      longitude: decimalNumber(deliveryStop.longitude)
    },
    deliveryArea: null,
    deliveryDay: null,
    deliveryStopId: deliveryStop.id,
    financialStatus: deliveryStop.order.financialStatus,
    fulfillmentStatus: deliveryStop.order.fulfillmentStatus,
    items: (deliveryStop.order.orderItems ?? []).map((item) => toOrderItemDto(item)),
    normalizedPaymentStatus: readNormalizedPaymentStatus(rawPayload?.normalizedPaymentStatus),
    orderId: deliveryStop.order.id,
    orderName: deliveryStop.order.name,
    paymentStatus: deliveryStop.order.financialStatus,
    recipientName: deliveryStop.recipientName,
    sequence: routeStop.sequence,
    shopifyOrderGid: deliveryStop.order.shopifyOrderGid,
    status: deliveryStop.status
  };
}

function routeItemDtosFromStops(stops: AssignedRoutePlanStopRecord[]) {
  return stops.flatMap((routeStop) =>
    (routeStop.deliveryStop.order.orderItems ?? []).map((item) => toOrderItemDto(item))
  );
}

function readRouteEndMode(value: unknown): RoutePlanEndMode {
  const constraints = objectOrNull(value);
  return constraints?.routeEndMode === 'RETURN_TO_DEPOT' ? 'RETURN_TO_DEPOT' : 'END_AT_LAST_STOP';
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

function emptyRouteResult(): RoutePlanRouteResult {
  return { routeGeometry: null, routeMetrics: null, routeStopPoints: [] };
}
