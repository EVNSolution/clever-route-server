import { describe, expect, test } from 'vitest';

import {
  DRIVER_DIAGNOSTIC_MAX_BATCH_BYTES,
  parseDriverDiagnosticEnvelope,
  parseDriverDiagnosticEnvelopeDetailed,
  parseDriverDiagnosticSnapshot,
  type DriverDiagnosticBlocker,
  type DriverDiagnosticEnvelope,
  type DriverDiagnosticSnapshot
} from '../src/modules/driver/driver-runtime-diagnostics.contract.js';
import {
  deriveDriverRuntimeDiagnostic,
  type DriverRuntimeAttemptEvidence
} from '../src/modules/driver/driver-runtime-diagnostics.projection.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const FRESH = '2026-10-02T11:59:00.000Z';
const BATCH_ID = '10000000-0000-4000-8000-000000000001';
const BOOT_ID = '10000000-0000-4000-8000-000000000002';
const ROUTE_ID = '10000000-0000-4000-8000-000000000003';
const DIAGNOSTIC_ID = '10000000-0000-4000-8000-000000000004';
const REQUEST_ID = '10000000-0000-4000-8000-000000000005';
const CLIENT_EVENT_ID = 'location-updated-test123';

function snapshot(overrides: Partial<DriverDiagnosticSnapshot> = {}): DriverDiagnosticSnapshot {
  return {
    businessQueue: {
      nextRetryAt: null,
      observedAt: FRESH,
      oldestAgeMs: null,
      oldestQueuedAt: null,
      queueDepth: 0,
      retryCount: 0
    },
    lastGpsCallbackAt: FRESH,
    lastGpsCollectedAt: FRESH,
    lastGpsPersistedAt: FRESH,
    lastGpsSendAcknowledgedAt: FRESH,
    lastGpsSendAttemptAt: FRESH,
    lifecycle: 'FOREGROUND',
    locationPermission: 'GRANTED_ALWAYS',
    locationService: 'ENABLED',
    locationTask: 'STARTED',
    locationTaskExpected: true,
    network: 'ONLINE',
    snapshotObservedAt: FRESH,
    stateObservedAt: {
      lifecycle: FRESH,
      locationPermission: FRESH,
      locationService: FRESH,
      locationTask: FRESH,
      network: FRESH
    },
    ...overrides
  };
}

function envelope(overrides: Record<string, unknown> = {}): DriverDiagnosticEnvelope & Record<string, unknown> {
  const context = {
    appVersion: '1.2.3',
    assignmentGeneration: '7',
    deviceInstanceHash: 'a'.repeat(64),
    os: 'ANDROID' as const,
    osVersion: '15',
    routePlanId: ROUTE_ID,
    sessionGeneration: '2026-10-02T11:00:00.000Z',
    versionCode: 123
  };
  return {
    batchId: BATCH_ID,
    bootId: BOOT_ID,
    discardedRecordCount: 0,
    liveContext: context,
    liveSnapshot: snapshot(),
    records: [{
      bootId: BOOT_ID,
      context,
      diagnosticId: DIAGNOSTIC_ID,
      identifiers: { clientEventId: CLIENT_EVENT_ID, requestId: REQUEST_ID },
      kind: 'HEARTBEAT',
      observedAt: FRESH,
      sequence: 1,
      snapshot: snapshot()
    }],
    schemaVersion: 1,
    sentAt: FRESH,
    ...overrides
  };
}

function blocker(overrides: Partial<DriverDiagnosticBlocker> = {}): DriverDiagnosticBlocker {
  return {
    clientEventId: CLIENT_EVENT_ID,
    lastObservedAt: FRESH,
    reason: 'NETWORK_REQUEST_FAILED',
    requestId: REQUEST_ID,
    since: FRESH,
    stage: 'TRANSPORT',
    ...overrides
  };
}

function classify(input: {
  attempts?: DriverRuntimeAttemptEvidence[];
  firstObservedAt?: Date | null;
  lastContactAt?: Date | null;
  snapshot?: DriverDiagnosticSnapshot | null;
}) {
  return deriveDriverRuntimeDiagnostic({
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
    firstObservedAt: input.firstObservedAt === undefined ? new Date(FRESH) : input.firstObservedAt,
    lastContactAt: input.lastContactAt === undefined ? new Date(FRESH) : input.lastContactAt,
    now: NOW,
    snapshot: input.snapshot === undefined ? snapshot() : input.snapshot
  });
}

describe('driver diagnostic contract parser', () => {
  test('keeps only allowlisted fields and never carries secrets, free text, or coordinates', () => {
    const unsafe = envelope({
      authorization: 'Bearer secret',
      latitude: 43.1,
      liveContext: { ...(envelope().liveContext as object), phone: '+1-555-secret' },
      liveSnapshot: {
        ...snapshot(),
        errorMessage: 'customer address and token',
        longitude: -79.1
      },
      records: [{
        ...(envelope().records[0] as object),
        customer: { address: 'secret' },
        token: 'secret'
      }]
    });

    const parsed = parseDriverDiagnosticEnvelope(unsafe);
    expect(parsed).not.toBeNull();
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toMatch(/authorization|Bearer|latitude|longitude|phone|errorMessage|customer|address|token/iu);
  });

  test('rejects an unknown live reason instead of silently projecting healthy', () => {
    expect(parseDriverDiagnosticEnvelope(envelope({
      liveSnapshot: snapshot({
        blockers: [{ ...blocker(), reason: 'FREE_TEXT_FAILURE' as never }]
      })
    }))).toBeNull();
  });

  test('reports malformed historical records by safe diagnostic ID while preserving valid records', () => {
    const validRecord = envelope().records[0]!;
    const detailed = parseDriverDiagnosticEnvelopeDetailed(envelope({
      records: [
        validRecord,
        {
          ...validRecord,
          diagnosticId: '10000000-0000-4000-8000-000000000006',
          snapshot: snapshot({ blockers: [{ ...blocker(), reason: 'arbitrary text' as never }] })
        }
      ]
    }));

    expect(detailed?.envelope.records).toHaveLength(1);
    expect(detailed?.rejectedRecords).toEqual([{
      code: 'INVALID_RECORD',
      diagnosticId: '10000000-0000-4000-8000-000000000006',
      index: 1
    }]);
  });

  test('enforces record count and serialized 64 KiB limits before sanitization', () => {
    expect(parseDriverDiagnosticEnvelope(envelope({ records: Array.from({ length: 51 }, () => envelope().records[0]) })))
      .toBeNull();
    expect(parseDriverDiagnosticEnvelope(envelope({ ignored: 'x'.repeat(DRIVER_DIAGNOSTIC_MAX_BATCH_BYTES) })))
      .toBeNull();
  });

  test('revalidates persisted snapshots and rejects malformed identifiers', () => {
    expect(parseDriverDiagnosticSnapshot(snapshot())).toEqual(snapshot());
    expect(parseDriverDiagnosticSnapshot(snapshot({
      blockers: [{ ...blocker(), clientEventId: 'raw arbitrary failure text' }]
    }))).toBeNull();
  });
});

describe('driver runtime diagnostic projection', () => {
  test.each([
    ['AUTH', 'AUTH_REFRESH_TIMEOUT', 'AUTH_OR_ROUTE_BLOCKED'],
    ['ROUTE', 'SESSION_MISMATCH', 'AUTH_OR_ROUTE_BLOCKED'],
    ['LOCATION', 'LOCATION_TASK_NOT_STARTED', 'GPS_COLLECTION_STOPPED'],
    ['PROCESSING', 'LOCATION_PROCESSING_FAILED', 'GPS_POST_COLLECTION_BLOCKED'],
    ['STORAGE', 'STORAGE_WRITE_FAILED', 'GPS_POST_COLLECTION_BLOCKED'],
    ['STORAGE', 'DIAGNOSTIC_STORAGE_FAILED', 'DIAGNOSTIC_EVIDENCE_DEGRADED']
  ] as const)('classifies fresh %s/%s evidence as %s', (stage, reason, state) => {
    expect(classify({ snapshot: snapshot({ blockers: [blocker({ stage, reason })] }) }).state).toBe(state);
  });

  test('requires an exactly scoped fresh attempt and lets successful evidence dominate older failure', () => {
    const liveBlocker = blocker();
    const attempts: DriverRuntimeAttemptEvidence[] = [
      {
        clientEventId: CLIENT_EVENT_ID,
        errorCode: 'TIMEOUT',
        id: 'attempt-failed',
        receivedAt: new Date('2026-10-02T11:58:30.000Z'),
        requestId: REQUEST_ID,
        status: 'FAILED'
      },
      {
        clientEventId: CLIENT_EVENT_ID,
        clientRequestId: REQUEST_ID,
        errorCode: null,
        id: 'attempt-applied',
        receivedAt: new Date(FRESH),
        requestId: '10000000-0000-4000-8000-000000000099',
        status: 'APPLIED'
      },
      {
        clientEventId: 'location-updated-unrelated',
        errorCode: 'REJECTED',
        id: 'attempt-unrelated',
        receivedAt: new Date(FRESH),
        requestId: REQUEST_ID,
        status: 'REJECTED'
      }
    ];

    const result = classify({ attempts, snapshot: snapshot({ blockers: [liveBlocker] }) });
    expect(result.state).toBe('SERVER_APPLIED_CLIENT_ACK_UNKNOWN');
    expect(result.evidence.attemptIds).toEqual(['attempt-applied']);
  });

  test('does not use the global GPS acknowledgement as business-event ACK evidence', () => {
    const result = classify({
      attempts: [{
        clientEventId: CLIENT_EVENT_ID,
        errorCode: null,
        id: 'attempt-applied',
        receivedAt: new Date(FRESH),
        requestId: REQUEST_ID,
        status: 'DUPLICATE'
      }],
      snapshot: snapshot({
        blockers: [blocker()],
        lastGpsSendAcknowledgedAt: FRESH
      })
    });
    expect(result.state).toBe('SERVER_APPLIED_CLIENT_ACK_UNKNOWN');
  });

  test('keeps durable applied proof and suppresses older failure for the same logical event', () => {
    const result = classify({
      attempts: [
        {
          clientEventId: CLIENT_EVENT_ID,
          errorCode: 'AUTH_FAILED',
          id: 'attempt-failed',
          receivedAt: new Date(FRESH),
          requestId: REQUEST_ID,
          status: 'FAILED'
        },
        {
          clientEventId: CLIENT_EVENT_ID,
          errorCode: null,
          id: 'attempt-applied-old',
          receivedAt: new Date('2026-10-02T10:00:00.000Z'),
          requestId: REQUEST_ID,
          status: 'APPLIED'
        }
      ],
      snapshot: snapshot({
        blockers: [blocker({ reason: 'AUTH_REFRESH_FAILED', stage: 'AUTH' })]
      })
    });
    expect(result.state).toBe('AUTH_OR_ROUTE_BLOCKED');
    expect(result.evidence.attemptIds).toEqual([]);

    expect(classify({
      attempts: [{
        clientEventId: CLIENT_EVENT_ID,
        errorCode: null,
        id: 'attempt-applied-old',
        receivedAt: new Date('2026-10-02T10:00:00.000Z'),
        requestId: REQUEST_ID,
        status: 'APPLIED'
      }],
      snapshot: snapshot({ blockers: [blocker()] })
    }).state).toBe('SERVER_APPLIED_CLIENT_ACK_UNKNOWN');
  });

  test('reports a scoped failed server attempt and ignores stale attempt history', () => {
    const failed: DriverRuntimeAttemptEvidence = {
      clientEventId: CLIENT_EVENT_ID,
      errorCode: 'SERVER_REJECTED',
      id: 'attempt-failed',
      receivedAt: new Date(FRESH),
      requestId: REQUEST_ID,
      status: 'REJECTED'
    };
    expect(classify({ attempts: [failed], snapshot: snapshot({ blockers: [blocker()] }) }).state)
      .toBe('SERVER_RECEIVED_NOT_APPLIED');
    expect(classify({
      attempts: [{ ...failed, receivedAt: new Date('2026-10-02T11:40:00.000Z') }],
      snapshot: snapshot({ blockers: [blocker()] })
    }).state).toBe('GPS_POST_COLLECTION_BLOCKED');
  });

  test('uses server contact and live snapshot freshness instead of replay history', () => {
    expect(classify({ lastContactAt: null }).state).toBe('SIGNAL_ABSENT_UNKNOWN');
    expect(classify({ lastContactAt: new Date('2026-10-02T11:50:00.000Z') }).state)
      .toBe('SIGNAL_ABSENT_UNKNOWN');
    expect(classify({ snapshot: snapshot({ snapshotObservedAt: '2026-10-02T11:40:00.000Z' }) }).state)
      .toBe('UNKNOWN_STALE_EVIDENCE');
  });

  test('does not use stale or future field evidence as a current diagnosis', () => {
    expect(classify({
      snapshot: snapshot({
        locationPermission: 'DENIED',
        stateObservedAt: { ...snapshot().stateObservedAt, locationPermission: '2026-10-02T11:40:00.000Z' }
      })
    }).state).toBe('UNKNOWN_STALE_EVIDENCE');
    expect(classify({
      snapshot: snapshot({ lastGpsCallbackAt: '2026-10-02T12:01:00.000Z' })
    }).state).toBe('UNKNOWN_STALE_EVIDENCE');
    expect(classify({
      snapshot: snapshot({ lastGpsPersistedAt: '2026-10-02T11:40:00.000Z' })
    }).state).toBe('UNKNOWN_STALE_EVIDENCE');
  });

  test('does not invent collection stopped from an uncertain location observation failure', () => {
    const uncertain = blocker({ reason: 'LOCATION_SNAPSHOT_FAILED', stage: 'LOCATION' });
    expect(classify({ snapshot: snapshot({ blockers: [uncertain] }) }).state)
      .toBe('UNKNOWN_INSUFFICIENT_EVIDENCE');
    expect(classify({
      snapshot: snapshot({ blockers: [uncertain], locationTaskExpected: false })
    }).state).toBe('UNKNOWN_INSUFFICIENT_EVIDENCE');
    expect(classify({
      snapshot: snapshot({ blockers: [uncertain], lastGpsCallbackAt: '2026-10-02T11:40:00.000Z' })
    }).state).toBe('GPS_COLLECTION_STOPPED');
  });

  test('applies warmup per fresh boot/route/session scope before declaring collection stopped', () => {
    const noCollection = snapshot({
      lastGpsCallbackAt: null,
      lastGpsCollectedAt: null,
      lastGpsPersistedAt: null,
      lastGpsSendAcknowledgedAt: null,
      lastGpsSendAttemptAt: null
    });
    expect(classify({ firstObservedAt: new Date('2026-10-02T11:58:00.000Z'), snapshot: noCollection }).state)
      .toBe('UNKNOWN_INSUFFICIENT_EVIDENCE');
    expect(classify({ firstObservedAt: null, snapshot: noCollection }).state)
      .toBe('UNKNOWN_INSUFFICIENT_EVIDENCE');
    expect(classify({ firstObservedAt: new Date('2026-10-02T11:55:00.000Z'), snapshot: noCollection }).state)
      .toBe('GPS_COLLECTION_STOPPED');
  });

  test('requires fresh evidence through persistence, send, ACK, and an empty observed queue for healthy', () => {
    expect(classify({}).state).toBe('HEALTHY');
    expect(classify({ snapshot: snapshot({ lastGpsPersistedAt: null }) }).state)
      .toBe('UNKNOWN_INSUFFICIENT_EVIDENCE');
    expect(classify({
      snapshot: snapshot({ businessQueue: { ...snapshot().businessQueue, queueDepth: 1 } })
    }).state).toBe('UNKNOWN_INSUFFICIENT_EVIDENCE');
  });
});


describe('database integer wire bounds', () => {
  test('accepts the PostgreSQL integer boundary and rejects envelope overflow', () => {
    expect(parseDriverDiagnosticEnvelope(envelope({ discardedRecordCount: 2_147_483_647 }))).not.toBeNull();
    expect(parseDriverDiagnosticEnvelope(envelope({ discardedRecordCount: 2_147_483_648 }))).toBeNull();
  });

  test('rejects only an overflowing record sequence with an explicit record rejection', () => {
    const payload = envelope();
    const first = payload.records[0]!;
    expect(parseDriverDiagnosticEnvelope(envelope({ records: [{ ...first, sequence: 2_147_483_647 }] }))).not.toBeNull();
    expect(parseDriverDiagnosticEnvelopeDetailed(envelope({ records: [{ ...first, sequence: 2_147_483_648 }] })))
      .toMatchObject({ envelope: { records: [] }, rejectedRecords: [{ diagnosticId: DIAGNOSTIC_ID, code: 'INVALID_RECORD' }] });
  });
});


describe('healthy state requires fresh state observations', () => {
  test.each(['locationPermission', 'locationService', 'locationTask', 'network', 'lifecycle'] as const)('rejects stale and future positive %s evidence', (field) => {
    for (const observedAt of ['2026-10-02T11:40:00.000Z', '2026-10-02T12:01:00.000Z']) {
      const current = snapshot();
      const diagnosis = deriveDriverRuntimeDiagnostic({
        firstObservedAt: new Date('2026-10-02T11:00:00.000Z'), lastContactAt: NOW, now: NOW,
        snapshot: snapshot({ stateObservedAt: { ...current.stateObservedAt, [field]: observedAt } })
      });
      expect(diagnosis.state).toBe('UNKNOWN_STALE_EVIDENCE');
    }
  });
});
