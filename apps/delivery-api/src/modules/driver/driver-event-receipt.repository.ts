import type { PrismaClient } from '@prisma/client';

export type DriverEventReceipt = {
  assignmentGeneration: string | null;
  clientEventId: string;
  errorCode: string | null;
  expectedRouteVersionId: string | null;
  routePlanId: string;
  routeStatus: string;
  status: 'APPLIED' | 'REJECTED' | 'UNKNOWN';
};

export type DriverDestinationCompletionResult =
  | { status: 'UNKNOWN' }
  | {
      clientEventId: string;
      completedStopCount: number;
      deliveryStopIds: string[];
      destinationId: string;
      eventIds: string[];
      occurredAt: string;
      routePlanId: string;
      status: 'APPLIED';
    };

export class DriverEventReceiptScopeError extends Error {
  constructor() {
    super('Driver event receipt is outside the authenticated account scope');
    this.name = 'DriverEventReceiptScopeError';
  }
}

type ReceiptPrismaClient = Pick<PrismaClient, 'driverEvent' | 'driverEventAttempt' | 'routePlan'>;

export class PrismaDriverEventReceiptRepository {
  constructor(private readonly prisma: ReceiptPrismaClient) {}

  async lookupDestinationCompletion(input: {
    accountId: string;
    clientEventId: string;
    deliveryStopIds: string[];
    destinationId: string;
    occurredAt: Date;
    routePlanId: string;
  }): Promise<DriverDestinationCompletionResult> {
    const expectedEventIds = input.deliveryStopIds.map(
      (deliveryStopId) => `${input.clientEventId}:${deliveryStopId}`
    );
    const events = await this.prisma.driverEvent.findMany({
      select: {
        clientEventId: true,
        completionOwnerAccountId: true,
        deliveryStopId: true,
        eventType: true,
        id: true,
        occurredAt: true,
        payload: true,
        routePlanId: true
      },
      where: {
        clientEventId: { in: expectedEventIds },
        completionOwnerAccountId: input.accountId,
        eventType: 'STOP_DELIVERED',
        routePlanId: input.routePlanId
      }
    });
    if (events.length !== expectedEventIds.length) return { status: 'UNKNOWN' };

    const eventsByClientEventId = new Map(events.map((event) => [event.clientEventId, event]));
    const occurredAt = input.occurredAt.toISOString();
    const orderedEvents = expectedEventIds.map((clientEventId) => eventsByClientEventId.get(clientEventId));
    if (orderedEvents.some((event) => event === undefined)) return { status: 'UNKNOWN' };

    const eventIds: string[] = [];
    for (let index = 0; index < orderedEvents.length; index += 1) {
      const event = orderedEvents[index];
      const deliveryStopId = input.deliveryStopIds[index];
      if (
        event === undefined
        || deliveryStopId === undefined
        || event.clientEventId !== expectedEventIds[index]
        || event.completionOwnerAccountId !== input.accountId
        || event.deliveryStopId !== deliveryStopId
        || event.eventType !== 'STOP_DELIVERED'
        || event.occurredAt.toISOString() !== occurredAt
        || event.routePlanId !== input.routePlanId
        || !matchesDestinationCompletionPayload(event.payload, {
          clientEventId: input.clientEventId,
          deliveryStopIds: input.deliveryStopIds,
          destinationId: input.destinationId,
          occurredAt,
          routePlanId: input.routePlanId
        })
      ) return { status: 'UNKNOWN' };
      eventIds.push(event.id);
    }

    return {
      clientEventId: input.clientEventId,
      completedStopCount: orderedEvents.length,
      deliveryStopIds: input.deliveryStopIds,
      destinationId: input.destinationId,
      eventIds,
      occurredAt,
      routePlanId: input.routePlanId,
      status: 'APPLIED'
    };
  }

  async lookup(input: {
    accountId: string;
    clientEventId: string;
    routePlanId: string;
  }): Promise<DriverEventReceipt> {
    const committed = await this.prisma.driverEvent.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        assignmentGeneration: true,
        clientEventId: true,
        expectedRouteVersionId: true,
        routePlan: { select: { status: true } },
        routePlanId: true
      },
      where: {
        clientEventId: input.clientEventId,
        driver: { accountId: input.accountId },
        routePlanId: input.routePlanId
      }
    });
    if (committed !== null && committed.clientEventId !== null && committed.routePlanId !== null && committed.routePlan !== null) {
      return {
        assignmentGeneration: committed.assignmentGeneration?.toString() ?? null,
        clientEventId: committed.clientEventId,
        errorCode: null,
        expectedRouteVersionId: committed.expectedRouteVersionId,
        routePlanId: committed.routePlanId,
        routeStatus: committed.routePlan.status,
        status: 'APPLIED'
      };
    }

    const attempt = await this.prisma.driverEventAttempt.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        assignmentGeneration: true,
        clientEventId: true,
        errorCode: true,
        expectedRouteVersionId: true,
        retryable: true,
        routePlan: { select: { status: true } },
        routePlanId: true,
        status: true
      },
      where: {
        clientEventId: input.clientEventId,
        driver: { accountId: input.accountId },
        routePlanId: input.routePlanId
      }
    });
    if (attempt !== null && attempt.clientEventId !== null && attempt.routePlanId !== null && attempt.routePlan !== null) {
      const rejected = attempt.status === 'REJECTED' && attempt.retryable === false;
      return {
        assignmentGeneration: attempt.assignmentGeneration?.toString() ?? null,
        clientEventId: attempt.clientEventId,
        errorCode: rejected ? attempt.errorCode : null,
        expectedRouteVersionId: attempt.expectedRouteVersionId,
        routePlanId: attempt.routePlanId,
        routeStatus: attempt.routePlan.status,
        status: rejected ? 'REJECTED' : 'UNKNOWN'
      };
    }

    const route = await this.prisma.routePlan.findFirst({
      select: { status: true },
      where: { driver: { accountId: input.accountId }, id: input.routePlanId }
    });
    if (route === null) throw new DriverEventReceiptScopeError();
    return {
      assignmentGeneration: null,
      clientEventId: input.clientEventId,
      errorCode: null,
      expectedRouteVersionId: null,
      routePlanId: input.routePlanId,
      routeStatus: route.status,
      status: 'UNKNOWN'
    };
  }
}

function matchesDestinationCompletionPayload(
  payload: unknown,
  expected: {
    clientEventId: string;
    deliveryStopIds: string[];
    destinationId: string;
    occurredAt: string;
    routePlanId: string;
  }
): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return record.clientEventId === expected.clientEventId
    && arraysEqual(record.deliveryStopIds, expected.deliveryStopIds)
    && record.destinationId === expected.destinationId
    && record.occurredAt === expected.occurredAt
    && record.routePlanId === expected.routePlanId;
}

function arraysEqual(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

export type DriverEventReceiptServiceApi = Pick<
  PrismaDriverEventReceiptRepository,
  'lookup' | 'lookupDestinationCompletion'
>;
