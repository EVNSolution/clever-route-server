import { DriverEventType, RoutePlanStatus, type PrismaClient } from '@prisma/client';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';
import type { DriverAssignedRouteServiceContract } from './driver-assigned-route.types.js';
import {
  DriverRouteSessionScopeError,
  type DriverRouteSessionRestoreInput,
  type DriverRouteSessionRestoreResult,
  type DriverRouteSessionRestoreSession
} from './driver-route-session.types.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';

type DriverRouteSessionPrismaClient = Pick<PrismaClient, 'driver' | 'driverEvent' | 'routePlan' | 'shop'>;

type ActiveRoutePlanRecord = {
  driverEvents: ActiveRoutePlanEventRecord[];
  id: string;
  routeStops: ActiveRoutePlanStopRecord[];
};

type ActiveRoutePlanEventRecord = {
  id: string;
  occurredAt: Date;
};

type ActiveRoutePlanStopRecord = {
  deliveryStop: {
    id: string;
    status: string;
  };
  id: string;
  sequence: number;
};

type StartedRouteEventRecord = {
  id: string;
  occurredAt: Date;
  routePlan: ActiveRoutePlanRecord | null;
  routePlanId: string | null;
};

const ACTIVE_ROUTE_STATUSES = [
  RoutePlanStatus.ASSIGNED,
  RoutePlanStatus.IN_PROGRESS,
  RoutePlanStatus.OPTIMIZED
] as const;
const TERMINAL_DELIVERY_STOP_STATUSES = new Set(['DELIVERED', 'FAILED']);

const activeRoutePlanInclude = (driverId: string) => ({
  driverEvents: {
    orderBy: { occurredAt: 'desc' as const },
    select: { id: true, occurredAt: true },
    take: 1,
    where: {
      driverId,
      eventType: DriverEventType.ROUTE_STARTED
    }
  },
  routeStops: {
    include: {
      deliveryStop: {
        select: {
          id: true,
          status: true
        }
      }
    },
    orderBy: {
      sequence: 'asc' as const
    }
  }
});

export class PrismaDriverRouteSessionRepository {
  constructor(
    private readonly prisma: DriverRouteSessionPrismaClient,
    private readonly assignedRouteService: DriverAssignedRouteServiceContract
  ) {}

  async getActiveRouteSession(input: DriverRouteSessionRestoreInput): Promise<DriverRouteSessionRestoreResult> {
    const shopDomain = normalizeDriverCommerceDomain(input.shopDomain);
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain })
    });
    if (shop === null) {
      throw new DriverRouteSessionScopeError(`Shop not installed: ${shopDomain}`);
    }

    const driver = await this.prisma.driver.findFirst({
      select: { id: true },
      where: {
        id: input.driverId,
        shopId: shop.id,
        status: 'ACTIVE'
      }
    });
    if (driver === null) {
      throw new DriverRouteSessionScopeError(`Driver not found for shop: ${input.driverId}`);
    }

    const activeRoutePlan = await this.findActiveRoutePlan({
      driverId: input.driverId,
      shopId: shop.id
    });
    if (activeRoutePlan === null) {
      return { status: 'NO_ACTIVE_SESSION' };
    }

    const assignedRoute = await this.assignedRouteService.getAssignedRoute({
      driverId: input.driverId,
      routeContext: activeRoutePlan.id,
      shopDomain
    });
    if (assignedRoute.status !== 'ASSIGNED_ROUTE') {
      return { status: 'NO_ACTIVE_SESSION' };
    }

    return {
      status: 'ACTIVE_SESSION',
      route: assignedRoute.route,
      session: toBestEffortSession(activeRoutePlan)
    };
  }

  private async findActiveRoutePlan(input: { driverId: string; shopId: string }): Promise<ActiveRoutePlanRecord | null> {
    const inProgressRoute = await this.prisma.routePlan.findFirst({
      include: activeRoutePlanInclude(input.driverId),
      orderBy: [
        { updatedAt: 'desc' },
        { planDate: 'desc' },
        { id: 'asc' }
      ],
      where: {
        driverId: input.driverId,
        shopId: input.shopId,
        status: RoutePlanStatus.IN_PROGRESS
      }
    });
    const activeInProgressRoute = inProgressRoute as ActiveRoutePlanRecord | null;
    if (activeInProgressRoute !== null && await this.isRouteStillActive({
      driverId: input.driverId,
      routePlan: activeInProgressRoute,
      shopId: input.shopId
    })) {
      return activeInProgressRoute;
    }

    const startedEvents = await this.prisma.driverEvent.findMany({
      include: {
        routePlan: {
          include: activeRoutePlanInclude(input.driverId)
        }
      },
      orderBy: [
        { occurredAt: 'desc' },
        { id: 'asc' }
      ],
      take: 10,
      where: {
        driverId: input.driverId,
        eventType: DriverEventType.ROUTE_STARTED,
        routePlan: {
          driverId: input.driverId,
          shopId: input.shopId,
          status: { in: [...ACTIVE_ROUTE_STATUSES] }
        },
        routePlanId: { not: null },
        shopId: input.shopId
      }
    });

    for (const event of startedEvents as unknown as StartedRouteEventRecord[]) {
      if (event.routePlan === null || event.routePlanId === null) {
        continue;
      }
      if (await this.hasLaterCompletionEvent({
        driverId: input.driverId,
        routePlanId: event.routePlanId,
        shopId: input.shopId,
        startedAt: event.occurredAt
      })) {
        continue;
      }

      return normalizeStartedRoutePlan(event.routePlan, event);
    }

    return null;
  }

  private async isRouteStillActive(input: {
    driverId: string;
    routePlan: ActiveRoutePlanRecord;
    shopId: string;
  }): Promise<boolean> {
    const latestStart = input.routePlan.driverEvents.at(0) ?? null;
    const completionEvent = await this.prisma.driverEvent.findFirst({
      select: { id: true },
      where: {
        driverId: input.driverId,
        eventType: DriverEventType.ROUTE_COMPLETED,
        routePlanId: input.routePlan.id,
        shopId: input.shopId,
        ...(latestStart === null ? {} : { occurredAt: { gt: latestStart.occurredAt } })
      }
    });

    return completionEvent === null;
  }

  private async hasLaterCompletionEvent(input: {
    driverId: string;
    routePlanId: string;
    shopId: string;
    startedAt: Date;
  }): Promise<boolean> {
    const completionEvent = await this.prisma.driverEvent.findFirst({
      select: { id: true },
      where: {
        driverId: input.driverId,
        eventType: DriverEventType.ROUTE_COMPLETED,
        occurredAt: { gt: input.startedAt },
        routePlanId: input.routePlanId,
        shopId: input.shopId
      }
    });

    return completionEvent !== null;
  }
}

function normalizeStartedRoutePlan(
  routePlan: ActiveRoutePlanRecord,
  event: StartedRouteEventRecord
): ActiveRoutePlanRecord {
  const events = routePlan.driverEvents.length === 0
    ? [{ id: event.id, occurredAt: event.occurredAt }]
    : routePlan.driverEvents;
  return {
    ...routePlan,
    driverEvents: events
  };
}

function toBestEffortSession(routePlan: ActiveRoutePlanRecord): DriverRouteSessionRestoreSession {
  const sortedStops = [...routePlan.routeStops].sort((left, right) => left.sequence - right.sequence);
  const nextStop = sortedStops.find((routeStop) => !TERMINAL_DELIVERY_STOP_STATUSES.has(routeStop.deliveryStop.status)) ?? null;
  const navigationStepIndex = nextStop === null
    ? sortedStops.length
    : sortedStops.some((routeStop) => TERMINAL_DELIVERY_STOP_STATUSES.has(routeStop.deliveryStop.status))
      ? nextStop.sequence
      : 0;
  const latestStart = routePlan.driverEvents.at(0) ?? null;

  return {
    currentDeliveryStopId: navigationStepIndex === 0 ? null : nextStop?.deliveryStop.id ?? null,
    currentRoutePlanStopId: navigationStepIndex === 0 ? null : nextStop?.id ?? null,
    lastEventId: latestStart?.id ?? null,
    lastResumedAt: null,
    navigationStepIndex,
    routePlanId: routePlan.id,
    sessionId: null,
    source: 'BEST_EFFORT_ROUTE_STATE',
    startedAt: latestStart?.occurredAt.toISOString() ?? null,
    status: 'ACTIVE'
  };
}

export type DriverRouteSessionRestoreServiceApi = Pick<PrismaDriverRouteSessionRepository, 'getActiveRouteSession'>;
