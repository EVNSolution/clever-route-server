import { describe, expect, test } from 'vitest';

import {
  toInternalRoutePlanStatus,
  toWordPressRoutePlanStatus,
  toWordPressStopStatus
} from '../src/modules/wordpress-plugin/wordpress-plugin-status.js';

describe('WordPress plugin status DTO mapping', () => {
  test('maps route plan statuses exactly for WordPress DTOs', () => {
    expect(toWordPressRoutePlanStatus('DRAFT')).toBe('draft');
    expect(toWordPressRoutePlanStatus('OPTIMIZED')).toBe('optimized');
    expect(toWordPressRoutePlanStatus('ASSIGNED')).toBe('assigned');
    expect(toWordPressRoutePlanStatus('IN_PROGRESS')).toBe('in_progress');
    expect(toWordPressRoutePlanStatus('COMPLETED')).toBe('completed');
    expect(toWordPressRoutePlanStatus('CANCELLED')).toBe('cancelled');
  });

  test('maps stop statuses exactly for WordPress DTOs', () => {
    expect(toWordPressStopStatus('PENDING')).toBe('pending');
    expect(toWordPressStopStatus('ASSIGNED')).toBe('assigned');
    expect(toWordPressStopStatus('EN_ROUTE')).toBe('en_route');
    expect(toWordPressStopStatus('ARRIVED')).toBe('arrived');
    expect(toWordPressStopStatus('DELIVERED')).toBe('delivered');
    expect(toWordPressStopStatus('FAILED')).toBe('failed');
    expect(toWordPressStopStatus('SKIPPED')).toBe('skipped');
    expect(toWordPressStopStatus('CANCELLED')).toBe('cancelled');
  });

  test('maps plugin status filters back to internal route plan enums', () => {
    expect(toInternalRoutePlanStatus('in_progress')).toBe('IN_PROGRESS');
    expect(toInternalRoutePlanStatus('bogus')).toBeNull();
  });
});
