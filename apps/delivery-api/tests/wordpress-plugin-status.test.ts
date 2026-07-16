import { describe, expect, test } from 'vitest';

import {
  toInternalRoutePlanStatuses,
  toWordPressRoutePlanStatus,
  toWordPressStopStatus
} from '../src/modules/wordpress-plugin/wordpress-plugin-status.js';

describe('WordPress plugin status DTO mapping', () => {
  test('maps route plan statuses exactly for WordPress DTOs', () => {
    expect(toWordPressRoutePlanStatus('READY')).toBe('published');
    expect(toWordPressRoutePlanStatus('IN_PROGRESS')).toBe('published');
    expect(toWordPressRoutePlanStatus('COMPLETED')).toBe('published');
    expect(toWordPressRoutePlanStatus('DRAFT')).toBe('published');
    expect(toWordPressRoutePlanStatus('PUBLISHED')).toBe('published');
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
    expect(toInternalRoutePlanStatuses('published')).toEqual([
      'READY', 'DRAFT', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'
    ]);
    expect(toInternalRoutePlanStatuses('in_progress')).toEqual(['IN_PROGRESS']);
    expect(toInternalRoutePlanStatuses('completed')).toEqual(['COMPLETED']);
    expect(toInternalRoutePlanStatuses('bogus')).toBeNull();
  });
});
