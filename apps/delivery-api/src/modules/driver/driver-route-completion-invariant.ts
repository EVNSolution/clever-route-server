export const DRIVER_ROUTE_COMPLETION_INVARIANT_MODES = ['OBSERVE', 'GUARDED', 'FULL'] as const;
export const DRIVER_ROUTE_COMPLETION_INVARIANT_CAPABILITY_VERSION = 1;

export type DriverRouteCompletionInvariantMode = typeof DRIVER_ROUTE_COMPLETION_INVARIANT_MODES[number];
export const DEFAULT_DRIVER_ROUTE_COMPLETION_REVIEW_RETENTION_DAYS = 365;

export function loadDriverRouteCompletionReviewRetentionDays(
  env: Partial<Record<'DRIVER_ROUTE_COMPLETION_REVIEW_RETENTION_DAYS', string | undefined>>
): number {
  const raw = env.DRIVER_ROUTE_COMPLETION_REVIEW_RETENTION_DAYS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_DRIVER_ROUTE_COMPLETION_REVIEW_RETENTION_DAYS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 365 || value > 3650) {
    throw new Error('DRIVER_ROUTE_COMPLETION_REVIEW_RETENTION_DAYS must be an integer from 365 to 3650');
  }
  return value;
}

export type DriverRouteCompletionInvariantEvidence = {
  decision: 'PERMITTED' | 'REJECTED';
  driverContractVersion: number | null;
  mode: DriverRouteCompletionInvariantMode;
  receiptAware: boolean;
  routeVersionId: string;
  terminalStatuses: readonly string[];
  totalStopCount: number;
  unresolvedStopCount: number;
  wouldReject: boolean;
};

export function loadDriverRouteCompletionInvariantMode(
  env: Partial<Record<'DRIVER_ROUTE_COMPLETION_INVARIANT_MODE', string | undefined>>
): DriverRouteCompletionInvariantMode {
  const raw = env.DRIVER_ROUTE_COMPLETION_INVARIANT_MODE?.trim().toUpperCase() ?? 'OBSERVE';
  if (!DRIVER_ROUTE_COMPLETION_INVARIANT_MODES.includes(raw as DriverRouteCompletionInvariantMode)) {
    throw new Error('DRIVER_ROUTE_COMPLETION_INVARIANT_MODE must be OBSERVE, GUARDED, or FULL');
  }
  return raw as DriverRouteCompletionInvariantMode;
}

export function completionInvariantDecision(input: {
  driverContractVersion?: number | null;
  mode: DriverRouteCompletionInvariantMode;
  unresolvedStopCount: number;
}): { reject: boolean; wouldReject: boolean } {
  const wouldReject = input.unresolvedStopCount > 0;
  const reject = wouldReject
    && input.mode !== 'OBSERVE'
    && (input.mode === 'FULL' || input.driverContractVersion === 2);
  return { reject, wouldReject };
}

export class DriverRouteCompletionIncompleteError extends Error {
  readonly code = 'ROUTE_COMPLETION_INCOMPLETE';

  constructor(readonly evidence: DriverRouteCompletionInvariantEvidence) {
    super('Route completion requires every stop to be terminal');
    this.name = 'DriverRouteCompletionIncompleteError';
  }
}
