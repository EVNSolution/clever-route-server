import type { Prisma } from '@prisma/client';

import { localDateTimeInTimeZoneToUtc } from '../driver/driver-route-timezone.js';
import { resolveRouteTimezone } from '../route-ops/route-timezone.js';

export type RouteTrackingEventWindow = {
  anchorSource: 'PLAN_DATE' | 'ROUTE_STARTED';
  endExclusive: Date;
  serviceDate: string;
  startInclusive: Date;
  timezone: string;
};

type RouteTrackingEventWindowPrismaClient = Pick<Prisma.TransactionClient, 'driverEvent' | 'routePlan'>;

export function resolveRouteTrackingEventWindow(input: {
  constraints: unknown;
  planDate: Date | string;
  serviceDate?: string | null | undefined;
  startOccurredAt?: Date | string | null | undefined;
}): RouteTrackingEventWindow | null {
  // Route-owned inputs only: this window decides what tracking data is kept, redacted or finalized, so a
  // later edit of the tenant center must not move it.
  const routeTimezone = resolveRouteTimezone({ constraints: input.constraints });
  if (routeTimezone === null) return null;
  const startedServiceDate = readDateOnly(input.serviceDate)
    ?? localDateOnly(input.startOccurredAt, routeTimezone);
  const serviceDate = startedServiceDate ?? formatDateOnly(input.planDate);

  return {
    anchorSource: startedServiceDate === null ? 'PLAN_DATE' : 'ROUTE_STARTED',
    endExclusive: localDateTimeInTimeZoneToUtc(addCalendarDays(serviceDate, 2), '00:00', routeTimezone),
    serviceDate,
    startInclusive: localDateTimeInTimeZoneToUtc(serviceDate, '00:00', routeTimezone),
    timezone: routeTimezone
  };
}

export function occurredAtWithinRouteTrackingEventWindow(
  window: RouteTrackingEventWindow,
  value: Date | string
): boolean {
  const occurredAt = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(occurredAt)
    && occurredAt >= window.startInclusive.getTime()
    && occurredAt < window.endExclusive.getTime();
}

export async function loadRouteTrackingEventWindow(
  prisma: RouteTrackingEventWindowPrismaClient,
  routePlanId: string
): Promise<RouteTrackingEventWindow | null> {
  const routePlan = await prisma.routePlan.findUnique({
    select: {
      constraints: true,
      planDate: true,
      shopId: true
    },
    where: { id: routePlanId }
  });
  if (routePlan === null) return null;
  const routeStarted = await prisma.driverEvent.findFirst({
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { occurredAt: true },
    where: {
      eventType: 'ROUTE_STARTED',
      routePlanId,
      shopId: routePlan.shopId
    }
  });
  return resolveRouteTrackingEventWindow({
    constraints: routePlan.constraints,
    planDate: routePlan.planDate,
    startOccurredAt: routeStarted?.occurredAt ?? null
  });
}

function addCalendarDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return date.toISOString().slice(0, 10);
}

function formatDateOnly(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid route plan date');
  return date.toISOString().slice(0, 10);
}

function localDateOnly(value: Date | string | null | undefined, timezone: string): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric'
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function readDateOnly(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return null;
  try {
    return formatDateOnly(text) === text ? text : null;
  } catch {
    return null;
  }
}
