import type { TollPolicy } from './delivery-options.js';

/** Missing policy preserves routes created before toll avoidance was introduced. */
export type RouteTollPolicy = TollPolicy;

export function avoidsTolls(policy: RouteTollPolicy | undefined): boolean {
  return policy === 'AVOID_TOLLS';
}

export function tollExclusionQuery(policy: RouteTollPolicy | undefined): string {
  return avoidsTolls(policy) ? '&exclude=toll' : '';
}
