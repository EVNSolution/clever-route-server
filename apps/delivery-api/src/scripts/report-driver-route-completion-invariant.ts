import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const now = new Date();
const since = readDateArgument('--since', new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
const activeSince = readDateArgument('--active-since', new Date(now.getTime() - 24 * 60 * 60 * 1000));
const sourceSha = readStringArgument('--source-sha');
const currentMode = readMode(process.env.DRIVER_ROUTE_COMPLETION_INVARIANT_MODE);

type ReviewAggregate = { confirmed_correct_count: bigint; false_positive_count: bigint; rejected_count: bigint; total_count: bigint; unreviewed_count: bigint; would_reject_count: bigint };
type AdoptionAggregate = { active_count: bigint; legacy_count: bigint; receipt_aware_count: bigint };
type DailyReviewAggregate = { day: Date; false_positive_count: bigint; unreviewed_count: bigint; would_reject_count: bigint };
type RecoveryAggregate = { unresolved_after_five_minutes: bigint };

try {
  const [[reviews], [adoption], daily, [recovery]] = await Promise.all([
    prisma.$queryRaw<ReviewAggregate[]>(Prisma.sql`
      SELECT COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE "wouldReject") AS would_reject_count,
        COUNT(*) FILTER (WHERE decision = 'REJECTED') AS rejected_count,
        COUNT(*) FILTER (WHERE "reviewOutcome" = 'CONFIRMED_CORRECT') AS confirmed_correct_count,
        COUNT(*) FILTER (WHERE "reviewOutcome" = 'FALSE_POSITIVE') AS false_positive_count,
        COUNT(*) FILTER (WHERE "reviewOutcome" IS NULL AND "wouldReject") AS unreviewed_count
      FROM driver_route_completion_reviews WHERE "createdAt" >= ${since}
    `),
    prisma.$queryRaw<AdoptionAggregate[]>(Prisma.sql`
      SELECT COUNT(*) AS active_count,
        COUNT(*) FILTER (WHERE "driverContractVersion" >= 2) AS receipt_aware_count,
        COUNT(*) FILTER (WHERE "driverContractVersion" < 2) AS legacy_count
      FROM driver_sync_sessions WHERE "lastObservedAt" >= ${activeSince}
    `),
    prisma.$queryRaw<DailyReviewAggregate[]>(Prisma.sql`
      SELECT days.day,
        COUNT(reviews.id) FILTER (WHERE reviews."wouldReject") AS would_reject_count,
        COUNT(reviews.id) FILTER (WHERE reviews."reviewOutcome" = 'FALSE_POSITIVE') AS false_positive_count,
        COUNT(reviews.id) FILTER (WHERE reviews."wouldReject" AND reviews."reviewOutcome" IS NULL) AS unreviewed_count
      FROM generate_series(date_trunc('day', ${since}::timestamptz), date_trunc('day', ${now}::timestamptz), interval '1 day') AS days(day)
      LEFT JOIN driver_route_completion_reviews reviews
        ON reviews."createdAt" >= days.day AND reviews."createdAt" < days.day + interval '1 day'
      GROUP BY days.day ORDER BY days.day DESC
    `),
    prisma.$queryRaw<RecoveryAggregate[]>(Prisma.sql`
      SELECT COUNT(*) AS unresolved_after_five_minutes
      FROM driver_event_attempts
      WHERE status = 'ACCEPTED' AND "receivedAt" < ${new Date(now.getTime() - 5 * 60 * 1000)}
    `)
  ]);
  const active = Number(adoption?.active_count ?? 0n);
  const receiptAware = Number(adoption?.receipt_aware_count ?? 0n);
  const legacyActiveCount = Number(adoption?.legacy_count ?? 0n);
  const recoveryPendingAfterFiveMinutes = Number(recovery?.unresolved_after_five_minutes ?? 0n);
  process.stdout.write(`${JSON.stringify({
    activeSessions: {
      activeSince: activeSince.toISOString(),
      adoptionPercent: active === 0 ? null : Number(((receiptAware / active) * 100).toFixed(2)),
      legacyActiveCount,
      receiptAwareCount: receiptAware,
      total: active
    },
    currentMode,
    gate: {
      consecutiveCleanReviewedDays: consecutiveCleanReviewedDays(daily, now),
      falsePositiveCount: Number(reviews?.false_positive_count ?? 0n),
      recoveryPendingAfterFiveMinutes,
      unreviewedWouldRejectCount: Number(reviews?.unreviewed_count ?? 0n)
    },
    generatedAt: now.toISOString(),
    legacyRetirementVerified: legacyActiveCount === 0,
    recoveryVerified: recoveryPendingAfterFiveMinutes === 0,
    reviews: {
      confirmedCorrect: Number(reviews?.confirmed_correct_count ?? 0n),
      rejected: Number(reviews?.rejected_count ?? 0n),
      total: Number(reviews?.total_count ?? 0n),
      wouldReject: Number(reviews?.would_reject_count ?? 0n)
    },
    since: since.toISOString(),
    sourceSha
  }, null, 2)}\n`);
} finally {
  await prisma.$disconnect();
}

function consecutiveCleanReviewedDays(rows: DailyReviewAggregate[], reference: Date): number {
  const byDay = new Map(rows.map((row) => [row.day.toISOString().slice(0, 10), row]));
  let count = 0;
  for (let offset = 0; offset < 31; offset += 1) {
    const day = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() - offset));
    const row = byDay.get(day.toISOString().slice(0, 10));
    if (row === undefined || row.false_positive_count !== 0n || row.unreviewed_count !== 0n) break;
    count += 1;
  }
  return count;
}

function readMode(value: string | undefined): 'FULL' | 'GUARDED' | 'OBSERVE' {
  if (value === undefined || value === '') return 'OBSERVE';
  if (value === 'OBSERVE' || value === 'GUARDED' || value === 'FULL') return value;
  throw new Error('DRIVER_ROUTE_COMPLETION_INVARIANT_MODE must be OBSERVE, GUARDED, or FULL');
}

function readStringArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || !/^[0-9a-f]{40}$/u.test(value)) throw new Error(`${name} must be an exact 40-character SHA`);
  return value;
}

function readDateArgument(name: string, fallback: Date): Date {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  const date = value === undefined ? fallback : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return date;
}
