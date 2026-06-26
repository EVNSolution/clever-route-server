import { describe, expect, test } from 'vitest';

import { mapShopifyOrderNodeToDeliveryInputs } from '../src/modules/shopify/order-sync.mapper.js';
import { buildOrdersUpdatedSinceQuery } from '../src/modules/shopify/order-sync.query.js';

describe('buildOrdersUpdatedSinceQuery', () => {
  test('builds an updated_at paginated orders query payload', () => {
    const payload = buildOrdersUpdatedSinceQuery({
      after: 'cursor-1',
      first: 50,
      updatedSince: new Date('2026-05-07T00:00:00.000Z')
    });

    expect(payload.variables).toEqual({
      after: 'cursor-1',
      first: 50,
      query: "updated_at:>='2026-05-07T00:00:00.000Z'"
    });
    expect(payload.query).toContain('orders(first: $first, after: $after, query: $query');
    expect(payload.query).toContain('shippingAddress');
  });
});

describe('mapShopifyOrderNodeToDeliveryInputs', () => {
  test('maps a Shopify order node with shipping address into local order and stop inputs', () => {
    const mapped = mapShopifyOrderNodeToDeliveryInputs({
      currentTotalPriceSet: {
        shopMoney: {
          amount: '123.45',
          currencyCode: 'USD'
        }
      },
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'UNFULFILLED',
      email: 'customer@example.com',
      id: 'gid://shopify/Order/123',
      legacyResourceId: '123',
      name: '#1001',
      phone: '+15551234567',
      processedAt: '2026-05-07T04:00:00Z',
      shippingAddress: {
        address1: '1 Main St',
        address2: 'Unit 2',
        city: 'New York',
        countryCodeV2: 'US',
        latitude: 40.7128,
        longitude: -74.006,
        name: 'Ada Lovelace',
        phone: '+15557654321',
        province: 'NY',
        zip: '10001'
      },
      updatedAt: '2026-05-07T05:00:00Z'
    });

    expect(mapped.order.rawPayload.id).toBe('gid://shopify/Order/123');
    expect(mapped.deliveryStop).toEqual(
      expect.objectContaining({
        address1: '1 Main St',
        address2: 'Unit 2',
        city: 'New York',
        countryCode: 'US',
        geocodeStatus: 'RESOLVED',
        instructions: null,
        latitude: '40.7128',
        longitude: '-74.006',
        phone: '+15557654321',
        postalCode: '10001',
        province: 'NY',
        recipientName: 'Ada Lovelace'
      })
    );
    expect(mapped.order).toEqual(
      expect.objectContaining({
        currencyCode: 'USD',
        email: 'customer@example.com',
        financialStatus: 'PAID',
        fulfillmentStatus: 'UNFULFILLED',
        name: '#1001',
        phone: '+15551234567',
        processedAt: new Date('2026-05-07T04:00:00.000Z'),
        rawPayload: mapped.order.rawPayload,
        shopifyOrderGid: 'gid://shopify/Order/123',
        shopifyOrderLegacyId: BigInt(123),
        totalPriceAmount: '123.45',
        updatedAtShopify: new Date('2026-05-07T05:00:00.000Z')
      })
    );
  });

  test('returns no delivery stop when an order has no shipping address', () => {
    const mapped = mapShopifyOrderNodeToDeliveryInputs({
      currentTotalPriceSet: null,
      displayFinancialStatus: null,
      displayFulfillmentStatus: 'FULFILLED',
      email: null,
      id: 'gid://shopify/Order/456',
      legacyResourceId: '456',
      name: '#1002',
      phone: null,
      processedAt: null,
      shippingAddress: null,
      updatedAt: '2026-05-07T05:00:00Z'
    });

    expect(mapped.deliveryStop).toBeNull();
  });
});

test('normalizes delivery attributes, pickup hints, cancellation, and review reasons from app order snapshots', () => {
  const mapped = mapShopifyOrderNodeToDeliveryInputs({
    cancelledAt: '2026-05-08T01:00:00Z',
    currentTotalPriceSet: {
      shopMoney: {
        amount: '95.00',
        currencyCode: 'CAD'
      }
    },
    customAttributes: [
      { key: 'Delivery Area', value: 'Mississauga' },
      { key: 'Delivery Day', value: 'Friday 5pm to 9pm *Check delivery map' },
      { key: 'Pickup Day', value: 'Friday' }
    ],
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: 'customer@example.com',
    id: 'gid://shopify/Order/123',
    legacyResourceId: '123',
    name: '#1035',
    note: 'Leave at door',
    phone: '+14165550000',
    processedAt: '2026-05-07T12:00:00Z',
    shippingAddress: {
      address1: '300 City Centre Dr',
      address2: '#08',
      city: 'Mississauga',
      countryCodeV2: 'CA',
      latitude: 43.589,
      longitude: -79.644,
      name: 'Noah Yoon',
      phone: '+14165550000',
      province: 'ON',
      provinceCode: 'ON',
      zip: 'L5B 3C1'
    },
    updatedAt: '2026-05-07T13:00:00Z'
  });

  expect(mapped.deliveryStop).toEqual(
    expect.objectContaining({
      geocodeStatus: 'RESOLVED',
      instructions: 'Leave at door',
      latitude: '43.589',
      longitude: '-79.644'
    })
  );
  expect(mapped.order).toEqual(
    expect.objectContaining({
      cancelledAt: new Date('2026-05-08T01:00:00.000Z'),
      deliveryArea: 'Mississauga',
      deliveryDayRaw: 'Friday 5pm to 9pm *Check delivery map',
      deliveryWeekday: 'FRIDAY',
      pickup: true,
      readiness: 'NEEDS_REVIEW',
      reviewReasons: ['cancelled_order'],
      serviceType: 'PICKUP',
      timeWindowEnd: null,
      timeWindowStart: null
    })
  );
});

test('marks snapshots with missing delivery metadata and coordinates as needing review', () => {
  const mapped = mapShopifyOrderNodeToDeliveryInputs({
    cancelledAt: null,
    currentTotalPriceSet: null,
    customAttributes: [{ key: 'Delivery Day', value: 'Someday maybe' }],
    displayFinancialStatus: null,
    displayFulfillmentStatus: null,
    email: null,
    id: 'gid://shopify/Order/456',
    legacyResourceId: '456',
    name: '#1036',
    note: null,
    phone: null,
    processedAt: null,
    shippingAddress: {
      address1: null,
      address2: null,
      city: null,
      countryCodeV2: null,
      latitude: null,
      longitude: null,
      name: null,
      phone: null,
      province: null,
      provinceCode: null,
      zip: null
    },
    updatedAt: '2026-05-07T13:00:00Z'
  });

  expect(mapped.deliveryStop).toEqual(expect.objectContaining({ geocodeStatus: 'PENDING' }));
  expect(mapped.order).toEqual(
    expect.objectContaining({
      deliveryArea: null,
      deliveryWeekday: null,
      readiness: 'NEEDS_REVIEW',
      reviewReasons: [
        'missing_address',
        'missing_delivery_area',
        'delivery_day_parse_failed',
        'missing_order_date',
        'missing_delivery_date',
        'missing_route_scope',
        'missing_coordinates'
      ],
      serviceType: null
    })
  );
});

test('normalizes pickup-only snapshots by pickup day instead of marking the day missing', () => {
  const mapped = mapShopifyOrderNodeToDeliveryInputs({
    cancelledAt: null,
    currentTotalPriceSet: {
      shopMoney: {
        amount: '45.00',
        currencyCode: 'CAD'
      }
    },
    customAttributes: [
      { key: 'Delivery Area', value: 'North York' },
      { key: 'Pickup Day', value: 'Thursday-pickup' }
    ],
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: 'pickup@example.com',
    id: 'gid://shopify/Order/789',
    legacyResourceId: '789',
    name: '#1037',
    note: null,
    phone: '+14165550123',
    processedAt: '2026-05-07T12:00:00Z',
    shippingAddress: {
      address1: '10 Pickup Rd',
      address2: null,
      city: 'Toronto',
      countryCodeV2: 'CA',
      latitude: 43.7,
      longitude: -79.4,
      name: 'Pickup Customer',
      phone: '+14165550123',
      province: 'ON',
      provinceCode: 'ON',
      zip: 'M2N 1N8'
    },
    updatedAt: '2026-05-07T13:00:00Z'
  });

  expect(mapped.order).toEqual(
    expect.objectContaining({
      deliveryArea: 'North York',
      deliveryDayRaw: 'Thursday-pickup',
      deliveryWeekday: 'THURSDAY',
      pickup: true,
      readiness: 'READY_TO_PLAN',
      reviewReasons: [],
      serviceType: 'PICKUP',
      timeWindowEnd: null,
      timeWindowStart: null
    })
  );
  expect(mapped.order.rawPayload).toEqual(
    expect.objectContaining({
      deliveryDayRaw: 'Thursday-pickup',
      pickupDayRaw: 'Thursday-pickup',
      deliveryWeekday: 'THURSDAY',
      readiness: 'READY_TO_PLAN',
      reviewReasons: []
    })
  );
});

test('stores delivery route scope fields from line item date ranges', () => {
  const mapped = mapShopifyOrderNodeToDeliveryInputs({
    cancelledAt: null,
    createdAt: '2026-05-05T14:00:00Z',
    currentTotalPriceSet: { shopMoney: { amount: '95.00', currencyCode: 'CAD' } },
    customAttributes: [
      { key: 'Delivery Area', value: 'Thornhill' },
      { key: 'Delivery Day', value: 'Friday 5pm to 9pm *Check delivery map' }
    ],
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: null,
    id: 'gid://shopify/Order/900',
    legacyResourceId: '900',
    lineItems: { nodes: [{ title: 'Tomatono 5/7-5/9', quantity: 1 }] },
    name: '#1900',
    note: null,
    phone: null,
    processedAt: '2026-05-05T14:00:00Z',
    shippingAddress: {
      address1: '1 Yonge St',
      address2: null,
      city: 'Toronto',
      countryCodeV2: 'CA',
      latitude: 43.65,
      longitude: -79.38,
      name: 'Customer',
      phone: null,
      province: 'ON',
      provinceCode: 'ON',
      zip: 'M5E 1E5'
    },
    updatedAt: '2026-05-05T15:00:00Z'
  });

  expect(mapped.deliveryStop).toEqual(
    expect.objectContaining({
      deliveryDate: '2026-05-08',
      timeWindowEnd: '21:00',
      timeWindowStart: '17:00'
    })
  );
  expect(mapped.order.rawPayload).toEqual(
    expect.objectContaining({
      deliveryBatchEndDate: '2026-05-09',
      deliveryBatchStartDate: '2026-05-07',
      deliveryDate: '2026-05-08',
      deliveryDateSource: 'LINE_ITEM_DATE_RANGE',
      deliverySession: 'EVENING',
      orderDateLocal: '2026-05-05',
      planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Thornhill',
      routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00'
    })
  );
  expect(mapped.deliveryFact).toEqual(
    expect.objectContaining({
      batchEligible: true,
      deliveryArea: 'Thornhill',
      deliveryDate: '2026-05-08',
      deliveryDateWeekday: 'FRIDAY',
      deliveryDateWeekdayVerified: true,
      deliveryDayParseStatus: 'PARSED',
      deliverySession: 'EVENING',
      deliveryWeekday: 'FRIDAY',
      geocodeStatus: 'RESOLVED',
      planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Thornhill',
      routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
      serviceType: 'EVENING_DELIVERY',
      sourceOrderId: 'gid://shopify/Order/900',
      sourceOrderNumber: '#1900',
      sourcePlatform: 'SHOPIFY',
      timeWindowEnd: '21:00',
      timeWindowStart: '17:00'
    })
  );
  expect(mapped.order.readiness).toBe('READY_TO_PLAN');
});

test('requires delivery date and route scope for readiness', () => {
  const mapped = mapShopifyOrderNodeToDeliveryInputs({
    cancelledAt: null,
    createdAt: null,
    currentTotalPriceSet: null,
    customAttributes: [
      { key: 'Delivery Area', value: 'Thornhill' },
      { key: 'Delivery Day', value: 'Friday' }
    ],
    displayFinancialStatus: null,
    displayFulfillmentStatus: null,
    email: null,
    id: 'gid://shopify/Order/901',
    legacyResourceId: '901',
    lineItems: null,
    name: '#1901',
    phone: null,
    processedAt: null,
    shippingAddress: {
      address1: '1 Yonge St',
      address2: null,
      city: 'Toronto',
      countryCodeV2: 'CA',
      latitude: 43.65,
      longitude: -79.38,
      name: 'Customer',
      phone: null,
      province: 'ON',
      provinceCode: 'ON',
      zip: 'M5E 1E5'
    },
    updatedAt: '2026-05-05T15:00:00Z'
  });

  expect(mapped.order.readiness).toBe('NEEDS_REVIEW');
  expect(mapped.order.reviewReasons).toEqual(['missing_order_date', 'missing_delivery_date', 'missing_route_scope']);
});

test('uses explicit Delivery Date attributes as ready route scope input', () => {
  const mapped = mapShopifyOrderNodeToDeliveryInputs({
    cancelledAt: null,
    createdAt: null,
    currentTotalPriceSet: null,
    customAttributes: [
      { key: 'Delivery Area', value: 'North York' },
      { key: 'Delivery Date', value: '2026-05-18' }
    ],
    displayFinancialStatus: null,
    displayFulfillmentStatus: null,
    email: null,
    id: 'gid://shopify/Order/902',
    legacyResourceId: '902',
    lineItems: null,
    name: '#1902',
    phone: null,
    processedAt: null,
    shippingAddress: {
      address1: '5100 Yonge St',
      address2: null,
      city: 'North York',
      countryCodeV2: 'CA',
      latitude: 43.7685,
      longitude: -79.4137,
      name: 'Customer',
      phone: null,
      province: 'ON',
      provinceCode: 'ON',
      zip: 'M2N 5V7'
    },
    updatedAt: '2026-05-18T15:00:00Z'
  });

  expect(mapped.deliveryStop).toEqual(expect.objectContaining({ deliveryDate: '2026-05-18' }));
  expect(mapped.order).toEqual(
    expect.objectContaining({
      deliveryDate: '2026-05-18',
      deliveryDateSource: 'EXPLICIT_ATTRIBUTE',
      deliveryWeekday: 'MONDAY',
      readiness: 'READY_TO_PLAN',
      reviewReasons: [],
      routeScopeKey: '2026-05-18|DELIVERY||',
      serviceType: 'DELIVERY'
    })
  );
});


test('uses tomatono_delivery_date attributes as ready route scope input', () => {
  const mapped = mapShopifyOrderNodeToDeliveryInputs({
    cancelledAt: null,
    createdAt: null,
    currentTotalPriceSet: null,
    customAttributes: [
      { key: 'Delivery Area', value: 'Thornhill' },
      { key: 'Delivery Day', value: 'Monday' },
      { key: 'tomatono_delivery_date', value: '2026-05-18' }
    ],
    displayFinancialStatus: null,
    displayFulfillmentStatus: null,
    email: null,
    id: 'gid://shopify/Order/903',
    legacyResourceId: '903',
    lineItems: null,
    name: '#1903',
    phone: null,
    processedAt: null,
    shippingAddress: {
      address1: '7755 Bayview Ave',
      address2: null,
      city: 'Thornhill',
      countryCodeV2: 'CA',
      latitude: 43.8196,
      longitude: -79.4004,
      name: 'Customer',
      phone: null,
      province: 'ON',
      provinceCode: 'ON',
      zip: 'L3T 4P1'
    },
    updatedAt: '2026-05-18T15:00:00Z'
  });

  expect(mapped.deliveryStop).toEqual(expect.objectContaining({ deliveryDate: '2026-05-18' }));
  expect(mapped.order).toEqual(
    expect.objectContaining({
      deliveryDate: '2026-05-18',
      deliveryDateSource: 'EXPLICIT_ATTRIBUTE',
      deliveryWeekday: 'MONDAY',
      readiness: 'READY_TO_PLAN',
      reviewReasons: [],
      routeScopeKey: '2026-05-18|DELIVERY||',
      planningGroupKey: '2026-05-18|DELIVERY|||Thornhill',
      serviceType: 'DELIVERY'
    })
  );
  expect(mapped.order.rawPayload).toEqual(expect.objectContaining({ deliveryDateRaw: '2026-05-18' }));
});
