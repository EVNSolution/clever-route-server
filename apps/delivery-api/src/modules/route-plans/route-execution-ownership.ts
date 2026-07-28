import { Prisma } from '@prisma/client';

type RouteExecutionOwnershipTx = {
  $queryRaw(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<unknown>;
  routePlanStop: {
    findFirst(args: {
      select: { deliveryStopId: true; routePlanId: true };
      where: {
        deliveryStopId: { in: string[] };
        routePlanId: { not: string };
        routePlan: { shopId: string; status: 'IN_PROGRESS' };
      };
    }): Promise<{ deliveryStopId: string; routePlanId: string } | null>;
    findMany(args: {
      select: { deliveryStopId: true };
      where: { routePlanId: string };
    }): Promise<Array<{ deliveryStopId: string }>>;
  };
};

export class RouteExecutionConflictError extends Error {
  readonly code = 'ROUTE_EXECUTION_CONFLICT';

  constructor(
    readonly conflictingRoutePlanId: string,
    readonly deliveryStopId: string,
    message = 'An overlapping route is already in progress'
  ) {
    super(message);
    this.name = 'RouteExecutionConflictError';
  }
}

export async function assertRouteExecutionOwnership(
  tx: RouteExecutionOwnershipTx,
  input: {
    createConflictError?: (conflict: { deliveryStopId: string; routePlanId: string }) => Error;
    deliveryStopIds: string[];
    routePlanId: string;
    shopId: string;
  }
): Promise<void> {
  const deliveryStopIds = [...new Set(input.deliveryStopIds)].sort((left, right) => left.localeCompare(right));
  if (deliveryStopIds.length === 0) return;

  for (const deliveryStopId of deliveryStopIds) {
    await tx.$queryRaw(Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(710027, hashtext(${deliveryStopId}))`);
  }

  const conflict = await tx.routePlanStop.findFirst({
    select: { deliveryStopId: true, routePlanId: true },
    where: {
      deliveryStopId: { in: deliveryStopIds },
      routePlanId: { not: input.routePlanId },
      routePlan: {
        shopId: input.shopId,
        status: 'IN_PROGRESS'
      }
    }
  });
  if (conflict !== null) {
    throw input.createConflictError?.(conflict) ?? new RouteExecutionConflictError(conflict.routePlanId, conflict.deliveryStopId);
  }
}

export async function assertRoutePlanExecutionOwnership(
  tx: RouteExecutionOwnershipTx,
  input: {
    createConflictError?: (conflict: { deliveryStopId: string; routePlanId: string }) => Error;
    routePlanId: string;
    shopId: string;
  }
): Promise<void> {
  const stops = await tx.routePlanStop.findMany({
    select: { deliveryStopId: true },
    where: { routePlanId: input.routePlanId }
  });
  await assertRouteExecutionOwnership(tx, {
    ...input,
    deliveryStopIds: stops.map((stop) => stop.deliveryStopId)
  });
}
