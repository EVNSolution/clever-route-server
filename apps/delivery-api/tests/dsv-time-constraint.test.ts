import { describe, expect, test } from 'vitest';

import {
  deriveDsvTimeConstraintState,
  dsvAllowedTimeConstraintRedactedDiffKeys,
  dsvCanonicalNoteHash,
  isValidTimeConstraintRedactedDiff,
} from '../src/modules/dsv/dsv-time-constraint.js';

describe('DSV special instruction time constraint state', () => {
  test('keeps raw notes independent and never emits MVP feasibility statuses', () => {
    const state = deriveDsvTimeConstraintState({
      audits: [],
      currentRouteVersionCreatedAt: null,
      currentRouteVersionId: null,
      rawNote: ' 오전 11시 배송 ',
      timeWindowEnd: null,
      timeWindowStart: null,
    });

    expect(state).toEqual({
      rawNote: '오전 11시 배송',
      reviewStatus: 'UNCONFIRMED',
      routeConstraintStatus: 'UNCONFIRMED',
      timeConstraint: null,
    });
    expect(state.routeConstraintStatus).not.toBe('FEASIBLE');
    expect(state.routeConstraintStatus).not.toBe('INFEASIBLE');
  });

  test('derives pending and not evaluated from confirmed audit timestamp versus route version timestamp', () => {
    const noteHash = dsvCanonicalNoteHash('오전 11시 배송');
    const audits = [{
      actorId: 'admin-1',
      eventType: 'TIME_CONSTRAINT_CONFIRMED',
      id: 'audit-1',
      occurredAt: new Date('2026-08-03T09:50:00.000Z'),
      redactedDiff: redactedDiff(noteHash),
    }];

    expect(deriveDsvTimeConstraintState({
      audits,
      currentRouteVersionCreatedAt: new Date('2026-08-03T09:40:00.000Z'),
      currentRouteVersionId: 'route-version-1',
      rawNote: '오전 11시 배송',
      timeWindowEnd: new Date('1970-01-01T11:00:00.000Z'),
      timeWindowStart: new Date('1970-01-01T10:30:00.000Z'),
    })).toMatchObject({
      reviewStatus: 'CONFIRMED',
      routeConstraintStatus: 'PENDING_RECALCULATION',
      timeConstraint: {
        auditEventId: 'audit-1',
        confirmedBy: 'admin-1',
        timeWindowEnd: '11:00',
        timeWindowStart: '10:30',
      },
    });

    expect(deriveDsvTimeConstraintState({
      audits,
      currentRouteVersionCreatedAt: new Date('2026-08-03T10:00:00.000Z'),
      currentRouteVersionId: 'route-version-2',
      rawNote: '오전 11시 배송',
      timeWindowEnd: new Date('1970-01-01T11:00:00.000Z'),
      timeWindowStart: new Date('1970-01-01T10:30:00.000Z'),
    }).routeConstraintStatus).toBe('NOT_EVALUATED');
  });

  test('clear suppresses repeat prompts for same note hash and changed notes invalidate the review', () => {
    const audits = [{
      actorId: null,
      eventType: 'TIME_CONSTRAINT_CLEARED',
      id: 'audit-clear',
      occurredAt: new Date('2026-08-03T09:50:00.000Z'),
      redactedDiff: redactedDiff(dsvCanonicalNoteHash('오전 11시 배송')),
    }];

    expect(deriveDsvTimeConstraintState({
      audits,
      currentRouteVersionCreatedAt: null,
      currentRouteVersionId: null,
      rawNote: '오전 11시 배송',
      timeWindowEnd: null,
      timeWindowStart: null,
    })).toMatchObject({
      reviewStatus: 'CLEARED',
      routeConstraintStatus: 'NOT_APPLICABLE',
      timeConstraint: null,
    });

    expect(deriveDsvTimeConstraintState({
      audits,
      currentRouteVersionCreatedAt: null,
      currentRouteVersionId: null,
      rawNote: '오전 10시 배송',
      timeWindowEnd: null,
      timeWindowStart: null,
    })).toMatchObject({
      reviewStatus: 'UNCONFIRMED',
      routeConstraintStatus: 'UNCONFIRMED',
    });
  });

  test('accepts only approved redacted audit keys', () => {
    const allowed = Object.fromEntries(dsvAllowedTimeConstraintRedactedDiffKeys.map((key) => [key, null]));
    expect(isValidTimeConstraintRedactedDiff(allowed)).toBe(true);
    expect(isValidTimeConstraintRedactedDiff({ ...allowed, rawNote: '오전 11시 배송' })).toBe(false);
    expect(isValidTimeConstraintRedactedDiff({ ...allowed, address: 'private address' })).toBe(false);
    expect(isValidTimeConstraintRedactedDiff({ ...allowed, routeConstraintStatus: 'PENDING_RECALCULATION' })).toBe(false);
  });
});

function redactedDiff(noteHash: string): Record<string, unknown> {
  return {
    commandId: 'cmd-1',
    deliveryStopId: 'stop-1',
    newTimeWindowEnd: '11:00',
    newTimeWindowStart: '10:30',
    noteHash,
    priorTimeWindowEnd: null,
    priorTimeWindowStart: null,
    sellerOrderId: 'order-1',
    sourceNotePresent: true,
  };
}
