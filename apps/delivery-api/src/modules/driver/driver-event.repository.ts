import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { ROUTE_ACTIVE_COMPATIBILITY_STATUSES, ROUTE_READY_COMPATIBILITY_STATUSES } from '../route-plans/route-plan-lifecycle.js';
import { readRouteStopPoints } from '../route-plans/route-plan-geometry-cache.js';
import {
  calculateArrivalEtaUpdate,
  calculateRouteStartEtaUpdate,
  type DriverRouteEtaStop,
  type DriverRouteEtaUpdate
} from './driver-route-eta.js';

export type RecordDriverEventInput = {
  clientEventId: string | null;
  deliveryStopId: string | null;
  driverId: string;
  eventType: string;
  latitude: string | null;
  longitude: string | null;
  occurredAt: Date;
  payload: unknown;
  routePlanId: string | null;
  shopDomain: string;
  shopId: string;
};

export type RecordDriverEventResult = {
  duplicate: boolean;
  etaUpdate?: DriverRouteEtaUpdate;
  eventId: string;
};

type DriverEventPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'deliveryStop' | 'driverEvent' | 'routePlan' | 'routePlanGeometryCache' | 'routePlanStop'
>;

type DriverEventTransactionClient = Pick<
  DriverEventPrismaClient,
  'deliveryStop' | 'driverEvent' | 'routePlan' | 'routePlanGeometryCache' | 'routePlanStop'
>;

export class DriverEventContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverEventContextError';
  }
}

export class DriverEventScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverEventScopeError';
  }
}

export class DriverEventRouteNotInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverEventRouteNotInProgressError';
  }
}

export class PrismaDriverEventRepository {
  constructor(private readonly prisma: DriverEventPrismaClient) {}

  async recordDriverEvent(input: RecordDriverEventInput): Promise<RecordDriverEventResult> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const duplicate = await findMatchingDriverEvent(transaction, input);
        if (duplicate !== null) {
          return { duplicate: true, eventId: duplicate.id };
        }

        await validateDriverEventStateContext(transaction, input, input.shopId);

        const event = await transaction.driverEvent.create({
          data: {
            clientEventId: input.clientEventId,
            deliveryStopId: input.deliveryStopId,
            driverId: input.driverId,
            eventType: input.eventType as never,
            latitude: input.latitude,
            longitude: input.longitude,
            occurredAt: input.occurredAt,
            payload: JSON.parse(JSON.stringify(input.payload)) as Prisma.InputJsonValue,
            routePlanId: input.routePlanId,
            shopId: input.shopId
          }
        });

        const etaUpdate = await applyDriverEventStateTransition(transaction, input, input.shopId, event.createdAt);

        return {
          duplicate: false,
          ...(etaUpdate === null ? {} : { etaUpdate }),
          eventId: event.id
        };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { duplicate: true, eventId: input.clientEventId ?? 'duplicate' };
      }

      throw error;
    }
  }
}

async function findMatchingDriverEvent(
  prisma: DriverEventTransactionClient,
  input: RecordDriverEventInput
): Promise<{ id: string } | null> {
  if (input.eventType === 'STOP_ARRIVED') {
    return prisma.driverEvent.findFirst({
      select: { id: true },
      where: {
        deliveryStopId: requireDeliveryStopId(input),
        driverId: input.driverId,
        eventType: 'STOP_ARRIVED',
        routePlanId: requireRoutePlanId(input)
      }
    });
  }

  if (
    input.clientEventId === null
    || (input.eventType !== 'ROUTE_COMPLETED' && input.eventType !== 'ROUTE_PAUSED')
  ) {
    return null;
  }

  const event = await prisma.driverEvent.findUnique({
    select: { eventType: true, id: true, routePlanId: true },
    where: {
      driverId_clientEventId: {
        clientEventId: input.clientEventId,
        driverId: input.driverId
      }
    }
  });
  if (event === null) {
    return null;
  }
  if (event.eventType !== input.eventType || event.routePlanId !== input.routePlanId) {
    throw new DriverEventContextError('clientEventId is already used by a different driver event');
  }

  return { id: event.id };
}

async function validateDriverEventStateContext(
  prisma: DriverEventTransactionClient,
  input: RecordDriverEventInput,
  shopId: string
): Promise<void> {
  if (input.eventType === 'ROUTE_STARTED') {
    const routePlanId = requireRoutePlanId(input);
    await requireStartableOwnedRoutePlan(prisma, {
      driverId: input.driverId,
      routePlanId,
      shopId
    });
    return;
  }

  const routePlanId = requireRoutePlanId(input);
  const routePlan = await requireOwnedRoutePlan(prisma, { driverId: input.driverId, routePlanId, shopId });
  if (input.eventType === 'LOCATION_UPDATED' && routePlan.status !== 'IN_PROGRESS') {
    throw new DriverEventRouteNotInProgressError('Route must be in progress before accepting location updates');
  }

  if (input.eventType === 'STOP_ARRIVED' || input.eventType === 'STOP_DELIVERED' || input.eventType === 'STOP_FAILED') {
    await requireOwnedRoutePlanStop(prisma, {
      deliveryStopId: requireDeliveryStopId(input),
      driverId: input.driverId,
      routePlanId,
      shopId
    });
  }
}

async function applyDriverEventStateTransition(
  prisma: DriverEventTransactionClient,
  input: RecordDriverEventInput,
  shopId: string,
  serverReceivedAt: Date
): Promise<DriverRouteEtaUpdate | null> {
  if (input.eventType === 'STOP_ARRIVED') {
    const routePlanId = requireRoutePlanId(input);
    const deliveryStopId = requireDeliveryStopId(input);
    await prisma.deliveryStop.updateMany({
      data: { status: 'ARRIVED' },
      where: {
        id: deliveryStopId,
        routePlanStops: {
          some: {
            routePlan: {
              driverId: input.driverId,
              id: routePlanId,
              shopId
            },
            routePlanId
          }
        },
        shopId
      }
    });
    const stops = await loadRouteEtaStops(prisma, routePlanId);
    const etaUpdate = calculateArrivalEtaUpdate({
      arrivedDeliveryStopId: deliveryStopId,
      serverReceivedAt,
      stops
    });
    await persistEtaUpdate(prisma, routePlanId, etaUpdate);
    return etaUpdate;
  }

  if (input.eventType === 'STOP_DELIVERED' || input.eventType === 'STOP_FAILED') {
    const routePlanId = requireRoutePlanId(input);
    await prisma.deliveryStop.updateMany({
      data: {
        status: input.eventType === 'STOP_DELIVERED' ? 'DELIVERED' : 'FAILED'
      },
      where: {
        id: requireDeliveryStopId(input),
        routePlanStops: {
          some: {
            routePlan: {
              driverId: input.driverId,
              id: routePlanId,
              shopId
            },
            routePlanId
          }
        },
        shopId
      }
    });
    return null;
  }

  if (input.eventType === 'ROUTE_STARTED') {
    const routePlanId = requireRoutePlanId(input);
    await prisma.routePlan.updateMany({
      data: { status: 'IN_PROGRESS' },
      where: {
        driverId: input.driverId,
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        id: routePlanId,
        shopId,
        status: { in: [...ROUTE_READY_COMPATIBILITY_STATUSES] }
      }
    });
    const etaUpdate = calculateRouteStartEtaUpdate({
      serverReceivedAt,
      stops: await loadRouteEtaStops(prisma, routePlanId)
    });
    await persistEtaUpdate(prisma, routePlanId, etaUpdate);
    return etaUpdate;
  }

  if (input.eventType === 'ROUTE_COMPLETED') {
    await prisma.routePlan.updateMany({
      data: { status: 'COMPLETED' },
      where: {
        driverId: input.driverId,
        id: requireRoutePlanId(input),
        shopId,
        status: { not: 'CANCELLED' }
      }
    });
    return null;
  }

  if (input.eventType === 'ROUTE_PAUSED') {
    await prisma.routePlan.updateMany({
      data: { status: 'READY' },
      where: {
        driverId: input.driverId,
        id: requireRoutePlanId(input),
        shopId,
        status: 'IN_PROGRESS'
      }
    });
    return null;
  }

  return null;
}

async function loadRouteEtaStops(
  prisma: DriverEventTransactionClient,
  routePlanId: string
): Promise<DriverRouteEtaStop[]> {
  const rows = await prisma.routePlanStop.findMany({
    orderBy: { sequence: 'asc' },
    select: {
      deliveryStop: { select: { serviceMinutes: true } },
      deliveryStopId: true,
      distanceFromPreviousMeters: true,
      durationFromPreviousSeconds: true,
      estimatedArrivalAt: true,
      sequence: true
    },
    where: { routePlanId }
  });
  if (rows.every((row) => row.durationFromPreviousSeconds !== null)) {
    return rows.map(toEtaStop);
  }

  const cache = await prisma.routePlanGeometryCache.findFirst({
    orderBy: { generatedAt: 'desc' },
    select: { stopPoints: true },
    where: { routePlanId }
  });
  const stopPoints = readRouteStopPoints(cache?.stopPoints);
  const stopPointById = new Map(stopPoints.map((point) => [point.deliveryStopId, point]));
  const cacheMatchesRoute = rows.length > 0 && rows.every((row) => {
    const point = stopPointById.get(row.deliveryStopId);
    return point?.sequence === row.sequence;
  });
  if (!cacheMatchesRoute) {
    return rows.map(toEtaStop);
  }

  const hydratedRows = rows.map((row) => {
    const point = stopPointById.get(row.deliveryStopId)!;
    return {
      ...row,
      distanceFromPreviousMeters: normalizedInteger(point.distanceFromPreviousMeters),
      durationFromPreviousSeconds: normalizedInteger(point.durationFromPreviousSeconds)
    };
  });
  await Promise.all(hydratedRows.map((row) => prisma.routePlanStop.update({
    data: {
      distanceFromPreviousMeters: row.distanceFromPreviousMeters,
      durationFromPreviousSeconds: row.durationFromPreviousSeconds
    },
    where: {
      routePlanId_deliveryStopId: {
        deliveryStopId: row.deliveryStopId,
        routePlanId
      }
    }
  })));
  return hydratedRows.map(toEtaStop);
}

async function persistEtaUpdate(
  prisma: DriverEventTransactionClient,
  routePlanId: string,
  etaUpdate: DriverRouteEtaUpdate
): Promise<void> {
  await Promise.all(etaUpdate.updatedStops.map((stop) => prisma.routePlanStop.update({
    data: {
      estimatedArrivalAt: stop.estimatedArrivalAt === null ? null : new Date(stop.estimatedArrivalAt)
    },
    where: {
      routePlanId_deliveryStopId: {
        deliveryStopId: stop.deliveryStopId,
        routePlanId
      }
    }
  })));
}

function toEtaStop(row: {
  deliveryStop: { serviceMinutes: number | null };
  deliveryStopId: string;
  durationFromPreviousSeconds: number | null;
  estimatedArrivalAt: Date | null;
  sequence: number;
}): DriverRouteEtaStop {
  return {
    deliveryStopId: row.deliveryStopId,
    durationFromPreviousSeconds: row.durationFromPreviousSeconds,
    estimatedArrivalAt: row.estimatedArrivalAt,
    sequence: row.sequence,
    serviceMinutes: row.deliveryStop.serviceMinutes
  };
}

function normalizedInteger(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) || value < 0
    ? null
    : Math.round(value);
}

async function requireStartableOwnedRoutePlan(
  prisma: DriverEventTransactionClient,
  input: { driverId: string; routePlanId: string; shopId: string }
): Promise<void> {
  const routePlan = await prisma.routePlan.findFirst({
    select: { id: true },
    where: {
      driverId: input.driverId,
      driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
      id: input.routePlanId,
      shopId: input.shopId,
      status: { in: [...ROUTE_ACTIVE_COMPATIBILITY_STATUSES] }
    }
  });
  if (routePlan === null) {
    throw new DriverEventScopeError('Completed or unavailable routes cannot be started');
  }
}

async function requireOwnedRoutePlan(
  prisma: DriverEventTransactionClient,
  input: { driverId: string; routePlanId: string; shopId: string }
): Promise<{ status: string }> {
  const routePlan = await prisma.routePlan.findFirst({
    select: { id: true, status: true },
    where: {
      driverId: input.driverId,
      driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
      id: input.routePlanId,
      shopId: input.shopId,
      status: { in: [...ROUTE_ACTIVE_COMPATIBILITY_STATUSES] }
    }
  });
  if (routePlan === null) {
    throw new DriverEventScopeError('Driver route context is outside the authenticated driver scope');
  }

  return { status: routePlan.status };
}

async function requireOwnedRoutePlanStop(
  prisma: DriverEventTransactionClient,
  input: { deliveryStopId: string; driverId: string; routePlanId: string; shopId: string }
): Promise<void> {
  const routePlanStop = await prisma.routePlanStop.findFirst({
    select: { id: true },
    where: {
      deliveryStopId: input.deliveryStopId,
      routePlan: {
        driverId: input.driverId,
        id: input.routePlanId,
        shopId: input.shopId
      }
    }
  });
  if (routePlanStop === null) {
    throw new DriverEventScopeError('Driver stop context is outside the authenticated route scope');
  }
}

function requireRoutePlanId(input: RecordDriverEventInput): string {
  if (input.routePlanId === null || input.routePlanId.trim().length === 0) {
    throw new DriverEventContextError('Driver event requires routePlanId for terminal route state changes');
  }

  return input.routePlanId;
}

function requireDeliveryStopId(input: RecordDriverEventInput): string {
  if (input.deliveryStopId === null || input.deliveryStopId.trim().length === 0) {
    throw new DriverEventContextError('Driver event requires deliveryStopId for terminal stop state changes');
  }

  return input.deliveryStopId;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
