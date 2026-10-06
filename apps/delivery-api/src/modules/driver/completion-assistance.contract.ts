const MAX_EVIDENCE_SAMPLES = 64;
const MAX_ASSIGNMENT_GENERATION = 9_223_372_036_854_775_807n;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export type CompletionPolicy = {
  version: string;
  maxAccuracyMeters: number;
  enterRadiusMeters: number;
  exitRadiusMeters: number;
  dwellMs: number;
  maxGapMs: number;
  minDwellSamples: number;
  ambiguityRadiusMeters: number;
};

export type CompletionSample = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  occurredAt: string;
};

export type CompletionStop = {
  deliveryStopId: string;
  coordinates: { latitude: number; longitude: number } | null;
  status: string;
  label?: string;
  manualResponse?: { response: 'completed' | 'failed'; occurredAt: string };
};

export type CompletionRun = {
  runId: string;
  routePlanId: string;
  assignmentGeneration: string;
  expectedRouteVersionId: string;
  routeName?: string;
  policy: CompletionPolicy;
  stops: CompletionStop[];
  trackingEndedAt?: string;
};

export type CompletionCandidate = {
  candidateId: string;
  runId: string;
  routePlanId: string;
  assignmentGeneration: string;
  expectedRouteVersionId: string;
  deliveryStopId: string;
  routeName?: string;
  stopLabel?: string;
  arrivalAt: string;
  dwellCompletedAt: string;
  exitAt: string;
  evidence: CompletionSample[];
  policyVersion: string;
  status: 'awaiting_response' | 'responded' | 'inferred_completed' | 'held' | 'invalidated';
  revision: number;
  response?: 'completed' | 'failed' | 'not_completed';
  responseAt?: string;
  responseDeadlineAt?: string;
  autoCompletedAt?: string;
  holdReason?: string;
  notified?: boolean;
};

export type CompletionCommand =
  | { kind: 'candidate'; commandId: string; candidate: CompletionCandidate; occurredAt: string }
  | {
      kind: 'response';
      commandId: string;
      candidateId: string;
      runId: string;
      routePlanId: string;
      assignmentGeneration: string;
      expectedRouteVersionId: string;
      deliveryStopId: string;
      response: 'completed' | 'failed' | 'not_completed';
      occurredAt: string;
      expectedRevision: number;
      previousResponseCommandId?: string;
    }
  | {
      kind: 'return_intent';
      commandId: string;
      runId: string;
      routePlanId: string;
      assignmentGeneration: string;
      expectedRouteVersionId: string;
      occurredAt: string;
    };

export type CompletionAcknowledgement = {
  contractVersion: 1;
  commandId: string;
  status: 'applied' | 'duplicate' | 'rejected';
  candidate?: CompletionCandidate;
  reason?: string;
};

export class CompletionAssistanceValidationError extends Error {
  readonly code = 'COMPLETION_ASSISTANCE_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'CompletionAssistanceValidationError';
  }
}

export function parseCompletionPolicy(value: unknown): CompletionPolicy | null {
  if (!isRecordWithKeys(value, [
    'ambiguityRadiusMeters', 'dwellMs', 'enterRadiusMeters', 'exitRadiusMeters',
    'maxAccuracyMeters', 'maxGapMs', 'minDwellSamples', 'version'
  ])) return null;
  if (
    !isOpaqueId(value.version)
    || !isPositiveNumber(value.maxAccuracyMeters)
    || !isPositiveNumber(value.enterRadiusMeters)
    || !isPositiveNumber(value.exitRadiusMeters)
    || value.maxAccuracyMeters >= value.enterRadiusMeters
    || value.enterRadiusMeters >= value.exitRadiusMeters
    || !isPositiveNumber(value.dwellMs)
    || !isPositiveNumber(value.maxGapMs)
    || value.maxGapMs > value.dwellMs
    || !Number.isInteger(value.minDwellSamples)
    || Number(value.minDwellSamples) < 3
    || Number(value.minDwellSamples) > MAX_EVIDENCE_SAMPLES - 2
    || !isPositiveNumber(value.ambiguityRadiusMeters)
    || value.ambiguityRadiusMeters < value.enterRadiusMeters
  ) return null;
  return value as CompletionPolicy;
}

export function parseCompletionCommand(body: unknown): CompletionCommand {
  if (!isRecordWithKeys(body, ['command', 'contractVersion']) || body.contractVersion !== 1) {
    throw new CompletionAssistanceValidationError('Completion assistance contractVersion must be 1.');
  }
  const command = body.command;
  if (!isRecord(command) || !isOpaqueId(command.commandId)) {
    throw new CompletionAssistanceValidationError('Completion assistance command identity is invalid.');
  }
  if (command.kind === 'candidate' && isRecordWithKeys(command, ['candidate', 'commandId', 'kind', 'occurredAt'])) {
    const candidate = parseCandidate(command.candidate);
    if (!isTimestamp(command.occurredAt) || command.occurredAt !== candidate.exitAt) {
      throw new CompletionAssistanceValidationError('Candidate command occurredAt must equal candidate exitAt.');
    }
    return { kind: 'candidate', commandId: command.commandId, candidate, occurredAt: command.occurredAt };
  }
  if (command.kind === 'response' && hasOnlyKeys(command, [
    'assignmentGeneration', 'candidateId', 'commandId', 'deliveryStopId', 'expectedRevision',
    'expectedRouteVersionId', 'kind', 'occurredAt', 'previousResponseCommandId', 'response', 'routePlanId', 'runId'
  ])) {
    requireIdentity(command);
    if (
      !isOpaqueId(command.candidateId)
      || !isOpaqueId(command.deliveryStopId)
      || typeof command.response !== 'string'
      || !['completed', 'failed', 'not_completed'].includes(command.response)
      || !isTimestamp(command.occurredAt)
      || !Number.isSafeInteger(command.expectedRevision)
      || Number(command.expectedRevision) < 0
      || (command.previousResponseCommandId !== undefined
        && (!isOpaqueId(command.previousResponseCommandId) || command.previousResponseCommandId === command.commandId))
    ) throw new CompletionAssistanceValidationError('Completion assistance response command is invalid.');
    return command as CompletionCommand;
  }
  if (command.kind === 'return_intent' && isRecordWithKeys(command, [
    'assignmentGeneration', 'commandId', 'expectedRouteVersionId', 'kind', 'occurredAt', 'routePlanId', 'runId'
  ])) {
    requireIdentity(command);
    if (!isTimestamp(command.occurredAt)) {
      throw new CompletionAssistanceValidationError('Completion assistance return intent timestamp is invalid.');
    }
    return command as CompletionCommand;
  }
  throw new CompletionAssistanceValidationError('Completion assistance command is malformed.');
}

function parseCandidate(value: unknown): CompletionCandidate {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'arrivalAt', 'assignmentGeneration', 'autoCompletedAt', 'candidateId', 'deliveryStopId', 'dwellCompletedAt',
    'evidence', 'exitAt', 'expectedRouteVersionId', 'holdReason', 'notified', 'policyVersion', 'response',
    'responseAt', 'responseDeadlineAt', 'revision', 'routeName', 'routePlanId', 'runId', 'status', 'stopLabel'
  ])) throw new CompletionAssistanceValidationError('Completion assistance candidate is malformed.');
  requireIdentity(value);
  if (
    !isOpaqueId(value.candidateId)
    || !isOpaqueId(value.deliveryStopId)
    || !isOpaqueId(value.policyVersion)
    || !optionalOpaqueString(value.routeName)
    || !optionalOpaqueString(value.stopLabel)
    || !isTimestamp(value.arrivalAt)
    || !isTimestamp(value.dwellCompletedAt)
    || !isTimestamp(value.exitAt)
    || Date.parse(value.arrivalAt) > Date.parse(value.dwellCompletedAt)
    || Date.parse(value.dwellCompletedAt) > Date.parse(value.exitAt)
    || !Array.isArray(value.evidence)
    || value.evidence.length === 0
    || value.evidence.length > MAX_EVIDENCE_SAMPLES
    || !value.evidence.every(isSample)
    || !hasStrictlyOrderedSamples(value.evidence)
    || Date.parse(value.evidence[0]!.occurredAt) > Date.parse(value.arrivalAt)
    || value.evidence.at(-1)?.occurredAt !== value.exitAt
    || typeof value.status !== 'string'
    || !['awaiting_response', 'responded', 'inferred_completed', 'held', 'invalidated'].includes(value.status)
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || (value.response !== undefined
      && (typeof value.response !== 'string'
        || !['completed', 'failed', 'not_completed'].includes(value.response)))
    || (value.status === 'responded' && (value.response === undefined || !isTimestamp(value.responseAt)))
    || (value.status === 'inferred_completed'
      && (!isTimestamp(value.responseDeadlineAt) || !isTimestamp(value.autoCompletedAt)))
    || !optionalTimestamp(value.responseAt)
    || !optionalTimestamp(value.responseDeadlineAt)
    || !optionalTimestamp(value.autoCompletedAt)
    || !optionalOpaqueString(value.holdReason)
    || (value.notified !== undefined && typeof value.notified !== 'boolean')
  ) throw new CompletionAssistanceValidationError('Completion assistance candidate fields are invalid.');
  return value as CompletionCandidate;
}

function requireIdentity(value: Record<string, unknown>): void {
  if (
    !isOpaqueId(value.runId)
    || !isOpaqueId(value.routePlanId)
    || !isCanonicalGeneration(value.assignmentGeneration)
    || typeof value.expectedRouteVersionId !== 'string'
    || !UUID_PATTERN.test(value.expectedRouteVersionId)
  ) throw new CompletionAssistanceValidationError('Completion assistance assignment identity is invalid.');
}

function isCanonicalGeneration(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 19 || !/^[1-9][0-9]*$/u.test(value)) return false;
  try { return BigInt(value) <= MAX_ASSIGNMENT_GENERATION; } catch { return false; }
}

function isSample(value: unknown): value is CompletionSample {
  return isRecordWithKeys(value, ['accuracyMeters', 'latitude', 'longitude', 'occurredAt'])
    && isCoordinate(value)
    && typeof value.accuracyMeters === 'number'
    && Number.isFinite(value.accuracyMeters)
    && value.accuracyMeters >= 0
    && isTimestamp(value.occurredAt);
}

function isCoordinate(value: Record<string, unknown>): boolean {
  return typeof value.latitude === 'number' && Number.isFinite(value.latitude)
    && value.latitude >= -90 && value.latitude <= 90
    && typeof value.longitude === 'number' && Number.isFinite(value.longitude)
    && value.longitude >= -180 && value.longitude <= 180;
}

function hasStrictlyOrderedSamples(samples: CompletionSample[]): boolean {
  return samples.every((sample, index) => index === 0
    || Date.parse(sample.occurredAt) > Date.parse(samples[index - 1]!.occurredAt));
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalOpaqueString(value: unknown): boolean {
  return value === undefined || isOpaqueId(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
