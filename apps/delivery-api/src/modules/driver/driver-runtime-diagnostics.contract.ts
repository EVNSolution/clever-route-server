export const DRIVER_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const DRIVER_DIAGNOSTIC_MAX_RECORDS = 50;
export const DRIVER_DIAGNOSTIC_MAX_BATCH_BYTES = 64 * 1024;

export const DRIVER_DIAGNOSTIC_REASON_CODES = [
  'AUTH_CREDENTIAL_MISSING',
  'AUTH_REFRESH_FAILED',
  'AUTH_REFRESH_TIMEOUT',
  'DIAGNOSTIC_STORAGE_FAILED',
  'HTTP_CLIENT_ERROR',
  'HTTP_FORBIDDEN',
  'HTTP_RATE_LIMITED',
  'HTTP_SERVER_ERROR',
  'HTTP_TIMEOUT',
  'HTTP_UNAUTHORIZED',
  'HTTP_INVALID_RESPONSE',
  'LOCATION_CALLBACK_STALE',
  'LOCATION_PERMISSION_DENIED',
  'LOCATION_PERMISSION_STATUS_FAILED',
  'LOCATION_PIPELINE_TIMEOUT',
  'LOCATION_PROCESSING_FAILED',
  'LOCATION_SERVICES_DISABLED',
  'LOCATION_SERVICE_STATUS_FAILED',
  'LOCATION_SNAPSHOT_FAILED',
  'LOCATION_TASK_NOT_STARTED',
  'LOCATION_TASK_ERROR',
  'LOCATION_TASK_STATUS_FAILED',
  'LOCATION_TASK_START_FAILED',
  'LOCATION_TASK_STOP_FAILED',
  'NETWORK_OFFLINE',
  'NETWORK_REQUEST_FAILED',
  'OPERATION_TIMEOUT',
  'REQUEST_ABORTED',
  'ROUTE_MISMATCH',
  'ROUTE_ACCESS_REVOKED',
  'ROUTE_NOT_IN_PROGRESS',
  'SESSION_MISMATCH',
  'STORAGE_OPERATION_TIMEOUT',
  'STORAGE_READ_FAILED',
  'STORAGE_WRITE_FAILED'
] as const;

export type DriverDiagnosticReasonCode = typeof DRIVER_DIAGNOSTIC_REASON_CODES[number];
export type DriverDiagnosticKind = 'ERROR' | 'HEARTBEAT' | 'STATE_CHANGE' | 'USER_REPORT';
export type DriverDiagnosticStage = 'AUTH' | 'LOCATION' | 'PROCESSING' | 'ROUTE' | 'STORAGE' | 'TRANSPORT';

export type DriverDiagnosticContext = {
  appVersion: string;
  assignmentGeneration?: string | null;
  deviceInstanceHash: string;
  os: 'ANDROID' | 'IOS';
  osVersion: string;
  routePlanId: string | null;
  sessionGeneration: string | null;
  versionCode: number | null;
};

export type DriverDiagnosticIdentifiers = {
  clientEventId?: string;
  requestId?: string;
};

export type DriverDiagnosticBlocker = DriverDiagnosticIdentifiers & {
  httpStatus?: number;
  lastObservedAt: string;
  reason: DriverDiagnosticReasonCode;
  since: string;
  stage: DriverDiagnosticStage;
};

export type DriverDiagnosticSnapshot = {
  blockers?: readonly DriverDiagnosticBlocker[];
  businessQueue: {
    nextRetryAt: string | null;
    observedAt: string | null;
    oldestAgeMs: number | null;
    oldestQueuedAt: string | null;
    queueDepth: number;
    retryCount: number;
  };
  lastGpsCallbackAt: string | null;
  lastGpsCollectedAt: string | null;
  lastGpsPersistedAt: string | null;
  lastGpsSendAcknowledgedAt: string | null;
  lastGpsSendAttemptAt: string | null;
  lifecycle: 'BACKGROUND' | 'FOREGROUND' | 'INACTIVE' | 'UNKNOWN';
  locationPermission: 'DENIED' | 'GRANTED_ALWAYS' | 'GRANTED_FOREGROUND' | 'UNKNOWN';
  locationService: 'DISABLED' | 'ENABLED' | 'UNKNOWN';
  locationTask: 'ERROR' | 'EXPECTED' | 'STARTED' | 'STOPPED' | 'UNKNOWN';
  locationTaskExpected: boolean | null;
  network: 'OFFLINE' | 'ONLINE' | 'UNKNOWN';
  snapshotObservedAt: string;
  stateObservedAt: {
    lifecycle: string | null;
    locationPermission: string | null;
    locationService: string | null;
    locationTask: string | null;
    network: string | null;
  };
};

export type DriverDiagnosticRecord = {
  bootId: string;
  context: DriverDiagnosticContext;
  diagnosticId: string;
  identifiers?: DriverDiagnosticIdentifiers;
  kind: DriverDiagnosticKind;
  observedAt: string;
  sequence: number;
  snapshot: DriverDiagnosticSnapshot;
};

export type DriverDiagnosticEnvelope = {
  batchId: string;
  bootId: string;
  discardedRecordCount: number;
  liveContext: DriverDiagnosticContext;
  liveSnapshot: DriverDiagnosticSnapshot;
  records: readonly DriverDiagnosticRecord[];
  schemaVersion: typeof DRIVER_DIAGNOSTIC_SCHEMA_VERSION;
  sentAt: string;
};

export type RejectedDriverDiagnosticRecord = {
  code: 'INVALID_RECORD';
  diagnosticId: string | null;
  index: number;
};

export type ParsedDriverDiagnosticEnvelope = {
  envelope: DriverDiagnosticEnvelope;
  rejectedRecords: readonly RejectedDriverDiagnosticRecord[];
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const sessionGenerationPattern = /^(?:[0-9]{1,20}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
const generatedClientEventIdPattern = /^(?:(?:route-started|route-completed|route-released|pickup-completed|location-updated|stop-delivered|stop-failed)-[a-z0-9]{1,32}|stop-arrived-[0-9a-f-]{36}-[a-z0-9]{1,32}|continuous-location-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9]{1,6}|[0-9A-HJKMNP-TV-Z]{20,26})$/u;
const completionAssistanceClientEventIdPattern = /^completion-assistance-(?:read|write|remove):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const versionPattern = /^[A-Za-z0-9._+()-]{1,64}$/u;
const hashPattern = /^[a-fA-F0-9]{32,128}$/u;
const reasonCodes = new Set<string>(DRIVER_DIAGNOSTIC_REASON_CODES);
const kinds = new Set<string>(['ERROR', 'HEARTBEAT', 'STATE_CHANGE', 'USER_REPORT']);
const stages = new Set<string>(['AUTH', 'LOCATION', 'PROCESSING', 'ROUTE', 'STORAGE', 'TRANSPORT']);
const lifecycles = new Set<string>(['BACKGROUND', 'FOREGROUND', 'INACTIVE', 'UNKNOWN']);
const networks = new Set<string>(['OFFLINE', 'ONLINE', 'UNKNOWN']);
const permissions = new Set<string>(['DENIED', 'GRANTED_ALWAYS', 'GRANTED_FOREGROUND', 'UNKNOWN']);
const services = new Set<string>(['DISABLED', 'ENABLED', 'UNKNOWN']);
const tasks = new Set<string>(['ERROR', 'EXPECTED', 'STARTED', 'STOPPED', 'UNKNOWN']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeUuid(value: unknown): string | undefined;
function safeUuid(value: unknown, nullable: true): string | null | undefined;
function safeUuid(value: unknown, nullable = false): string | null | undefined {
  if (nullable && value === null) return null;
  return typeof value === 'string' && uuidPattern.test(value) ? value.toLowerCase() : undefined;
}

function safeTimestamp(value: unknown): string | undefined;
function safeTimestamp(value: unknown, nullable: true): string | null | undefined;
function safeTimestamp(value: unknown, nullable = false): string | null | undefined {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > 40 || !isoTimestampPattern.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeDatabaseInteger(value: unknown): number | undefined {
  const integer = safeNonNegativeInteger(value);
  return integer !== undefined && integer <= 2_147_483_647 ? integer : undefined;
}

function sanitizeIdentifiers(value: unknown): DriverDiagnosticIdentifiers | null | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  const hasClientEventId = Object.hasOwn(value, 'clientEventId');
  const hasRequestId = Object.hasOwn(value, 'requestId');
  const clientEventId = !hasClientEventId
    ? undefined
    : typeof value.clientEventId === 'string'
      && (
        uuidPattern.test(value.clientEventId)
        || generatedClientEventIdPattern.test(value.clientEventId)
        || completionAssistanceClientEventIdPattern.test(value.clientEventId)
      )
      ? value.clientEventId
      : null;
  const requestId = !hasRequestId ? undefined : safeUuid(value.requestId) ?? null;
  if (clientEventId === null || requestId === null) return null;
  if (clientEventId === undefined && requestId === undefined) return undefined;
  return {
    ...(clientEventId === undefined ? {} : { clientEventId }),
    ...(requestId === undefined ? {} : { requestId })
  };
}

function sanitizeBlocker(value: unknown): DriverDiagnosticBlocker | null {
  if (!isObject(value)) return null;
  const lastObservedAt = safeTimestamp(value.lastObservedAt);
  const since = safeTimestamp(value.since);
  const identifiers = sanitizeIdentifiers(value);
  const hasHttpStatus = Object.hasOwn(value, 'httpStatus');
  const httpStatus = hasHttpStatus ? safeNonNegativeInteger(value.httpStatus) : undefined;
  if (
    lastObservedAt === undefined
    || since === undefined
    || identifiers === null
    || typeof value.reason !== 'string'
    || !reasonCodes.has(value.reason)
    || typeof value.stage !== 'string'
    || !stages.has(value.stage)
    || (hasHttpStatus && (httpStatus === undefined || httpStatus < 100 || httpStatus > 599))
  ) return null;
  return {
    ...(identifiers ?? {}),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    lastObservedAt,
    reason: value.reason as DriverDiagnosticReasonCode,
    since,
    stage: value.stage as DriverDiagnosticStage
  };
}

function sanitizeContext(value: unknown): DriverDiagnosticContext | null {
  if (!isObject(value)) return null;
  const routePlanId = safeUuid(value.routePlanId, true);
  const sessionGeneration = value.sessionGeneration === null
    ? null
    : typeof value.sessionGeneration === 'string'
      && (sessionGenerationPattern.test(value.sessionGeneration) || isoTimestampPattern.test(value.sessionGeneration))
      ? value.sessionGeneration
      : undefined;
  const assignmentGeneration = value.assignmentGeneration === undefined
    ? undefined
    : value.assignmentGeneration === null
      ? null
      : typeof value.assignmentGeneration === 'string' && /^[0-9]{1,20}$/u.test(value.assignmentGeneration)
        ? value.assignmentGeneration
        : undefined;
  const versionCode = value.versionCode === null ? null : safeNonNegativeInteger(value.versionCode);
  if (
    typeof value.appVersion !== 'string' || !versionPattern.test(value.appVersion)
    || typeof value.deviceInstanceHash !== 'string' || !hashPattern.test(value.deviceInstanceHash)
    || (value.os !== 'ANDROID' && value.os !== 'IOS')
    || typeof value.osVersion !== 'string' || !versionPattern.test(value.osVersion)
    || routePlanId === undefined
    || sessionGeneration === undefined
    || (Object.hasOwn(value, 'assignmentGeneration') && assignmentGeneration === undefined)
    || versionCode === undefined
  ) return null;
  return {
    appVersion: value.appVersion,
    ...(assignmentGeneration === undefined ? {} : { assignmentGeneration }),
    deviceInstanceHash: value.deviceInstanceHash.toLowerCase(),
    os: value.os,
    osVersion: value.osVersion,
    routePlanId,
    sessionGeneration,
    versionCode
  };
}

export function parseDriverDiagnosticSnapshot(value: unknown): DriverDiagnosticSnapshot | null {
  if (!isObject(value) || !isObject(value.businessQueue) || !isObject(value.stateObservedAt)) return null;
  const queueDepth = safeNonNegativeInteger(value.businessQueue.queueDepth);
  const retryCount = safeNonNegativeInteger(value.businessQueue.retryCount);
  const oldestAgeMs = value.businessQueue.oldestAgeMs === null ? null : safeNonNegativeInteger(value.businessQueue.oldestAgeMs);
  const oldestQueuedAt = safeTimestamp(value.businessQueue.oldestQueuedAt, true);
  const nextRetryAt = safeTimestamp(value.businessQueue.nextRetryAt, true);
  const queueObservedAt = safeTimestamp(value.businessQueue.observedAt, true);
  if (
    queueDepth === undefined || retryCount === undefined || oldestAgeMs === undefined
    || oldestQueuedAt === undefined || nextRetryAt === undefined || queueObservedAt === undefined
    || typeof value.lifecycle !== 'string' || !lifecycles.has(value.lifecycle)
    || typeof value.network !== 'string' || !networks.has(value.network)
    || typeof value.locationPermission !== 'string' || !permissions.has(value.locationPermission)
    || typeof value.locationService !== 'string' || !services.has(value.locationService)
    || typeof value.locationTask !== 'string' || !tasks.has(value.locationTask)
    || (value.locationTaskExpected !== null && typeof value.locationTaskExpected !== 'boolean')
  ) return null;

  const timestampKeys = [
    'lastGpsCallbackAt', 'lastGpsCollectedAt', 'lastGpsPersistedAt',
    'lastGpsSendAcknowledgedAt', 'lastGpsSendAttemptAt'
  ] as const;
  const timestamps = Object.fromEntries(timestampKeys.map((key) => [key, safeTimestamp(value[key], true)])) as
    Record<typeof timestampKeys[number], string | null | undefined>;
  const snapshotObservedAt = safeTimestamp(value.snapshotObservedAt);
  const stateObservedAt = {
    lifecycle: safeTimestamp(value.stateObservedAt.lifecycle, true),
    locationPermission: safeTimestamp(value.stateObservedAt.locationPermission, true),
    locationService: safeTimestamp(value.stateObservedAt.locationService, true),
    locationTask: safeTimestamp(value.stateObservedAt.locationTask, true),
    network: safeTimestamp(value.stateObservedAt.network, true)
  };
  if (
    timestampKeys.some((key) => timestamps[key] === undefined)
    || snapshotObservedAt === undefined
    || Object.values(stateObservedAt).some((timestamp) => timestamp === undefined)
  ) return null;

  let blockers: DriverDiagnosticBlocker[] | undefined;
  if (value.blockers !== undefined) {
    if (!Array.isArray(value.blockers) || value.blockers.length > 10) return null;
    const parsedBlockers = value.blockers.map(sanitizeBlocker);
    if (parsedBlockers.some((blocker) => blocker === null)) return null;
    blockers = parsedBlockers as DriverDiagnosticBlocker[];
  }

  return {
    ...(blockers === undefined || blockers.length === 0 ? {} : { blockers }),
    businessQueue: {
      nextRetryAt,
      observedAt: queueObservedAt,
      oldestAgeMs,
      oldestQueuedAt,
      queueDepth,
      retryCount
    },
    lastGpsCallbackAt: timestamps.lastGpsCallbackAt!,
    lastGpsCollectedAt: timestamps.lastGpsCollectedAt!,
    lastGpsPersistedAt: timestamps.lastGpsPersistedAt!,
    lastGpsSendAcknowledgedAt: timestamps.lastGpsSendAcknowledgedAt!,
    lastGpsSendAttemptAt: timestamps.lastGpsSendAttemptAt!,
    lifecycle: value.lifecycle as DriverDiagnosticSnapshot['lifecycle'],
    locationPermission: value.locationPermission as DriverDiagnosticSnapshot['locationPermission'],
    locationService: value.locationService as DriverDiagnosticSnapshot['locationService'],
    locationTask: value.locationTask as DriverDiagnosticSnapshot['locationTask'],
    locationTaskExpected: value.locationTaskExpected,
    network: value.network as DriverDiagnosticSnapshot['network'],
    snapshotObservedAt,
    stateObservedAt: stateObservedAt as DriverDiagnosticSnapshot['stateObservedAt']
  };
}

function sanitizeRecord(value: unknown): DriverDiagnosticRecord | null {
  if (!isObject(value)) return null;
  const bootId = safeUuid(value.bootId);
  const context = sanitizeContext(value.context);
  const diagnosticId = safeUuid(value.diagnosticId);
  const identifiers = sanitizeIdentifiers(value.identifiers);
  const observedAt = safeTimestamp(value.observedAt);
  const sequence = safeDatabaseInteger(value.sequence);
  const snapshot = parseDriverDiagnosticSnapshot(value.snapshot);
  if (
    bootId === undefined || context === null || diagnosticId === undefined || identifiers === null
    || observedAt === undefined || sequence === undefined || snapshot === null
    || typeof value.kind !== 'string' || !kinds.has(value.kind)
  ) return null;
  return {
    bootId,
    context,
    diagnosticId,
    ...(identifiers === undefined ? {} : { identifiers }),
    kind: value.kind as DriverDiagnosticKind,
    observedAt,
    sequence,
    snapshot
  };
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return null;
  }
}

export function parseDriverDiagnosticEnvelopeDetailed(value: unknown): ParsedDriverDiagnosticEnvelope | null {
  const byteLength = serializedByteLength(value);
  if (byteLength === null || byteLength > DRIVER_DIAGNOSTIC_MAX_BATCH_BYTES || !isObject(value)) return null;
  if (value.schemaVersion !== DRIVER_DIAGNOSTIC_SCHEMA_VERSION || !Array.isArray(value.records)) return null;
  if (value.records.length > DRIVER_DIAGNOSTIC_MAX_RECORDS) return null;

  const batchId = safeUuid(value.batchId);
  const bootId = safeUuid(value.bootId);
  const discardedRecordCount = safeDatabaseInteger(value.discardedRecordCount);
  const liveContext = sanitizeContext(value.liveContext);
  const liveSnapshot = parseDriverDiagnosticSnapshot(value.liveSnapshot);
  const sentAt = safeTimestamp(value.sentAt);
  if (
    batchId === undefined || bootId === undefined || discardedRecordCount === undefined
    || liveContext === null || liveSnapshot === null || sentAt === undefined
  ) return null;

  const records: DriverDiagnosticRecord[] = [];
  const rejectedRecords: RejectedDriverDiagnosticRecord[] = [];
  value.records.forEach((record, index) => {
    const parsed = sanitizeRecord(record);
    if (parsed !== null) {
      records.push(parsed);
      return;
    }
    rejectedRecords.push({
      code: 'INVALID_RECORD',
      diagnosticId: isObject(record) ? safeUuid(record.diagnosticId) ?? null : null,
      index
    });
  });

  return {
    envelope: {
      batchId,
      bootId,
      discardedRecordCount,
      liveContext,
      liveSnapshot,
      records,
      schemaVersion: DRIVER_DIAGNOSTIC_SCHEMA_VERSION,
      sentAt
    },
    rejectedRecords
  };
}

export function parseDriverDiagnosticEnvelope(value: unknown): DriverDiagnosticEnvelope | null {
  return parseDriverDiagnosticEnvelopeDetailed(value)?.envelope ?? null;
}
