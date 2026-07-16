import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { ROUTE_ACTIVE_COMPATIBILITY_STATUSES, ROUTE_READY_COMPATIBILITY_STATUSES } from '../route-plans/route-plan-lifecycle.js';

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
  eventId: string;
};

type DriverEventPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'deliveryStop' | 'driverEvent' | 'routePlan' | 'routePlanStop'
>;

type DriverEventTransactionClient = Pick<
  DriverEventPrismaClient,
  'deliveryStop' | 'driverEvent' | 'routePlan' | 'routePlanStop'
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


export class PrismaDriverEventRepository {
  constructor(private readonly prisma: DriverEventPrismaClient) {}

  async recordDriverEvent(input: RecordDriverEventInput): Promise<RecordDriverEventResult> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
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

        await applyDriverEventStateTransition(transaction, input, input.shopId);

        return { duplicate: false, eventId: event.id };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { duplicate: true, eventId: input.clientEventId ?? 'duplicate' };
      }

      throw error;
    }
  }
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
  await requireOwnedRoutePlan(prisma, { driverId: input.driverId, routePlanId, shopId });

  if (input.eventType === 'STOP_DELIVERED' || input.eventType === 'STOP_FAILED') {
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
  shopId: string
): Promise<void> {
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
    return;
  }

  if (input.eventType === 'ROUTE_STARTED') {
    await prisma.routePlan.updateMany({
      data: { status: 'IN_PROGRESS' },
      where: {
        driverId: input.driverId,
        driverEvents: { none: { eventType: 'ROUTE_COMPLETED' } },
        id: requireRoutePlanId(input),
        shopId,
        status: { in: [...ROUTE_READY_COMPATIBILITY_STATUSES] }
      }
    });
    return;
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
    return;
  }
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
    throw new DriverEventScopeError('Driver route context is outside the authenticated driver scope');
  }
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
