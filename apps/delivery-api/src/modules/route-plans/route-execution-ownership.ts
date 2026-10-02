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

export type RouteDispatchConflict = {
  deliveryStopId: string;
  orderId: string;
  orderName: string;
  routePlanId: string;
  routeName: string;
};

export async function lockRouteExecutionStops(
  tx: Pick<RouteExecutionOwnershipTx, '$queryRaw'>,
  deliveryStopIds: string[]
): Promise<void> {
  for (const stopId of [...new Set(deliveryStopIds)].sort()) {
    await tx.$queryRaw(Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(710027, hashtext(${stopId}))`);
  }
}

// Planning membership is many-to-many. Dispatch reserves execution, separately
// from the order's legacy primary-route projection. No stop outcome is reset.
export async function assertRouteDispatchOwnership(
  tx: Pick<RouteExecutionOwnershipTx, '$queryRaw'>,
  input: { deliveryStopIds: string[]; routePlanId: string; shopId: string }
): Promise<void> {
  const stopIds = [...new Set(input.deliveryStopIds)].sort();
  if (stopIds.length === 0) return;
  await lockRouteExecutionStops(tx, stopIds);
  const conflicts = await tx.$queryRaw(Prisma.sql`
    SELECT DISTINCT s."deliveryStopId", o.id AS "orderId", o.name AS "orderName",
      r.id AS "routePlanId", r.name AS "routeName"
    FROM route_plan_stops s
    JOIN route_plans r ON r.id = s."routePlanId" AND r."shopId" = s."shopId"
    JOIN delivery_stops d ON d.id = s."deliveryStopId" AND d."shopId" = s."shopId"
    JOIN orders o ON o.id = d."orderId" AND o."shopId" = d."shopId"
    WHERE r."shopId" = ${input.shopId}::uuid AND r.id <> ${input.routePlanId}::uuid
      AND s."deliveryStopId" IN (${Prisma.join(stopIds.map((id) => Prisma.sql`${id}::uuid`))})
      AND r.status NOT IN ('COMPLETED', 'INCOMPLETE', 'CANCELLED')
      AND NOT EXISTS (SELECT 1 FROM driver_events e WHERE e."routePlanId" = r.id
        AND e."shopId" = r."shopId" AND e."eventType" = 'ROUTE_COMPLETED')
      AND (r.status = 'IN_PROGRESS' OR r.constraints->>'cleverDispatchReservedAt' IS NOT NULL
        OR (EXISTS (SELECT 1 FROM driver_events e WHERE e."routePlanId" = r.id
          AND e."shopId" = r."shopId" AND e."eventType" = 'ROUTE_STARTED')
          AND NOT EXISTS (SELECT 1 FROM driver_events e WHERE e."routePlanId" = r.id
            AND e."shopId" = r."shopId" AND e."eventType" = 'ROUTE_PAUSED'))
        OR EXISTS (SELECT 1 FROM route_grouping_child_versions c WHERE c."routePlanId" = r.id
          AND c."shopId" = r."shopId" AND c.status = 'CURRENT' AND c."supersededAt" IS NULL AND c."publishedAt" IS NOT NULL)
        OR EXISTS (SELECT 1 FROM driver_route_notification_attempts n WHERE n."routePlanId" = r.id
          AND n."shopId" = r."shopId" AND n."groupingId" IS NULL AND n.status IN ('PENDING', 'SENT', 'FAILED')))
    ORDER BY o.name, r.name, r.id
  `) as RouteDispatchConflict[];
  if (conflicts.length > 0) {
    const first = conflicts[0]!;
    const error = new RouteExecutionConflictError(first.routePlanId, first.deliveryStopId,
      `배차 또는 배송 시작을 할 수 없습니다. 이미 배차되었거나 배송 중인 주문: ${conflicts.map((conflict) => `${conflict.orderName} (경로: ${conflict.routeName} [${conflict.routePlanId}])`).join(', ')}. 충돌 주문을 제외하거나 해당 경로를 완료/취소한 뒤 다시 시도해주세요.`);
    throw error;
  }
}

export function hasDispatchReservation(value: unknown): boolean {
  return value !== null && typeof value === 'object' && 'cleverDispatchReservedAt' in value
    && typeof value.cleverDispatchReservedAt === 'string';
}

export function withoutDispatchReservation(value: unknown): Prisma.InputJsonObject {
  const result: Record<string, unknown> = value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  delete result.cleverDispatchReservedAt;
  return result as Prisma.InputJsonObject;
}

export async function claimRouteExecutionProjection(
  tx: Pick<RouteExecutionOwnershipTx, '$queryRaw'>,
  input: { routePlanId: string; shopId: string }
): Promise<void> {
  // This singular field remains a compatibility projection for order/DSV
  // reads. Planning authority lives on each route's own current membership.
  // Call only after the shared stop locks and conflict check, in the same tx.
  await tx.$queryRaw(Prisma.sql`
    UPDATE orders o SET "currentRouteVersionId" = (
      SELECT c.id FROM route_grouping_child_versions c
      WHERE c."routePlanId" = ${input.routePlanId}::uuid AND c."shopId" = ${input.shopId}::uuid
        AND c.status = 'CURRENT' AND c."supersededAt" IS NULL
    ), "updatedAt" = NOW()
    FROM delivery_stops d JOIN route_plan_stops s ON s."deliveryStopId" = d.id AND s."shopId" = d."shopId"
    WHERE o.id = d."orderId" AND o."shopId" = d."shopId"
      AND s."routePlanId" = ${input.routePlanId}::uuid AND o."shopId" = ${input.shopId}::uuid
  `);
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

  await lockRouteExecutionStops(tx, deliveryStopIds);

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
