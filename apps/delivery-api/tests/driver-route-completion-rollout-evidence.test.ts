import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { consecutiveCleanReviewedDays, meetsRecoveryThreshold } from '../src/modules/driver/driver-route-completion-rollout-evidence.js';

const now = new Date('2026-08-25T12:00:00.000Z');

describe('route completion rollout review continuity', () => {
  test('does not count a zero-sample day as clean evidence', () => {
    expect(consecutiveCleanReviewedDays([
      day('2026-08-24', { sample: 0 }), day('2026-08-23'), day('2026-08-22')
    ], now)).toBe(0);
  });

  test('stops continuity on an unreviewed or false-positive sample', () => {
    expect(consecutiveCleanReviewedDays([
      day('2026-08-24'), day('2026-08-23', { unreviewed: 1 }), day('2026-08-22')
    ], now)).toBe(1);
    expect(consecutiveCleanReviewedDays([
      day('2026-08-24'), day('2026-08-23', { falsePositive: 1 })
    ], now)).toBe(1);
  });

  test('counts consecutive sampled days when every would-reject is reviewed and correct', () => {
    expect(consecutiveCleanReviewedDays([
      day('2026-08-24'), day('2026-08-23'), day('2026-08-22')
    ], now)).toBe(3);
  });

  test('uses the raw recovery fraction at the 99.5 percent gate', () => {
    expect(meetsRecoveryThreshold(199, 200)).toBe(true);
    expect(meetsRecoveryThreshold(198, 199)).toBe(false);
  });

  test('gates on every retained false positive and outstanding review, not only the seven-day sample window', () => {
    const report = readFileSync(join(process.cwd(), 'src/scripts/report-driver-route-completion-invariant.ts'), 'utf8');
    expect(report).toContain('history."retainedUntil" > ${now}');
    expect(report).toContain('outstanding."retainedUntil" > ${now}');
    expect(report).not.toContain('history."createdAt" >= ${since} AND history.outcome');
  });
});

function day(date: string, input: { falsePositive?: number; sample?: number; unreviewed?: number } = {}) {
  return {
    day: new Date(`${date}T00:00:00.000Z`), false_positive_count: BigInt(input.falsePositive ?? 0),
    sample_count: BigInt(input.sample ?? 2), unreviewed_count: BigInt(input.unreviewed ?? 0), would_reject_count: 1n
  };
}
