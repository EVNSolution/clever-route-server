import { describe, expect, it } from 'vitest';

import {
  advanceDsvGeofence,
  dsvGeofenceTransitionEvidence,
  emptyDsvGeofenceState,
  missingStartDueAt,
  nextMissingStartReminderAt,
  resolveDsvExecutionAttribution,
  type DsvGeofenceObservation,
  type DsvGeofenceTargetState,
} from '../src/modules/dsv/dsv-geofence-engine.js';
import { parseDsvGeofencePolicy, type DsvGeofencePolicy } from '../src/modules/dsv/dsv-geofence-policy.js';

const target = { entryRadiusMeters: 100, exitRadiusMeters: 140, latitude: 37.5, longitude: 127 };
const policy: DsvGeofencePolicy = {
  arrivalDwellSeconds: 60,
  arrivalMinSamples: 2,
  destinationExitRadiusMeters: 120,
  destinationRadiusMeters: 80,
  exitDwellSeconds: 120,
  exitMinSamples: 2,
  futureToleranceSeconds: 5,
  maxGapSeconds: 180,
  maxObservationDelaySeconds: 300,
  maxReminderCount: null,
  maxSpeedKph: 140,
  mode: 'SHADOW',
  notificationTtlSeconds: 3_600,
  policyVersion: 'synthetic-v1',
  reminderIntervalSeconds: 300,
  warehouseExitRadiusMeters: 140,
  warehouseRadiusMeters: 100,
};

describe('DSV geofence transition engine', () => {
  it('G01/G17 confirms arrival and uses the exit-completing observation as T', () => {
    let state = emptyDsvGeofenceState();
    ({ state } = step(state, 'inside-1', '2026-10-06T22:00:00.000Z', 37.5, 127));
    const arrival = step(state, 'inside-2', '2026-10-06T22:01:00.000Z', 37.5, 127);
    expect(arrival.transition).toBe('ARRIVED');
    state = arrival.state;

    ({ state } = step(state, 'outside-1', '2026-10-06T22:30:00.000Z', 37.503, 127));
    const beforeConfirmation = state;
    const departure = step(state, 'outside-2', '2026-10-06T22:32:00.000Z', 37.503, 127);
    expect(departure.transition).toBe('DEPARTED');
    expect(departure.state.lastObservationAt).toBe('2026-10-06T22:32:00.000Z');
    expect(missingStartDueAt(new Date(departure.state.lastObservationAt as string)).toISOString())
      .toBe('2026-10-06T22:37:00.000Z');
    expect(dsvGeofenceTransitionEvidence(beforeConfirmation, { observedAt: new Date('2026-10-06T22:32:00.000Z') }))
      .toEqual({
        confirmedObservedAt: new Date('2026-10-06T22:32:00.000Z'),
        firstObservedAt: new Date('2026-10-06T22:30:00.000Z'),
      });
  });

  it('R2 confirms a one-sample zero-dwell departure on the first valid outer observation', () => {
    const previous = confirmedInsideState();
    const observation = {
      latitude: 37.503,
      longitude: 127,
      observedAt: new Date('2026-10-06T22:30:00.000Z'),
      sampleId: 'single-outside',
    };
    const departure = advanceDsvGeofence(previous, observation, target, {
      ...policy,
      exitDwellSeconds: 0,
      exitMinSamples: 1,
    });

    expect(departure).toMatchObject({
      state: { firstOutsideAt: '2026-10-06T22:30:00.000Z', phase: 'OUTSIDE' },
      transition: 'DEPARTED',
    });
    expect(dsvGeofenceTransitionEvidence(previous, observation)).toEqual({
      confirmedObservedAt: observation.observedAt,
      firstObservedAt: observation.observedAt,
    });
  });

  it('G02/G03 preserves confirmed presence through the neutral band and confirms only an outer-radius exit', () => {
    let state = emptyDsvGeofenceState();
    ({ state } = step(state, 'pass-inside', '2026-10-06T22:00:00.000Z', 37.5, 127));
    const passOutside = step(state, 'pass-outside', '2026-10-06T22:00:30.000Z', 37.503, 127);
    expect(passOutside.transition).toBe('NONE');
    expect(passOutside.state.phase).toBe('OUTSIDE');

    state = confirmedInsideState();
    ({ state } = step(state, 'outer-jitter', '2026-10-06T22:02:00.000Z', 37.503, 127));
    const neutralReset = step(state, 'neutral-reset', '2026-10-06T22:02:30.000Z', 37.501, 127);
    expect(neutralReset.state).toMatchObject({ candidateSampleCount: 0, phase: 'INSIDE' });
    const neutralAfterDwell = step(neutralReset.state, 'neutral-after-dwell', '2026-10-06T22:04:30.000Z', 37.501, 127);
    expect(neutralAfterDwell.transition).toBe('NONE');
    expect(neutralAfterDwell.state).toMatchObject({ candidateSampleCount: 0, phase: 'INSIDE' });

    state = step(neutralAfterDwell.state, 'outer-1', '2026-10-06T22:05:00.000Z', 37.503, 127).state;
    const confirmedExit = step(state, 'outer-2', '2026-10-06T22:07:00.000Z', 37.503, 127);
    expect(confirmedExit.transition).toBe('DEPARTED');
    expect(confirmedExit.state.phase).toBe('OUTSIDE');
  });

  it('G06/G07 ignores duplicate and out-of-order observations', () => {
    const initial = step(emptyDsvGeofenceState(), 'first', '2026-10-06T22:00:00.000Z', 37.5, 127).state;
    expect(step(initial, 'duplicate-time', '2026-10-06T22:00:00.000Z', 37.5, 127).state).toEqual(initial);
    expect(step(initial, 'late', '2026-10-06T21:59:00.000Z', 37.5, 127).state).toEqual(initial);
  });

  it('G11 resets incomplete dwell evidence after a GPS gap', () => {
    const state = step(emptyDsvGeofenceState(), 'before-gap', '2026-10-06T22:00:00.000Z', 37.5, 127).state;
    const afterGap = step(state, 'after-gap', '2026-10-06T22:04:00.000Z', 37.5, 127);
    expect(afterGap.transition).toBe('NONE');
    expect(afterGap.state.candidateSampleCount).toBe(1);
    expect(afterGap.state.candidateStartedAt).toBe('2026-10-06T22:04:00.000Z');
  });

  it('D01/D09 increments the visit ordinal only for confirmed re-entry', () => {
    let state = confirmedInsideState();
    ({ state } = step(state, 'exit-1', '2026-10-06T22:30:00.000Z', 37.503, 127));
    ({ state } = step(state, 'exit-2', '2026-10-06T22:32:00.000Z', 37.503, 127));
    ({ state } = step(state, 'return-1', '2026-10-06T22:40:00.000Z', 37.5, 127));
    const returned = step(state, 'return-2', '2026-10-06T22:41:00.000Z', 37.5, 127);
    expect(returned.transition).toBe('ARRIVED');
    expect(returned.state.visitOrdinal).toBe(2);
  });
});

describe('DSV missing-start schedule and attribution', () => {
  it('T02-T04 schedules the first and later logical reminders at least 300 seconds apart', () => {
    const departure = new Date('2026-10-06T22:30:00.000Z');
    const firstDue = missingStartDueAt(departure);
    expect(firstDue.toISOString()).toBe('2026-10-06T22:35:00.000Z');
    expect(nextMissingStartReminderAt(new Date('2026-10-06T22:37:10.000Z'), policy).toISOString())
      .toBe('2026-10-06T22:42:10.000Z');
  });

  it('T07 rejects a LIVE policy without an injected reminder cap', () => {
    expect(parseDsvGeofencePolicy({ ...policy, mode: 'LIVE', maxReminderCount: undefined })).toBeNull();
    expect(parseDsvGeofencePolicy({ ...policy, mode: 'LIVE', maxReminderCount: null }))
      .toMatchObject({ maxReminderCount: null });
  });

  it.each([
    ['missing arrival minimum', { arrivalMinSamples: undefined }],
    ['zero arrival minimum', { arrivalMinSamples: 0 }],
    ['NaN arrival minimum', { arrivalMinSamples: Number.NaN }],
    ['string arrival minimum', { arrivalMinSamples: '2' }],
    ['missing exit minimum', { exitMinSamples: undefined }],
    ['zero exit minimum', { exitMinSamples: 0 }],
    ['NaN exit minimum', { exitMinSamples: Number.NaN }],
    ['string exit minimum', { exitMinSamples: '2' }],
    ['missing warehouse exit radius', { warehouseExitRadiusMeters: undefined }],
    ['equal warehouse exit radius', { warehouseExitRadiusMeters: policy.warehouseRadiusMeters }],
    ['smaller warehouse exit radius', { warehouseExitRadiusMeters: policy.warehouseRadiusMeters - 1 }],
    ['NaN warehouse exit radius', { warehouseExitRadiusMeters: Number.NaN }],
    ['missing destination exit radius', { destinationExitRadiusMeters: undefined }],
    ['equal destination exit radius', { destinationExitRadiusMeters: policy.destinationRadiusMeters }],
    ['smaller destination exit radius', { destinationExitRadiusMeters: policy.destinationRadiusMeters - 1 }],
    ['string destination exit radius', { destinationExitRadiusMeters: '120' }],
  ])('rejects %s instead of accepting an incomplete policy', (_name, invalid) => {
    expect(parseDsvGeofencePolicy({ ...policy, ...invalid })).toBeNull();
  });

  it('C04 requires a valid explicit selection when multiple contexts are eligible', () => {
    const contexts = [{ id: 'morning' }, { id: 'afternoon' }];
    expect(resolveDsvExecutionAttribution(contexts, null)).toBeNull();
    expect(resolveDsvExecutionAttribution(contexts, 'unknown')).toBeNull();
    expect(resolveDsvExecutionAttribution(contexts, 'afternoon')).toEqual({ id: 'afternoon' });
    expect(resolveDsvExecutionAttribution([{ id: 'only' }], null)).toEqual({ id: 'only' });
  });
});

function step(
  state: DsvGeofenceTargetState,
  sampleId: string,
  observedAt: string,
  latitude: number,
  longitude: number,
) {
  const observation: DsvGeofenceObservation = { latitude, longitude, observedAt: new Date(observedAt), sampleId };
  return advanceDsvGeofence(state, observation, target, policy);
}

function confirmedInsideState(): DsvGeofenceTargetState {
  let state = step(emptyDsvGeofenceState(), 'inside-1', '2026-10-06T22:00:00.000Z', 37.5, 127).state;
  state = step(state, 'inside-2', '2026-10-06T22:01:00.000Z', 37.5, 127).state;
  return state;
}
