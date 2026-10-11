// Who chose a stop's Stop time (delivery_stops.serviceMinutes) and what a driver's average may replace.
//
//   STOP   the office changed the time on that stop
//   ROUTE  the unified time given when the route was created
//   DRIVER the time was taken from the route driver's average
//   null   the system default of 5 minutes
import type { Prisma } from '@prisma/client';
import { isRouteReadyStatus } from './route-plan-lifecycle.js';

export const DEFAULT_SERVICE_MINUTES = 5;

export type StopServiceTime = { serviceMinutes: number; serviceMinutesSource: string | null };

/**
 * Precedence: the stop's own time, the unified time of its route, the driver's average, then 5.
 * A time the office chose (STOP or ROUTE) is never replaced. A time that is not the default and has no source was
 * imported or typed before sources were recorded, so it is never replaced either. Only a default (null at 5) or an
 * earlier driver average follows the driver's average, and returns to 5 when the driver has none.
 */
export function resolveStopServiceTime(stop: StopServiceTime, driverAverage: number | null): StopServiceTime {
  const followsDriver = stop.serviceMinutesSource === 'DRIVER'
    || (stop.serviceMinutesSource === null && stop.serviceMinutes === DEFAULT_SERVICE_MINUTES);
  if (!followsDriver) return stop;
  return driverAverage === null
    ? { serviceMinutes: DEFAULT_SERVICE_MINUTES, serviceMinutesSource: null }
    : { serviceMinutes: driverAverage, serviceMinutesSource: 'DRIVER' };
}

/**
 * Gives the Ready route's stops that nobody chose the route driver's average Stop time, or sends them back to the
 * default when the route has no driver or the driver has no average. Chosen times are never touched. Routes that
 * started, finished or were cancelled keep their times.
 */
export async function applyDriverStopTimes(tx: Prisma.TransactionClient, routePlanId: string): Promise<void> {
  const routePlan = await tx.routePlan.findUnique({
    select: {
      driver: { select: { averageServiceMinutes: true } },
      routeStops: {
        select: { deliveryStop: { select: { id: true, serviceMinutes: true, serviceMinutesSource: true, status: true } } }
      },
      status: true
    },
    where: { id: routePlanId }
  });
  if (routePlan === null || !isRouteReadyStatus(routePlan.status)) return;
  const average = routePlan.driver?.averageServiceMinutes ?? null;
  for (const { deliveryStop } of routePlan.routeStops) {
    if (!['PENDING', 'ASSIGNED', 'EN_ROUTE'].includes(deliveryStop.status)) continue;
    const next = resolveStopServiceTime(deliveryStop, average);
    if (next.serviceMinutes === deliveryStop.serviceMinutes && next.serviceMinutesSource === deliveryStop.serviceMinutesSource) continue;
    await tx.deliveryStop.update({ data: next, where: { id: deliveryStop.id } });
  }
}
