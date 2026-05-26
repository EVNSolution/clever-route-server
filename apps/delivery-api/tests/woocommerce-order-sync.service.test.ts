import { describe, expect, test, vi } from 'vitest';

import type { CanonicalOrderRow, SyncedOrderWithDeliveryStopInput } from '../src/modules/shopify/order-sync.mapper.js';
import type { UpsertOrderWithDeliveryStopResult } from '../src/modules/shopify/order-sync.repository.js';
import { WooCommerceOrderSyncService } from '../src/modules/woocommerce/woocommerce-order-sync.service.js';
import type { WooCommerceOrder } from '../src/modules/woocommerce/woocommerce-order.types.js';

describe('WooCommerceOrderSyncService', () => {
  test('syncs paginated WooCommerce pages and upserts source-identified orders', async () => {
    const client = {
      listOrdersPage: vi
        .fn()
        .mockResolvedValueOnce({ orders: [order(1)], page: 1, perPage: 1, total: 2, totalPages: 2 })
        .mockResolvedValueOnce({ orders: [order(2)], page: 2, perPage: 1, total: 2, totalPages: 2 })
    };
    const repository = createRepositoryHarness();
    const service = new WooCommerceOrderSyncService({
      client,
      repository,
      shopDomain: 'woo.example.test',
      siteUrl: 'https://woo.example.test'
    });

    const result = await service.syncUpdatedOrders({
      modifiedAfter: new Date('2026-05-20T00:00:00.000Z'),
      pageSize: 1,
      status: 'processing'
    });

    expect(result.pagesRead).toBe(2);
    expect(result.sync).toEqual({ created: 2, needsReview: 0, readyToPlan: 2, received: 2, skipped: 0, unchanged: 0, updated: 0 });
    expect(repository.upsertOrderWithDeliveryStop).toHaveBeenCalledTimes(2);
    const firstUpsert = repository.upsertOrderWithDeliveryStop.mock.calls[0]?.[0];
    expect(firstUpsert?.shopDomain).toBe('woo.example.test');
    expect(firstUpsert?.synced.order.sourcePlatform).toBe('WOOCOMMERCE');
    expect(firstUpsert?.synced.order.sourceOrderId).toBe('1');
  });
});

function createRepositoryHarness() {
  return {
    findCanonicalOrderById: vi.fn((input: { orderId: string; shopDomain: string }) =>
      Promise.resolve<CanonicalOrderRow>({
        cancelledAt: null,
        currencyCode: 'CAD',
        deliveryArea: 'Markham',
        deliveryBatchEndDate: null,
        deliveryBatchStartDate: null,
        deliveryDate: '2026-05-21',
        deliveryDateSource: 'EXPLICIT_ATTRIBUTE',
        deliveryDayRaw: null,
        deliverySession: 'DAY',
        deliveryStopId: `stop-${input.orderId}`,
        deliveryStopStatus: 'PENDING',
        deliveryWeekday: 'THURSDAY',
        email: null,
        financialStatus: null,
        fulfillmentStatus: 'PROCESSING',
        geocodeStatus: 'RESOLVED',
        hasCoordinates: true,
        latitude: 43,
        longitude: -79,
        name: `#${input.orderId}`,
        orderCreatedAt: '2026-05-20T00:00:00.000Z',
        orderDateLocal: '2026-05-20',
        orderId: input.orderId,
        phone: null,
        pickup: false,
        planningGroupKey: '2026-05-21|DELIVERY|||Markham',
        planningStatus: 'UNPLANNED',
        processedAt: '2026-05-20T00:00:00.000Z',
        readiness: 'READY_TO_PLAN',
        recipientName: null,
        reviewReasons: [],
        routePlanId: null,
        routePlanName: null,
        routePlanStatus: null,
        routeScopeKey: '2026-05-21|DELIVERY||',
        serviceType: 'DELIVERY',
        shippingAddress: { address1: null, address2: null, city: null, countryCode: null, postalCode: null, province: null },
        shopifyOrderGid: `woocommerce://woo.example.test/orders/${input.orderId}`,
        shopifyOrderLegacyId: null,
        sourceOrderId: input.orderId,
        sourceOrderNumber: input.orderId,
        sourcePlatform: 'WOOCOMMERCE',
        sourceSiteUrl: 'https://woo.example.test',
        sourceUpdatedAt: '2026-05-20T00:00:00.000Z',
        timeWindowEnd: null,
        timeWindowStart: null,
        totalPriceAmount: '10.00',
        updatedAtShopify: '2026-05-20T00:00:00.000Z'
      })
    ),
    listCanonicalOrders: vi.fn(() => Promise.resolve([])),
    upsertOrderWithDeliveryStop: vi.fn(
      (input: { shopDomain: string; synced: SyncedOrderWithDeliveryStopInput }): Promise<UpsertOrderWithDeliveryStopResult> =>
        Promise.resolve({ orderId: input.synced.order.sourceOrderId ?? input.synced.order.shopifyOrderGid, status: 'created', stopId: 'stop-id' })
    )
  };
}

function order(id: number): WooCommerceOrder {
  return {
    billing: { phone: '+14165550000' },
    currency: 'CAD',
    date_created_gmt: '2026-05-20T00:00:00',
    date_modified_gmt: '2026-05-20T00:00:00',
    id,
    meta_data: [
      { key: 'delivery_date', value: '2026-05-21' },
      { key: 'delivery_area', value: 'Markham' }
    ],
    number: String(id),
    shipping: { address_1: '100 Test St', city: 'Markham', country: 'CA', first_name: 'Test', last_name: 'User', postcode: 'L3R 0A1', state: 'ON' },
    status: 'processing',
    total: '10.00'
  };
}
