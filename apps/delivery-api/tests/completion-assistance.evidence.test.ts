import { describe, expect, test } from 'vitest';

import type {
  CompletionCandidate,
  CompletionPolicy,
  CompletionSample,
  CompletionStop
} from '../src/modules/driver/completion-assistance.contract.js';
import { validateVisitEvidence } from '../src/modules/driver/completion-assistance.evidence.js';

const policy: CompletionPolicy = {
  ambiguityRadiusMeters: 75,
  dwellMs: 60_000,
  enterRadiusMeters: 40,
  exitRadiusMeters: 80,
  maxAccuracyMeters: 10,
  maxGapMs: 30_000,
  minDwellSamples: 3,
  version: 'policy-1'
};
const now = new Date('2026-09-17T12:10:00.000Z');

describe('completion assistance visit evidence', () => {
  test('accepts gradual departure after completed dwell but never extends an earlier verified exit', () => {
    const candidate = candidateFixture();
    candidate.evidence.splice(4, 0, sample('2026-09-17T12:01:45.000Z', 43.0006));
    expect(validateVisitEvidence(candidate, policy, stops(), candidate.evidence, now)).toEqual({ verifiedExitAt: new Date(candidate.exitAt) });
    candidate.evidence[4] = sample('2026-09-17T12:01:45.000Z', 43.002);
    expect(validateVisitEvidence(candidate, policy, stops(), candidate.evidence, now)).toEqual({ holdReason: 'earlier_exit_observed' });
  });

  test('verifies server-corroborated approach, continuous dwell, and exit', () => {
    const candidate = candidateFixture();
    expect(validateVisitEvidence(candidate, policy, stops(), candidate.evidence, now)).toEqual({
      verifiedExitAt: new Date(candidate.exitAt)
    });
  });

  test.each([
    ['one point', (candidate: CompletionCandidate) => ({ ...candidate, evidence: [candidate.evidence[0]!] }), 'insufficient_evidence'],
    ['gap', (candidate: CompletionCandidate) => retime(candidate, 3, '2026-09-17T12:01:31.000Z'), 'sample_gap_exceeded'],
    ['low accuracy', (candidate: CompletionCandidate) => alter(candidate, 2, { accuracyMeters: 11 }), 'accuracy_too_low'],
    ['future sample', (candidate: CompletionCandidate) => retime(candidate, 4, '2026-09-17T12:11:00.000Z'), 'invalid_sample_time'],
    ['declared temporal drift', (candidate: CompletionCandidate) => ({ ...candidate, arrivalAt: candidate.evidence[2]!.occurredAt }), 'arrival_not_verified']
  ])('holds %s evidence', (_name, change, reason) => {
    const candidate = change(candidateFixture());
    expect(validateVisitEvidence(candidate, policy, stops(), candidate.evidence, now)).toEqual({ holdReason: reason });
  });

  test('corroborates coordinates at persisted Decimal(10,7) precision without rewriting raw evidence', () => {
    const candidate = candidateFixture();
    const rawLatitude = 43.000000049;
    candidate.evidence[1] = { ...candidate.evidence[1]!, latitude: rawLatitude };
    const serverSamples = candidate.evidence.map((sample) => ({ ...sample, latitude: Number(sample.latitude.toFixed(7)) }));
    expect(validateVisitEvidence(candidate, policy, stops(), serverSamples, now)).toEqual({
      verifiedExitAt: new Date(candidate.exitAt)
    });
    expect(candidate.evidence[1].latitude).toBe(rawLatitude);
  });

  test('holds when even one client evidence sample lacks immutable server corroboration', () => {
    const candidate = candidateFixture();
    expect(validateVisitEvidence(candidate, policy, stops(), candidate.evidence.slice(0, -1), now)).toEqual({
      holdReason: 'server_evidence_sequence_mismatch'
    });
  });

  test.each([
    ['low accuracy', { accuracyMeters: 99, latitude: 43 }],
    ['outside dwell', { accuracyMeters: 5, latitude: 43.002 }],
    ['same-building ambiguity', { accuracyMeters: 10, latitude: 43.0001 }]
  ])('holds an omitted intervening server %s sample', (_name, intervening) => {
    const candidate = candidateFixture();
    const serverSamples = [
      ...candidate.evidence,
      { ...intervening, longitude: -80, occurredAt: '2026-09-17T12:00:45.000Z' }
    ];
    expect(validateVisitEvidence(candidate, policy, stops(), serverSamples, now)).toEqual({
      holdReason: 'server_evidence_sequence_mismatch'
    });
  });

  test('includes terminal neighboring stops in same-building ambiguity', () => {
    const candidate = candidateFixture();
    const assignedStops = stops();
    assignedStops.push({
      coordinates: { latitude: 43.0001, longitude: -80 },
      deliveryStopId: 'terminal-neighbor',
      status: 'DELIVERED'
    });
    expect(validateVisitEvidence(candidate, policy, assignedStops, candidate.evidence, now)).toEqual({
      holdReason: 'ambiguous_stop'
    });
  });

  test('holds uncertain boundary readings instead of treating them as inside or outside', () => {
    const candidate = alter(candidateFixture(), 1, { accuracyMeters: 10, latitude: 43.0004 });
    expect(validateVisitEvidence(candidate, policy, stops(), candidate.evidence, now)).toEqual({
      holdReason: 'arrival_not_verified'
    });
  });
});

function candidateFixture(): CompletionCandidate {
  const evidence: CompletionSample[] = [
    sample('2026-09-17T12:00:00.000Z', 43.002),
    sample('2026-09-17T12:00:30.000Z', 43),
    sample('2026-09-17T12:01:00.000Z', 43),
    sample('2026-09-17T12:01:30.000Z', 43),
    sample('2026-09-17T12:02:00.000Z', 43.002)
  ];
  return {
    arrivalAt: evidence[1]!.occurredAt,
    assignmentGeneration: '1',
    candidateId: 'candidate-1',
    deliveryStopId: 'stop-1',
    dwellCompletedAt: evidence[3]!.occurredAt,
    evidence,
    exitAt: evidence[4]!.occurredAt,
    expectedRouteVersionId: '22222222-2222-4222-8222-222222222222',
    policyVersion: policy.version,
    revision: 0,
    routePlanId: 'route-1',
    runId: 'run-1',
    status: 'awaiting_response'
  };
}

function sample(occurredAt: string, latitude: number): CompletionSample {
  return { accuracyMeters: 5, latitude, longitude: -80, occurredAt };
}

function stops(): CompletionStop[] {
  return [{ coordinates: { latitude: 43, longitude: -80 }, deliveryStopId: 'stop-1', status: 'PENDING' }];
}

function alter(
  candidate: CompletionCandidate,
  index: number,
  change: Partial<CompletionSample>
): CompletionCandidate {
  return {
    ...candidate,
    evidence: candidate.evidence.map((item, itemIndex) => itemIndex === index ? { ...item, ...change } : item)
  };
}

function retime(candidate: CompletionCandidate, index: number, occurredAt: string): CompletionCandidate {
  const changed = alter(candidate, index, { occurredAt });
  return index === changed.evidence.length - 1 ? { ...changed, exitAt: occurredAt } : changed;
}
