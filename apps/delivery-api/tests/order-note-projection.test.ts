import { describe, expect, test } from 'vitest';

import {
  toCanonicalOrderRow,
  toOrdersQueryRow,
  type CanonicalOrderRecord,
} from '../src/modules/shopify/order-sync.repository.js';

describe('canonical order note projection', () => {
  test('keeps source order, customer, and delivery stop notes semantically distinct', () => {
    const row = toCanonicalOrderRow(orderRecord({
      customer: { note: '  Call on arrival  ' },
      note: '  Leave beside the side door  ',
    }, 'Use the loading entrance'));

    expect(row).toMatchObject({
      customerNote: 'Call on arrival',
      deliveryInstructions: 'Use the loading entrance',
      note: 'Leave beside the side door',
    });
  });

  test('preserves explicit blank clears and does not revive older fallback values', () => {
    const row = toCanonicalOrderRow(orderRecord({
      customer: { note: 'stale nested customer note' },
      customerNote: '   ',
      note: '',
    }, 'stale delivery instruction'));

    expect(row.note).toBe('');
    expect(row.customerNote).toBe('');
    expect(row.deliveryInstructions).toBe('stale delivery instruction');
  });

  test('preserves explicit nulls while leaving absent source notes sparse', () => {
    const cleared = toCanonicalOrderRow(orderRecord({
      customer: { note: 'stale nested customer note' },
      customerNote: null,
      note: null,
    }, null));
    const absent = toCanonicalOrderRow(orderRecord({}, null));

    expect(cleared.note).toBeNull();
    expect(cleared.customerNote).toBeNull();
    expect(Object.hasOwn(absent, 'note')).toBe(false);
    expect(Object.hasOwn(absent, 'customerNote')).toBe(false);
  });

  test('uses the same note projection for paginated order rows', () => {
    const row = toOrdersQueryRow(
      orderRecord({ customer_note: 'Legacy customer note', note: 'Order note' }, 'Stop instruction'),
      {},
      new Date('2026-10-02T00:00:00.000Z'),
    );

    expect(row).toMatchObject({
      customerNote: 'Legacy customer note',
      deliveryInstructions: 'Stop instruction',
      note: 'Order note',
    });
  });

  test('projects WooCommerce customer_note as the source order note', () => {
    const row = toCanonicalOrderRow({
      ...orderRecord({ customer_note: 'Woo delivery note' }, 'Woo delivery note'),
      sourcePlatform: 'WOOCOMMERCE',
    });

    expect(row.note).toBe('Woo delivery note');
    expect(Object.hasOwn(row, 'customerNote')).toBe(false);
    expect(row.deliveryInstructions).toBe('Woo delivery note');
  });
});

function orderRecord(
  rawPayload: Record<string, unknown>,
  instructions: string | null,
): CanonicalOrderRecord {
  return {
    cancelledAt: null,
    currencyCode: 'CAD',
    deliveryStops: [{
      address1: '100 Test St',
      address2: null,
      city: 'Toronto',
      countryCode: 'CA',
      deliveryDate: null,
      geocodeStatus: 'PENDING',
      id: 'stop-1',
      instructions,
      latitude: null,
      longitude: null,
      phone: null,
      postalCode: 'M5V 1A1',
      province: 'ON',
      recipientName: 'Test Customer',
      routePlanStops: [],
      status: 'PENDING',
      timeWindowEnd: null,
      timeWindowStart: null,
    }],
    email: null,
    financialStatus: null,
    fulfillmentStatus: null,
    id: 'order-1',
    name: '#1001',
    phone: null,
    processedAt: new Date('2026-10-01T12:00:00.000Z'),
    rawPayload,
    shippingAddress: {},
    shopifyOrderGid: 'gid://shopify/Order/1001',
    shopifyOrderLegacyId: 1001n,
    totalPriceAmount: '10.00',
    updatedAtShopify: new Date('2026-10-01T13:00:00.000Z'),
  };
}
