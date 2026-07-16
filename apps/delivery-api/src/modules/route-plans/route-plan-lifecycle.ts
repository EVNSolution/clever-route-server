import type { RoutePlanStatus } from '@prisma/client';

export const ROUTE_DRIVER_OPERATIONAL_STATUSES = [
  'READY',
  'IN_PROGRESS',
  'DRAFT',
  'PUBLISHED',
  'OPTIMIZED',
  'ASSIGNED'
] as const satisfies readonly RoutePlanStatus[];

export const ROUTE_DRIVER_VISIBLE_STATUSES = [
  ...ROUTE_DRIVER_OPERATIONAL_STATUSES,
  'COMPLETED'
] as const satisfies readonly RoutePlanStatus[];

export const ROUTE_ACTIVE_COMPATIBILITY_STATUSES = [
  'IN_PROGRESS',
  'READY',
  'DRAFT',
  'PUBLISHED',
  'OPTIMIZED',
  'ASSIGNED'
] as const satisfies readonly RoutePlanStatus[];

export const ROUTE_READY_COMPATIBILITY_STATUSES = [
  'READY',
  'DRAFT',
  'PUBLISHED',
  'OPTIMIZED',
  'ASSIGNED'
] as const satisfies readonly RoutePlanStatus[];

export type RouteExecutionStatus = 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export function toRouteExecutionStatus(
  status: string | null | undefined,
  driverEvents: readonly { eventType: string }[] = []
): RouteExecutionStatus {
  if (status === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (status === 'COMPLETED') return 'COMPLETED';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (driverEvents.some((event) => event.eventType === 'ROUTE_COMPLETED')) return 'COMPLETED';
  if (driverEvents.some((event) => event.eventType === 'ROUTE_STARTED')) return 'IN_PROGRESS';
  return 'READY';
}

export function isRouteReadyStatus(status: string): boolean {
  return (ROUTE_READY_COMPATIBILITY_STATUSES as readonly string[]).includes(status);
}
