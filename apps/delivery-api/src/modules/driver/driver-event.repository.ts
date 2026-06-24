import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { normalizeDriverCommerceDomain } from './driver-commerce-domain.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';

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
};

export type RecordDriverEventResult = {
  duplicate: boolean;
  eventId: string;
};

type DriverEventPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'deliveryStop' | 'driver' | 'driverEvent' | 'routePlan' | 'routePlanStop' | 'shop'
>;

type DriverEventTransactionClient = Pick<
  DriverEventPrismaClient,
  'deliveryStop' | 'driver' | 'driverEvent' | 'routePlan' | 'routePlanStop' | 'shop'
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

const TERMINAL_DELIVERY_STOP_STATUSES = new Set(['DELIVERED', 'FAILED']);

export class PrismaDriverEventRepository {
  constructor(private readonly prisma: DriverEventPrismaClient) {}

  async recordDriverEvent(input: RecordDriverEventInput): Promise<RecordDriverEventResult> {
    const shopDomain = normalizeDriverCommerceDomain(input.shopDomain);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const shop = await transaction.shop.findUnique({ where: appScopedShopWhere({ shopDomain }) });
        if (shop === null) {
          throw new Error(`Shop not installed: ${shopDomain}`);
        }

        const driver = await transaction.driver.findUnique({ where: { id: input.driverId } });
        if (driver === null || driver.shopId !== shop.id) {
          throw new Error(`Driver not found for shop: ${input.driverId}`);
        }

        await validateDriverEventStateContext(transaction, input, shop.id);

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
            shopId: shop.id
          }
        });

        await applyDriverEventStateTransition(transaction, input, shop.id);

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
  if (input.eventType === 'STOP_DELIVERED' || input.eventType === 'STOP_FAILED') {
    const routePlanId = requireRoutePlanId(input);
    const deliveryStopId = requireDeliveryStopId(input);
    await requireOwnedRoutePlan(prisma, {
      driverId: input.driverId,
      routePlanId,
      shopId
    });
    await requireOwnedRoutePlanStop(prisma, {
      deliveryStopId,
      driverId: input.driverId,
      routePlanId,
      shopId
    });
    return;
  }

  if (input.eventType === 'ROUTE_STARTED' || input.eventType === 'ROUTE_COMPLETED') {
    const routePlanId = requireRoutePlanId(input);
    await requireOwnedRoutePlan(prisma, {
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
    await completeRoutePlanIfTerminal(prisma, {
      driverId: input.driverId,
      routePlanId,
      shopId
    });
    return;
  }

  if (input.eventType === 'ROUTE_STARTED') {
    await prisma.routePlan.updateMany({
      data: { status: 'IN_PROGRESS' },
      where: {
        driverId: input.driverId,
        id: requireRoutePlanId(input),
        shopId,
        status: { in: ['ASSIGNED', 'OPTIMIZED'] }
      }
    });
    return;
  }

  if (input.eventType === 'ROUTE_COMPLETED') {
    await completeRoutePlanIfTerminal(prisma, {
      driverId: input.driverId,
      routePlanId: requireRoutePlanId(input),
      shopId
    });
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
      id: input.routePlanId,
      shopId: input.shopId
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

async function completeRoutePlanIfTerminal(
  prisma: DriverEventTransactionClient,
  input: { driverId: string; routePlanId: string; shopId: string }
): Promise<void> {
  const routePlan = await prisma.routePlan.findFirst({
    select: {
      id: true,
      routeStops: {
        select: {
          deliveryStop: {
            select: {
              status: true
            }
          }
        }
      }
    },
    where: {
      driverId: input.driverId,
      id: input.routePlanId,
      shopId: input.shopId
    }
  });
  if (routePlan === null || routePlan.routeStops.length === 0) {
    return;
  }

  const allStopsTerminal = routePlan.routeStops.every((routeStop) =>
    TERMINAL_DELIVERY_STOP_STATUSES.has(routeStop.deliveryStop.status)
  );
  if (!allStopsTerminal) {
    return;
  }

  const completionEvent = await prisma.driverEvent.findFirst({
    select: { id: true },
    where: {
      driverId: input.driverId,
      eventType: 'ROUTE_COMPLETED',
      routePlanId: input.routePlanId,
      shopId: input.shopId
    }
  });
  if (completionEvent === null) {
    return;
  }

  await prisma.routePlan.updateMany({
    data: { status: 'COMPLETED' },
    where: {
      driverId: input.driverId,
      id: input.routePlanId,
      shopId: input.shopId,
      status: { notIn: ['COMPLETED', 'CANCELLED'] }
    }
  });
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
