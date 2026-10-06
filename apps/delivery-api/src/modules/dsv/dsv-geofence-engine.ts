import type { DsvGeofencePolicy } from './dsv-geofence-policy.js';

export type DsvGeofenceTargetState = {
  phase: 'OUTSIDE' | 'ENTERING' | 'INSIDE' | 'EXITING';
  candidateStartedAt: string | null;
  candidateSampleCount: number;
  firstOutsideAt: string | null;
  lastObservationAt: string | null;
  lastSampleId: string | null;
  visitOrdinal: number;
};

export type DsvGeofenceTransition = {
  state: DsvGeofenceTargetState;
  transition: 'NONE' | 'ARRIVED' | 'DEPARTED';
};

export type DsvGeofenceObservation = {
  sampleId: string;
  observedAt: Date;
  latitude: number;
  longitude: number;
};

export type DsvGeofenceTarget = {
  latitude: number;
  longitude: number;
  entryRadiusMeters: number;
  exitRadiusMeters: number;
};

export function emptyDsvGeofenceState(): DsvGeofenceTargetState {
  return {
    candidateSampleCount: 0,
    candidateStartedAt: null,
    firstOutsideAt: null,
    lastObservationAt: null,
    lastSampleId: null,
    phase: 'OUTSIDE',
    visitOrdinal: 0,
  };
}

export function advanceDsvGeofence(
  previous: DsvGeofenceTargetState,
  observation: DsvGeofenceObservation,
  target: DsvGeofenceTarget,
  policy: DsvGeofencePolicy,
): DsvGeofenceTransition {
  const previousAt = parseInstant(previous.lastObservationAt);
  if (previousAt !== null && observation.observedAt.getTime() <= previousAt.getTime()) {
    return { state: previous, transition: 'NONE' };
  }

  const hasGap = previousAt !== null
    && observation.observedAt.getTime() - previousAt.getTime() > policy.maxGapSeconds * 1000;
  const distanceMeters = haversineMeters(observation, target);
  const insideEntry = distanceMeters <= target.entryRadiusMeters;
  const outsideExit = distanceMeters > target.exitRadiusMeters;
  let state = hasGap ? resetCandidate(previous) : { ...previous };
  const observedAt = observation.observedAt.toISOString();
  let transition: DsvGeofenceTransition['transition'] = 'NONE';

  if (state.phase === 'OUTSIDE') {
    if (insideEntry) {
      state = startCandidate(state, 'ENTERING', observedAt);
      if (meetsConfirmation(state, observation.observedAt, policy.arrivalMinSamples, policy.arrivalDwellSeconds)) {
        state = confirmInside(state);
        transition = 'ARRIVED';
      }
    }
  } else if (state.phase === 'ENTERING') {
    if (!insideEntry) {
      state = resetOutside(state);
    } else {
      state.candidateSampleCount += 1;
      if (meetsConfirmation(state, observation.observedAt, policy.arrivalMinSamples, policy.arrivalDwellSeconds)) {
        state = confirmInside(state);
        transition = 'ARRIVED';
      }
    }
  } else if (state.phase === 'INSIDE') {
    if (outsideExit) state = startCandidate(state, 'EXITING', observedAt);
  } else if (!outsideExit) {
    state = resetInside(state);
  } else {
    state.candidateSampleCount += 1;
    if (meetsConfirmation(state, observation.observedAt, policy.exitMinSamples, policy.exitDwellSeconds)) {
      state = resetOutside(state);
      state.firstOutsideAt = previous.firstOutsideAt ?? previous.candidateStartedAt ?? observedAt;
      transition = 'DEPARTED';
    }
  }

  state.lastObservationAt = observedAt;
  state.lastSampleId = observation.sampleId;
  return { state, transition };
}

export function haversineMeters(
  first: Pick<DsvGeofenceObservation, 'latitude' | 'longitude'>,
  second: Pick<DsvGeofenceTarget, 'latitude' | 'longitude'>,
): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (second.latitude - first.latitude) * radians;
  const longitudeDelta = (second.longitude - first.longitude) * radians;
  const firstLatitude = first.latitude * radians;
  const secondLatitude = second.latitude * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function missingStartDueAt(departureConfirmedAt: Date): Date {
  return new Date(departureConfirmedAt.getTime() + 300_000);
}

export function nextMissingStartReminderAt(createdAt: Date, policy: DsvGeofencePolicy): Date {
  return new Date(createdAt.getTime() + policy.reminderIntervalSeconds * 1000);
}

export function resolveDsvExecutionAttribution<T extends { id: string }>(
  candidates: T[],
  selectedExecutionContextId: string | null,
): T | null {
  if (candidates.length === 1) return candidates[0] ?? null;
  if (candidates.length === 0 || selectedExecutionContextId === null) return null;
  return candidates.find((candidate) => candidate.id === selectedExecutionContextId) ?? null;
}

export function dsvGeofenceTransitionEvidence(
  previous: DsvGeofenceTargetState,
  observation: Pick<DsvGeofenceObservation, 'observedAt'>,
): { confirmedObservedAt: Date; firstObservedAt: Date } {
  const value = previous.firstOutsideAt ?? previous.candidateStartedAt;
  if (value === null) return { confirmedObservedAt: observation.observedAt, firstObservedAt: observation.observedAt };
  const parsed = new Date(value);
  return {
    confirmedObservedAt: observation.observedAt,
    firstObservedAt: Number.isNaN(parsed.getTime()) ? observation.observedAt : parsed,
  };
}

function meetsConfirmation(
  state: DsvGeofenceTargetState,
  observedAt: Date,
  minimumSamples: number,
  dwellSeconds: number,
): boolean {
  const startedAt = parseInstant(state.candidateStartedAt);
  return startedAt !== null
    && state.candidateSampleCount >= minimumSamples
    && observedAt.getTime() - startedAt.getTime() >= dwellSeconds * 1000;
}

function startCandidate(
  state: DsvGeofenceTargetState,
  phase: 'ENTERING' | 'EXITING',
  observedAt: string,
): DsvGeofenceTargetState {
  return {
    ...state,
    candidateSampleCount: 1,
    candidateStartedAt: observedAt,
    firstOutsideAt: phase === 'EXITING' ? observedAt : null,
    phase,
  };
}

function confirmInside(state: DsvGeofenceTargetState): DsvGeofenceTargetState {
  return {
    ...state,
    candidateSampleCount: 0,
    candidateStartedAt: null,
    firstOutsideAt: null,
    phase: 'INSIDE',
    visitOrdinal: state.visitOrdinal + 1,
  };
}

function resetCandidate(state: DsvGeofenceTargetState): DsvGeofenceTargetState {
  return state.phase === 'ENTERING' ? resetOutside(state) : state.phase === 'EXITING' ? resetInside(state) : state;
}

function resetOutside(state: DsvGeofenceTargetState): DsvGeofenceTargetState {
  return { ...state, candidateSampleCount: 0, candidateStartedAt: null, firstOutsideAt: null, phase: 'OUTSIDE' };
}

function resetInside(state: DsvGeofenceTargetState): DsvGeofenceTargetState {
  return { ...state, candidateSampleCount: 0, candidateStartedAt: null, firstOutsideAt: null, phase: 'INSIDE' };
}

function parseInstant(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
