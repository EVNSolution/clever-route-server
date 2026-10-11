import {
  Prisma,
  type PrismaClient,
  type RoutePlanStatus,
  type DeliveryStopStatus,
} from '@prisma/client';
import { orderedDateBoundary } from './ordered-date-range.js';
import { normalizeOrderNumberPrefix } from './order-number-prefix.js';
import type { CanonicalOrderRecord, ListCanonicalOrdersFilters } from './order-sync.repository.js';

export const V2_PROGRESS = [
  'unplanned',
  'planned',
  'assigned_in_progress',
  'delivered',
  'failed',
  'skipped',
  'cancelled',
  'pickup_elapsed',
  'unknown',
] as const;
export const V2_SERVICES = ['DELIVERY', 'EVENING_DELIVERY', 'PICKUP', 'UNKNOWN'] as const;
export const V2_FULFILLMENT = [
  'UNFULFILLED',
  'PARTIALLY_FULFILLED',
  'FULFILLED',
  'IN_PROGRESS',
  'ON_HOLD',
  'SCHEDULED',
  'REQUEST_DECLINED',
  'FULFILLMENT_NOT_REQUIRED',
  'UNKNOWN',
] as const;
export const V2_PAYMENT = [
  'AUTHORIZED',
  'EXPIRED',
  'PAID',
  'PARTIALLY_PAID',
  'PARTIALLY_REFUNDED',
  'PENDING',
  'REFUNDED',
  'VOIDED',
  'UNKNOWN',
] as const;
export const V2_WEEKDAYS = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const;
export type OrdersV2Filters = {
  filterVersion?: '2';
  receivedDateFrom?: string;
  receivedDateTo?: string;
  scheduledDateFrom?: string;
  scheduledDateTo?: string;
  scheduledDateMissing?: boolean;
  scheduledWeekdays?: string[];
  serviceTypes?: string[];
  deliveryProgress?: string[];
  fulfillmentStatuses?: string[];
  paymentStatuses?: string[];
  orderNumberPrefix?: string;
  cancelled?: boolean;
  areas?: string[];
  areaMissing?: boolean;
  /** Internal date set from EXTRACT(DOW); never accepted from clients or included in a filter hash. */
  scheduledActualDates?: Date[];
};
const scalarKeys = [
  'receivedDateFrom',
  'receivedDateTo',
  'scheduledDateFrom',
  'scheduledDateTo',
  'scheduledDateMissing',
  'cancelled',
  'areaMissing',
  'orderNumberPrefix',
  'search',
  'orderedDateTimeZone',
] as const;
const arrayKeys = [
  'scheduledWeekdays',
  'serviceTypes',
  'deliveryProgress',
  'fulfillmentStatuses',
  'paymentStatuses',
  'areas',
] as const;
export function readOrdersV2Filters(
  query: Record<string, string | string[] | undefined>,
): ListCanonicalOrdersFilters {
  const allowed = new Set<string>(['filterVersion', ...scalarKeys, ...arrayKeys]);
  if (Object.keys(query).some((key) => !allowed.has(key)))
    throw new Error('v2 cannot be combined with legacy or unknown filters');
  const scalar = (key: string) => {
    const value = query[key];
    if (Array.isArray(value)) throw new Error(`duplicate ${key}`);
    return value?.trim() || undefined;
  };
  if (scalar('filterVersion') !== '2') throw new Error('unsupported filterVersion');
  const filters: ListCanonicalOrdersFilters = { filterVersion: '2' };
  for (const key of [
    'receivedDateFrom',
    'receivedDateTo',
    'scheduledDateFrom',
    'scheduledDateTo',
  ] as const) {
    const value = scalar(key);
    if (value === undefined) continue;
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
    )
      throw new Error(`invalid ${key}`);
    filters[key] = value;
  }
  for (const [from, to] of [
    ['receivedDateFrom', 'receivedDateTo'],
    ['scheduledDateFrom', 'scheduledDateTo'],
  ] as const) {
    const a = filters[from],
      b = filters[to];
    if (a !== undefined && b !== undefined && a > b) {
      filters[from] = b;
      filters[to] = a;
    }
  }
  for (const key of ['scheduledDateMissing', 'cancelled', 'areaMissing'] as const) {
    const value = scalar(key);
    if (value === undefined) continue;
    if (value !== 'true' && value !== 'false') throw new Error(`invalid ${key}`);
    filters[key] = value === 'true';
  }
  const enums = {
    scheduledWeekdays: V2_WEEKDAYS,
    serviceTypes: V2_SERVICES,
    deliveryProgress: V2_PROGRESS,
    fulfillmentStatuses: V2_FULFILLMENT,
    paymentStatuses: V2_PAYMENT,
    areas: null,
  };
  for (const key of arrayKeys) {
    const value = query[key];
    const values = [
      ...new Set(
        (Array.isArray(value) ? value : value === undefined ? [] : [value])
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ].sort();
    const permitted = enums[key];
    if (
      values.length > 100 ||
      values.some(
        (v) =>
          v.length > 200 || (permitted !== null && !(permitted as readonly string[]).includes(v)),
      )
    )
      throw new Error(`invalid ${key}`);
    if (values.length) filters[key] = values;
  }
  if (
    filters.scheduledDateMissing &&
    (filters.scheduledDateFrom || filters.scheduledDateTo || filters.scheduledWeekdays?.length)
  )
    throw new Error('missing schedule excludes ranges and weekdays');
  const zone = scalar('orderedDateTimeZone');
  if (zone !== undefined) {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format();
    filters.orderedDateTimeZone = zone;
  }
  if ((filters.receivedDateFrom || filters.receivedDateTo) && zone === undefined)
    throw new Error('received date requires the store IANA timezone');
  const search = scalar('search');
  if (search) filters.search = search;
  const orderNumberPrefix = normalizeOrderNumberPrefix(scalar('orderNumberPrefix'));
  if (orderNumberPrefix !== undefined) filters.orderNumberPrefix = orderNumberPrefix;
  return filters;
}

export async function prepareOrdersV2Filters(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  shopId: string,
  filters: ListCanonicalOrdersFilters,
): Promise<ListCanonicalOrdersFilters> {
  if (filters.filterVersion !== '2' || !filters.scheduledWeekdays?.length) return filters;
  const days = filters.scheduledWeekdays.map((day) =>
    V2_WEEKDAYS.indexOf(day as (typeof V2_WEEKDAYS)[number]),
  );
  const dates = await prisma.$queryRaw<Array<{ deliveryDate: Date }>>(Prisma.sql`
    SELECT DISTINCT "deliveryDate" FROM order_delivery_facts
    WHERE "shopId" = ${shopId}::uuid AND "deliveryDate" IS NOT NULL
      AND EXTRACT(DOW FROM "deliveryDate")::integer IN (${Prisma.join(days)})`);
  return { ...filters, scheduledActualDates: dates.map((row) => row.deliveryDate) };
}
const awaiting = ['READY', 'DRAFT', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED'] as const;
const active = [...awaiting, 'IN_PROGRESS'] as const;
function routeWhere(statuses: readonly string[]): Prisma.OrderWhereInput {
  return {
    OR: [
      {
        currentRouteVersion: {
          is: {
            status: 'CURRENT',
            supersededAt: null,
            routePlan: { is: { status: { in: [...statuses] as RoutePlanStatus[] } } },
          },
        },
      },
      {
        currentRouteVersionId: null,
        deliveryStops: {
          some: {
            routePlanStops: {
              some: { routePlan: { status: { in: [...statuses] as RoutePlanStatus[] } } },
            },
          },
        },
      },
    ],
  };
}
function stopWhere(status: string): Prisma.OrderWhereInput {
  return { deliveryStops: { some: { status: status as DeliveryStopStatus } } };
}
function pickupElapsed(now: Date, zone: string): Prisma.OrderWhereInput {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return {
    cancelledAt: null,
    deliveryFacts: { some: { serviceType: 'PICKUP' } },
    OR: [
      { deliveryFacts: { some: { serviceType: 'PICKUP', timeWindowEnd: { lte: now } } } },
      {
        deliveryFacts: { some: { serviceType: 'PICKUP', timeWindowEnd: null } },
        OR: [
          { deliveryStops: { some: { timeWindowEnd: { lte: now } } } },
          {
            deliveryStops: { none: { timeWindowEnd: { not: null } } },
            deliveryFacts: {
              some: {
                serviceType: 'PICKUP',
                timeWindowEnd: null,
                deliveryDate: { lt: new Date(`${today}T00:00:00Z`) },
              },
            },
          },
        ],
      },
    ],
  };
}
export function deliveryProgressWhere(
  value: string,
  now: Date,
  zone = 'UTC',
): Prisma.OrderWhereInput {
  const waiting = routeWhere(awaiting),
    routed = routeWhere(active);
  const invalidAuthority: Prisma.OrderWhereInput = {
    currentRouteVersionId: { not: null },
    NOT: {
      currentRouteVersion: {
        is: { status: 'CURRENT', supersededAt: null, routePlanId: { not: null } },
      },
    },
  };
  const valid = { NOT: invalidAuthority };
  const terminals = ['DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED'];
  const elapsed = pickupElapsed(now, zone);
  const nonterminal = {
    deliveryStops: { some: { status: { notIn: terminals as DeliveryStopStatus[] } } },
  } satisfies Prisma.OrderWhereInput;
  if (['delivered', 'failed', 'skipped', 'cancelled'].includes(value))
    return { AND: [valid, { NOT: waiting }, stopWhere(value.toUpperCase())] };
  if (value === 'planned') return { AND: [valid, { deliveryStops: { some: {} } }, waiting] };
  if (value === 'pickup_elapsed') return { AND: [valid, { NOT: waiting }, nonterminal, elapsed] };
  const notElapsed = { NOT: elapsed };
  if (value === 'assigned_in_progress')
    return {
      AND: [
        valid,
        { NOT: waiting },
        notElapsed,
        nonterminal,
        {
          OR: [
            routeWhere(['IN_PROGRESS']),
            { deliveryStops: { some: { status: { in: ['ASSIGNED', 'EN_ROUTE', 'ARRIVED'] } } } },
          ],
        },
      ],
    };
  if (value === 'unplanned')
    return { AND: [valid, { NOT: routed }, notElapsed, stopWhere('PENDING')] };
  return { OR: [invalidAuthority, { deliveryStops: { none: {} } }] };
}
function paymentWhere(value: string): Prisma.OrderWhereInput {
  const manual = ['PAID', 'PENDING', 'UNKNOWN'];
  const overrides = manual.map((v) => ({
    rawPayload: { path: ['cleverManualPaymentStatus'], equals: v },
  }));
  return {
    OR: [
      ...(manual.includes(value)
        ? [overrides[manual.indexOf(value)] as Prisma.OrderWhereInput]
        : []),
      {
        OR: [
          { rawPayload: { path: ['cleverManualPaymentStatus'], equals: Prisma.DbNull } },
          { rawPayload: { path: ['cleverManualPaymentStatus'], equals: Prisma.JsonNull } },
          { NOT: { OR: overrides } },
        ],
        ...(value === 'UNKNOWN'
          ? {
              OR: [
                { financialStatus: null },
                {
                  financialStatus: {
                    notIn: V2_PAYMENT.filter((v) => v !== 'UNKNOWN'),
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : { financialStatus: { equals: value, mode: 'insensitive' } }),
      },
    ],
  };
}
function fulfillmentWhere(value: string): Prisma.OrderWhereInput {
  if (value === 'UNKNOWN')
    return {
      OR: [
        { fulfillmentStatus: null },
        {
          fulfillmentStatus: {
            notIn: [
              ...V2_FULFILLMENT.filter((v) => v !== 'UNKNOWN'),
              'OPEN',
              'RESTOCKED',
              'PENDING_FULFILLMENT',
            ],
            mode: 'insensitive',
          },
        },
      ],
    };
  const aliases =
    value === 'UNFULFILLED'
      ? ['UNFULFILLED', 'OPEN', 'RESTOCKED']
      : value === 'IN_PROGRESS'
        ? ['IN_PROGRESS', 'PENDING_FULFILLMENT']
        : [value];
  return { fulfillmentStatus: { in: aliases, mode: 'insensitive' } };
}
export function ordersV2Where(
  filters: ListCanonicalOrdersFilters,
  now: Date,
): Prisma.OrderWhereInput[] {
  const AND: Prisma.OrderWhereInput[] = [],
    fact: Prisma.OrderDeliveryFactWhereInput = {};
  if (filters.receivedDateFrom)
    AND.push({
      processedAt: {
        gte: orderedDateBoundary(filters.receivedDateFrom, filters.orderedDateTimeZone),
      },
    });
  if (filters.receivedDateTo)
    AND.push({
      processedAt: {
        lt: orderedDateBoundary(filters.receivedDateTo, filters.orderedDateTimeZone, true),
      },
    });
  if (filters.scheduledDateFrom || filters.scheduledDateTo || filters.scheduledWeekdays?.length)
    fact.deliveryDate = {
      ...(filters.scheduledDateFrom
        ? { gte: new Date(`${filters.scheduledDateFrom}T00:00:00Z`) }
        : {}),
      ...(filters.scheduledDateTo ? { lte: new Date(`${filters.scheduledDateTo}T00:00:00Z`) } : {}),
      ...(filters.scheduledWeekdays?.length ? { in: filters.scheduledActualDates ?? [] } : {}),
    };
  if (Object.keys(fact).length) AND.push({ deliveryFacts: { some: fact } });
  if (filters.scheduledDateMissing)
    AND.push({
      OR: [{ deliveryFacts: { none: {} } }, { deliveryFacts: { some: { deliveryDate: null } } }],
    });
  if (filters.serviceTypes?.length)
    AND.push({
      OR: filters.serviceTypes.map((value) =>
        value === 'UNKNOWN'
          ? {
              OR: [
                { deliveryFacts: { none: {} } },
                {
                  deliveryFacts: {
                    some: {
                      OR: [
                        { serviceType: null },
                        { serviceType: { notIn: ['DELIVERY', 'EVENING_DELIVERY', 'PICKUP'] } },
                      ],
                    },
                  },
                },
              ],
            }
          : { deliveryFacts: { some: { serviceType: value } } },
      ),
    });
  const areaConditions: Prisma.OrderWhereInput[] = (filters.areas ?? []).map((value) => ({
    deliveryFacts: { some: { deliveryArea: { equals: value, mode: 'insensitive' } } },
  }));
  if (filters.areaMissing)
    areaConditions.push({
      OR: [
        { deliveryFacts: { none: {} } },
        { deliveryFacts: { some: { OR: [{ deliveryArea: null }, { deliveryArea: '' }] } } },
      ],
    });
  if (areaConditions.length) AND.push({ OR: areaConditions });
  if (filters.cancelled !== undefined)
    AND.push({ cancelledAt: filters.cancelled ? { not: null } : null });
  if (filters.paymentStatuses?.length) AND.push({ OR: filters.paymentStatuses.map(paymentWhere) });
  if (filters.fulfillmentStatuses?.length)
    AND.push({ OR: filters.fulfillmentStatuses.map(fulfillmentWhere) });
  if (filters.deliveryProgress?.length)
    AND.push({
      OR: filters.deliveryProgress.map((value) =>
        deliveryProgressWhere(value, now, filters.orderedDateTimeZone),
      ),
    });
  return AND;
}
export function v2ProgressForRecord(
  order: CanonicalOrderRecord,
  now: Date,
  zone = 'UTC',
): (typeof V2_PROGRESS)[number] {
  const stop = order.deliveryStops[0];
  const current = order.currentRouteVersion;
  if (
    order.currentRouteVersionId &&
    (!current ||
      current.status !== 'CURRENT' ||
      current.supersededAt !== null ||
      !current.routePlan)
  )
    return 'unknown';
  if (!stop) return 'unknown';
  const memberships = current?.routePlan
    ? [current.routePlan.status]
    : (stop.routePlanStops ?? []).flatMap((item) =>
        item.routePlan ? [item.routePlan.status] : [],
      );
  if (memberships.some((status) => (awaiting as readonly string[]).includes(status)))
    return 'planned';
  if (['DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(stop.status))
    return stop.status.toLowerCase() as (typeof V2_PROGRESS)[number];
  const fact = order.deliveryFacts?.[0];
  const deadline = fact?.timeWindowEnd ?? stop.timeWindowEnd;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  if (
    order.cancelledAt === null &&
    fact?.serviceType === 'PICKUP' &&
    (deadline
      ? deadline <= now
      : fact.deliveryDate && fact.deliveryDate.toISOString().slice(0, 10) < today)
  )
    return 'pickup_elapsed';
  if (
    memberships.includes('IN_PROGRESS') ||
    ['ASSIGNED', 'EN_ROUTE', 'ARRIVED'].includes(stop.status)
  )
    return 'assigned_in_progress';
  return stop.status === 'PENDING' ? 'unplanned' : 'unknown';
}
