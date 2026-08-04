import { createHash } from 'node:crypto';

export const dsvTimeConstraintAuditEvents = [
  'TIME_CONSTRAINT_CONFIRMED',
  'TIME_CONSTRAINT_CLEARED',
] as const;

export type DsvTimeConstraintAuditEventType = typeof dsvTimeConstraintAuditEvents[number];
export type DsvTimeConstraintReviewStatus = 'CLEARED' | 'CONFIRMED' | 'UNCONFIRMED' | 'NOT_APPLICABLE';
export type DsvRouteConstraintStatus =
  | 'NOT_APPLICABLE'
  | 'UNCONFIRMED'
  | 'PENDING_RECALCULATION'
  | 'NOT_EVALUATED';

export type DsvTimeConstraintDto = {
  auditEventId: string;
  confirmedAt: string;
  confirmedBy?: string;
  status: 'CONFIRMED';
  timeWindowEnd: string;
  timeWindowStart: string;
};

export type DsvCanonicalTimeConstraintState = {
  rawNote: string | null;
  reviewStatus: DsvTimeConstraintReviewStatus;
  routeConstraintStatus: DsvRouteConstraintStatus;
  timeConstraint: DsvTimeConstraintDto | null;
};

export type DsvTimeConstraintAuditInput = {
  actorId: string | null;
  eventType: string;
  id: string;
  occurredAt: Date;
  redactedDiff: unknown;
};

export type DsvTimeConstraintStateInput = {
  audits: readonly DsvTimeConstraintAuditInput[];
  currentRouteVersionCreatedAt: Date | null;
  currentRouteVersionId: string | null;
  rawNote: string | null;
  timeWindowEnd: Date | string | null;
  timeWindowStart: Date | string | null;
};

export const dsvAllowedTimeConstraintRedactedDiffKeys = [
  'commandId',
  'deliveryStopId',
  'newTimeWindowEnd',
  'newTimeWindowStart',
  'noteHash',
  'priorTimeWindowEnd',
  'priorTimeWindowStart',
  'sellerOrderId',
  'sourceNotePresent',
] as const;

type ParsedTimeConstraintAudit = DsvTimeConstraintAuditInput & {
  noteHash: string;
};

export function deriveDsvTimeConstraintState(input: DsvTimeConstraintStateInput): DsvCanonicalTimeConstraintState {
  const rawNote = normalizeRawNote(input.rawNote);
  const noteHash = rawNote === null ? null : dsvCanonicalNoteHash(rawNote);
  const matchingAudit = latestValidMatchingAudit(input.audits, noteHash);
  const assigned = input.currentRouteVersionId !== null;

  if (matchingAudit?.eventType === 'TIME_CONSTRAINT_CONFIRMED') {
    const timeWindowStart = formatTimeOnly(input.timeWindowStart);
    const timeWindowEnd = formatTimeOnly(input.timeWindowEnd);
    const pending = assigned
      && input.currentRouteVersionCreatedAt !== null
      && matchingAudit.occurredAt.getTime() > input.currentRouteVersionCreatedAt.getTime();
    return {
      rawNote,
      reviewStatus: 'CONFIRMED',
      routeConstraintStatus: pending ? 'PENDING_RECALCULATION' : 'NOT_EVALUATED',
      timeConstraint: timeWindowStart === null || timeWindowEnd === null
        ? null
        : {
            auditEventId: matchingAudit.id,
            confirmedAt: matchingAudit.occurredAt.toISOString(),
            ...(matchingAudit.actorId === null ? {} : { confirmedBy: matchingAudit.actorId }),
            status: 'CONFIRMED',
            timeWindowEnd,
            timeWindowStart,
          },
    };
  }

  if (matchingAudit?.eventType === 'TIME_CONSTRAINT_CLEARED') {
    const pending = assigned
      && input.currentRouteVersionCreatedAt !== null
      && matchingAudit.occurredAt.getTime() > input.currentRouteVersionCreatedAt.getTime();
    return {
      rawNote,
      reviewStatus: 'CLEARED',
      routeConstraintStatus: pending ? 'PENDING_RECALCULATION' : 'NOT_APPLICABLE',
      timeConstraint: null,
    };
  }

  if (rawNote !== null) {
    return {
      rawNote,
      reviewStatus: 'UNCONFIRMED',
      routeConstraintStatus: 'UNCONFIRMED',
      timeConstraint: null,
    };
  }

  return {
    rawNote: null,
    reviewStatus: 'NOT_APPLICABLE',
    routeConstraintStatus: 'NOT_APPLICABLE',
    timeConstraint: null,
  };
}

export function dsvCanonicalNoteHash(rawNote: string): string {
  return createHash('sha256').update(normalizeRawNote(rawNote) ?? '').digest('hex');
}

export function normalizeRawNote(rawNote: string | null | undefined): string | null {
  const normalized = rawNote?.trim();
  return normalized === undefined || normalized === '' ? null : normalized;
}

export function formatTimeOnly(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCHours().toString().padStart(2, '0')}:${date.getUTCMinutes().toString().padStart(2, '0')}`;
}

export function parseTimeOnlyAsUtcDate(value: string): Date | null {
  if (!/^\d{2}:\d{2}$/u.test(value)) return null;
  const [hourRaw, minuteRaw] = value.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return new Date(Date.UTC(1970, 0, 1, hour, minute, 0, 0));
}

export function dsvTimeOnlyMinutes(value: string): number | null {
  const parsed = parseTimeOnlyAsUtcDate(value);
  if (parsed === null) return null;
  return parsed.getUTCHours() * 60 + parsed.getUTCMinutes();
}

export function isValidTimeConstraintRedactedDiff(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => dsvAllowedTimeConstraintRedactedDiffKeys.includes(
    key as typeof dsvAllowedTimeConstraintRedactedDiffKeys[number],
  ));
}

function latestValidMatchingAudit(
  audits: readonly DsvTimeConstraintAuditInput[],
  noteHash: string | null,
): ParsedTimeConstraintAudit | null {
  if (noteHash === null) return null;
  const sorted = [...audits].sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
  for (const audit of sorted) {
    if (!isTimeConstraintAuditType(audit.eventType) || !isValidTimeConstraintRedactedDiff(audit.redactedDiff)) continue;
    const auditNoteHash = audit.redactedDiff.noteHash;
    if (auditNoteHash === noteHash) return { ...audit, noteHash };
  }
  return null;
}

function isTimeConstraintAuditType(value: string): value is DsvTimeConstraintAuditEventType {
  return dsvTimeConstraintAuditEvents.includes(value as DsvTimeConstraintAuditEventType);
}
