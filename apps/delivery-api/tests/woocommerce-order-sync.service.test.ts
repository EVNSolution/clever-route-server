import { describe, expect, test, vi } from 'vitest';

import type { CanonicalOrderRow, SyncedOrderWithDeliveryStopInput } from '../src/modules/shopify/order-sync.mapper.js';
import type { UpsertOrderWithDeliveryStopResult } from '../src/modules/shopify/order-sync.repository.js';
import { GeocodingService } from '../src/modules/geocoding/geocoding.service.js';
import type { GeocodingQuery } from '../src/modules/geocoding/geocoding.types.js';
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

  test('loads connection-scoped mapping config and threads connection id into delivery facts', async () => {
    const repository = createRepositoryHarness();
    repository.readOrderMappingConfig.mockResolvedValueOnce({
      datePaths: ['line_items.meta_data.jckwds_date'],
      dayPaths: ['shipping_lines.method_title'],
      areaPaths: ['shipping_lines.meta_data.delivery_area'],
      version: 1
    });
    const wooOrder = order(10);
    wooOrder.meta_data = [];
    wooOrder.line_items = [{ name: 'Delivery item', quantity: 1, meta_data: [{ key: 'jckwds_date', value: '2026-05-21' }] }];
    wooOrder.shipping_lines = [{ method_title: 'Thursday', meta_data: [{ key: 'delivery_area', value: 'Markham' }] }];
    const service = new WooCommerceOrderSyncService({
      connectionId: '8b57ab89-3fe7-4a62-b1f4-b6dbb26ef3ea',
      repository,
      shopDomain: 'woo.example.test',
      siteUrl: 'https://woo.example.test'
    });

    await service.syncOrders({ orders: [wooOrder], reason: 'manual_backfill' });

    expect(repository.readOrderMappingConfig).toHaveBeenCalledWith({
      commerceConnectionId: '8b57ab89-3fe7-4a62-b1f4-b6dbb26ef3ea'
    });
    const upsert = repository.upsertOrderWithDeliveryStop.mock.calls[0]?.[0];
    expect(upsert?.synced.deliveryFact).toEqual(
      expect.objectContaining({
        commerceConnectionId: '8b57ab89-3fe7-4a62-b1f4-b6dbb26ef3ea',
        matchedMappingPaths: expect.objectContaining({
          deliveryArea: 'shipping_lines[0].meta_data.delivery_area',
          deliveryDate: 'line_items[0].meta_data.jckwds_date',
          deliveryDay: 'shipping_lines[0].method_title'
        }) as unknown
      })
    );
  });

  test('threads weekday-only Woo metadata as an order-week route scope', async () => {
    const repository = createRepositoryHarness();
    const wooOrder = order(20);
    wooOrder.meta_data = [{ key: 'delivery_area', value: 'Markham' }];
    wooOrder.shipping_lines = [{ method_title: 'Thursday Delivery', meta_data: [] }];
    const service = new WooCommerceOrderSyncService({
      repository,
      shopDomain: 'woo.example.test',
      siteUrl: 'https://woo.example.test'
    });

    await service.syncOrders({ orders: [wooOrder], reason: 'manual_backfill' });

    const upsert = repository.upsertOrderWithDeliveryStop.mock.calls[0]?.[0];
    expect(upsert?.synced.order).toEqual(
      expect.objectContaining({
        deliveryDate: '2026-05-21',
        deliveryDateSource: 'ORDER_DATE_WEEK_RULE',
        routeScopeKey: '2026-05-21|DELIVERY||'
      })
    );
    expect(upsert?.synced.deliveryFact).toEqual(
      expect.objectContaining({
        deliveryDate: '2026-05-21',
        routeScopeKey: '2026-05-21|DELIVERY||'
      })
    );
  });

  test('geocodes Woo shipping addresses before persisting route stops', async () => {
    const repository = createRepositoryHarness();
    const geocodingService = {
      geocode: vi.fn().mockResolvedValue({
        cached: false,
        ok: true,
        result: {
          addressLabel: '100 Test St, Markham, ON L3R 0A1, CA',
          latitude: 43.8561,
          longitude: -79.337,
          provider: 'test-geocoder',
          providerPlaceId: 'place-100',
          rawLabel: '100 Test Street'
        }
      }),
      status: {
        mode: 'nominatim_compatible' as const,
        persistentCacheEnabled: true,
        providerPolicy: 'public_nominatim' as const
      }
    };
    const wooOrder = order(30);
    const service = new WooCommerceOrderSyncService({
      geocodingService,
      repository,
      shopDomain: 'woo.example.test',
      siteUrl: 'https://woo.example.test'
    });

    await service.syncOrders({ orders: [wooOrder], reason: 'webhook' });

    expect(geocodingService.geocode).toHaveBeenCalledWith({
      address: {
        address1: '100 Test St',
        address2: null,
        city: 'Markham',
        countryCode: 'CA',
        postalCode: 'L3R 0A1',
        province: 'ON'
      },
      shopDomain: 'woo.example.test'
    });
    const upsert = repository.upsertOrderWithDeliveryStop.mock.calls[0]?.[0];
    expect(upsert?.synced.deliveryStop).toEqual(
      expect.objectContaining({
        geocodeStatus: 'RESOLVED',
        latitude: '43.8561000',
        longitude: '-79.3370000'
      })
    );
    expect(upsert?.synced.deliveryFact).toEqual(
      expect.objectContaining({
        geocodeStatus: 'RESOLVED',
        mappingDiagnostics: expect.objectContaining({
          ingestGeocode: expect.objectContaining({
            ok: true,
            provider: 'test-geocoder',
            providerPlaceId: 'place-100',
            source: 'server_pre_persist'
          }) as unknown
        }) as unknown
      })
    );
    expect(upsert?.synced.order.rawPayload).toEqual(
      expect.objectContaining({
        ingestGeocode: expect.objectContaining({
          ok: true,
          provider: 'test-geocoder',
          source: 'server_pre_persist'
        }) as unknown
      })
    );
  });

  test('skips pre-persist geocoding for public-provider paginated sync', async () => {
    const client = {
      listOrdersPage: vi.fn().mockResolvedValue({
        orders: [order(33)],
        page: 1,
        perPage: 10,
        total: 1,
        totalPages: 1
      })
    };
    const repository = createRepositoryHarness();
    const geocodingService = {
      geocode: vi.fn(),
      status: {
        mode: 'nominatim_compatible' as const,
        persistentCacheEnabled: true,
        providerPolicy: 'public_nominatim' as const
      }
    };
    const service = new WooCommerceOrderSyncService({
      client,
      geocodingService,
      repository,
      shopDomain: 'woo.example.test',
      siteUrl: 'https://woo.example.test'
    });

    await service.syncUpdatedOrders({ pageSize: 10, status: 'processing' });

    expect(geocodingService.geocode).not.toHaveBeenCalled();
    const upsert = repository.upsertOrderWithDeliveryStop.mock.calls[0]?.[0];
    expect(upsert?.synced.deliveryStop).toEqual(
      expect.objectContaining({
        geocodeStatus: 'PENDING',
        latitude: null,
        longitude: null
      })
    );
  });


  test('pre-persist geocoding resolves Woo unit addresses using fallback street queries', async () => {
    const repository = createRepositoryHarness();
    const provider = {
      geocodeAddress: vi.fn((query: GeocodingQuery) => {
        if (query.shape !== 'freeform_without_unit') return Promise.resolve(null);
        return Promise.resolve({
          addressLabel: query.shape,
          latitude: 42.9965699,
          longitude: -81.3216486,
          provider: 'test-geocoder',
          providerPlaceId: 'place-1020',
          rawLabel: '1020 Coronation Drive, London, Ontario, Canada'
        });
      }),
      providerName: 'test-geocoder'
    };
    const geocodingService = new GeocodingService({ minIntervalMs: 0, mode: 'nominatim_compatible', provider });
    const wooOrder = order(32);
    wooOrder.shipping = {
      address_1: '1020 Coronation Drive',
      address_2: '302',
      city: 'London',
      country: 'CA',
      first_name: 'Test',
      last_name: 'User',
      postcode: 'N6H 0B5',
      state: 'ON'
    };
    const service = new WooCommerceOrderSyncService({
      geocodingService,
      repository,
      shopDomain: 'woo.example.test',
      siteUrl: 'https://woo.example.test'
    });

    await service.syncOrders({ orders: [wooOrder], reason: 'webhook' });

    expect(provider.geocodeAddress).toHaveBeenNthCalledWith(1, expect.objectContaining({ shape: 'structured_without_unit' }));
    expect(provider.geocodeAddress).toHaveBeenNthCalledWith(3, expect.objectContaining({ shape: 'freeform_without_unit' }));
    const upsert = repository.upsertOrderWithDeliveryStop.mock.calls[0]?.[0];
    expect(upsert?.synced.deliveryStop).toEqual(
      expect.objectContaining({
        geocodeStatus: 'RESOLVED',
        latitude: '42.9965699',
        longitude: '-81.3216486'
      })
    );
  });

  test('keeps saving Woo orders when pre-persist geocoding cannot resolve an address', async () => {
    const repository = createRepositoryHarness();
    const geocodingService = {
      geocode: vi.fn().mockResolvedValue({
        code: 'GEOCODER_NO_RESULT',
        message: 'No geocoding result was found.',
        ok: false
      }),
      status: { mode: 'nominatim_compatible' as const, persistentCacheEnabled: true }
    };
    const service = new WooCommerceOrderSyncService({
      geocodingService,
      repository,
      shopDomain: 'woo.example.test',
      siteUrl: 'https://woo.example.test'
    });

    await service.syncOrders({ orders: [order(31)], reason: 'webhook' });

    const upsert = repository.upsertOrderWithDeliveryStop.mock.calls[0]?.[0];
    expect(upsert?.synced.deliveryStop).toEqual(
      expect.objectContaining({
        geocodeStatus: 'PENDING',
        latitude: null,
        longitude: null
      })
    );
    expect(upsert?.synced.deliveryFact).toEqual(
      expect.objectContaining({
        geocodeStatus: 'FAILED',
        mappingDiagnostics: expect.objectContaining({
          ingestGeocode: expect.objectContaining({
            code: 'GEOCODER_NO_RESULT',
            ok: false,
            source: 'server_pre_persist'
          }) as unknown
        }) as unknown
      })
    );
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
    readOrderMappingConfig: vi.fn(() => Promise.resolve<Record<string, unknown> | null>(null)),
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
