export type DailyCompletionReviewAggregate = {
  day: Date;
  false_positive_count: bigint;
  sample_count: bigint;
  unreviewed_count: bigint;
  would_reject_count: bigint;
};

export function consecutiveCleanReviewedDays(rows: DailyCompletionReviewAggregate[], reference: Date): number {
  const byDay = new Map(rows.map((row) => [row.day.toISOString().slice(0, 10), row]));
  let count = 0;
  // The current UTC day is partial and can never satisfy a full-day rollout gate.
  for (let offset = 1; offset < 32; offset += 1) {
    const day = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() - offset));
    const row = byDay.get(day.toISOString().slice(0, 10));
    if (row === undefined || row.sample_count === 0n || row.false_positive_count !== 0n || row.unreviewed_count !== 0n) break;
    count += 1;
  }
  return count;
}

export function meetsRecoveryThreshold(resolved: number, cohort: number): boolean {
  return Number.isSafeInteger(resolved)
    && Number.isSafeInteger(cohort)
    && cohort > 0
    && resolved >= 0
    && resolved <= cohort
    && resolved / cohort >= 0.995;
}
