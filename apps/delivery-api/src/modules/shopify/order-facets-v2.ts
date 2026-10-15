import { Prisma, type PrismaClient } from '@prisma/client';

import { V2_FULFILLMENT, V2_PAYMENT, V2_PROGRESS, V2_SERVICES } from './order-filters-v2.js';
import type { ListCanonicalOrdersFilters } from './order-sync.repository.js';

// v2 facets used to send one COUNT per option value (~40 per request, each
// re-reading rawPayload). This loads the few facts each predicate needs in one
// query and counts in memory. The predicates below mirror ordersV2Where and
// deliveryProgressWhere in order-filters-v2.ts; change both together.

export const V2_FACET_KEYS = [
  'scheduledDateFrom',
  'scheduledDateTo',
  'scheduledDateMissing',
  'scheduledWeekdays',
  'scheduledActualDates',
  'serviceTypes',
  'areas',
  'areaMissing',
  'paymentStatuses',
  'fulfillmentStatuses',
  'deliveryProgress',
] as const satisfies readonly (keyof ListCanonicalOrdersFilters)[];

export type V2FacetOrder = {
  cancelled: boolean;
  crv: boolean;
  cvHasPlan: boolean;
  cvPlanStatus: string | null;
  facts: { area: string | null; date: string | null; due: boolean | null; open: boolean; st: string | null }[];
  fs: string | null;
  ful: string | null;
  legacyRouteStatuses: string[];
  manual: unknown;
  stops: { due: boolean | null; hasTwe: boolean; status: string }[];
};

export async function loadV2FacetOrders(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  orderIds: string[],
  now: Date,
): Promise<V2FacetOrder[]> {
  if (orderIds.length === 0) return [];
  return prisma.$queryRaw<V2FacetOrder[]>(Prisma.sql`
    SELECT
      o."financialStatus" AS fs,
      o."fulfillmentStatus" AS ful,
      o."rawPayload" -> 'cleverManualPaymentStatus' AS manual,
      o."cancelledAt" IS NOT NULL AS cancelled,
      o."currentRouteVersionId" IS NOT NULL AS crv,
      COALESCE(cv.has_plan, false) AS "cvHasPlan",
      cv.plan_status AS "cvPlanStatus",
      COALESCE((
        SELECT array_agg(DISTINCT rp.status::text)
        FROM delivery_stops ds
        JOIN route_plan_stops rps ON rps."deliveryStopId" = ds.id AND rps."shopId" = ds."shopId"
        JOIN route_plans rp ON rp.id = rps."routePlanId" AND rp."shopId" = rps."shopId"
        WHERE ds."orderId" = o.id AND ds."shopId" = o."shopId"
      ), '{}') AS "legacyRouteStatuses",
      COALESCE((
        SELECT json_agg(json_build_object(
          'st', f."serviceType",
          'area', f."deliveryArea",
          'date', to_char(f."deliveryDate", 'YYYY-MM-DD'),
          'due', f."timeWindowEnd" <= ${now},
          'open', f."timeWindowEnd" IS NULL))
        FROM order_delivery_facts f
        WHERE f."orderId" = o.id
      ), '[]') AS facts,
      COALESCE((
        SELECT json_agg(json_build_object(
          'status', ds.status::text,
          'due', ds."timeWindowEnd" <= ${now},
          'hasTwe', ds."timeWindowEnd" IS NOT NULL))
        FROM delivery_stops ds
        WHERE ds."orderId" = o.id AND ds."shopId" = o."shopId"
      ), '[]') AS stops
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT v."routePlanId" IS NOT NULL AS has_plan, rp.status::text AS plan_status
      FROM route_grouping_child_versions v
      LEFT JOIN route_plans rp ON rp.id = v."routePlanId" AND rp."shopId" = v."shopId"
      WHERE v.id = o."currentRouteVersionId" AND v."shopId" = o."shopId"
        AND v.status::text = 'CURRENT' AND v."supersededAt" IS NULL
    ) cv ON true
    WHERE o.id = ANY(${orderIds}::uuid[])`);
}

type Dimension = 'area' | 'fulfillment' | 'payment' | 'progress' | 'scheduled' | 'service';

const KNOWN_SERVICES = ['DELIVERY', 'EVENING_DELIVERY', 'PICKUP'];
const MANUAL_PAYMENTS = ['PAID', 'PENDING', 'UNKNOWN'];
const KNOWN_PAYMENTS = V2_PAYMENT.filter((v) => v !== 'UNKNOWN').map((v) => v.toLowerCase());
const KNOWN_FULFILLMENTS = [...V2_FULFILLMENT.filter((v) => v !== 'UNKNOWN'), 'OPEN', 'RESTOCKED', 'PENDING_FULFILLMENT'].map((v) => v.toLowerCase());
const AWAITING = ['READY', 'DRAFT', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED'];
const ACTIVE = [...AWAITING, 'IN_PROGRESS'];
const TERMINALS = ['DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED'];

export function countV2Facets(orders: V2FacetOrder[], filters: ListCanonicalOrdersFilters, now: Date) {
  const zone = filters.orderedDateTimeZone ?? 'UTC';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const actualDates = filters.scheduledWeekdays?.length
    ? (filters.scheduledActualDates ?? []).map((date) => date.toISOString().slice(0, 10))
    : null;
  const selectedAreas = (filters.areas ?? []).map((area) => area.toLowerCase());

  const matches = (order: V2FacetOrder, skip: Dimension | null): boolean =>
    (skip === 'scheduled' || scheduledMatch(order, filters, actualDates))
    && (skip === 'service' || anyOf(filters.serviceTypes, (v) => service(order, v)))
    && (skip === 'area' || (selectedAreas.length === 0 && !filters.areaMissing)
      || selectedAreas.some((v) => order.facts.some((f) => f.area?.toLowerCase() === v))
      || (filters.areaMissing === true && areaMissing(order)))
    && (skip === 'payment' || anyOf(filters.paymentStatuses, (v) => payment(order, v)))
    && (skip === 'fulfillment' || anyOf(filters.fulfillmentStatuses, (v) => fulfillment(order, v)))
    && (skip === 'progress' || anyOf(filters.deliveryProgress, (v) => progress(order, v, today)));

  const without = (skip: Dimension) => orders.filter((order) => matches(order, skip));
  const options = (skip: Dimension, values: readonly string[], test: (order: V2FacetOrder, value: string) => boolean) => {
    const pool = without(skip);
    return values.map((value) => ({ value, count: pool.filter((order) => test(order, value)).length }));
  };

  const areaPool = without('area');
  const areaValues = [...new Set(areaPool.flatMap((order) => order.facts.flatMap((f) => (f.area?.trim() ? [f.area] : []))))].sort();
  const areas = areaValues.map((value) => ({
    value,
    count: areaPool.filter((order) => order.facts.some((f) => f.area?.toLowerCase() === value.toLowerCase())).length,
  }));
  areas.push({ value: '__MISSING__', count: areaPool.filter(areaMissing).length });

  return {
    totalCount: orders.filter((order) => matches(order, null)).length,
    facets: {
      areas,
      serviceTypes: options('service', V2_SERVICES, service),
      deliveryProgress: options('progress', V2_PROGRESS, (order, value) => progress(order, value, today)),
      fulfillmentStatuses: options('fulfillment', V2_FULFILLMENT, fulfillment),
      paymentStatuses: options('payment', V2_PAYMENT, payment),
      scheduledDateMissing: [{ value: 'true', count: without('scheduled').filter(dateMissing).length }],
    },
  };
}

function anyOf(values: string[] | undefined, test: (value: string) => boolean): boolean {
  return values === undefined || values.length === 0 || values.some(test);
}

function scheduledMatch(order: V2FacetOrder, filters: ListCanonicalOrdersFilters, actualDates: string[] | null): boolean {
  if (filters.scheduledDateFrom || filters.scheduledDateTo || actualDates !== null) {
    const inRange = order.facts.some((f) => f.date !== null
      && (!filters.scheduledDateFrom || f.date >= filters.scheduledDateFrom)
      && (!filters.scheduledDateTo || f.date <= filters.scheduledDateTo)
      && (actualDates === null || actualDates.includes(f.date)));
    if (!inRange) return false;
  }
  return !filters.scheduledDateMissing || dateMissing(order);
}

function dateMissing(order: V2FacetOrder): boolean {
  return order.facts.length === 0 || order.facts.some((f) => f.date === null);
}

function areaMissing(order: V2FacetOrder): boolean {
  return order.facts.length === 0 || order.facts.some((f) => f.area === null || f.area === '');
}

function service(order: V2FacetOrder, value: string): boolean {
  if (value !== 'UNKNOWN') return order.facts.some((f) => f.st === value);
  return order.facts.length === 0 || order.facts.some((f) => f.st === null || !KNOWN_SERVICES.includes(f.st));
}

function payment(order: V2FacetOrder, value: string): boolean {
  const manual = typeof order.manual === 'string' ? order.manual : null;
  if (MANUAL_PAYMENTS.includes(value) && manual === value) return true;
  if (manual !== null && MANUAL_PAYMENTS.includes(manual)) return false;
  const status = order.fs?.toLowerCase() ?? null;
  return value === 'UNKNOWN'
    ? status === null || !KNOWN_PAYMENTS.includes(status)
    : status === value.toLowerCase();
}

function fulfillment(order: V2FacetOrder, value: string): boolean {
  const status = order.ful?.toLowerCase() ?? null;
  if (value === 'UNKNOWN') return status === null || !KNOWN_FULFILLMENTS.includes(status);
  const aliases = value === 'UNFULFILLED'
    ? ['UNFULFILLED', 'OPEN', 'RESTOCKED']
    : value === 'IN_PROGRESS' ? ['IN_PROGRESS', 'PENDING_FULFILLMENT'] : [value];
  return status !== null && aliases.some((alias) => alias.toLowerCase() === status);
}

function routeIn(order: V2FacetOrder, statuses: readonly string[]): boolean {
  return (order.cvPlanStatus !== null && statuses.includes(order.cvPlanStatus))
    || (!order.crv && order.legacyRouteStatuses.some((status) => statuses.includes(status)));
}

function pickupElapsed(order: V2FacetOrder, today: string): boolean {
  const pickups = order.facts.filter((f) => f.st === 'PICKUP');
  if (order.cancelled || pickups.length === 0) return false;
  if (pickups.some((f) => f.due === true)) return true;
  const open = pickups.filter((f) => f.open);
  if (open.length === 0) return false;
  return order.stops.some((s) => s.due === true)
    || (!order.stops.some((s) => s.hasTwe) && open.some((f) => f.date !== null && f.date < today));
}

function progress(order: V2FacetOrder, value: string, today: string): boolean {
  const invalid = order.crv && !order.cvHasPlan;
  if (!['delivered', 'failed', 'skipped', 'cancelled', 'planned', 'pickup_elapsed', 'assigned_in_progress', 'unplanned'].includes(value)) {
    return invalid || order.stops.length === 0;
  }
  if (invalid) return false;
  const waiting = routeIn(order, AWAITING);
  if (['delivered', 'failed', 'skipped', 'cancelled'].includes(value)) {
    return !waiting && order.stops.some((s) => s.status === value.toUpperCase());
  }
  if (value === 'planned') return order.stops.length > 0 && waiting;
  const elapsed = pickupElapsed(order, today);
  const nonterminal = order.stops.some((s) => !TERMINALS.includes(s.status));
  if (value === 'pickup_elapsed') return !waiting && nonterminal && elapsed;
  if (value === 'assigned_in_progress') {
    return !waiting && !elapsed && nonterminal
      && (routeIn(order, ['IN_PROGRESS']) || order.stops.some((s) => ['ASSIGNED', 'EN_ROUTE', 'ARRIVED'].includes(s.status)));
  }
  return !routeIn(order, ACTIVE) && !elapsed && order.stops.some((s) => s.status === 'PENDING');
}
