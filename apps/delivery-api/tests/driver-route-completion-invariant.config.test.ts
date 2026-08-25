import { describe, expect, test } from 'vitest';

import {
  completionInvariantDecision,
  loadDriverRouteCompletionInvariantMode,
  loadDriverRouteCompletionReviewRetentionDays
} from '../src/modules/driver/driver-route-completion-invariant.js';

describe('driver route completion invariant rollout config', () => {
  test('defaults a missing mode to OBSERVE and rejects invalid startup configuration', () => {
    expect(loadDriverRouteCompletionInvariantMode({})).toBe('OBSERVE');
    expect(loadDriverRouteCompletionInvariantMode({ DRIVER_ROUTE_COMPLETION_INVARIANT_MODE: ' guarded ' })).toBe('GUARDED');
    expect(() => loadDriverRouteCompletionInvariantMode({ DRIVER_ROUTE_COMPLETION_INVARIANT_MODE: 'enabled' }))
      .toThrow('DRIVER_ROUTE_COMPLETION_INVARIANT_MODE must be OBSERVE, GUARDED, or FULL');
  });

  test('retains review evidence for at least one year and fails invalid startup configuration', () => {
    expect(loadDriverRouteCompletionReviewRetentionDays({})).toBe(365);
    expect(loadDriverRouteCompletionReviewRetentionDays({ DRIVER_ROUTE_COMPLETION_REVIEW_RETENTION_DAYS: '730' })).toBe(730);
    expect(() => loadDriverRouteCompletionReviewRetentionDays({ DRIVER_ROUTE_COMPLETION_REVIEW_RETENTION_DAYS: '30' }))
      .toThrow('DRIVER_ROUTE_COMPLETION_REVIEW_RETENTION_DAYS must be an integer from 365 to 3650');
  });

  test.each([
    ['OBSERVE', 2, false],
    ['GUARDED', 1, false],
    ['GUARDED', 2, true],
    ['FULL', 1, true],
    ['FULL', 2, true]
  ] as const)('%s contract v%s reject=%s', (mode, driverContractVersion, reject) => {
    expect(completionInvariantDecision({
      driverContractVersion,
      mode,
      unresolvedStopCount: 1
    })).toEqual({ reject, wouldReject: true });
  });

  test('never rejects a complete or zero-stop route', () => {
    expect(completionInvariantDecision({ driverContractVersion: null, mode: 'FULL', unresolvedStopCount: 0 }))
      .toEqual({ reject: false, wouldReject: false });
  });
});
