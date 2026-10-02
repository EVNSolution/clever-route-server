import type {
  DriverDiagnosticBlocker,
  DriverDiagnosticReasonCode,
  DriverDiagnosticSnapshot,
  DriverDiagnosticStage
} from './driver-runtime-diagnostics.contract.js';

export const DRIVER_RUNTIME_DIAGNOSTIC_PROJECTION_VERSION = 1 as const;
export const DRIVER_RUNTIME_DIAGNOSTIC_THRESHOLDS = Object.freeze({
  clockSkewBudgetMs: 30_000,
  collectionWarmupMs: 180_000,
  evidenceFreshForMs: 180_000,
  signalAbsentAfterMs: 180_000
});

export type DriverRuntimeDiagnosticState =
  | 'AUTH_OR_ROUTE_BLOCKED'
  | 'DIAGNOSTIC_EVIDENCE_DEGRADED'
  | 'GPS_COLLECTION_STOPPED'
  | 'GPS_POST_COLLECTION_BLOCKED'
  | 'HEALTHY'
  | 'SERVER_APPLIED_CLIENT_ACK_UNKNOWN'
  | 'SERVER_RECEIVED_NOT_APPLIED'
  | 'SIGNAL_ABSENT_UNKNOWN'
  | 'UNKNOWN_INSUFFICIENT_EVIDENCE'
  | 'UNKNOWN_STALE_EVIDENCE';

export type DriverRuntimeAttemptEvidence = {
  clientEventId?: string | null;
  clientRequestId?: string | null;
  errorCode: string | null;
  id: string;
  receivedAt: Date;
  requestId?: string | null;
  status: 'APPLIED' | 'DUPLICATE' | 'FAILED' | 'REJECTED';
};

export type DriverRuntimeDiagnosticProjection = {
  evidence: {
    attemptIds: readonly string[];
    clientEventIds: readonly string[];
    requestIds: readonly string[];
  };
  observedAt: Date | null;
  reasons: readonly DriverDiagnosticReasonCode[];
  stage: DriverDiagnosticStage | null;
  state: DriverRuntimeDiagnosticState;
  version: typeof DRIVER_RUNTIME_DIAGNOSTIC_PROJECTION_VERSION;
};

export type DriverRuntimeDiagnosticInput = {
  attempts?: readonly DriverRuntimeAttemptEvidence[];
  firstObservedAt: Date | null;
  lastContactAt: Date | null;
  now: Date;
  snapshot: DriverDiagnosticSnapshot | null;
};

type ProjectionEvidence = DriverRuntimeDiagnosticProjection['evidence'];

const emptyEvidence = (): ProjectionEvidence => ({ attemptIds: [], clientEventIds: [], requestIds: [] });

function unique(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
}

function projection(input: {
  attempts?: readonly DriverRuntimeAttemptEvidence[];
  blocker?: DriverDiagnosticBlocker;
  observedAt: Date | null;
  reasons?: readonly DriverDiagnosticReasonCode[];
  stage?: DriverDiagnosticStage | null;
  state: DriverRuntimeDiagnosticState;
}): DriverRuntimeDiagnosticProjection {
  return {
    evidence: input.blocker === undefined && input.attempts === undefined
      ? emptyEvidence()
      : {
          attemptIds: unique(input.attempts?.map(({ id }) => id) ?? []),
          clientEventIds: unique([
            input.blocker?.clientEventId,
            ...(input.attempts?.map(({ clientEventId }) => clientEventId) ?? [])
          ]),
          requestIds: unique([
            input.blocker?.requestId,
            ...(input.attempts?.map((attempt) => attempt.clientRequestId ?? attempt.requestId) ?? [])
          ])
        },
    observedAt: input.observedAt,
    reasons: input.reasons ?? (input.blocker === undefined ? [] : [input.blocker.reason]),
    stage: input.stage ?? input.blocker?.stage ?? null,
    state: input.state,
    version: DRIVER_RUNTIME_DIAGNOSTIC_PROJECTION_VERSION
  };
}

function parseTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

function evidenceAge(nowMs: number, value: Date | null): number | null {
  return value === null ? null : nowMs - value.getTime();
}

function isFresh(nowMs: number, value: Date | null): boolean {
  const age = evidenceAge(nowMs, value);
  return age !== null
    && age >= -DRIVER_RUNTIME_DIAGNOSTIC_THRESHOLDS.clockSkewBudgetMs
    && age <= DRIVER_RUNTIME_DIAGNOSTIC_THRESHOLDS.evidenceFreshForMs;
}

function isFuture(nowMs: number, value: Date | null): boolean {
  const age = evidenceAge(nowMs, value);
  return age !== null && age < -DRIVER_RUNTIME_DIAGNOSTIC_THRESHOLDS.clockSkewBudgetMs;
}

function matchesBlocker(attempt: DriverRuntimeAttemptEvidence, blocker: DriverDiagnosticBlocker): boolean {
  const blockerIds = [blocker.clientEventId, blocker.requestId].filter((value): value is string => value !== undefined);
  if (blockerIds.length === 0) return false;
  const attemptRequestId = attempt.clientRequestId ?? attempt.requestId ?? null;
  return (blocker.clientEventId === undefined || attempt.clientEventId === blocker.clientEventId)
    && (blocker.requestId === undefined || attemptRequestId === blocker.requestId);
}

function attemptsForBlocker(
  attempts: readonly DriverRuntimeAttemptEvidence[],
  blocker: DriverDiagnosticBlocker
): DriverRuntimeAttemptEvidence[] {
  return attempts.filter((attempt) => matchesBlocker(attempt, blocker));
}

function observedAt(blocker: DriverDiagnosticBlocker): Date {
  return new Date(blocker.since);
}

export function deriveDriverRuntimeDiagnostic(input: DriverRuntimeDiagnosticInput): DriverRuntimeDiagnosticProjection {
  const nowMs = input.now.getTime();
  if (input.lastContactAt === null) {
    return projection({ observedAt: null, state: 'SIGNAL_ABSENT_UNKNOWN' });
  }
  if (isFuture(nowMs, input.lastContactAt)) {
    return projection({ observedAt: input.lastContactAt, state: 'UNKNOWN_STALE_EVIDENCE' });
  }
  if (nowMs - input.lastContactAt.getTime() > DRIVER_RUNTIME_DIAGNOSTIC_THRESHOLDS.signalAbsentAfterMs) {
    return projection({ observedAt: input.lastContactAt, state: 'SIGNAL_ABSENT_UNKNOWN' });
  }
  if (input.snapshot === null) {
    return projection({ observedAt: input.lastContactAt, state: 'UNKNOWN_INSUFFICIENT_EVIDENCE' });
  }

  const snapshot = input.snapshot;
  const snapshotAt = parseTimestamp(snapshot.snapshotObservedAt);
  if (!isFresh(nowMs, snapshotAt)) {
    return projection({ observedAt: snapshotAt, state: 'UNKNOWN_STALE_EVIDENCE' });
  }

  const blockers = snapshot.blockers ?? [];
  const staleBlocker = blockers.find((blocker) => {
    const lastObservedAt = parseTimestamp(blocker.lastObservedAt);
    const since = parseTimestamp(blocker.since);
    return !isFresh(nowMs, lastObservedAt) || isFuture(nowMs, since);
  });
  if (staleBlocker !== undefined) {
    return projection({ blocker: staleBlocker, observedAt: parseTimestamp(staleBlocker.lastObservedAt), state: 'UNKNOWN_STALE_EVIDENCE' });
  }

  const attempts = input.attempts ?? [];
  for (const blocker of blockers) {
    const scopedAttempts = attemptsForBlocker(attempts, blocker);
    const successful = scopedAttempts.filter(({ receivedAt, status }) => (
      Number.isFinite(receivedAt.getTime())
      && !isFuture(nowMs, receivedAt)
      && (status === 'APPLIED' || status === 'DUPLICATE')
    ));
    if (successful.length > 0) {
      if (blocker.stage === 'TRANSPORT') {
        return projection({
          attempts: successful,
          blocker,
          observedAt: observedAt(blocker),
          state: 'SERVER_APPLIED_CLIENT_ACK_UNKNOWN'
        });
      }
      continue;
    }
    const failed = scopedAttempts.filter(({ receivedAt, status }) => (
      isFresh(nowMs, receivedAt) && (status === 'FAILED' || status === 'REJECTED')
    ));
    if (failed.length > 0) {
      return projection({ attempts: failed, blocker, observedAt: observedAt(blocker), state: 'SERVER_RECEIVED_NOT_APPLIED' });
    }
  }

  const authOrRoute = blockers.find(({ stage }) => stage === 'AUTH' || stage === 'ROUTE');
  if (authOrRoute !== undefined) {
    return projection({ blocker: authOrRoute, observedAt: observedAt(authOrRoute), state: 'AUTH_OR_ROUTE_BLOCKED' });
  }
  const diagnosticStorage = blockers.find(({ reason }) => reason === 'DIAGNOSTIC_STORAGE_FAILED');
  if (diagnosticStorage !== undefined) {
    return projection({ blocker: diagnosticStorage, observedAt: observedAt(diagnosticStorage), state: 'DIAGNOSTIC_EVIDENCE_DEGRADED' });
  }

  const callbackAt = parseTimestamp(snapshot.lastGpsCallbackAt);
  const collectedAt = parseTimestamp(snapshot.lastGpsCollectedAt);
  const persistedAt = parseTimestamp(snapshot.lastGpsPersistedAt);
  const sendAttemptAt = parseTimestamp(snapshot.lastGpsSendAttemptAt);
  const sendAcknowledgedAt = parseTimestamp(snapshot.lastGpsSendAcknowledgedAt);
  const futureGpsEvidence = [callbackAt, collectedAt, persistedAt, sendAttemptAt, sendAcknowledgedAt]
    .find((at) => isFuture(nowMs, at));
  if (futureGpsEvidence !== undefined) {
    return projection({ observedAt: futureGpsEvidence, state: 'UNKNOWN_STALE_EVIDENCE' });
  }
  const callbackIsFresh = isFresh(nowMs, callbackAt);
  const collectionIsFresh = isFresh(nowMs, collectedAt);

  const postCollection = blockers.find(({ stage }) => (
    stage === 'PROCESSING' || stage === 'STORAGE' || stage === 'TRANSPORT'
  ));
  if (postCollection !== undefined && callbackIsFresh && collectionIsFresh) {
    return projection({ blocker: postCollection, observedAt: observedAt(postCollection), state: 'GPS_POST_COLLECTION_BLOCKED' });
  }
  const locationBlocker = blockers.find(({ stage }) => stage === 'LOCATION');
  if (snapshot.locationTaskExpected !== true) {
    return projection({
      ...(locationBlocker === undefined ? {} : { blocker: locationBlocker }),
      observedAt: locationBlocker === undefined ? snapshotAt : observedAt(locationBlocker),
      state: 'UNKNOWN_INSUFFICIENT_EVIDENCE'
    });
  }
  const stoppedLocationReasons = new Set<DriverDiagnosticReasonCode>([
    'LOCATION_PERMISSION_DENIED',
    'LOCATION_SERVICES_DISABLED',
    'LOCATION_TASK_ERROR',
    'LOCATION_TASK_NOT_STARTED',
    'LOCATION_TASK_START_FAILED'
  ]);
  if (locationBlocker !== undefined && stoppedLocationReasons.has(locationBlocker.reason)) {
    return projection({ blocker: locationBlocker, observedAt: observedAt(locationBlocker), state: 'GPS_COLLECTION_STOPPED' });
  }

  const explicitLocationFaults = [
    snapshot.locationPermission === 'DENIED'
      ? { at: parseTimestamp(snapshot.stateObservedAt.locationPermission), reason: 'LOCATION_PERMISSION_DENIED' as const }
      : null,
    snapshot.locationService === 'DISABLED'
      ? { at: parseTimestamp(snapshot.stateObservedAt.locationService), reason: 'LOCATION_SERVICES_DISABLED' as const }
      : null,
    snapshot.locationTask === 'ERROR' || snapshot.locationTask === 'STOPPED'
      ? {
          at: parseTimestamp(snapshot.stateObservedAt.locationTask),
          reason: snapshot.locationTask === 'ERROR' ? 'LOCATION_TASK_ERROR' as const : 'LOCATION_TASK_NOT_STARTED' as const
        }
      : null
  ].filter((fault) => fault !== null);
  const staleExplicitFault = explicitLocationFaults.find(({ at }) => !isFresh(nowMs, at));
  if (staleExplicitFault !== undefined) {
    return projection({ observedAt: staleExplicitFault.at, reasons: [staleExplicitFault.reason], stage: 'LOCATION', state: 'UNKNOWN_STALE_EVIDENCE' });
  }
  if (explicitLocationFaults.length > 0) {
    return projection({
      observedAt: explicitLocationFaults[0]!.at,
      reasons: explicitLocationFaults.map(({ reason }) => reason),
      stage: 'LOCATION',
      state: 'GPS_COLLECTION_STOPPED'
    });
  }

  if (callbackAt === null) {
    if (input.firstObservedAt === null) {
      return projection({ observedAt: null, state: 'UNKNOWN_INSUFFICIENT_EVIDENCE' });
    }
    if (isFuture(nowMs, input.firstObservedAt)) {
      return projection({ observedAt: input.firstObservedAt, state: 'UNKNOWN_STALE_EVIDENCE' });
    }
    if (nowMs - input.firstObservedAt.getTime() <= DRIVER_RUNTIME_DIAGNOSTIC_THRESHOLDS.collectionWarmupMs) {
      return projection({ observedAt: input.firstObservedAt, state: 'UNKNOWN_INSUFFICIENT_EVIDENCE' });
    }
    return projection({ observedAt: input.firstObservedAt, stage: 'LOCATION', state: 'GPS_COLLECTION_STOPPED' });
  }
  if (!callbackIsFresh) {
    return projection({ observedAt: callbackAt, stage: 'LOCATION', state: 'GPS_COLLECTION_STOPPED' });
  }
  if (!collectionIsFresh) {
    return projection({ observedAt: collectedAt ?? callbackAt, stage: 'LOCATION', state: 'GPS_COLLECTION_STOPPED' });
  }
  if (locationBlocker !== undefined) {
    return projection({ blocker: locationBlocker, observedAt: observedAt(locationBlocker), state: 'UNKNOWN_INSUFFICIENT_EVIDENCE' });
  }

  const queueAt = parseTimestamp(snapshot.businessQueue.observedAt);
  const requiredCurrentEvidence = [persistedAt, sendAttemptAt, sendAcknowledgedAt, queueAt];
  if (requiredCurrentEvidence.some((at) => isFuture(nowMs, at))) {
    return projection({ observedAt: requiredCurrentEvidence.find((at) => isFuture(nowMs, at)) ?? snapshotAt, state: 'UNKNOWN_STALE_EVIDENCE' });
  }
  const staleCurrentEvidence = requiredCurrentEvidence.find((at) => at !== null && !isFresh(nowMs, at));
  if (staleCurrentEvidence !== undefined) {
    return projection({ observedAt: staleCurrentEvidence, state: 'UNKNOWN_STALE_EVIDENCE' });
  }
  const stateAllowsHealthy = snapshot.locationPermission !== 'UNKNOWN'
    && snapshot.locationService === 'ENABLED'
    && snapshot.locationTask === 'STARTED'
    && snapshot.network === 'ONLINE';
  if (
    requiredCurrentEvidence.every((at) => isFresh(nowMs, at))
    && snapshot.businessQueue.queueDepth === 0
    && stateAllowsHealthy
  ) {
    const currentStateObservations = Object.values(snapshot.stateObservedAt).map(parseTimestamp);
    const missingStateObservation = currentStateObservations.some((at) => at === null);
    if (missingStateObservation) return projection({ observedAt: snapshotAt, state: 'UNKNOWN_INSUFFICIENT_EVIDENCE' });
    const staleStateObservation = currentStateObservations.find((at) => !isFresh(nowMs, at));
    if (staleStateObservation !== undefined) {
      return projection({ observedAt: staleStateObservation, state: 'UNKNOWN_STALE_EVIDENCE' });
    }
    return projection({ observedAt: snapshotAt, state: 'HEALTHY' });
  }
  return projection({ observedAt: snapshotAt, state: 'UNKNOWN_INSUFFICIENT_EVIDENCE' });
}
