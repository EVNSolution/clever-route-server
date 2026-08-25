import { Prisma, PrismaClient } from '@prisma/client';
import { consecutiveCleanReviewedDays, meetsRecoveryThreshold, type DailyCompletionReviewAggregate } from '../modules/driver/driver-route-completion-rollout-evidence.js';

const prisma = new PrismaClient();
const now = new Date();
const since = readDateArgument('--since', new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
const activeSince = readDateArgument('--active-since', new Date(now.getTime() - 24 * 60 * 60 * 1000));
const sourceSha = readStringArgument('--source-sha');
const currentMode = readMode(process.env.DRIVER_ROUTE_COMPLETION_INVARIANT_MODE);

type ReviewAggregate = { confirmed_correct_count: bigint; false_positive_count: bigint; rejected_count: bigint; total_count: bigint; unreviewed_count: bigint; would_reject_count: bigint };
type AdoptionAggregate = { active_count: bigint; legacy_count: bigint; receipt_aware_count: bigint };
type RecoveryAggregate = { cohort_count: bigint; resolved_within_five_minutes_count: bigint };

try {
  const [[reviews], [adoption], daily, [recovery]] = await Promise.all([
    prisma.$queryRaw<ReviewAggregate[]>(Prisma.sql`
      SELECT COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE "wouldReject") AS would_reject_count,
        COUNT(*) FILTER (WHERE decision = 'REJECTED') AS rejected_count,
        COUNT(*) FILTER (WHERE "reviewOutcome" = 'CONFIRMED_CORRECT') AS confirmed_correct_count,
        (SELECT COUNT(*) FROM driver_route_completion_gate_history history
          WHERE history."createdAt" >= ${since} AND history.outcome = 'FALSE_POSITIVE') AS false_positive_count,
        COUNT(*) FILTER (WHERE "reviewOutcome" IS NULL AND "wouldReject") AS unreviewed_count
      FROM driver_route_completion_reviews WHERE "createdAt" >= ${since}
    `),
    prisma.$queryRaw<AdoptionAggregate[]>(Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON (sessions."driverId", sessions."routePlanId") sessions.*
        FROM driver_sync_sessions sessions
        JOIN route_plans routes ON routes.id = sessions."routePlanId" AND routes."driverId" = sessions."driverId"
        WHERE sessions."lastObservedAt" >= ${activeSince}
          AND sessions."expiresAt" > ${now}
          AND routes.status = 'IN_PROGRESS'
        ORDER BY sessions."driverId", sessions."routePlanId", sessions."lastObservedAt" DESC, sessions.id DESC
      )
      SELECT COUNT(*) AS active_count,
        COUNT(*) FILTER (WHERE "driverContractVersion" >= 2) AS receipt_aware_count,
        COUNT(*) FILTER (WHERE "driverContractVersion" IS NULL OR "driverContractVersion" < 2) AS legacy_count
      FROM latest
    `),
    prisma.$queryRaw<DailyCompletionReviewAggregate[]>(Prisma.sql`
      SELECT days.day,
        COUNT(reviews.id) AS sample_count,
        COUNT(reviews.id) FILTER (WHERE reviews."wouldReject") AS would_reject_count,
        (SELECT COUNT(*) FROM driver_route_completion_gate_history history
          WHERE history."createdAt" >= days.day AND history."createdAt" < days.day + interval '1 day'
            AND history.outcome = 'FALSE_POSITIVE') AS false_positive_count,
        COUNT(reviews.id) FILTER (WHERE reviews."wouldReject" AND reviews."reviewOutcome" IS NULL) AS unreviewed_count
      FROM generate_series(date_trunc('day', ${since}::timestamptz), date_trunc('day', ${now}::timestamptz), interval '1 day') AS days(day)
      LEFT JOIN driver_route_completion_reviews reviews
        ON reviews."createdAt" >= days.day AND reviews."createdAt" < days.day + interval '1 day'
      GROUP BY days.day ORDER BY days.day DESC
    `),
    prisma.$queryRaw<RecoveryAggregate[]>(Prisma.sql`
      WITH cohorts AS (
        SELECT "driverId", "routePlanId", "clientEventId", MIN("receivedAt") AS first_received_at,
          MIN("updatedAt") FILTER (WHERE status IN ('APPLIED', 'DUPLICATE', 'REJECTED')) AS resolved_at
        FROM driver_event_attempts
        WHERE "receivedAt" >= ${since}
          AND "eventType" = 'ROUTE_COMPLETED'
          AND "driverContractVersion" >= 2
          AND "clientEventId" IS NOT NULL
        GROUP BY "driverId", "routePlanId", "clientEventId"
      )
      SELECT COUNT(*) AS cohort_count,
        COUNT(*) FILTER (WHERE resolved_at <= first_received_at + interval '5 minutes') AS resolved_within_five_minutes_count
      FROM cohorts
      WHERE first_received_at < ${new Date(now.getTime() - 5 * 60 * 1000)}
    `)
  ]);
  const active = Number(adoption?.active_count ?? 0n);
  const receiptAware = Number(adoption?.receipt_aware_count ?? 0n);
  const legacyActiveCount = Number(adoption?.legacy_count ?? 0n);
  const recoveryCohortCount = Number(recovery?.cohort_count ?? 0n);
  const recoveryResolvedWithinFiveMinutesCount = Number(recovery?.resolved_within_five_minutes_count ?? 0n);
  const recoveryWithinFiveMinutesPercent = recoveryCohortCount === 0
    ? null
    : Number(((recoveryResolvedWithinFiveMinutesCount / recoveryCohortCount) * 100).toFixed(2));
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
      minimumDailySampleCount: daily.slice(1, 8).reduce((minimum, row) => Math.min(minimum, Number(row.sample_count)), Number.POSITIVE_INFINITY),
      recoveryCohortCount,
      recoveryResolvedWithinFiveMinutesCount,
      recoveryWithinFiveMinutesPercent,
      unreviewedWouldRejectCount: Number(reviews?.unreviewed_count ?? 0n)
    },
    generatedAt: now.toISOString(),
    legacyRetirementVerified: legacyActiveCount === 0,
    recoveryVerified: meetsRecoveryThreshold(recoveryResolvedWithinFiveMinutesCount, recoveryCohortCount),
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
