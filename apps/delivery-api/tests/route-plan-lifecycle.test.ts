import { describe, expect, test } from 'vitest';

import {
  ROUTE_ACTIVE_COMPATIBILITY_STATUSES,
  ROUTE_DRIVER_OPERATIONAL_STATUSES,
  ROUTE_DRIVER_VISIBLE_STATUSES,
  isRouteReadyStatus,
  toRouteExecutionStatus
} from '../src/modules/route-plans/route-plan-lifecycle.js';

describe('route plan lifecycle', () => {
  test('treats legacy pre-execution values as Ready', () => {
    for (const status of ['READY', 'DRAFT', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED']) {
      expect(toRouteExecutionStatus(status)).toBe('READY');
      expect(isRouteReadyStatus(status)).toBe(true);
    }
  });

  test('preserves active, completed, and cancelled execution states', () => {
    expect(toRouteExecutionStatus('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(toRouteExecutionStatus('COMPLETED')).toBe('COMPLETED');
    expect(toRouteExecutionStatus('CANCELLED')).toBe('CANCELLED');
  });

  test('recovers legacy route execution state from persisted driver events', () => {
    expect(toRouteExecutionStatus('PUBLISHED', [{ eventType: 'ROUTE_STARTED' }])).toBe('IN_PROGRESS');
    expect(toRouteExecutionStatus('DRAFT', [
      { eventType: 'ROUTE_STARTED' },
      { eventType: 'ROUTE_COMPLETED' }
    ])).toBe('COMPLETED');
  });

  test('keeps completed routes visible but excludes them from active session restoration', () => {
    expect(ROUTE_DRIVER_VISIBLE_STATUSES).toContain('COMPLETED');
    expect(ROUTE_DRIVER_OPERATIONAL_STATUSES).not.toContain('COMPLETED');
    expect(ROUTE_ACTIVE_COMPATIBILITY_STATUSES).not.toContain('COMPLETED');
  });
});
