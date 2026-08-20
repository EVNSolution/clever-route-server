import { PrismaClient } from '@prisma/client';

type AuditRow = {
  foreignRoutePlanAssociations: number;
  orphanedCustomOrders: number;
  ownerMismatchCustomOrders: number;
  sharedCustomOrders: number;
};

type MembershipAuditRow = Omit<AuditRow, 'foreignRoutePlanAssociations'>;
type PreMigrationAuditRow = Omit<MembershipAuditRow, 'ownerMismatchCustomOrders'>;

const prisma = new PrismaClient();

try {
  const columnRows = await prisma.$queryRaw<Array<{ ownershipColumnPresent: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'orders'
        AND column_name = 'ownedRouteGroupingId'
    ) AS "ownershipColumnPresent"
  `;
  const ownershipColumnPresent = columnRows[0]?.ownershipColumnPresent ?? false;
  const membershipResult: MembershipAuditRow = ownershipColumnPresent
    ? (await prisma.$queryRaw<MembershipAuditRow[]>`
        SELECT
          COUNT(*) FILTER (WHERE membership_count = 0)::INTEGER AS "orphanedCustomOrders",
          COUNT(*) FILTER (
            WHERE membership_count = 1 AND "ownedRouteGroupingId" IS DISTINCT FROM single_grouping_id
          )::INTEGER AS "ownerMismatchCustomOrders",
          COUNT(*) FILTER (WHERE membership_count > 1)::INTEGER AS "sharedCustomOrders"
        FROM (
          SELECT
            o."id",
            o."ownedRouteGroupingId",
            COUNT(DISTINCT rgo."groupingId") AS membership_count,
            MIN(rgo."groupingId"::TEXT)::UUID AS single_grouping_id
          FROM "orders" o
          LEFT JOIN "route_grouping_orders" rgo ON rgo."orderId" = o."id"
          WHERE o."sourcePlatform" = 'CUSTOM'
          GROUP BY o."id"
        ) audit
      `)[0] ?? { orphanedCustomOrders: 0, ownerMismatchCustomOrders: 0, sharedCustomOrders: 0 }
    : {
        ...(await prisma.$queryRaw<PreMigrationAuditRow[]>`
          SELECT
            COUNT(*) FILTER (WHERE membership_count = 0)::INTEGER AS "orphanedCustomOrders",
            COUNT(*) FILTER (WHERE membership_count > 1)::INTEGER AS "sharedCustomOrders"
          FROM (
            SELECT o."id", COUNT(DISTINCT rgo."groupingId") AS membership_count
            FROM "orders" o
            LEFT JOIN "route_grouping_orders" rgo ON rgo."orderId" = o."id"
            WHERE o."sourcePlatform" = 'CUSTOM'
            GROUP BY o."id"
          ) audit
        `)[0] ?? { orphanedCustomOrders: 0, sharedCustomOrders: 0 },
        ownerMismatchCustomOrders: 0
      };
  const foreignRoutePlanAssociations = ownershipColumnPresent
    ? (await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(DISTINCT o."id")::INTEGER AS "count"
        FROM "orders" o
        JOIN "delivery_stops" ds ON ds."orderId" = o."id"
        JOIN "route_plan_stops" rps ON rps."deliveryStopId" = ds."id"
        WHERE o."sourcePlatform" = 'CUSTOM'
          AND (
            NOT EXISTS (
              SELECT 1
              FROM "route_grouping_child_versions" child
              WHERE child."routePlanId" = rps."routePlanId"
                AND child."groupingId" = o."ownedRouteGroupingId"
                AND child."shopId" = o."shopId"
            )
            OR EXISTS (
              SELECT 1
              FROM "route_grouping_child_versions" foreign_child
              WHERE foreign_child."routePlanId" = rps."routePlanId"
                AND foreign_child."groupingId" IS DISTINCT FROM o."ownedRouteGroupingId"
            )
          )
      `)[0]?.count ?? 0
    : (await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(DISTINCT o."id")::INTEGER AS "count"
        FROM "orders" o
        JOIN "delivery_stops" ds ON ds."orderId" = o."id"
        JOIN "route_plan_stops" rps ON rps."deliveryStopId" = ds."id"
        WHERE o."sourcePlatform" = 'CUSTOM'
          AND (
            NOT EXISTS (
              SELECT 1
              FROM "route_grouping_orders" owner_membership
              JOIN "route_grouping_child_versions" child
                ON child."groupingId" = owner_membership."groupingId"
               AND child."routePlanId" = rps."routePlanId"
               AND child."shopId" = o."shopId"
              WHERE owner_membership."orderId" = o."id"
            )
            OR EXISTS (
              SELECT 1
              FROM "route_grouping_child_versions" foreign_child
              WHERE foreign_child."routePlanId" = rps."routePlanId"
                AND NOT EXISTS (
                  SELECT 1
                  FROM "route_grouping_orders" owner_membership
                  WHERE owner_membership."orderId" = o."id"
                    AND owner_membership."groupingId" = foreign_child."groupingId"
                )
            )
          )
      `)[0]?.count ?? 0;
  const result: AuditRow = { foreignRoutePlanAssociations, ...membershipResult };
  process.stdout.write(`${JSON.stringify({ audit: 'custom-route-order-ownership', ownershipColumnPresent, ...result })}\n`);
  if (result.foreignRoutePlanAssociations > 0 || result.orphanedCustomOrders > 0 || result.ownerMismatchCustomOrders > 0 || result.sharedCustomOrders > 0) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
