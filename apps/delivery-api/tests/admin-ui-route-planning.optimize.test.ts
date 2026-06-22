import { describe, expect, test } from 'vitest';

import type { CanonicalOrderRow } from '../src/modules/shopify/order-sync.mapper.js';
import {
  buildRouteOptimizeNotice,
  toRouteOpsOrderDto,
} from '../src/routes/admin-ui-route-planning.js';

describe('buildRouteOptimizeNotice', () => {
  test('exposes order total and currency to the Route Ops UI DTO', () => {
    const dto = toRouteOpsOrderDto(canonicalOrderRow({
      currencyCode: 'CAD',
      totalPriceAmount: '42.50',
    }));

    expect(dto.currencyCode).toBe('CAD');
    expect(dto.totalPriceAmount).toBe('42.50');
  });

  test('labels VROOM optimizer results distinctly from clever fallback', () => {
    expect(
      buildRouteOptimizeNotice({
        missingCoordinateStops: 0,
        source: 'vroom',
        stops: [],
      }),
    ).toBe('VROOM optimized sequence saved.');
    expect(
      buildRouteOptimizeNotice({
        missingCoordinateStops: 2,
        source: 'vroom',
        stops: [],
      }),
    ).toBe(
      'VROOM optimized sequence saved; 2 stop(s) without coordinates stayed at the end.',
    );
  });
});

function canonicalOrderRow(
  overrides: Partial<CanonicalOrderRow> = {},
): CanonicalOrderRow {
  return {
    cancelledAt: null,
    currencyCode: null,
    customerNote: null,
    deliveryArea: 'Toronto',
    deliveryBatchEndDate: null,
    deliveryBatchStartDate: null,
    deliveryDate: '2026-06-26',
    deliveryDateSource: 'EXPLICIT_ATTRIBUTE',
    deliveryDayRaw: 'Friday',
    deliveryMetadataDiagnostics: null,
    deliverySession: 'EVENING',
    deliveryStopId: null,
    deliveryStopStatus: null,
    deliveryWeekday: 'FRIDAY',
    email: null,
    financialStatus: 'paid',
    fulfillmentStatus: 'unfulfilled',
    geocodeDiagnostics: null,
    geocodeStatus: 'RESOLVED',
    hasCoordinates: true,
    items: [],
    latitude: 43.6,
    longitude: -79.3,
    metadataResolved: true,
    name: '#1001',
    normalizedPaymentReason: null,
    normalizedPaymentStatus: null,
    orderCreatedAt: '2026-06-20T00:00:00.000Z',
    orderDateLocal: '2026-06-20',
    orderId: 'order-1',
    paidAt: null,
    paymentMethodFamily: null,
    paymentMethodId: null,
    paymentMethodTitle: null,
    paymentReviewReason: null,
    phone: null,
    pickup: false,
    planningGroupKey: '2026-06-26|EVENING_DELIVERY|EVENING',
    planningStatus: 'UNPLANNED',
    processedAt: '2026-06-20T00:00:00.000Z',
    readiness: 'READY_TO_PLAN',
    recipientName: 'Customer',
    reviewReasons: [],
    routeEligible: true,
    routePlanId: null,
    routePlanName: null,
    routePlanStatus: null,
    routeScopeKey: '2026-06-26|EVENING_DELIVERY|EVENING',
    serviceType: 'EVENING_DELIVERY',
    shippingAddress: {
      address1: null,
      address2: null,
      city: null,
      countryCode: null,
      postalCode: null,
      province: null,
    },
    shopifyOrderGid: 'gid://woo/Order/1001',
    shopifyOrderLegacyId: '1001',
    sourceCreatedAt: '2026-06-20T00:00:00.000Z',
    sourceCreatedDate: '2026-06-20',
    sourceOrderId: '1001',
    sourceOrderNumber: '1001',
    sourcePlatform: 'WOOCOMMERCE',
    sourceSiteUrl: 'https://woo.example.test',
    sourceUpdatedAt: '2026-06-20T00:00:00.000Z',
    sourceUpdatedDate: '2026-06-20',
    timeWindowEnd: null,
    timeWindowStart: null,
    totalPriceAmount: null,
    transactionId: null,
    updatedAtShopify: '2026-06-20T00:00:00.000Z',
    wooOrderStatus: 'processing',
    ...overrides,
  };
}
