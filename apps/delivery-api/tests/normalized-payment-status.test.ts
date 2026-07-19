import { describe, expect, test } from 'vitest';

import { resolveNormalizedPaymentStatus } from '../src/modules/payments/normalized-payment-status.js';

describe('resolveNormalizedPaymentStatus', () => {
  test('keeps canonical payment status ahead of a legacy financial status', () => {
    expect(resolveNormalizedPaymentStatus({
      financialStatus: 'PAID',
      normalizedPaymentStatus: 'CASH_COLLECT_REQUIRED'
    })).toBe('CASH_COLLECT_REQUIRED');
  });

  test('derives safe driver payment states from Shopify financial status', () => {
    expect(resolveNormalizedPaymentStatus({ financialStatus: 'PAID', normalizedPaymentStatus: null }))
      .toBe('PAID_CONFIRMED');
    expect(resolveNormalizedPaymentStatus({ financialStatus: 'REFUNDED', normalizedPaymentStatus: null }))
      .toBe('NOT_DELIVERABLE_OR_EXCEPTION');
    expect(resolveNormalizedPaymentStatus({ financialStatus: 'PENDING', normalizedPaymentStatus: null }))
      .toBe('UNKNOWN_REVIEW');
    expect(resolveNormalizedPaymentStatus({ financialStatus: null, normalizedPaymentStatus: null }))
      .toBeNull();
  });
});
