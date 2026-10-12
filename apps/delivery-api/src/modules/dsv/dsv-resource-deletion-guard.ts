import { Prisma } from '@prisma/client';

type ResourceKind = 'driver' | 'vehicle';
type Transaction = Prisma.TransactionClient;

export class DsvResourceInUseError extends Error {
  readonly code = 'RESOURCE_IN_USE';

  constructor(readonly resource: ResourceKind) {
    super(`${resource} is referenced by DSV operational history`);
    this.name = 'DsvResourceInUseError';
  }
}

export async function assertDsvResourceDeletionAllowed(
  tx: Transaction,
  input: { resourceId: string; resource: ResourceKind; shopId: string },
): Promise<boolean> {
  const resourceRoutePredicate = input.resource === 'driver'
    ? Prisma.sql`route_plan."driverId" = ${input.resourceId}::uuid`
    : Prisma.sql`route_plan."vehicleId" = ${input.resourceId}::uuid`;
  const contextResourcePredicate = input.resource === 'driver'
    ? Prisma.sql`execution_context."driverId" = ${input.resourceId}::uuid`
    : Prisma.sql`execution_context."vehicleId" = ${input.resourceId}::uuid`;

  const routeHints = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT resource_route."id"
    FROM (
      SELECT route_plan."id"
      FROM route_plans route_plan
      WHERE route_plan."shopId" = ${input.shopId}::uuid
        AND ${resourceRoutePredicate}
      UNION
      SELECT execution_context."routePlanId" AS "id"
      FROM dsv_execution_contexts execution_context
      WHERE execution_context."shopId" = ${input.shopId}::uuid
        AND execution_context."status" = 'ACTIVE'
        AND ${contextResourcePredicate}
    ) resource_route
    ORDER BY resource_route."id"
  `);
  const routeIds = [...new Set(routeHints.map((row) => row.id))].sort();
  if (routeIds.length > 0) {
    await tx.$queryRaw(Prisma.sql`
      SELECT route_plan."id"
      FROM route_plans route_plan
      WHERE route_plan."shopId" = ${input.shopId}::uuid
        AND route_plan."id" IN (${Prisma.join(routeIds.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY route_plan."id"
      FOR UPDATE
    `);
  }

  const lockedResource = input.resource === 'driver'
    ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT driver."id"
      FROM drivers driver
      WHERE driver."id" = ${input.resourceId}::uuid AND driver."shopId" = ${input.shopId}::uuid
      FOR UPDATE
    `)
    : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT vehicle."id"
      FROM vehicles vehicle
      WHERE vehicle."id" = ${input.resourceId}::uuid AND vehicle."shopId" = ${input.shopId}::uuid
      FOR UPDATE
    `);
  if (lockedResource.length !== 1) return false;

  const importResourcePredicate = input.resource === 'driver'
    ? Prisma.sql`import_row."driverId" = ${input.resourceId}::uuid`
    : Prisma.sql`import_row."vehicleId" = ${input.resourceId}::uuid`;
  const blockers = await tx.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
    SELECT (
      EXISTS (
        SELECT 1
        FROM route_plans route_plan
        WHERE route_plan."shopId" = ${input.shopId}::uuid
          AND ${resourceRoutePredicate}
          AND route_plan."status" NOT IN ('COMPLETED', 'INCOMPLETE', 'CANCELLED')
          AND EXISTS (
            SELECT 1
            FROM route_grouping_child_versions child
            WHERE child."shopId" = route_plan."shopId"
              AND child."routePlanId" = route_plan."id"
              AND child."status" = 'CURRENT'
              AND child."supersededAt" IS NULL
              AND child."publishedAt" IS NOT NULL
          )
      )
      OR EXISTS (
        SELECT 1
        FROM dsv_execution_contexts execution_context
        WHERE execution_context."shopId" = ${input.shopId}::uuid
          AND execution_context."status" = 'ACTIVE'
          AND ${contextResourcePredicate}
      )
      OR EXISTS (
        SELECT 1
        FROM dsv_dispatch_import_rows import_row
        WHERE import_row."shopId" = ${input.shopId}::uuid
          AND ${importResourcePredicate}
      )
    ) AS blocked
  `);
  if (blockers[0]?.blocked === true) throw new DsvResourceInUseError(input.resource);
  return true;
}

export function isResourceDeletionForeignKeyConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}
