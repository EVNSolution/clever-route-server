import { Prisma, type PrismaClient } from '@prisma/client';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';

import type {
  DriverAssignedRouteInput,
  DriverAssignedRouteResult,
  DriverAssignedRouteStop,
  DriverAssignedRouteStopPoint
} from './driver-assigned-route.types.js';
import { buildDriverRouteEtaSnapshot, type DriverRouteEtaStop } from './driver-route-eta.js';
import { coerceIanaTimezone } from './driver-route-timezone.js';
import type {
  RoutePlanDetail,
  RoutePlanDetailStop,
  RoutePlanEndMode,
  RoutePlanRouteResult,
  RoutePlanRouteStopPoint
} from '../route-plans/route-plan.types.js';
import { applyCachedRouteGeometry, computeRouteShapeSignature } from '../route-plans/route-plan-geometry-cache.js';
import { ROUTE_DRIVER_OPERATIONAL_STATUSES } from '../route-plans/route-plan-lifecycle.js';
import type { RouteGeometryCacheRead } from '../route-plans/route-plan-geometry-cache.js';
import { resolveNormalizedPaymentStatus } from '../payments/normalized-payment-status.js';
import {
  aggregateOrderItems,
  toOrderItemDto,
  type OrderItemRecordLike
} from '../order-items/order-items.js';
import {
  deriveDsvTimeConstraintState,
  dsvTimeConstraintAuditEvents,
  normalizeRawNote
} from '../dsv/dsv-time-constraint.js';
type DriverAssignedRoutePrismaClient = Pick<PrismaClient, 'routePlan' | 'routePlanGeometryCache'>;

type AssignedRoutePlanRecord = {
  createdAt: Date;
  constraints: unknown;
  depotLatitude: unknown;
  depotLongitude: unknown;
  driverId: string | null;
  id: string;
  metrics: unknown;
  name: string;
  planDate: Date;
  routeStops: AssignedRoutePlanStopRecord[];
  driverEvents: Array<{ createdAt: Date }>;
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
    instructions: string | null;
    latitude: unknown;
    longitude: unknown;
    dsvDispatchChangeRequests: Array<{
      createdAt: Date;
      id: string;
      status: string;
      timeWindowEnd: Date | null;
      timeWindowStart: Date | null;
      type: string;
    }>;
    driverEvents: Array<{
      driverId: string | null;
      id: string;
      occurredAt: Date;
      routePlanId: string | null;
    }>;
    order: {
      currentRouteVersion: {
        createdAt: Date;
      } | null;
      currentRouteVersionId: string | null;
      currencyCode: string | null;
      destinationId: string | null;
      dsvAuditEvents: Array<{
        actorId: string | null;
        eventType: string;
        id: string;
        occurredAt: Date;
        redactedDiff: unknown;
      }>;
      financialStatus: string | null;
      fulfillmentStatus: string | null;
      id: string;
      name: string;
      orderItems?: OrderItemRecordLike[];
      orderMessages: Array<{
        body: string;
        createdAt: Date;
        id: string;
        readByDriverAt: Date | null;
      }>;
      rawPayload: unknown;
      shopifyOrderGid: string;
      totalPriceAmount: unknown;
    };
    phone: string | null;
    postalCode: string | null;
    province: string | null;
    recipientName: string | null;
    serviceMinutes: number | null;
    status: string;
    timeWindowEnd: Date | null;
    timeWindowStart: Date | null;
  };
  durationFromPreviousSeconds: number | null;
  distanceFromPreviousMeters: number | null;
  etaCalculatedAt: Date | null;
  etaFailureCode: string | null;
  etaFailureMessage: string | null;
  estimatedArrivalAt: Date | null;
  sequence: number;
};

const assignedRouteInclude = {
  driverEvents: {
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
    take: 1,
    where: { eventType: 'PICKUP_COMPLETED' }
  },
  routeStops: {
    include: {
      deliveryStop: {
        include: {
          driverEvents: {
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            select: { driverId: true, id: true, occurredAt: true, routePlanId: true },
            where: { eventType: 'TIME_CONSTRAINT_ACKNOWLEDGED' }
          },
          dsvDispatchChangeRequests: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { createdAt: true, id: true, status: true, timeWindowEnd: true, timeWindowStart: true, type: true },
            take: 1,
            where: { status: 'PENDING_ACK', type: 'TIME_CONSTRAINT_CHANGE' }
          },
          order: {
            include: {
              currentRouteVersion: {
                select: { createdAt: true }
              },
              dsvAuditEvents: {
                orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
                select: {
                  actorId: true,
                  eventType: true,
                  id: true,
                  occurredAt: true,
                  redactedDiff: true
                },
                where: { eventType: { in: dsvTimeConstraintAuditEvents.slice() } }
              },
              orderItems: {
                orderBy: { lineIndex: 'asc' }
              },
              orderMessages: {
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { body: true, createdAt: true, id: true, readByDriverAt: true },
                where: { audience: 'DRIVER' }
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
} satisfies Prisma.RoutePlanInclude;

export class PrismaDriverAssignedRouteRepository {
  constructor(private readonly prisma: DriverAssignedRoutePrismaClient) {}

  async getAssignedRoute(input: DriverAssignedRouteInput): Promise<DriverAssignedRouteResult> {
    const routePlan = await this.prisma.routePlan.findFirst({
      include: assignedRouteInclude,
      orderBy: { planDate: 'desc' },
      where: {
        driverId: input.driverId,
        ...(input.routeContext === null ? {} : { id: input.routeContext }),
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        routeStops: { some: {} },
        shopId: input.shopId,
        status: { in: [...ROUTE_DRIVER_OPERATIONAL_STATUSES] }
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
      depot: {
        latitude: decimalNumber(routePlan.depotLatitude),
        longitude: decimalNumber(routePlan.depotLongitude)
      },
      etaSnapshot: buildDriverRouteEtaSnapshot({
        pickupCompletedAt: routePlan.driverEvents[0]?.createdAt ?? null,
        stops: routePlan.routeStops.map(toEtaStop)
      }),
      id: routePlan.id,
      name: routePlan.name,
      routeGeometry: routeResult.routeGeometry,
      routeMapPreview: null,
      routeMetrics: routeResult.routeMetrics,
      routeStopPoints: routeResult.routeStopPoints.map(toAssignedRouteStopPoint),
      shopDomain: normalizeDriverCommerceDomain(routePlan.shop.shopDomain),
      stops: [...routePlan.routeStops]
        .sort((left, right) => left.sequence - right.sequence)
        .map((routeStop) => toAssignedRouteStop(routeStop, routePlan)),
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

function toAssignedRouteStop(routeStop: AssignedRoutePlanStopRecord, routePlan: AssignedRoutePlanRecord): DriverAssignedRouteStop {
  const deliveryStop = routeStop.deliveryStop;
  const rawPayload = objectOrNull(deliveryStop.order.rawPayload);
  const dsvNormalized = readDsvNormalizedPayload(rawPayload);
  const timeConstraintState = deriveDsvTimeConstraintState({
    audits: deliveryStop.order.dsvAuditEvents,
    currentRouteVersionCreatedAt: deliveryStop.order.currentRouteVersion?.createdAt ?? null,
    currentRouteVersionId: deliveryStop.order.currentRouteVersionId,
    rawNote: deliveryStop.instructions,
    timeWindowEnd: deliveryStop.timeWindowEnd,
    timeWindowStart: deliveryStop.timeWindowStart
  });
  const acknowledgement = deliveryStop.driverEvents.find((event) =>
    event.driverId === routePlan.driverId && event.routePlanId === routePlan.id
  ) ?? null;
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
    currencyCode: readCurrencyCode(deliveryStop.order.currencyCode),
    customerNote: readCustomerNote(rawPayload),
    deliverySession: readString(rawPayload?.deliverySession)
      ?? readString(rawPayload?.delivery_session),
    deliveryStopId: deliveryStop.id,
    destinationId: deliveryStop.order.destinationId
      ?? readString(dsvNormalized?.destinationId)
      ?? readString(rawPayload?.destinationId)
      ?? readString(rawPayload?.destination_id),
    distanceFromPreviousMeters: routeStop.distanceFromPreviousMeters,
    durationFromPreviousSeconds: routeStop.durationFromPreviousSeconds,
    driverMessages: deliveryStop.order.orderMessages.map((message) => ({
      body: message.body,
      createdAt: message.createdAt.toISOString(),
      messageId: message.id,
      readAt: message.readByDriverAt?.toISOString() ?? null
    })),
    estimatedArrivalAt: routeStop.estimatedArrivalAt?.toISOString() ?? null,
    conditionCode: readConditionComparisonKey(dsvNormalized, rawPayload),
    items: (deliveryStop.order.orderItems ?? []).map((item) => toOrderItemDto(item)),
    normalizedPaymentStatus: resolveNormalizedPaymentStatus({
      financialStatus: deliveryStop.order.financialStatus,
      normalizedPaymentStatus: rawPayload?.normalizedPaymentStatus
    }),
    orderName: deliveryStop.order.name,
    paymentMethodTitle: readPaymentMethodTitle(rawPayload),
    ...optionalPendingTimeConstraintChange(toPendingTimeConstraintChange(deliveryStop.dsvDispatchChangeRequests?.[0] ?? null)),
    phone: deliveryStop.phone,
    recipientName: deliveryStop.recipientName,
    sequence: routeStop.sequence,
    serviceType: readString(rawPayload?.serviceType)
      ?? readString(rawPayload?.service_type),
    sellerOrderKey: readString(dsvNormalized?.sellerOrderKey)
      ?? readString(rawPayload?.sellerOrderKey)
      ?? readString(rawPayload?.seller_order_key),
    shippedBoxes: readInteger(dsvNormalized?.shippedBoxes)
      ?? readInteger(rawPayload?.shippedBoxes)
      ?? readInteger(rawPayload?.shipped_boxes),
    specialInstructionNote: normalizeRawNote(deliveryStop.instructions),
    status: deliveryStop.status,
    routeConstraintStatus: timeConstraintState.routeConstraintStatus,
    timeConstraintAcknowledgement: acknowledgement === null
      ? null
      : {
          acknowledgedAt: acknowledgement.occurredAt.toISOString(),
          eventId: acknowledgement.id
        },
    timeWindow: timeConstraintState.timeConstraint === null
      ? null
      : {
          end: timeConstraintState.timeConstraint.timeWindowEnd,
          start: timeConstraintState.timeConstraint.timeWindowStart
        },
    timeWindowEnd: deliveryStop.timeWindowEnd?.toISOString() ?? null,
    timeWindowStart: deliveryStop.timeWindowStart?.toISOString() ?? null,
    totalPriceAmount: decimalString(deliveryStop.order.totalPriceAmount)
  };
}

function optionalPendingTimeConstraintChange(
  value: DriverAssignedRouteStop['pendingTimeConstraintChange'],
): Pick<DriverAssignedRouteStop, 'pendingTimeConstraintChange'> | Record<string, never> {
  return value === null || value === undefined ? {} : { pendingTimeConstraintChange: value };
}

function toPendingTimeConstraintChange(change: AssignedRoutePlanStopRecord['deliveryStop']['dsvDispatchChangeRequests'][number] | null): DriverAssignedRouteStop['pendingTimeConstraintChange'] {
  if (change === null || change.status !== 'PENDING_ACK' || change.type !== 'TIME_CONSTRAINT_CHANGE') return null;
  return {
    pendingChangeId: change.id,
    requestedAt: change.createdAt.toISOString(),
    status: 'PENDING_ACK',
    type: 'TIME_CONSTRAINT_CHANGE',
    timeWindow: change.timeWindowStart === null || change.timeWindowEnd === null
      ? null
      : {
          end: formatTimeOnly(change.timeWindowEnd),
          start: formatTimeOnly(change.timeWindowStart)
        }
  };
}

function toEtaStop(routeStop: AssignedRoutePlanStopRecord): DriverRouteEtaStop {
  return {
    deliveryStopId: routeStop.deliveryStop.id,
    distanceFromPreviousMeters: routeStop.distanceFromPreviousMeters,
    durationFromPreviousSeconds: routeStop.durationFromPreviousSeconds,
    etaCalculatedAt: routeStop.etaCalculatedAt,
    etaFailureCode: routeStop.etaFailureCode,
    etaFailureMessage: routeStop.etaFailureMessage,
    estimatedArrivalAt: routeStop.estimatedArrivalAt,
    sequence: routeStop.sequence,
    serviceMinutes: routeStop.deliveryStop.serviceMinutes,
    status: routeStop.deliveryStop.status
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
    normalizedPaymentStatus: resolveNormalizedPaymentStatus({
      financialStatus: deliveryStop.order.financialStatus,
      normalizedPaymentStatus: rawPayload?.normalizedPaymentStatus
    }),
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

function readInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/u.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function readDsvNormalizedPayload(rawPayload: Record<string, unknown> | null): Record<string, unknown> | null {
  const dsv = objectOrNull(rawPayload?.dsv);
  return objectOrNull(dsv?.normalized);
}

function readConditionComparisonKey(
  dsvNormalized: Record<string, unknown> | null,
  rawPayload: Record<string, unknown> | null
): string | null {
  return conditionComparisonKey(
    readString(dsvNormalized?.conditionComparisonKey)
      ?? readString(dsvNormalized?.conditionCode)
      ?? readString(rawPayload?.conditionComparisonKey)
      ?? readString(rawPayload?.conditionCode)
      ?? readString(rawPayload?.condition_code)
  );
}

function conditionComparisonKey(value: string | null): string | null {
  return value === null ? null : value.trim().toUpperCase();
}

function readCustomerNote(rawPayload: Record<string, unknown> | null): string | null {
  if (rawPayload === null) {
    return null;
  }

  for (const key of ['customer_note', 'customerNote', 'note']) {
    const value = readString(rawPayload[key]);
    if (value !== null) {
      return value;
    }
  }

  const customer = objectOrNull(rawPayload.customer);
  return readString(customer?.note);
}

function readCurrencyCode(value: unknown): string | null {
  const currencyCode = readString(value)?.toUpperCase() ?? null;
  return currencyCode !== null && /^[A-Z]{3}$/u.test(currencyCode) ? currencyCode : null;
}

function readPaymentMethodTitle(rawPayload: Record<string, unknown> | null): string | null {
  if (rawPayload === null) {
    return null;
  }
  return readString(rawPayload.payment_method_title)
    ?? readString(rawPayload.paymentMethodTitle)
    ?? readString(rawPayload.payment_method)
    ?? readString(rawPayload.paymentMethod);
}

function decimalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    const normalized = String(value).trim();
    return /^-?\d+(?:\.\d+)?$/u.test(normalized) ? normalized : null;
  }
  if (value instanceof Prisma.Decimal) {
    const normalized = value.toString().trim();
    return /^-?\d+(?:\.\d+)?$/u.test(normalized) ? normalized : null;
  }
  return null;
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

function formatTimeOnly(date: Date): string {
  return date.toISOString().slice(11, 16);
}

function emptyRouteResult(): RoutePlanRouteResult {
  return { routeGeometry: null, routeMetrics: null, routeStopPoints: [] };
}
