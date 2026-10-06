import { Prisma } from '@prisma/client';

import { dsvReviewedTestExclusions as exclusions } from './dsv-reviewed-test-exclusions.js';
import type { RouteGroupingDetailDto, RouteGroupingRoutesListDto, RouteGroupingSummaryDto } from '../route-grouping/route-grouping.types.js';

type Scope = string | { appId?: string | undefined; shopDomain: string };
const orderIds = new Set<string>(exclusions.sellerOrderIds);
const routeIds = new Set<string>(exclusions.routePlanIds);
const vehicleIds = new Set<string>(exclusions.vehicleIds);

export function hasDsvTestExclusions(scope: Scope): boolean {
  return typeof scope === 'string' ? scope === exclusions.shopId
    : (scope.appId ?? 'clever') === exclusions.appId && scope.shopDomain.trim().toLowerCase() === exclusions.shopDomain;
}

// These predicates affect presentation reads only. They do not alter persisted state,
// imports, ownership, proofs, accounts, or the internal grouping mutation authority.
// Visibility deliberately has no role/scope-based administrator exception.
export function visibleDsvOrderWhere(scope: Scope): Prisma.OrderWhereInput {
  return hasDsvTestExclusions(scope) ? { NOT: { id: { in: [...orderIds] } } } : {};
}

export function visibleDsvRouteWhere(scope?: Scope): Prisma.RoutePlanWhereInput {
  if (scope === undefined) return { NOT: { shopId: exclusions.shopId, id: { in: [...routeIds] } } };
  return hasDsvTestExclusions(scope) ? { NOT: { id: { in: [...routeIds] } } } : {};
}

export function visibleDsvVehicleWhere(scope: Scope): Prisma.VehicleWhereInput {
  return hasDsvTestExclusions(scope) ? { NOT: { id: { in: [...vehicleIds] } } } : {};
}

export function visibleDsvAssignmentWhere(scope: Scope): Prisma.DsvVehicleDriverAssignmentWhereInput {
  return hasDsvTestExclusions(scope) ? { NOT: { vehicleId: { in: [...vehicleIds] } } } : {};
}

export function visibleDsvNotificationWhere(scope: Scope): Prisma.AdminNotificationWhereInput {
  if (!hasDsvTestExclusions(scope)) return {};
  return { AND: [
    { OR: [{ orderId: null }, { orderId: { notIn: [...orderIds] } }] },
    { OR: [{ routePlanId: null }, { routePlanId: { notIn: [...routeIds] } }] },
  ] };
}

export function visibleDsvProofWhere(scope: string): Prisma.DriverProofMediaWhereInput {
  if (!hasDsvTestExclusions(scope)) return {};
  // A proof shared with a visible stop remains available to that stop. A proof
  // belonging solely to excluded stops/routes cannot issue a public read URL.
  return { OR: [
    { deliveryStop: { shopId: scope, order: visibleDsvOrderWhere(scope) } },
    { deliveryStopLinks: { some: { deliveryStop: { shopId: scope, order: visibleDsvOrderWhere(scope) } } } },
  ] };
}

export function visibleDsvOrderCountSql(shopId: string): Prisma.Sql {
  return hasDsvTestExclusions(shopId)
    ? Prisma.sql`AND orders.id NOT IN (${Prisma.join([...orderIds].map(id => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
}

export function isVisibleDsvOrder(scope: Scope, id: string | null | undefined): boolean {
  return !hasDsvTestExclusions(scope) || id == null || !orderIds.has(id);
}

export function isVisibleDsvRoute(scope: Scope, id: string | null | undefined): boolean {
  return !hasDsvTestExclusions(scope) || id == null || !routeIds.has(id);
}

type Group = RouteGroupingSummaryDto | RouteGroupingRoutesListDto | RouteGroupingDetailDto;

export function projectVisibleDsvGrouping<T extends Group>(scope: Scope, group: T): T | null {
  if (!hasDsvTestExclusions(scope)) return group;
  const children = group.children.filter(child => isVisibleDsvRoute(scope, child.routePlanId));
  const removedOrders = group.children.filter(child => !isVisibleDsvRoute(scope, child.routePlanId))
    .reduce((count, child) => count + child.stopsCount, 0);
  const totalOrders = Math.max(0, group.totalOrders - removedOrders);
  if (totalOrders === 0 && removedOrders > 0) return null;
  const statuses = children.map(child => child.displayStatus);
  const displayStatus = group.status === 'CANCELLED' ? 'CANCELLED'
    : statuses.length > 0 && statuses.every(status => status === 'COMPLETED') ? 'COMPLETED'
    : statuses.some(status => status === 'IN_PROGRESS') ? 'IN_PROGRESS'
    : statuses.length > 0 && statuses.every(status => status === 'COMPLETED' || status === 'INCOMPLETE') ? 'INCOMPLETE'
    : statuses.some(status => status === 'COMPLETED' || status === 'INCOMPLETE') ? 'IN_PROGRESS' : 'READY';
  const projected = { ...group, children, totalOrders, displayStatus } as T;
  if ('assignments' in group) {
    const assignments = group.assignments.filter(row => isVisibleDsvOrder(scope, row.orderId));
    const branches = group.branches.map(branch => {
      const ids = branch.orderIds.filter(id => isVisibleDsvOrder(scope, id));
      return { ...branch, orderIds: ids, ordersCount: ids.length,
        optimized: ids.length === branch.orderIds.length ? branch.optimized : null };
    });
    Object.assign(projected, { assignments, branches,
      totalOrders: assignments.length,
      unresolvedOrders: assignments.filter(row => row.assignmentStatus !== 'ASSIGNED' && row.assignmentStatus !== 'UNASSIGNED').length,
    });
  }
  if ('warningState' in group) {
    Object.assign(projected, { warningState: group.warningState.flatMap(warning => {
        const visibleOrders = warning.orderIds?.filter(id => isVisibleDsvOrder(scope, id));
        const visibleRoutes = warning.routePlanIds?.filter(id => isVisibleDsvRoute(scope, id));
        if (warning.orderIds?.length && visibleOrders?.length === 0
          || warning.routePlanIds?.length && visibleRoutes?.length === 0) return [];
        return [{ ...warning, ...(visibleOrders === undefined ? {} : { orderIds: visibleOrders }),
          ...(visibleRoutes === undefined ? {} : { routePlanIds: visibleRoutes }) }];
      }),
    });
    if ('assignments' in group && projected.totalOrders === 0 && group.assignments.length > 0) return null;
  }
  if ('switchRoutes' in group && group.switchRoutes !== undefined) {
    Object.assign(projected, { switchRoutes: group.switchRoutes.filter(route => isVisibleDsvRoute(scope, route.routePlanId)) });
  }
  return projected;
}
