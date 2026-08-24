import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const since = readSince(process.argv.slice(2));

type AggregateRow = {
  confirmed_correct_count: bigint;
  false_positive_count: bigint;
  full_count: bigint;
  guarded_count: bigint;
  observe_count: bigint;
  receipt_aware_count: bigint;
  rejected_count: bigint;
  total_count: bigint;
  unreviewed_count: bigint;
  would_reject_count: bigint;
};

try {
  const [row] = await prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT
      COUNT(*) AS total_count,
      COUNT(*) FILTER (WHERE "receiptAware") AS receipt_aware_count,
      COUNT(*) FILTER (WHERE mode = 'OBSERVE') AS observe_count,
      COUNT(*) FILTER (WHERE mode = 'GUARDED') AS guarded_count,
      COUNT(*) FILTER (WHERE mode = 'FULL') AS full_count,
      COUNT(*) FILTER (WHERE "wouldReject") AS would_reject_count,
      COUNT(*) FILTER (WHERE decision = 'REJECTED') AS rejected_count,
      COUNT(*) FILTER (WHERE "reviewOutcome" = 'CONFIRMED_CORRECT') AS confirmed_correct_count,
      COUNT(*) FILTER (WHERE "reviewOutcome" = 'FALSE_POSITIVE') AS false_positive_count,
      COUNT(*) FILTER (WHERE "reviewOutcome" IS NULL AND "wouldReject") AS unreviewed_count
    FROM driver_route_completion_reviews
    WHERE "createdAt" >= ${since}
  `);
  const total = Number(row?.total_count ?? 0n);
  const receiptAware = Number(row?.receipt_aware_count ?? 0n);
  process.stdout.write(`${JSON.stringify({
    adoptionPercent: total === 0 ? null : Number(((receiptAware / total) * 100).toFixed(2)),
    decisions: {
      rejected: Number(row?.rejected_count ?? 0n),
      wouldReject: Number(row?.would_reject_count ?? 0n)
    },
    modes: {
      full: Number(row?.full_count ?? 0n),
      guarded: Number(row?.guarded_count ?? 0n),
      observe: Number(row?.observe_count ?? 0n)
    },
    receiptAware,
    review: {
      confirmedCorrect: Number(row?.confirmed_correct_count ?? 0n),
      falsePositive: Number(row?.false_positive_count ?? 0n),
      unreviewedWouldReject: Number(row?.unreviewed_count ?? 0n)
    },
    since: since.toISOString(),
    total
  }, null, 2)}\n`);
} finally {
  await prisma.$disconnect();
}

function readSince(args: string[]): Date {
  const index = args.indexOf('--since');
  const value = index === -1 ? undefined : args[index + 1];
  const date = value === undefined ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('--since must be an ISO-8601 timestamp');
  return date;
}
