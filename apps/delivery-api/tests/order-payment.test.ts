import { Prisma } from '@prisma/client';
import { describe, expect, test } from 'vitest';

import { resolveOrderPayment } from '../src/modules/payments/order-payment.js';

const order = {
  currencyCode: 'CAD',
  financialStatus: 'PENDING',
  rawPayload: { paymentGatewayNames: ['Cash on Delivery (COD)'] },
  totalPriceAmount: new Prisma.Decimal('122.25')
};

describe('shared order payment contract', () => {
  test.each([
    [{ paymentGatewayNames: ['Cash on Delivery (COD)'] }, 'CASH', 'Cash'],
    [{ payment_gateway_names: ['Email Money Transfer'] }, 'ETRANSFER', 'e-Transfer'],
    [{ cleverManualPaymentMethod: 'CASH' }, 'CASH', 'Cash'],
    [{ cleverManualPaymentStatus: 'ETRANSFER' }, 'ETRANSFER', 'e-Transfer'],
    [{ paymentGatewayNames: ['manual'], cleverManualPaymentMethod: 'CASH' }, 'CASH', 'Cash'],
    [{ paymentGatewayNames: ['manual'], payment_method_title: 'eTransfer' }, 'ETRANSFER', 'eTransfer'],
    [{ payment_method_title: 'Cash on delivery' }, 'CASH', 'Cash on delivery'],
    [{ paymentMethod: 'ETRANSFER' }, 'ETRANSFER', 'ETRANSFER'],
    [{ paymentGatewayNames: ['eTransfer'], cleverManualPaymentMethod: 'CASH' }, 'ETRANSFER', 'e-Transfer'],
    [{ paymentGatewayNames: ['shopify_payments'], paymentMethodTitle: 'Cash' }, 'OTHER', 'Shopify Payments'],
    [{ paymentGatewayNames: ['cashback rewards'] }, 'OTHER', 'cashback rewards'],
    [{ paymentGatewayNames: ['codapay'] }, 'OTHER', 'codapay'],
    [{ paymentGatewayNames: ['manual'] }, 'UNKNOWN', 'Manual'],
    [{ paymentGatewayNames: ['Cash', 'eTransfer'] }, 'UNKNOWN', 'Cash / e-Transfer'],
    [{}, 'UNKNOWN', null]
  ])('reads gateway/manual/legacy method without guessing: %j', (rawPayload, method, methodTitle) => {
    expect(resolveOrderPayment({ ...order, rawPayload })).toMatchObject({ method, methodTitle });
  });

  test('uses total only for an explicitly unpaid order and preserves exact cents', () => {
    expect(resolveOrderPayment(order)).toEqual({
      currencyCode: 'CAD', expectedAmount: '122.25', expectedAmountSource: 'UNPAID_ORDER_TOTAL',
      financialStatus: 'PENDING', gatewayNames: ['Cash on Delivery (COD)'], method: 'CASH',
      methodTitle: 'Cash', requiresCashInput: true
    });
  });

  test.each(['PARTIALLY_PAID', 'UNKNOWN', 'AUTHORIZED', 'Cash', null])('does not treat total as balance for %s', (financialStatus) => {
    expect(resolveOrderPayment({ ...order, financialStatus })).toMatchObject({
      expectedAmount: null, expectedAmountSource: 'UNKNOWN'
    });
  });

  test('uses explicit outstanding for a partial payment', () => {
    expect(resolveOrderPayment({ ...order, financialStatus: 'PARTIALLY_PAID', rawPayload: {
      ...order.rawPayload, totalOutstandingSet: { shopMoney: { amount: '22.25', currencyCode: 'CAD' } }
    } })).toMatchObject({ expectedAmount: '22.25', expectedAmountSource: 'SHOPIFY_OUTSTANDING', requiresCashInput: true });
  });

  test.each(['0', '0.0', '0.00', '-0.00'])('zero outstanding %s needs no cash input', (amount) => {
    expect(resolveOrderPayment({ ...order, rawPayload: {
      ...order.rawPayload, totalOutstandingSet: { shopMoney: { amount, currencyCode: 'CAD' } }
    } })).toMatchObject({ expectedAmount: '0.00', requiresCashInput: false });
  });

  test('a negative outstanding is a refund balance, not cash to collect', () => {
    expect(resolveOrderPayment({ ...order, rawPayload: {
      ...order.rawPayload, totalOutstandingSet: { shopMoney: { amount: '-1.25', currencyCode: 'CAD' } }
    } })).toMatchObject({ expectedAmount: '-1.25', requiresCashInput: false });
  });

  test.each(['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'VOIDED'])('does not require cash for %s', (financialStatus) => {
    const payment = resolveOrderPayment({ ...order, financialStatus });
    expect(payment.requiresCashInput).toBe(false);
    expect(payment.expectedAmount).toBe(financialStatus === 'PAID' ? '0.00' : null);
  });

  test('an explicit office paid marker suppresses collection without mutating source totals', () => {
    const input = { ...order, rawPayload: { ...order.rawPayload, cleverManualPaymentStatus: 'PAID' } };
    expect(resolveOrderPayment(input)).toMatchObject({ expectedAmount: '0.00', expectedAmountSource: 'PAID', requiresCashInput: false });
    expect(input.totalPriceAmount.toString()).toBe('122.25');
  });

  test('a pending office marker cannot reinterpret a partially paid total as outstanding', () => {
    expect(resolveOrderPayment({ ...order, financialStatus: 'PARTIALLY_PAID', rawPayload: {
      ...order.rawPayload, cleverManualPaymentStatus: 'PENDING'
    } })).toMatchObject({ expectedAmount: null, expectedAmountSource: 'UNKNOWN' });
  });

  test('an office edit of both local status fields cannot erase the original partial-payment evidence', () => {
    expect(resolveOrderPayment({ ...order, financialStatus: 'PENDING', rawPayload: {
      ...order.rawPayload, displayFinancialStatus: 'PARTIALLY_PAID', cleverManualPaymentStatus: 'PENDING'
    } })).toMatchObject({ expectedAmount: null, expectedAmountSource: 'UNKNOWN', requiresCashInput: true });
  });

  test.each([
    { displayFinancialStatus: 'PAID' },
    { financial_status: 'paid' }
  ])('a locally unpaid order cannot use total when its source was already paid: %j', (source) => {
    expect(resolveOrderPayment({ ...order, financialStatus: 'UNPAID', rawPayload: {
      ...order.rawPayload, ...source
    } })).toMatchObject({ expectedAmount: null, expectedAmountSource: 'UNKNOWN' });
  });

  test.each([null, '', 'unknown'])('an unknown Cash currency (%s) does not waive actual-amount input', (currencyCode) => {
    expect(resolveOrderPayment({ ...order, currencyCode })).toMatchObject({
      method: 'CASH', currencyCode: null, expectedAmount: null, requiresCashInput: true
    });
  });

  test('paid Cash still needs no input when the currency is unknown', () => {
    expect(resolveOrderPayment({ ...order, currencyCode: null, financialStatus: 'PAID' })).toMatchObject({
      expectedAmount: '0.00', requiresCashInput: false
    });
  });

  test.each([
    { amount: '122.25', currencyCode: 'USD' },
    { amount: '122.251', currencyCode: 'CAD' },
    { amount: 122.25, currencyCode: 'CAD' },
    { amount: 'NaN', currencyCode: 'CAD' },
    { amount: '99999999999999999.00', currencyCode: 'CAD' },
    { amount: '22.25' }
  ])('does not fall back from an invalid explicit balance %j', (shopMoney) => {
    expect(resolveOrderPayment({ ...order, rawPayload: {
      ...order.rawPayload, totalOutstandingSet: { shopMoney }
    } })).toMatchObject({ expectedAmount: null, expectedAmountSource: 'UNKNOWN' });
  });

  test('an outstanding money bag can establish missing order currency', () => {
    expect(resolveOrderPayment({ ...order, currencyCode: null, rawPayload: {
      ...order.rawPayload, totalOutstandingSet: { shopMoney: { amount: '22.25', currencyCode: 'CAD' } }
    } })).toMatchObject({ expectedAmount: '22.25', currencyCode: 'CAD' });
  });

  test('eTransfer and unknown methods do not require cash input', () => {
    for (const rawPayload of [{ paymentGatewayNames: ['eTransfer'] }, {}]) {
      expect(resolveOrderPayment({ ...order, rawPayload }).requiresCashInput).toBe(false);
    }
  });

  test('keeps large exact decimals and does not silently round order totals', () => {
    expect(resolveOrderPayment({ ...order, totalPriceAmount: '9999999999999999.99' }).expectedAmount).toBe('9999999999999999.99');
    expect(resolveOrderPayment({ ...order, totalPriceAmount: '122.255' }).expectedAmount).toBeNull();
  });
});
