import { Prisma, type PrismaClient } from '@prisma/client';

type AttemptRetentionPrisma = Pick<PrismaClient, '$queryRaw'>;

const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_DEADLINE_MS = 2 * 60 * 1000;

export async function cleanupResolvedDriverEventAttempts(
  prisma: AttemptRetentionPrisma,
  now = new Date(),
  options: { batchSize?: number; deadlineAt?: number; maxRows?: number } = {}
): Promise<{ continuationRequired: boolean; deletedCount: number }> {
  const batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
  const maxRows = positiveInteger(options.maxRows, DEFAULT_MAX_ROWS);
  const deadlineAt = Math.min(options.deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + DEFAULT_DEADLINE_MS);
  let deletedCount = 0;
  while (deletedCount < maxRows && Date.now() < deadlineAt) {
    const take = Math.min(batchSize, maxRows - deletedCount);
    const deleted = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "driver_event_attempts"
        WHERE "retainedUntil" < ${now}
          AND (
            "status" IN ('APPLIED', 'DUPLICATE')
            OR ("status" = 'REJECTED' AND "reconciledAt" IS NOT NULL)
          )
        ORDER BY "retainedUntil" ASC, "id" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "driver_event_attempts" target
      USING candidates
      WHERE target."id" = candidates."id"
      RETURNING target."id"
    `);
    deletedCount += deleted.length;
    if (deleted.length < take) return { continuationRequired: false, deletedCount };
  }
  const remaining = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "driver_event_attempts"
      WHERE "retainedUntil" < ${now}
        AND (
          "status" IN ('APPLIED', 'DUPLICATE')
          OR ("status" = 'REJECTED' AND "reconciledAt" IS NOT NULL)
        )
    ) AS "exists"
  `);
  return { continuationRequired: remaining[0]?.exists === true, deletedCount };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

export function parseRetentionDeadline(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('RETENTION_DEADLINE_EPOCH_MS is invalid');
  return parsed;
}
