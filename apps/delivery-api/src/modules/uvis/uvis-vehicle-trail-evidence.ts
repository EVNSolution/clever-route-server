export const MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND = 55;
export const FROZEN_FIX_MIN_REPEATS = 3;
export const FROZEN_FIX_MIN_JUMP_METERS = 500;
const NO_FIX_SPEED_KPH = 200;

type GpsPoint = {
  latitude: number;
  longitude: number;
};

type TimedGpsPoint = GpsPoint & { observedAt: string | Date };

type FrozenFixCandidate = GpsPoint & {
  ignitionOn?: boolean | null | undefined;
  observedAt: string;
  speedKph?: number | null | undefined;
  staleAfter: string;
};

/** What the folded run looked like; the folded sample keeps the first fix and carries this. */
export type FrozenFixGap = {
  /** Every repeat arrived while the previous one was still fresh: the unit kept reporting through the loss. */
  continuous: boolean;
  lastObservedAt: string;
  lastStaleAfter: string;
  /** Repeats after the first fix that carried the no-fix speed (>= 200 km/h). Supporting evidence only. */
  noFixRepeats: number;
  repeats: number;
};

/**
 * A unit that loses GPS repeats its last coordinate, then jumps once the fix returns. That whole stretch is
 * one GPS gap from the first repeated fix to the recovery, not a 60-second jump. Folds each run of 3+ exact
 * repeats (ignition on throughout, next fix >= 500 m away) into its first fix, marked with `frozenGap`.
 * Input is not mutated and the stored rows are untouched; running it on its own output changes nothing.
 */
export function foldFrozenFixRuns<T extends FrozenFixCandidate>(
  samples: readonly T[],
): Array<T & { frozenGap?: FrozenFixGap }> {
  const folded: Array<T & { frozenGap?: FrozenFixGap }> = [];
  let start = 0;
  while (start < samples.length) {
    const first = samples[start]!;
    let end = start + 1;
    while (
      end < samples.length
      && samples[end]!.latitude === first.latitude
      && samples[end]!.longitude === first.longitude
    ) end += 1;
    const run = samples.slice(start, end);
    const next = samples[end];
    if (
      run.length >= FROZEN_FIX_MIN_REPEATS
      && next !== undefined
      && run.every((sample) => sample.ignitionOn === true)
      && distanceMeters(first, next) >= FROZEN_FIX_MIN_JUMP_METERS
    ) {
      const last = run.at(-1)!;
      const repeats = run.slice(1);
      folded.push({
        ...first,
        frozenGap: {
          continuous: repeats.every((sample, index) => isFreshSuccessor(run[index]!, sample)),
          lastObservedAt: last.observedAt,
          lastStaleAfter: last.staleAfter,
          noFixRepeats: repeats.filter((sample) => (sample.speedKph ?? 0) >= NO_FIX_SPEED_KPH).length,
          repeats: run.length,
        },
      });
    } else {
      folded.push(...run);
    }
    start = end;
  }
  return folded;
}

// The collector defines freshness: staleAfter is recordedAt + 2 polls, so one missed poll is still fresh.
// A fixed cap tighter than that broke the Seobu underground pass on 2026-10-12 after a single missed poll.
export function isFreshSuccessor(
  before: { observedAt: string; staleAfter: string },
  after: { observedAt: string },
): boolean {
  const afterMs = Date.parse(after.observedAt);
  const staleAfterMs = Date.parse(before.staleAfter);
  return afterMs - Date.parse(before.observedAt) >= 30_000
    && Number.isFinite(staleAfterMs)
    && staleAfterMs >= afterMs;
}

export function distanceMeters(left: GpsPoint, right: GpsPoint): number {
  const earthRadiusMeters = 6_371_000;
  const leftLat = degreesToRadians(left.latitude);
  const rightLat = degreesToRadians(right.latitude);
  const deltaLat = degreesToRadians(right.latitude - left.latitude);
  const deltaLng = degreesToRadians(right.longitude - left.longitude);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function impliedSpeedMetersPerSecond(
  previous: TimedGpsPoint,
  current: TimedGpsPoint,
): number {
  const elapsedSeconds = (observedAtMs(current) - observedAtMs(previous)) / 1000;
  return elapsedSeconds > 0 ? distanceMeters(previous, current) / elapsedSeconds : Number.POSITIVE_INFINITY;
}

export function hasImplausibleGpsJump(
  previous: TimedGpsPoint,
  current: TimedGpsPoint,
): boolean {
  return impliedSpeedMetersPerSecond(previous, current) > MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND;
}

function observedAtMs(point: TimedGpsPoint): number {
  return point.observedAt instanceof Date ? point.observedAt.getTime() : Date.parse(point.observedAt);
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}
