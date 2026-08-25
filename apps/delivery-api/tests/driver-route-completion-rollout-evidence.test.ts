import { describe, expect, test } from 'vitest';
import { consecutiveCleanReviewedDays } from '../src/modules/driver/driver-route-completion-rollout-evidence.js';

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
});

function day(date: string, input: { falsePositive?: number; sample?: number; unreviewed?: number } = {}) {
  return {
    day: new Date(`${date}T00:00:00.000Z`), false_positive_count: BigInt(input.falsePositive ?? 0),
    sample_count: BigInt(input.sample ?? 2), unreviewed_count: BigInt(input.unreviewed ?? 0), would_reject_count: 1n
  };
}
