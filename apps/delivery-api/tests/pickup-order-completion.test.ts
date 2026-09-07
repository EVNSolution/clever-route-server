import { describe, expect, test } from 'vitest';

import { deriveOperateDeliveryStatus } from '../src/modules/shopify/order-operate-status.js';
import { isPickupComplete, pickupCompleteAfter, torontoDateOnly } from '../src/modules/shopify/pickup-order-completion.js';
import type { CanonicalOrderRow } from '../src/modules/shopify/order-sync.mapper.js';

describe('pickup order completion', () => {
  test('uses an explicit pickup end instant and completes at the inclusive boundary', () => {
    const input = pickup({ timeWindowEnd: '2026-09-04T20:00:00.000Z' });
    expect(pickupCompleteAfter(input)?.toISOString()).toBe('2026-09-04T20:00:00.000Z');
    expect(isPickupComplete(input, new Date('2026-09-04T19:59:59.999Z'))).toBe(false);
    expect(isPickupComplete(input, new Date('2026-09-04T20:00:00.000Z'))).toBe(true);
  });

  test('falls back to Toronto midnight after the delivery date across DST changes', () => {
    expect(pickupCompleteAfter(pickup({ deliveryDate: '2026-03-07', timeWindowEnd: null }))?.toISOString())
      .toBe('2026-03-08T05:00:00.000Z');
    expect(pickupCompleteAfter(pickup({ deliveryDate: '2026-03-08', timeWindowEnd: null }))?.toISOString())
      .toBe('2026-03-09T04:00:00.000Z');
    expect(torontoDateOnly(new Date('2026-09-05T03:59:59.999Z'))).toBe('2026-09-04');
    expect(torontoDateOnly(new Date('2026-09-05T04:00:00.000Z'))).toBe('2026-09-05');
  });

  test('does not auto-complete cancelled, non-pickup, or date-less orders', () => {
    expect(pickupCompleteAfter(pickup({ cancelledAt: '2026-09-04T12:00:00.000Z' }))).toBeNull();
    expect(pickupCompleteAfter(pickup({ serviceType: 'DELIVERY' }))).toBeNull();
    expect(pickupCompleteAfter(pickup({ deliveryDate: null, timeWindowEnd: null }))).toBeNull();
  });

  test('derives a failed route pickup as completed without changing its stop status', () => {
    const row = canonicalRow({
      deliveryStopStatus: 'FAILED',
      pickupCompleteAfter: '2026-09-05T04:00:00.000Z'
    });
    expect(deriveOperateDeliveryStatus(row, new Date('2026-09-05T04:00:00.000Z'))).toBe('completed');
    expect(row.deliveryStopStatus).toBe('FAILED');
  });
});

function pickup(overrides: Partial<Parameters<typeof pickupCompleteAfter>[0]> = {}) {
  return {
    cancelledAt: null,
    deliveryDate: '2026-09-04',
    serviceType: 'PICKUP',
    timeWindowEnd: null,
    ...overrides
  };
}

function canonicalRow(overrides: Partial<CanonicalOrderRow> = {}): CanonicalOrderRow {
  return {
    cancelledAt: null,
    currencyCode: 'CAD',
    deliveryArea: 'Pickup',
    deliveryBatchEndDate: null,
    deliveryBatchStartDate: null,
    deliveryDate: '2026-09-04',
    deliveryDateSource: null,
    deliveryDayRaw: null,
    deliverySession: 'PICKUP',
    deliveryStopId: 'stop-1',
    deliveryStopStatus: 'FAILED',
    deliveryWeekday: 'FRIDAY',
    email: null,
    financialStatus: null,
    fulfillmentStatus: 'UNFULFILLED',
    geocodeStatus: 'NOT_REQUIRED',
    hasCoordinates: false,
    latitude: null,
    longitude: null,
    name: '#pickup',
    orderCreatedAt: null,
    orderDateLocal: null,
    orderId: 'order-1',
    phone: null,
    pickup: true,
    pickupCompleteAfter: '2026-09-05T04:00:00.000Z',
    planningGroupKey: 'pickup',
    planningStatus: 'PLANNED',
    processedAt: null,
    readiness: 'READY_TO_PLAN',
    recipientName: null,
    reviewReasons: [],
    routePlanId: 'route-1',
    routePlanName: 'Pickup route',
    routePlanStatus: 'COMPLETED',
    routeScopeKey: 'pickup',
    serviceType: 'PICKUP',
    shippingAddress: { address1: null, address2: null, city: null, countryCode: null, postalCode: null, province: null },
    shopifyOrderGid: 'gid://shopify/Order/1',
    shopifyOrderLegacyId: '1',
    timeWindowEnd: null,
    timeWindowStart: null,
    totalPriceAmount: null,
    updatedAtShopify: null,
    ...overrides
  };
}
