import { describe, expect, test } from 'vitest';

import {
  CompletionAssistanceValidationError,
  parseCompletionCommand,
  parseCompletionPolicy,
  type CompletionCandidate,
  type CompletionPolicy
} from '../src/modules/driver/completion-assistance.contract.js';

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

describe('completion assistance wire v1', () => {
  test('parses policy only when every threshold and relationship is explicit', () => {
    expect(parseCompletionPolicy(policy)).toEqual(policy);
    expect(parseCompletionPolicy({ ...policy, extra: true })).toBeNull();
    expect(parseCompletionPolicy({ ...policy, maxAccuracyMeters: 40 })).toBeNull();
    expect(parseCompletionPolicy({ ...policy, maxGapMs: 60_001 })).toBeNull();
    expect(parseCompletionPolicy({ ...policy, minDwellSamples: 2 })).toBeNull();
  });

  test('parses opaque identifiers while enforcing canonical assignment and UUID route version', () => {
    const command = parseCompletionCommand({
      contractVersion: 1,
      command: {
        assignmentGeneration: '9223372036854775807',
        candidateId: 'candidate:opaque/value',
        commandId: 'command:opaque/value',
        deliveryStopId: 'stop:opaque/value',
        expectedRevision: 0,
        expectedRouteVersionId: '22222222-2222-4222-8222-222222222222',
        kind: 'response',
        occurredAt: '2026-09-17T12:00:00.000Z',
        response: 'completed',
        routePlanId: 'route:opaque/value',
        runId: 'run:opaque/value'
      }
    });
    expect(command).toMatchObject({ kind: 'response', assignmentGeneration: '9223372036854775807' });
  });

  test.each([
    ['noncanonical generation', { assignmentGeneration: '01' }],
    ['generation overflow', { assignmentGeneration: '9223372036854775808' }],
    ['invalid route version', { expectedRouteVersionId: 'route-version' }],
    ['self predecessor', { previousResponseCommandId: 'command-1' }]
  ])('rejects malformed response wire: %s', (_name, override) => {
    const command = responseCommand();
    expect(() => parseCompletionCommand({ contractVersion: 1, command: { ...command, ...override } }))
      .toThrow(CompletionAssistanceValidationError);
  });

  test('parses a candidate command and rejects excess or noncanonical evidence', () => {
    const candidate = candidateFixture();
    expect(parseCompletionCommand({
      command: { candidate, commandId: 'candidate-command', kind: 'candidate', occurredAt: candidate.exitAt },
      contractVersion: 1
    })).toMatchObject({ kind: 'candidate', candidate });

    const tooMuchEvidence = Array.from({ length: 65 }, (_, index) => ({
      accuracyMeters: 5,
      latitude: 43,
      longitude: -80,
      occurredAt: new Date(Date.parse('2026-09-17T12:00:00.000Z') + index * 1_000).toISOString()
    }));
    expect(() => parseCompletionCommand({
      command: {
        candidate: { ...candidate, evidence: tooMuchEvidence, exitAt: tooMuchEvidence.at(-1)!.occurredAt },
        commandId: 'candidate-command',
        kind: 'candidate',
        occurredAt: tooMuchEvidence.at(-1)!.occurredAt
      },
      contractVersion: 1
    })).toThrow(CompletionAssistanceValidationError);
    expect(() => parseCompletionCommand({
      command: { ...responseCommand(), unexpected: true }, contractVersion: 1
    })).toThrow(CompletionAssistanceValidationError);
  });
});

function responseCommand(): Record<string, unknown> {
  return {
    assignmentGeneration: '1',
    candidateId: 'candidate-1',
    commandId: 'command-1',
    deliveryStopId: 'stop-1',
    expectedRevision: 0,
    expectedRouteVersionId: '22222222-2222-4222-8222-222222222222',
    kind: 'response',
    occurredAt: '2026-09-17T12:00:00.000Z',
    response: 'completed',
    routePlanId: 'route-1',
    runId: 'run-1'
  };
}

function candidateFixture(): CompletionCandidate {
  return {
    arrivalAt: '2026-09-17T12:00:30.000Z',
    assignmentGeneration: '1',
    candidateId: 'candidate-1',
    deliveryStopId: 'stop-1',
    dwellCompletedAt: '2026-09-17T12:01:30.000Z',
    evidence: [
      { accuracyMeters: 5, latitude: 43.002, longitude: -80, occurredAt: '2026-09-17T12:00:00.000Z' },
      { accuracyMeters: 5, latitude: 43, longitude: -80, occurredAt: '2026-09-17T12:00:30.000Z' },
      { accuracyMeters: 5, latitude: 43, longitude: -80, occurredAt: '2026-09-17T12:01:00.000Z' },
      { accuracyMeters: 5, latitude: 43, longitude: -80, occurredAt: '2026-09-17T12:01:30.000Z' },
      { accuracyMeters: 5, latitude: 43.002, longitude: -80, occurredAt: '2026-09-17T12:02:00.000Z' }
    ],
    exitAt: '2026-09-17T12:02:00.000Z',
    expectedRouteVersionId: '22222222-2222-4222-8222-222222222222',
    policyVersion: 'policy-1',
    revision: 0,
    routePlanId: 'route-1',
    runId: 'run-1',
    status: 'awaiting_response'
  };
}
