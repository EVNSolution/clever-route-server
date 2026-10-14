import { describe, expect, test } from 'vitest';

import {
  isRouteEmailSelected,
  parseRouteEmailSelectionPayload,
  readRouteEmailSelection,
} from '../src/modules/customer-email/customer-email-route-selection.js';

describe('customer email route selection', () => {
  test('keeps legacy selections explicit when mode is absent', () => {
    const constraints = selection({ deliveryStopIds: ['stop-1'] });

    expect(readRouteEmailSelection(constraints)?.mode).toBe('EXPLICIT');
    expect(isRouteEmailSelected(constraints, 'DELIVERED', 'stop-1')).toBe(true);
    expect(isRouteEmailSelected(constraints, 'DELIVERED', 'late-stop')).toBe(false);
  });

  test('selects future eligible route stops in ALL_ELIGIBLE mode', () => {
    const constraints = selection({ deliveryStopIds: [], mode: 'ALL_ELIGIBLE' });

    expect(isRouteEmailSelected(constraints, 'DELIVERED', 'late-stop')).toBe(true);
    expect(isRouteEmailSelected(constraints, 'MISSED_DELIVERY', 'late-stop')).toBe(false);
  });

  test('parses the optional mode and rejects unknown modes', () => {
    expect(parseRouteEmailSelectionPayload({
      deliveryStopIds: [],
      mode: 'ALL_ELIGIBLE',
      signals: ['DELIVERED'],
    })).toEqual({ deliveryStopIds: [], mode: 'ALL_ELIGIBLE', signals: ['DELIVERED'] });
    expect(parseRouteEmailSelectionPayload({
      deliveryStopIds: ['stop-1'],
      signals: ['DELIVERED'],
    })).toEqual({ deliveryStopIds: ['stop-1'], mode: 'EXPLICIT', signals: ['DELIVERED'] });
    expect(parseRouteEmailSelectionPayload({
      deliveryStopIds: [],
      mode: 'FUTURE',
      signals: ['DELIVERED'],
    })).toBeNull();
  });
});

function selection(overrides: { deliveryStopIds: string[]; mode?: string }) {
  return {
    customerEmailSelection: {
      ...overrides,
      signals: ['DELIVERED'],
      updatedAt: '2026-10-14T00:00:00.000Z',
      updatedBy: 'office',
    },
  };
}
