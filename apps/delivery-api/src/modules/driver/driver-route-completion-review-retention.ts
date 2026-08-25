import { Prisma, type PrismaClient } from '@prisma/client';

type ReviewRetentionPrisma = Pick<PrismaClient, '$queryRaw'>;

export async function cleanupReviewedRouteCompletionEvidence(
  prisma: ReviewRetentionPrisma,
  now = new Date(),
  options: { batchSize?: number; maxRows?: number } = {}
): Promise<{ continuationRequired: boolean; deletedCount: number }> {
  const batchSize = positiveInteger(options.batchSize, 1_000);
  const maxRows = positiveInteger(options.maxRows, 10_000);
  let deletedCount = 0;
  while (deletedCount < maxRows) {
    const take = Math.min(batchSize, maxRows - deletedCount);
    const deleted = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "driver_route_completion_reviews"
        WHERE "reviewedAt" IS NOT NULL AND "retainedUntil" < ${now}
        ORDER BY "retainedUntil" ASC, "id" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "driver_route_completion_reviews" target
      USING candidates
      WHERE target."id" = candidates."id"
      RETURNING target."id"
    `);
    deletedCount += deleted.length;
    if (deleted.length < take) return { continuationRequired: false, deletedCount };
  }
  const remaining = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "driver_route_completion_reviews"
      WHERE "reviewedAt" IS NOT NULL AND "retainedUntil" < ${now}
    ) AS "exists"
  `);
  return { continuationRequired: remaining[0]?.exists === true, deletedCount };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}
