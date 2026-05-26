import { describe, expect, test, vi } from 'vitest';

import { deriveOperateDeliveryStatus, deriveOrderHealth } from '../src/modules/shopify/order-operate-status.js';
import { PrismaOrderSyncRepository } from '../src/modules/shopify/order-sync.repository.js';
import type { CanonicalOrderRow, SyncedOrderWithDeliveryStopInput } from '../src/modules/shopify/order-sync.mapper.js';

describe('PrismaOrderSyncRepository canonical orders', () => {
  test('creates new orders and lists canonical rows with planned status derived from route stops', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 1 });
    const repository = new PrismaOrderSyncRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaOrderSyncRepository>[0]
    );

    const result = await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'Example.myshopify.com',
      synced: syncedOrder()
    });

    expect(result.status).toBe('created');
    expect(prisma.order.upsert).toHaveBeenCalled();
    expect(prisma.deliveryStop.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId_orderId: { orderId: 'order-id', shopId: 'shop-id' } }
      })
    );

    const rows = await repository.listCanonicalOrders({
      filters: { planned: true, readiness: 'READY_TO_PLAN' },
      shopDomain: 'example.myshopify.com'
    });

    expect(prisma.order.findMany).toHaveBeenCalledOnce();
    const findManyInput = prisma.order.findMany.mock.calls[0]?.[0] as
      | { where?: { shopId?: string } }
      | undefined;
    expect(findManyInput?.where?.shopId).toBe('shop-id');
    expect(rows[0]).toEqual(
      expect.objectContaining({
        deliverySession: 'EVENING',
      deliveryWeekday: 'FRIDAY',
        deliveryStopStatus: 'ASSIGNED',
        planningStatus: 'PLANNED',
        readiness: 'READY_TO_PLAN',
        routePlanName: 'Route draft',
        routePlanStatus: 'ASSIGNED',
        serviceType: 'EVENING_DELIVERY',
        timeWindowEnd: '21:00',
        timeWindowStart: '17:00'
      })
    );
  });

  test('filters canonical rows by area, health, and operate delivery status', async () => {
    const readyHarness = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    const readyRepository = new PrismaOrderSyncRepository(
      readyHarness.prisma as unknown as ConstructorParameters<typeof PrismaOrderSyncRepository>[0]
    );

    await expect(
      readyRepository.listCanonicalOrders({
        filters: { deliveryArea: ' mississauga ', operateDeliveryStatus: 'ready', orderHealth: 'normal' },
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toHaveLength(1);
    await expect(
      readyRepository.listCanonicalOrders({
        filters: { deliveryArea: 'Toronto' },
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toEqual([]);

    const plannedHarness = createPrismaHarness({ existingOrder: null, routeStopCount: 1 });
    const plannedRepository = new PrismaOrderSyncRepository(
      plannedHarness.prisma as unknown as ConstructorParameters<typeof PrismaOrderSyncRepository>[0]
    );
    await expect(
      plannedRepository.listCanonicalOrders({
        filters: { operateDeliveryStatus: 'in_progress' },
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toHaveLength(1);
  });

  test('derives first-pass operate delivery status and health from canonical rows', () => {
    expect(deriveOperateDeliveryStatus(canonicalRow())).toBe('ready');
    expect(deriveOrderHealth(canonicalRow())).toBe('normal');
    expect(deriveOperateDeliveryStatus(canonicalRow({ readiness: 'NEEDS_REVIEW', reviewReasons: ['missing_delivery_date'] }))).toBe('preparing');
    expect(deriveOrderHealth(canonicalRow({ cancelledAt: '2026-05-25T00:00:00.000Z' }))).toBe('needs_review');
    expect(deriveOperateDeliveryStatus(canonicalRow({ planningStatus: 'PLANNED', routePlanStatus: 'IN_PROGRESS' }))).toBe('in_progress');
    expect(deriveOperateDeliveryStatus(canonicalRow({ deliveryStopStatus: 'DELIVERED', planningStatus: 'PLANNED' }))).toBe('completed');
  });

  test('does not overwrite a local row when the payload is not newer', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: { id: 'order-id', updatedAtShopify: new Date('2026-05-08T00:00:00.000Z') },
      routeStopCount: 0
    });
    const repository = new PrismaOrderSyncRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaOrderSyncRepository>[0]
    );

    const result = await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder({ updatedAtShopify: new Date('2026-05-07T13:00:00.000Z') })
    });

    expect(result.status).toBe('unchanged');
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.upsert).not.toHaveBeenCalled();
    expect(prisma.deliveryStop.upsert).not.toHaveBeenCalled();
  });

  test('refreshes same-timestamp snapshots so derived route scope/readiness can be repaired', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: { id: 'order-id', updatedAtShopify: new Date('2026-05-07T13:00:00.000Z') },
      routeStopCount: 0
    });
    const repository = new PrismaOrderSyncRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaOrderSyncRepository>[0]
    );

    const result = await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder({ updatedAtShopify: new Date('2026-05-07T13:00:00.000Z') })
    });

    expect(result.status).toBe('updated');
    expect(prisma.order.upsert).toHaveBeenCalledOnce();
    expect(prisma.deliveryStop.upsert).toHaveBeenCalledOnce();
  });



  test('uses additive WooCommerce source identity without colliding with Shopify numeric order ids', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    prisma.shop.findUnique.mockResolvedValueOnce(null);
    prisma.shop.create = vi.fn(() => Promise.resolve({ id: 'woo-shop-id' }));
    const repository = new PrismaOrderSyncRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaOrderSyncRepository>[0],
      { allowAnyShopDomain: true, createMissingShop: true }
    );

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'localhost:8088',
      synced: syncedOrder({
        name: '#123',
        shopifyOrderGid: 'woocommerce://localhost:8088/orders/123',
        shopifyOrderLegacyId: null,
        sourceOrderId: '123',
        sourceOrderNumber: '123',
        sourcePlatform: 'WOOCOMMERCE',
        sourceSiteUrl: 'http://localhost:8088',
        sourceUpdatedAt: new Date('2026-05-21T00:00:00.000Z'),
        updatedAtShopify: new Date('2026-05-21T00:00:00.000Z')
      })
    });

    expect(prisma.shop.create).toHaveBeenCalledWith({
      data: { shopDomain: 'localhost:8088' },
      select: { id: true }
    });
    const findFirstInput = prisma.order.findFirst.mock.calls[0]?.[0] as
      | { where?: { OR?: unknown[]; shopId?: string } }
      | undefined;
    expect(findFirstInput?.where).toEqual({
      OR: [
        { shopifyOrderGid: 'woocommerce://localhost:8088/orders/123' },
        { sourceOrderId: '123', sourcePlatform: 'WOOCOMMERCE', sourceSiteUrl: 'http://localhost:8088' }
      ],
      shopId: 'woo-shop-id'
    });

    const upsertInput = prisma.order.upsert.mock.calls[0]?.[0] as
      | {
          create?: {
            shopId?: string;
            shopifyOrderGid?: string;
            sourceOrderId?: string | null;
            sourceOrderNumber?: string | null;
            sourcePlatform?: string | null;
            sourceSiteUrl?: string | null;
          };
        }
      | undefined;
    expect(upsertInput?.create).toMatchObject({
      shopId: 'woo-shop-id',
      shopifyOrderGid: 'woocommerce://localhost:8088/orders/123',
      sourceOrderId: '123',
      sourceOrderNumber: '123',
      sourcePlatform: 'WOOCOMMERCE',
      sourceSiteUrl: 'http://localhost:8088'
    });
  });
  test('clears stale delivery stop fields when a newer snapshot has no shipping address', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: { id: 'order-id', updatedAtShopify: new Date('2026-05-07T12:00:00.000Z') },
      routeStopCount: 0
    });
    const repository = new PrismaOrderSyncRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaOrderSyncRepository>[0]
    );

    const result = await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...syncedOrder({
          rawPayload: {
            ...syncedOrder().order.rawPayload,
            shippingAddress: null
          },
          reviewReasons: ['missing_address', 'missing_coordinates'],
          updatedAtShopify: new Date('2026-05-08T13:00:00.000Z')
        }),
        deliveryStop: null
      }
    });

    expect(result.status).toBe('updated');
    expect(prisma.deliveryStop.updateMany).toHaveBeenCalledWith({
      data: {
        address1: null,
        address2: null,
        city: null,
        countryCode: null,
        deliveryDate: null,
        geocodeStatus: 'PENDING',
        instructions: null,
        latitude: null,
        longitude: null,
        phone: null,
        postalCode: null,
        province: null,
        recipientName: null,
        timeWindowEnd: null,
        timeWindowStart: null
      },
      where: { orderId: 'order-id', shopId: 'shop-id' }
    });
  });
});

function createPrismaHarness(input: {
  existingOrder: { id: string; updatedAtShopify: Date | null } | null;
  routeStopCount: number;
}): {
  prisma: {
    deliveryStop: { updateMany: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    order: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
    shop: { create?: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  };
} {
  const orderRecord = canonicalOrderRecord(input.routeStopCount);
  return {
    prisma: {
      deliveryStop: {
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
        upsert: vi.fn(() => Promise.resolve({ id: 'stop-id' }))
      },
      order: {
        create: vi.fn(() => Promise.resolve({ id: 'order-id' })),
        findFirst: vi.fn(() => Promise.resolve(input.existingOrder)),
        findMany: vi.fn(() => Promise.resolve([orderRecord])),
        update: vi.fn(() => Promise.resolve({ id: 'order-id' })),
        upsert: vi.fn(() => Promise.resolve({ id: 'order-id' }))
      },
      shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' })) }
    }
  };
}

function syncedOrder(overrides: Partial<SyncedOrderWithDeliveryStopInput['order']> = {}): SyncedOrderWithDeliveryStopInput {
  return {
    deliveryStop: {
      address1: '300 City Centre Dr',
      address2: '#08',
      city: 'Mississauga',
      countryCode: 'CA',
      deliveryDate: '2026-05-08',
      geocodeStatus: 'RESOLVED',
      instructions: 'Leave at door',
      latitude: '43.589',
      longitude: '-79.644',
      phone: '+14165550000',
      postalCode: 'L5B 3C1',
      province: 'ON',
      recipientName: 'Noah Yoon',
      timeWindowEnd: '21:00',
      timeWindowStart: '17:00'
    },
    order: {
      cancelledAt: null,
      currencyCode: 'CAD',
      deliveryArea: 'Mississauga',
      deliveryBatchEndDate: '2026-05-09',
      deliveryBatchStartDate: '2026-05-07',
      deliveryDate: '2026-05-08',
      deliveryDateSource: 'LINE_ITEM_DATE_RANGE',
      deliveryDayRaw: 'Friday 5pm to 9pm *Check delivery map',
      deliverySession: 'EVENING',
      deliveryWeekday: 'FRIDAY',
      email: 'customer@example.com',
      financialStatus: 'PAID',
      fulfillmentStatus: 'UNFULFILLED',
      name: '#1035',
      orderCreatedAt: '2026-05-05T14:00:00.000Z',
      orderDateLocal: '2026-05-05',
      phone: '+14165550000',
      pickup: false,
      planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Mississauga',
      processedAt: new Date('2026-05-07T12:00:00.000Z'),
      rawPayload: {
        currentTotalPriceSet: { shopMoney: { amount: '95.00', currencyCode: 'CAD' } },
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'UNFULFILLED',
        email: 'customer@example.com',
        id: 'gid://shopify/Order/123',
        legacyResourceId: '123',
        name: '#1035',
        phone: '+14165550000',
        processedAt: '2026-05-07T12:00:00.000Z',
        deliveryBatchEndDate: '2026-05-09',
        deliveryBatchStartDate: '2026-05-07',
        deliveryDate: '2026-05-08',
        deliveryDateSource: 'LINE_ITEM_DATE_RANGE',
        deliverySession: 'EVENING',
        orderCreatedAt: '2026-05-05T14:00:00.000Z',
        orderDateLocal: '2026-05-05',
        planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Mississauga',
        routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
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
          zip: 'L5B 3C1'
        },
        updatedAt: '2026-05-07T13:00:00.000Z'
      },
      readiness: 'READY_TO_PLAN',
      reviewReasons: [],
      routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
      serviceType: 'EVENING_DELIVERY',
      shopifyOrderGid: 'gid://shopify/Order/123',
      shopifyOrderLegacyId: BigInt(123),
      timeWindowEnd: '21:00',
      timeWindowStart: '17:00',
      totalPriceAmount: '95.00',
      updatedAtShopify: new Date('2026-05-07T13:00:00.000Z'),
      ...overrides
    }
  };
}

function canonicalOrderRecord(routeStopCount: number): Record<string, unknown> {
  return {
    cancelledAt: null,
    currencyCode: 'CAD',
    deliveryStops: [
      {
        address1: '300 City Centre Dr',
        address2: '#08',
        city: 'Mississauga',
        countryCode: 'CA',
        geocodeStatus: 'RESOLVED',
        id: 'stop-id',
        latitude: '43.589',
        longitude: '-79.644',
        phone: '+14165550000',
        postalCode: 'L5B 3C1',
        province: 'ON',
        recipientName: 'Noah Yoon',
        routePlanStops: Array.from({ length: routeStopCount }, (_, index) => ({
          id: `rps-${index}`,
          routePlan: { id: 'route-plan-id', name: 'Route draft', status: 'ASSIGNED' }
        })),
        status: routeStopCount > 0 ? 'ASSIGNED' : 'PENDING',
      }
    ],
    email: 'customer@example.com',
    financialStatus: 'PAID',
    fulfillmentStatus: 'UNFULFILLED',
    id: 'order-id',
    name: '#1035',
    phone: '+14165550000',
    processedAt: new Date('2026-05-07T12:00:00.000Z'),
    rawPayload: {
      deliveryArea: 'Mississauga',
      deliveryBatchEndDate: '2026-05-09',
      deliveryBatchStartDate: '2026-05-07',
      deliveryDate: '2026-05-08',
      deliveryDateSource: 'LINE_ITEM_DATE_RANGE',
      deliveryDayRaw: 'Friday 5pm to 9pm *Check delivery map',
      deliverySession: 'EVENING',
      deliveryWeekday: 'FRIDAY',
      pickup: false,
      readiness: 'READY_TO_PLAN',
      reviewReasons: [],
      routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
      serviceType: 'EVENING_DELIVERY',
      timeWindowEnd: '21:00',
      timeWindowStart: '17:00'
    },
    shippingAddress: {
      address1: '300 City Centre Dr',
      address2: '#08',
      city: 'Mississauga',
      countryCode: 'CA',
      postalCode: 'L5B 3C1',
      province: 'ON'
    },
    shopifyOrderGid: 'gid://shopify/Order/123',
    shopifyOrderLegacyId: BigInt(123),
    totalPriceAmount: '95.00',
    updatedAtShopify: new Date('2026-05-07T13:00:00.000Z')
  };
}

function canonicalRow(overrides: Partial<CanonicalOrderRow> = {}): CanonicalOrderRow {
  return {
    cancelledAt: null,
    currencyCode: 'CAD',
    deliveryArea: 'Mississauga',
    deliveryBatchEndDate: null,
    deliveryBatchStartDate: null,
    deliveryDate: '2026-05-08',
    deliveryDateSource: 'LINE_ITEM_DATE_RANGE',
    deliveryDayRaw: 'Friday',
    deliverySession: 'EVENING',
    deliveryStopId: 'stop-id',
    deliveryStopStatus: 'PENDING',
    deliveryWeekday: 'FRIDAY',
    email: 'customer@example.com',
    financialStatus: 'PAID',
    fulfillmentStatus: 'UNFULFILLED',
    geocodeStatus: 'RESOLVED',
    hasCoordinates: true,
    latitude: 43.589,
    longitude: -79.644,
    name: '#1035',
    orderCreatedAt: '2026-05-05T14:00:00.000Z',
    orderDateLocal: '2026-05-05',
    orderId: 'order-id',
    phone: '+14165550000',
    pickup: false,
    planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Mississauga',
    planningStatus: 'UNPLANNED',
    processedAt: '2026-05-07T12:00:00.000Z',
    readiness: 'READY_TO_PLAN',
    recipientName: 'Noah Yoon',
    reviewReasons: [],
    routePlanId: null,
    routePlanName: null,
    routePlanStatus: null,
    routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
    serviceType: 'EVENING_DELIVERY',
    shippingAddress: {
      address1: '300 City Centre Dr',
      address2: '#08',
      city: 'Mississauga',
      countryCode: 'CA',
      postalCode: 'L5B 3C1',
      province: 'ON'
    },
    shopifyOrderGid: 'gid://shopify/Order/123',
    shopifyOrderLegacyId: '123',
    sourceOrderId: '123',
    sourceOrderNumber: '1035',
    sourcePlatform: 'SHOPIFY',
    sourceSiteUrl: null,
    sourceUpdatedAt: '2026-05-07T13:00:00.000Z',
    timeWindowEnd: '21:00',
    timeWindowStart: '17:00',
    totalPriceAmount: '95.00',
    updatedAtShopify: '2026-05-07T13:00:00.000Z',
    ...overrides
  };
}
