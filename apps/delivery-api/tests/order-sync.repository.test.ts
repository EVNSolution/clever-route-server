import { describe, expect, test, vi } from 'vitest';

import { deriveOperateDeliveryStatus, deriveOrderHealth } from '../src/modules/shopify/order-operate-status.js';
import { PrismaAdminNotificationRepository } from '../src/modules/notifications/admin-notification.repository.js';
import { AdminNotificationService } from '../src/modules/notifications/admin-notification.service.js';
import { AdminNotificationStreamHub } from '../src/modules/notifications/admin-notification.stream.js';
import { PrismaOrderSyncRepository, type OrderSyncNotificationLogger } from '../src/modules/shopify/order-sync.repository.js';
import type { CanonicalOrderRow, SyncedOrderWithDeliveryStopInput } from '../src/modules/shopify/order-sync.mapper.js';

describe('PrismaOrderSyncRepository canonical orders', () => {
  test('creates new orders and lists canonical rows with planned status derived from route stops', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 1 });
    const repository = createOrderSyncRepository(prisma);

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
        routePlanStatus: 'PUBLISHED',
        serviceType: 'EVENING_DELIVERY',
        timeWindowEnd: '21:00',
        timeWindowStart: '17:00'
      })
    );
  });

  test('reads canonical time windows from route scope without UTC-shifting stored Toronto times', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);
    const order = canonicalOrderRecord(0);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        ...order,
        deliveryFacts: [canonicalDeliveryFactWithUtcTorontoWindow()],
        rawPayload: {
          ...(order.rawPayload as Record<string, unknown>),
          deliveryDate: '2026-05-29',
          routeScopeKey: '2026-05-29|EVENING_DELIVERY|17:00|21:00'
        }
      }
    ]);

    const rows = await repository.listCanonicalOrders({
      filters: {},
      shopDomain: 'example.myshopify.com'
    });

    expect(rows[0]).toEqual(
      expect.objectContaining({
        deliveryDate: '2026-05-29',
        routeScopeKey: '2026-05-29|EVENING_DELIVERY|17:00|21:00',
        timeWindowEnd: '21:00',
        timeWindowStart: '17:00'
      })
    );
    expect(rows[0]?.deliveryMetadataDiagnostics?.current).toEqual(
      expect.objectContaining({
        routeScopeKey: '2026-05-29|EVENING_DELIVERY|17:00|21:00',
        timeWindowEnd: '21:00',
        timeWindowStart: '17:00'
      })
    );
  });

  test('preserves order-week delivery date source when reading canonical rows', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);
    const order = canonicalOrderRecord(0);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        ...order,
        rawPayload: {
          ...(order.rawPayload as Record<string, unknown>),
          deliveryDateSource: 'ORDER_DATE_WEEK_RULE'
        }
      }
    ]);

    const rows = await repository.listCanonicalOrders({
      filters: {},
      shopDomain: 'example.myshopify.com'
    });

    expect(rows[0]).toEqual(
      expect.objectContaining({
        deliveryDateSource: 'ORDER_DATE_WEEK_RULE'
      })
    );
  });

  test('bulk patches selected order state and payment overrides', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);

    await repository.bulkPatchCanonicalOrderStatus({
      actor: 'shopify-user-id',
      field: 'state',
      orderIds: ['order-id'],
      shopDomain: 'example.myshopify.com',
      value: 'DELIVERED'
    });

    const deliveryStopCreateMatcher: unknown = expect.objectContaining({
      orderId: 'order-id',
      shopId: 'shop-id',
      status: 'DELIVERED'
    });
    const deliveryStopUpsertMatcher: unknown = expect.objectContaining({
      create: deliveryStopCreateMatcher,
      update: { status: 'DELIVERED' }
    });
    expect(prisma.deliveryStop.upsert).toHaveBeenCalledWith(deliveryStopUpsertMatcher);

    await repository.bulkPatchCanonicalOrderStatus({
      actor: 'shopify-user-id',
      field: 'payment',
      orderIds: ['order-id'],
      shopDomain: 'example.myshopify.com',
      value: 'ETRANSFER'
    });

    const paymentRawPayloadMatcher: unknown = expect.objectContaining({
      cleverManualPaymentStatus: 'ETRANSFER',
      cleverManualPaymentUpdatedBy: 'shopify-user-id'
    });
    const paymentUpdateDataMatcher: unknown = expect.objectContaining({
      financialStatus: 'ETRANSFER',
      rawPayload: paymentRawPayloadMatcher
    });
    const paymentUpdateMatcher: unknown = expect.objectContaining({
      data: paymentUpdateDataMatcher,
      where: { id: 'order-id' }
    });
    expect(prisma.order.update).toHaveBeenCalledWith(paymentUpdateMatcher);
  });

  test('keeps manual payment override when Shopify sync refreshes the order', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: {
        ...canonicalOrderRecord(0),
        id: 'order-id',
        rawPayload: { cleverManualPaymentStatus: 'CASH' },
        updatedAtShopify: new Date('2026-05-07T13:00:00.000Z')
      },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder({ financialStatus: 'PAID' })
    });

    const rawPayloadOverrideMatcher: unknown = expect.objectContaining({ cleverManualPaymentStatus: 'CASH' });
    const orderUpdateMatcher: unknown = expect.objectContaining({
      rawPayload: rawPayloadOverrideMatcher
    });
    const orderUpsertMatcher: unknown = expect.objectContaining({
      update: orderUpdateMatcher
    });
    expect(prisma.order.upsert).toHaveBeenCalledWith(orderUpsertMatcher);
  });

  test('reads source-created and source-updated store-local dates from raw payload', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);
    const order = canonicalOrderRecord(0);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        ...order,
        sourceUpdatedAt: new Date('2026-06-05T14:00:00.000Z'),
        rawPayload: {
          ...(order.rawPayload as Record<string, unknown>),
          sourceCreatedDate: '2026-06-04',
          sourceUpdatedDate: '2026-06-05'
        }
      }
    ]);

    const rows = await repository.listCanonicalOrders({
      filters: {},
      shopDomain: 'example.myshopify.com'
    });

    expect(rows[0]).toEqual(
      expect.objectContaining({
        processedAt: '2026-05-07T12:00:00.000Z',
        sourceCreatedAt: '2026-05-07T12:00:00.000Z',
        sourceCreatedDate: '2026-06-04',
        sourceUpdatedAt: '2026-06-05T14:00:00.000Z',
        sourceUpdatedDate: '2026-06-05'
      })
    );
  });

  test('keeps ambiguous or unparsed time-window metadata unresolved in canonical rows', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);
    const order = canonicalOrderRecord(0);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        ...order,
        deliveryFacts: [
          {
            ...canonicalDeliveryFactWithUtcTorontoWindow(),
            mappingDiagnostics: {
              deliveryMetadata: {
                candidates: [
                  {
                    parseStatus: 'UNPARSED',
                    path: 'meta_data.consumer_secret',
                    valuePreview: 'bare-secret-value',
                    weekday: null
                  },
                  {
                    parseStatus: 'UNPARSED',
                    path: 'meta_data.delivery_note',
                    valuePreview: '1100 King Street West, 1902A, Toronto, ON M6K 0C6 +14165550100',
                    weekday: null
                  }
                ],
                status: 'NEEDS_REVIEW'
              }
            },
            matchedMappingPaths: {
              deliveryDay: 'meta_data.delivery_day',
              deliveryTimeWindow: 'meta_data.consumer_secret'
            },
            readiness: 'NEEDS_REVIEW',
            reviewReasons: ['ambiguous_delivery_time_window', 'delivery_time_window_unparsed'],
            rawDeliveryTimeWindow: 'bare-secret-value'
          }
        ]
      }
    ]);

    const rows = await repository.listCanonicalOrders({
      filters: {},
      shopDomain: 'example.myshopify.com'
    });

    expect(rows[0]).toEqual(
      expect.objectContaining({
        metadataResolved: false,
        readiness: 'NEEDS_REVIEW',
        routeEligible: false
      })
    );
    expect(rows[0]?.deliveryMetadataDiagnostics?.candidates[0]).toEqual(
      expect.objectContaining({
        path: '[redacted-sensitive-path]',
        valuePreview: '[redacted-secret]'
      })
    );
    expect(
      rows[0]?.deliveryMetadataDiagnostics?.current.rawDeliveryTimeWindowPreview
    ).toBe('[redacted-secret]');
    expect(rows[0]?.deliveryMetadataDiagnostics?.matchedMappingPaths).toEqual(
      expect.objectContaining({
        deliveryTimeWindow: '[redacted-sensitive-path]'
      })
    );
    expect(JSON.stringify(rows[0]?.deliveryMetadataDiagnostics)).not.toContain(
      '1100 King Street West'
    );
    expect(JSON.stringify(rows[0]?.deliveryMetadataDiagnostics)).not.toContain(
      '+14165550100'
    );
    expect(JSON.stringify(rows[0]?.deliveryMetadataDiagnostics)).toContain(
      '[redacted-address]'
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

  test('filters Route Ops planning scope and tabs without leaking completed history', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);
    const ready = canonicalOrderRecord(0);
    const completed = {
      ...canonicalOrderRecord(0),
      id: 'completed-order',
      deliveryStops: [
        {
          ...((canonicalOrderRecord(0).deliveryStops as Array<Record<string, unknown>>)[0] ?? {}),
          status: 'DELIVERED'
        }
      ],
      name: '#completed'
    };
    const missingDate = {
      ...canonicalOrderRecord(0),
      id: 'missing-date-order',
      name: '#missing-date',
      rawPayload: {
        ...(canonicalOrderRecord(0).rawPayload as Record<string, unknown>),
        deliveryDate: null,
        readiness: 'NEEDS_REVIEW',
        reviewReasons: ['missing_delivery_date'],
        routeScopeKey: null,
        serviceType: null
      }
    };
    const planned = {
      ...canonicalOrderRecord(1),
      id: 'planned-order',
      name: '#planned'
    };

    prisma.order.findMany.mockResolvedValueOnce([ready, completed, missingDate, planned]);
    await expect(
      repository.listCanonicalOrders({
        filters: { routeOpsScope: 'planning', routeOpsTab: 'all', routeOpsToday: '2026-05-08' },
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toEqual([
      expect.objectContaining({ orderId: 'order-id' }),
      expect.objectContaining({ orderId: 'missing-date-order' }),
      expect.objectContaining({ orderId: 'planned-order' })
    ]);

    prisma.order.findMany.mockResolvedValueOnce([ready, completed, missingDate, planned]);
    await expect(
      repository.listCanonicalOrders({
        filters: { routeOpsScope: 'planning', routeOpsTab: 'needs_review', routeOpsToday: '2026-05-08' },
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toEqual([expect.objectContaining({ orderId: 'missing-date-order' })]);

    prisma.order.findMany.mockResolvedValueOnce([ready, completed, missingDate, planned]);
    await expect(
      repository.listCanonicalOrders({
        filters: { routeOpsScope: 'history', routeOpsTab: 'all' },
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toEqual([
      expect.objectContaining({ orderId: 'order-id' }),
      expect.objectContaining({ orderId: 'completed-order' }),
      expect.objectContaining({ orderId: 'missing-date-order' }),
      expect.objectContaining({ orderId: 'planned-order' })
    ]);

    prisma.order.findMany.mockResolvedValueOnce([ready, completed, missingDate, planned]);
    await expect(
      repository.listCanonicalOrders({
        filters: { routeOpsScope: 'history', routeOpsTab: 'unplanned' },
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toEqual([expect.objectContaining({ orderId: 'order-id' })]);

    prisma.order.findMany.mockResolvedValueOnce([ready, completed, missingDate, planned]);
    await expect(
      repository.listCanonicalOrders({
        filters: { routeOpsScope: 'history', routeOpsTab: 'planned' },
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toEqual([expect.objectContaining({ orderId: 'planned-order' })]);

    prisma.order.findMany.mockResolvedValueOnce([ready, completed, missingDate, planned]);
    await expect(
      repository.listCanonicalOrders({
        filters: { routeOpsScope: 'history', routeOpsTab: 'needs_review' },
        shopDomain: 'example.myshopify.com'
      })
    ).resolves.toEqual([
      expect.objectContaining({ orderId: 'completed-order' }),
      expect.objectContaining({ orderId: 'missing-date-order' })
    ]);
  });

  test('derives first-pass operate delivery status and health from canonical rows', () => {
    expect(deriveOperateDeliveryStatus(canonicalRow())).toBe('ready');
    expect(deriveOrderHealth(canonicalRow())).toBe('normal');
    expect(deriveOperateDeliveryStatus(canonicalRow({ readiness: 'NEEDS_REVIEW', reviewReasons: ['missing_delivery_date'] }))).toBe('preparing');
    expect(deriveOrderHealth(canonicalRow({ cancelledAt: '2026-05-25T00:00:00.000Z' }))).toBe('needs_review');
    expect(deriveOperateDeliveryStatus(canonicalRow({ planningStatus: 'PLANNED', routePlanStatus: 'PUBLISHED' }))).toBe('preparing');
    expect(deriveOperateDeliveryStatus(canonicalRow({ deliveryStopStatus: 'ASSIGNED', planningStatus: 'PLANNED' }))).toBe('in_progress');
    expect(deriveOperateDeliveryStatus(canonicalRow({ deliveryStopStatus: 'DELIVERED', planningStatus: 'PLANNED' }))).toBe('completed');
  });

  test('does not overwrite a local row when the payload is not newer', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: { id: 'order-id', updatedAtShopify: new Date('2026-05-08T00:00:00.000Z') },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

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
    const repository = createOrderSyncRepository(prisma);

    const result = await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder({ updatedAtShopify: new Date('2026-05-07T13:00:00.000Z') })
    });

    expect(result.status).toBe('updated');
    expect(prisma.order.upsert).toHaveBeenCalledOnce();
    expect(prisma.deliveryStop.upsert).toHaveBeenCalledOnce();
  });

  test('upserts delivery facts atomically with order and delivery stop snapshots', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...syncedOrder(),
        deliveryFact: syncedDeliveryFact()
      }
    });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.orderDeliveryFact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          commerceConnectionId: '8b57ab89-3fe7-4a62-b1f4-b6dbb26ef3ea',
          deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
          deliveryDateWeekdayMismatch: false,
          deliveryDayParseStatus: 'PARSED',
          orderId: 'order-id',
          readiness: 'READY_TO_PLAN',
          shopId: 'shop-id'
        }) as unknown,
        where: { shopId_orderId: { orderId: 'order-id', shopId: 'shop-id' } }
      })
    );
  });

  test('summarizes batch candidates from delivery facts with live coordinate and planned-state joins', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    prisma.orderDeliveryFact.findMany.mockResolvedValueOnce([
      deliveryFactCandidate({ orderId: 'order-1', stopId: 'stop-1' }),
      deliveryFactCandidate({ orderId: 'order-2', planned: true, stopId: 'stop-2' }),
      deliveryFactCandidate({ latitude: null, orderId: 'order-3', stopId: 'stop-3' })
    ]);
    const repository = createOrderSyncRepository(prisma);

    const candidates = await repository.listDeliveryBatchCandidates({
      deliveryDate: '2026-05-08',
      shopDomain: 'example.myshopify.com'
    });

    expect(prisma.orderDeliveryFact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deliveryDate: new Date('2026-05-08T00:00:00.000Z'), shopId: 'shop-id' }
      })
    );
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        alreadyPlannedCount: 1,
        blockedCount: 2,
        missingCoordinatesCount: 1,
        orderCount: 3,
        readyCount: 1
      })
    );
  });

  test('does not let stale missing-coordinate fact readiness block a live-resolved batch candidate', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    prisma.orderDeliveryFact.findMany.mockResolvedValueOnce([
      deliveryFactCandidate({
        orderId: 'order-1',
        readiness: 'NEEDS_REVIEW',
        reviewReasons: ['missing_coordinates'],
        stopId: 'stop-1'
      })
    ]);
    const repository = createOrderSyncRepository(prisma);

    const candidates = await repository.listDeliveryBatchCandidates({
      deliveryDate: '2026-05-08',
      shopDomain: 'example.myshopify.com'
    });

    expect(candidates[0]).toEqual(
      expect.objectContaining({
        blockedCount: 0,
        missingCoordinatesCount: 0,
        readyCount: 1
      })
    );
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
      data: { appId: 'clever', shopDomain: 'localhost:8088' },
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

  test('preserves Route Ops operator corrections across later Woo sync snapshots', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: {
        deliveryFacts: [
          {
            batchEligible: true,
            deliveryArea: 'Operator Area',
            deliveryDate: new Date('2026-05-09T00:00:00.000Z'),
            deliveryDateWeekday: 'SATURDAY',
            deliveryDateWeekdayMismatch: false,
            deliveryDateWeekdayVerified: true,
            deliverySession: 'DAY',
            geocodeStatus: 'RESOLVED',
            mappingDiagnostics: {
              routeOpsCorrections: {
                fields: {
                  address1: { actor: 'dispatcher', correctedAt: '2026-05-28T00:00:00.000Z', source: 'operator_metadata_patch' },
                  deliveryDate: { actor: 'dispatcher', correctedAt: '2026-05-28T00:00:00.000Z', source: 'operator_metadata_patch' },
                  deliverySession: { actor: 'dispatcher', correctedAt: '2026-05-28T00:00:00.000Z', source: 'operator_metadata_patch' },
                  geocodeStatus: { actor: 'dispatcher', correctedAt: '2026-05-28T00:00:00.000Z', source: 'geocoder' },
                  latitude: { actor: 'dispatcher', correctedAt: '2026-05-28T00:00:00.000Z', source: 'geocoder' },
                  longitude: { actor: 'dispatcher', correctedAt: '2026-05-28T00:00:00.000Z', source: 'geocoder' },
                  routeScopeKey: { actor: 'dispatcher', correctedAt: '2026-05-28T00:00:00.000Z', source: 'operator_metadata_patch' },
                  serviceType: { actor: 'dispatcher', correctedAt: '2026-05-28T00:00:00.000Z', source: 'operator_metadata_patch' }
                },
                version: 1
              }
            },
            planningGroupKey: '2026-05-09|DELIVERY|Operator Area',
            readiness: 'READY_TO_PLAN',
            reviewReasons: [],
            routeScopeKey: '2026-05-09|DELIVERY',
            serviceType: 'DELIVERY',
            timeWindowEnd: null,
            timeWindowStart: null
          }
        ],
        deliveryStops: [
          {
            address1: 'Corrected Address',
            address2: null,
            city: 'Mississauga',
            countryCode: 'CA',
            deliveryDate: new Date('2026-05-09T00:00:00.000Z'),
            geocodeStatus: 'RESOLVED',
            latitude: '43.6000000',
            longitude: '-79.6500000',
            postalCode: 'L5B 3C1',
            province: 'ON',
            timeWindowEnd: null,
            timeWindowStart: null
          }
        ],
        id: 'order-id',
        updatedAtShopify: new Date('2026-05-07T12:00:00.000Z')
      },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...syncedOrder({ updatedAtShopify: new Date('2026-05-08T13:00:00.000Z') }),
        deliveryFact: syncedDeliveryFact()
      }
    });

    const stopCall = prisma.deliveryStop.upsert.mock.calls[0];
    if (stopCall === undefined) throw new Error('expected deliveryStop upsert');
    const stopUpdate = (stopCall[0] as { update: Record<string, unknown> }).update;
    expect(stopUpdate).toMatchObject({
      address1: 'Corrected Address',
      geocodeStatus: 'RESOLVED',
      latitude: '43.6000000',
      longitude: '-79.6500000'
    });
    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (factCall === undefined) throw new Error('expected orderDeliveryFact upsert');
    const factUpdate = (factCall[0] as { update: Record<string, unknown> }).update;
    expect(factUpdate).toMatchObject({
      deliveryDate: new Date('2026-05-09T00:00:00.000Z'),
      deliverySession: 'DAY',
      planningGroupKey: '2026-05-09|DELIVERY|||Operator Area',
      routeScopeKey: '2026-05-09|DELIVERY||',
      serviceType: 'DELIVERY'
    });
    const diagnostics: unknown = factUpdate.mappingDiagnostics;
    expect(diagnostics).toMatchObject({ routeOpsCorrections: { version: 1 } });
    const orderCall = prisma.order.upsert.mock.calls[0];
    if (orderCall === undefined) throw new Error('expected order upsert');
    const orderUpdate = (orderCall[0] as { update: Record<string, unknown> }).update;
    expect(orderUpdate.rawPayload).toEqual(expect.objectContaining({ deliveryDate: '2026-05-08' }));
  });

  test('guards valid CLEVER schedules from abnormal newer Woo schedule downgrades while payment updates', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: {
        deliveryFacts: [
          {
            batchEligible: true,
            deliveryArea: 'Operator Area',
            deliveryDate: new Date('2026-05-09T00:00:00.000Z'),
            deliveryDateWeekday: 'SATURDAY',
            deliveryDateWeekdayMismatch: false,
            deliveryDateWeekdayVerified: true,
            deliverySession: 'DAY',
            geocodeStatus: 'RESOLVED',
            mappingDiagnostics: { deliveryMetadata: { status: 'RESOLVED' } },
            planningGroupKey: '2026-05-09|DELIVERY|||Operator Area',
            readiness: 'READY_TO_PLAN',
            reviewReasons: [],
            routeScopeKey: '2026-05-09|DELIVERY||',
            serviceType: 'DELIVERY',
            timeWindowEnd: null,
            timeWindowStart: null
          }
        ],
        deliveryStops: [
          {
            address1: 'Corrected Address',
            address2: null,
            city: 'Mississauga',
            countryCode: 'CA',
            deliveryDate: new Date('2026-05-09T00:00:00.000Z'),
            geocodeStatus: 'RESOLVED',
            latitude: '43.6000000',
            longitude: '-79.6500000',
            postalCode: 'L5B 3C1',
            province: 'ON',
            timeWindowEnd: null,
            timeWindowStart: null
          }
        ],
        id: 'order-id',
        sourceUpdatedAt: new Date('2026-05-08T13:00:00.000Z'),
        updatedAtShopify: new Date('2026-05-08T13:00:00.000Z')
      },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);
    const abnormalFact = {
      ...syncedDeliveryFact(),
      batchEligible: false,
      deliveryDate: null,
      deliveryDateWeekday: null,
      deliveryDateWeekdayVerified: false,
      deliveryDayParseStatus: 'NOT_PROVIDED' as const,
      deliveryDayUnparsedReason: null,
      deliverySession: null,
      deliveryWeekday: null,
      planningGroupKey: null,
      rawDeliveryDate: null,
      rawDeliveryDay: null,
      readiness: 'NEEDS_REVIEW' as const,
      reviewReasons: ['missing_delivery_date', 'missing_route_scope'],
      routeScopeKey: null,
      serviceType: null,
      sourceUpdatedAt: new Date('2026-05-09T13:00:00.000Z'),
      timeWindowEnd: null,
      timeWindowStart: null
    };
    const baseSynced = syncedOrder({
      rawPayload: {
        ...syncedOrder().order.rawPayload,
        deliveryDate: null,
        normalizedPaymentStatus: 'PAID_CONFIRMED',
        paymentMethodId: 'stripe',
        paymentMethodTitle: 'Credit Card',
        wooOrderStatus: 'processing'
      },
      sourcePlatform: 'WOOCOMMERCE',
      sourceUpdatedAt: new Date('2026-05-09T13:00:00.000Z'),
      updatedAtShopify: new Date('2026-05-09T13:00:00.000Z')
    });

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...baseSynced,
        deliveryFact: abnormalFact,
        deliveryStop: {
          ...baseSynced.deliveryStop!,
          deliveryDate: null,
          timeWindowEnd: null,
          timeWindowStart: null
        }
      }
    });

    const stopCall = prisma.deliveryStop.upsert.mock.calls[0];
    if (stopCall === undefined) throw new Error('expected deliveryStop upsert');
    const stopUpdate = (stopCall[0] as { update: Record<string, unknown> }).update;
    expect(stopUpdate).toMatchObject({
      deliveryDate: new Date('2026-05-09T00:00:00.000Z')
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (factCall === undefined) throw new Error('expected orderDeliveryFact upsert');
    const factUpdate = (factCall[0] as { update: Record<string, unknown> }).update;
    expect(factUpdate).toMatchObject({
      batchEligible: true,
      deliveryDate: new Date('2026-05-09T00:00:00.000Z'),
      deliverySession: 'DAY',
      planningGroupKey: '2026-05-09|DELIVERY|||Operator Area',
      readiness: 'READY_TO_PLAN',
      routeScopeKey: '2026-05-09|DELIVERY||',
      serviceType: 'DELIVERY'
    });
    expect(factUpdate.reviewReasons).toEqual([]);
    expect(factUpdate.mappingDiagnostics).toMatchObject({
      wooScheduleDowngradeGuard: {
        preservedFields: expect.arrayContaining(['deliveryDate', 'routeScopeKey']) as unknown,
        reason: 'incoming_woo_schedule_abnormal',
        version: 1
      }
    });

    const orderCall = prisma.order.upsert.mock.calls[0];
    if (orderCall === undefined) throw new Error('expected order upsert');
    const orderUpdate = (orderCall[0] as { update: Record<string, unknown> }).update;
    expect(orderUpdate.rawPayload).toEqual(expect.objectContaining({
      normalizedPaymentStatus: 'PAID_CONFIRMED'
    }));
  });

  test('keeps coordinate-only correction needing review when no delivery fact exists', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: {
        ...canonicalOrderRecord(0),
        deliveryFacts: [],
        deliveryStops: [],
        id: 'order-id',
        shippingAddress: {
          address1: '300 City Centre Dr',
          city: 'Mississauga',
          countryCode: 'CA',
          postalCode: 'L5B 3C1',
          province: 'ON'
        },
        updatedAtShopify: new Date('2026-05-07T12:00:00.000Z')
      },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.patchCanonicalOrderCoordinates({
      actor: 'dispatcher',
      latitude: 43.6,
      longitude: -79.65,
      orderId: 'order-id',
      shopDomain: 'example.myshopify.com',
      source: 'manual'
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (factCall === undefined) throw new Error('expected orderDeliveryFact upsert');
    const factCreate = (factCall[0] as { create: Record<string, unknown> }).create;
    expect(factCreate).toMatchObject({
      batchEligible: false,
      deliveryDate: null,
      planningGroupKey: null,
      readiness: 'NEEDS_REVIEW',
      routeScopeKey: null
    });
    expect(factCreate.reviewReasons).toEqual(expect.arrayContaining(['missing_delivery_area', 'missing_delivery_date', 'missing_route_scope']));
  });

  test('preserves route-scope local time windows when patching unrelated metadata', async () => {
    const existingOrder = {
      ...canonicalOrderRecord(0),
      deliveryFacts: [canonicalDeliveryFactWithUtcTorontoWindow()],
      deliveryStops: [
        {
          address1: '300 City Centre Dr',
          address2: null,
          city: 'Mississauga',
          countryCode: 'CA',
          deliveryDate: new Date('2026-05-29T00:00:00.000Z'),
          geocodeStatus: 'RESOLVED',
          latitude: '43.5890000',
          longitude: '-79.6440000',
          postalCode: 'L5B 3C1',
          province: 'ON',
          timeWindowEnd: new Date('2026-05-30T01:00:00.000Z'),
          timeWindowStart: new Date('2026-05-29T21:00:00.000Z')
        }
      ],
      id: 'order-id',
      updatedAtShopify: new Date('2026-05-07T12:00:00.000Z')
    };
    const { prisma } = createPrismaHarness({
      existingOrder,
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.patchCanonicalOrder({
      actor: 'dispatcher',
      orderId: 'order-id',
      patch: { address1: '4475 Chesswood Dr' },
      shopDomain: 'example.myshopify.com'
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (factCall === undefined) throw new Error('expected orderDeliveryFact upsert');
    const factUpdate = (factCall[0] as { update: Record<string, unknown> }).update;
    expect(factUpdate).toMatchObject({
      planningGroupKey: '2026-05-29|EVENING_DELIVERY|17:00|21:00|Mississauga',
      routeScopeKey: '2026-05-29|EVENING_DELIVERY|17:00|21:00'
    });
    expect(factUpdate.timeWindowStart).toEqual(new Date('2026-05-29T21:00:00.000Z'));
    expect(factUpdate.timeWindowEnd).toEqual(new Date('2026-05-30T01:00:00.000Z'));
  });

  test('clears time-window review blockers when operator patches a coherent manual window', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: timeBlockedExistingOrder(),
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.patchCanonicalOrder({
      actor: 'dispatcher',
      orderId: 'order-id',
      patch: {
        deliverySession: 'EVENING',
        serviceType: 'EVENING_DELIVERY',
        timeWindowEnd: '21:00',
        timeWindowStart: '17:00'
      },
      shopDomain: 'example.myshopify.com'
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (factCall === undefined) throw new Error('expected orderDeliveryFact upsert');
    const factUpdate = (factCall[0] as { update: Record<string, unknown> }).update;
    expect(factUpdate).toMatchObject({
      batchEligible: true,
      planningGroupKey: '2026-05-29|EVENING_DELIVERY|17:00|21:00|Mississauga',
      readiness: 'READY_TO_PLAN',
      reviewReasons: [],
      routeScopeKey: '2026-05-29|EVENING_DELIVERY|17:00|21:00'
    });
  });

  test('keeps time-window review blockers when patch does not correct the window', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: timeBlockedExistingOrder(),
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.patchCanonicalOrder({
      actor: 'dispatcher',
      orderId: 'order-id',
      patch: { address1: '4475 Chesswood Dr' },
      shopDomain: 'example.myshopify.com'
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (factCall === undefined) throw new Error('expected orderDeliveryFact upsert');
    const factUpdate = (factCall[0] as { update: Record<string, unknown> }).update;
    expect(factUpdate).toMatchObject({
      batchEligible: false,
      readiness: 'NEEDS_REVIEW',
      reviewReasons: [
        'ambiguous_delivery_time_window',
        'delivery_time_window_unparsed'
      ],
      routeScopeKey: '2026-05-29|DELIVERY||'
    });
  });

  test('does not clear unresolved date blockers when only coordinates are corrected', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: {
        ...canonicalOrderRecord(0),
        deliveryFacts: [
          {
            deliveryArea: 'Mississauga',
            deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
            deliveryDateWeekday: 'FRIDAY',
            deliverySession: 'EVENING',
            mappingDiagnostics: {},
            planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Mississauga',
            reviewReasons: ['missing_coordinates', 'delivery_date_weekday_mismatch'],
            routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
            serviceType: 'EVENING_DELIVERY',
            timeWindowEnd: new Date('2026-05-08T21:00:00.000Z'),
            timeWindowStart: new Date('2026-05-08T17:00:00.000Z')
          }
        ],
        id: 'order-id',
        updatedAtShopify: new Date('2026-05-07T12:00:00.000Z')
      },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.patchCanonicalOrderCoordinates({
      actor: 'dispatcher',
      latitude: 43.6,
      longitude: -79.65,
      orderId: 'order-id',
      shopDomain: 'example.myshopify.com',
      source: 'manual'
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (factCall === undefined) throw new Error('expected orderDeliveryFact upsert');
    const factUpdate = (factCall[0] as { update: Record<string, unknown> }).update;
    expect(factUpdate).toMatchObject({
      batchEligible: false,
      readiness: 'NEEDS_REVIEW'
    });
    expect(factUpdate.reviewReasons).toEqual(['delivery_date_weekday_mismatch']);
  });

  test('clears stale delivery stop fields when a newer snapshot has no shipping address', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: { id: 'order-id', updatedAtShopify: new Date('2026-05-07T12:00:00.000Z') },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

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

  test.each(['DRAFT', 'PUBLISHED'])(
    'creates a critical notification when Woo changes an address already assigned to a %s route',
    async (routePlanStatus) => {
      const { prisma } = createPrismaHarness({
        existingOrder: routedExistingOrder(routePlanStatus),
        routeStopCount: 0
      });
      const repository = createOrderSyncRepository(prisma);

      await repository.upsertOrderWithDeliveryStop({
        shopDomain: 'example.myshopify.com',
        synced: syncedOrder({
          sourcePlatform: 'WOOCOMMERCE',
          sourceUpdatedAt: new Date('2026-05-08T13:00:00.000Z'),
          updatedAtShopify: new Date('2026-05-08T13:00:00.000Z')
        })
      });

      const anyObjectMatcher: unknown = expect.any(Object);
      const notificationCreateDataMatcher: unknown = expect.objectContaining({
        href: '/admin/ui/app/routes/route-plan-id',
        orderId: 'order-id',
        routePlanId: 'route-plan-id',
        severity: 'critical',
        shopId: 'shop-id',
        title: 'Route assigned order address changed',
        type: 'WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED'
      });
      expect(prisma.adminNotification.create).toHaveBeenCalledWith({
        data: notificationCreateDataMatcher,
        select: anyObjectMatcher
      });
      const createInput = prisma.adminNotification.create.mock.calls[0]?.[0] as
        | { data?: { dedupeKey?: string; payload?: Record<string, unknown> } }
        | undefined;
      expect(createInput?.data?.dedupeKey).toMatch(
        /^woo_address_changed_route_assigned:shop-id:order-id:route-plan-id:/u
      );
      expect(createInput?.data?.payload).toEqual(expect.objectContaining({
        routePlanStatus
      }));
    }
  );

  test('does not notify when the changed Woo address is not assigned to a route', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: routedExistingOrder('DRAFT', { routePlanStops: [] }),
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder({
        sourcePlatform: 'WOOCOMMERCE',
        sourceUpdatedAt: new Date('2026-05-08T13:00:00.000Z'),
        updatedAtShopify: new Date('2026-05-08T13:00:00.000Z')
      })
    });

    expect(prisma.adminNotification.create).not.toHaveBeenCalled();
  });

  test('does not emit Woo address notifications for non-Woo order snapshots', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: routedExistingOrder('DRAFT'),
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder({
        sourcePlatform: 'SHOPIFY',
        sourceUpdatedAt: new Date('2026-05-08T13:00:00.000Z'),
        updatedAtShopify: new Date('2026-05-08T13:00:00.000Z')
      })
    });

    expect(prisma.adminNotification.create).not.toHaveBeenCalled();
  });

  test('writes routed-address notifications after the sync transaction with duplicate skipping', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: routedExistingOrder('DRAFT'),
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await expect(
      repository.upsertOrderWithDeliveryStop({
        shopDomain: 'example.myshopify.com',
        synced: {
          ...syncedOrder({
          sourcePlatform: 'WOOCOMMERCE',
          sourceUpdatedAt: new Date('2026-05-08T13:00:00.000Z'),
          updatedAtShopify: new Date('2026-05-08T13:00:00.000Z')
          }),
          deliveryFact: syncedDeliveryFact()
        }
      })
    ).resolves.toEqual(expect.objectContaining({ status: 'updated' }));
    const notificationDedupeMatcher: unknown = expect.stringMatching(
      /^woo_address_changed_route_assigned:shop-id:order-id:route-plan-id:/u
    );
    const notificationCreateDataMatcher: unknown = expect.objectContaining({
      dedupeKey: notificationDedupeMatcher
    });
    const notificationCreateMatcher: unknown = expect.objectContaining({
      data: notificationCreateDataMatcher
    });
    expect(prisma.orderDeliveryFact.upsert).toHaveBeenCalled();
    expect(prisma.adminNotification.create).toHaveBeenCalledWith(
      notificationCreateMatcher
    );
  });

  test('keeps Woo order sync committed when the post-commit advisory notification write fails', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: routedExistingOrder('DRAFT'),
      routeStopCount: 0
    });
    prisma.adminNotification.create.mockRejectedValueOnce(
      new Error('notification table unavailable')
    );
    const notificationWarn = vi.fn<(bindings: Record<string, unknown>, message: string) => void>();
    const notificationLogger: OrderSyncNotificationLogger = { warn: notificationWarn };
    const repository = createOrderSyncRepository(prisma, { notificationLogger });

    await expect(
      repository.upsertOrderWithDeliveryStop({
        shopDomain: 'example.myshopify.com',
        synced: {
          ...syncedOrder({
          sourcePlatform: 'WOOCOMMERCE',
          sourceUpdatedAt: new Date('2026-05-08T13:00:00.000Z'),
          updatedAtShopify: new Date('2026-05-08T13:00:00.000Z')
          }),
          deliveryFact: syncedDeliveryFact()
        }
      })
    ).resolves.toEqual(expect.objectContaining({ status: 'updated' }));
    expect(prisma.orderDeliveryFact.upsert).toHaveBeenCalled();
    const transactionOrder = prisma.$transaction.mock.invocationCallOrder[0] ?? 0;
    const notificationOrder = prisma.adminNotification.create.mock.invocationCallOrder[0] ?? 0;
    expect(transactionOrder).toBeLessThan(notificationOrder);
    const notificationWarningMatcher: unknown = expect.objectContaining({
      err: expect.any(Error) as unknown,
      eventType: 'woo.assigned_route_address_changed',
      orderId: 'order-id',
      shopId: 'shop-id'
    });
    expect(notificationWarn).toHaveBeenCalledWith(
      notificationWarningMatcher,
      'admin web notification write failed after order sync commit'
    );
  });

  test('uses a new dedupe key when Woo changes the same routed order to a second distinct address', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: routedExistingOrder('DRAFT'),
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder({
        sourcePlatform: 'WOOCOMMERCE',
        sourceUpdatedAt: new Date('2026-05-08T13:00:00.000Z'),
        updatedAtShopify: new Date('2026-05-08T13:00:00.000Z')
      })
    });
    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...syncedOrder({
          sourcePlatform: 'WOOCOMMERCE',
          sourceUpdatedAt: new Date('2026-05-08T14:00:00.000Z'),
          updatedAtShopify: new Date('2026-05-08T14:00:00.000Z')
        }),
        deliveryStop: {
          ...(syncedOrder()
            .deliveryStop as NonNullable<
            SyncedOrderWithDeliveryStopInput['deliveryStop']
          >),
          address1: '400 Second Address Ave'
        }
      }
    });

    const dedupeKeys = prisma.adminNotification.create.mock.calls.map((call) =>
      String((call[0] as { data: { dedupeKey: string } }).data.dedupeKey)
    );
    expect(dedupeKeys).toHaveLength(2);
    expect(new Set(dedupeKeys).size).toBe(2);
  });

});


function createOrderSyncRepository(
  prisma: ReturnType<typeof createPrismaHarness>['prisma'],
  options: { notificationLogger?: OrderSyncNotificationLogger } = {},
): PrismaOrderSyncRepository {
  const streamHub = new AdminNotificationStreamHub();
  const notificationService = new AdminNotificationService(
    new PrismaAdminNotificationRepository(prisma as never),
    streamHub,
  );
  return new PrismaOrderSyncRepository(
    prisma as unknown as ConstructorParameters<typeof PrismaOrderSyncRepository>[0],
    {
      notificationService,
      ...(options.notificationLogger === undefined
        ? {}
        : { notificationLogger: options.notificationLogger }),
    },
  );
}

function createPrismaHarness(input: {
  existingOrder: ({ id: string; sourceUpdatedAt?: Date | null; updatedAtShopify: Date | null; deliveryFacts?: Array<Record<string, unknown>>; deliveryStops?: Array<Record<string, unknown>> } & Record<string, unknown>) | null;
  routeStopCount: number;
}): {
  prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    adminNotification: { create: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
    commerceConnectionOrderMapping: { findUnique: ReturnType<typeof vi.fn> };
    deliveryStop: { updateMany: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    order: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
    orderDeliveryFact: { findMany: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    shop: { create?: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  };
} {
  const orderRecord = canonicalOrderRecord(input.routeStopCount);
  const prisma = {
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(prisma)),
    adminNotification: {
      create: vi.fn((createInput: { data: Record<string, unknown> }) =>
        Promise.resolve({
          body: (createInput.data.body ?? null) as string | null,
          createdAt: new Date('2026-05-08T13:01:00.000Z'),
          href: (createInput.data.href ?? null) as string | null,
          id: `notification-${prisma.adminNotification.create.mock.calls.length}`,
          orderId: (createInput.data.orderId ?? null) as string | null,
          payload: (createInput.data.payload ?? null) as Record<string, unknown> | null,
          readAt: null as Date | null,
          routePlanId: (createInput.data.routePlanId ?? null) as string | null,
          severity: createInput.data.severity as string,
          title: createInput.data.title as string,
          type: createInput.data.type as string
        })
      ),
      findUnique: vi.fn(() => Promise.resolve(null))
    },
    commerceConnectionOrderMapping: {
      findUnique: vi.fn(() => Promise.resolve(null))
    },
    deliveryStop: {
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      upsert: vi.fn(() => Promise.resolve({ id: 'stop-id' }))
    },
    order: {
      create: vi.fn(() => Promise.resolve({ id: 'order-id' })),
      findFirst: vi.fn(() => Promise.resolve(input.existingOrder === null ? null : { sourceUpdatedAt: null, ...input.existingOrder })),
      findMany: vi.fn(() => Promise.resolve([orderRecord])),
      update: vi.fn(() => Promise.resolve({ id: 'order-id' })),
      upsert: vi.fn(() => Promise.resolve({ id: 'order-id' }))
    },
    orderDeliveryFact: {
      findMany: vi.fn(() => Promise.resolve([])),
      upsert: vi.fn(() => Promise.resolve({ id: 'fact-id' }))
    },
    shop: { findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' })) }
  };
  return {
    prisma
  };
}


function routedExistingOrder(
  routePlanStatus: string,
  overrides: { routePlanStops?: Array<Record<string, unknown>> } = {}
): ({ id: string; updatedAtShopify: Date; deliveryStops: Array<Record<string, unknown>> } & Record<string, unknown>) {
  return {
    ...canonicalOrderRecord(0),
    deliveryStops: [
      {
        address1: '100 Old Route St',
        address2: 'Unit 1',
        city: 'Mississauga',
        countryCode: 'CA',
        deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
        geocodeStatus: 'RESOLVED',
        latitude: '43.5000000',
        longitude: '-79.6000000',
        postalCode: 'L5A 1A1',
        province: 'ON',
        routePlanStops: overrides.routePlanStops ?? [
          {
            routePlan: {
              id: 'route-plan-id',
              name: 'Route draft',
              status: routePlanStatus
            }
          }
        ],
        timeWindowEnd: new Date('2026-05-09T01:00:00.000Z'),
        timeWindowStart: new Date('2026-05-08T21:00:00.000Z')
      }
    ],
    id: 'order-id',
    sourceUpdatedAt: new Date('2026-05-07T13:00:00.000Z'),
    updatedAtShopify: new Date('2026-05-07T13:00:00.000Z')
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

function syncedDeliveryFact(): NonNullable<SyncedOrderWithDeliveryStopInput['deliveryFact']> {
  return {
    batchEligible: true,
    commerceConnectionId: '8b57ab89-3fe7-4a62-b1f4-b6dbb26ef3ea',
    computedAt: new Date('2026-05-07T13:00:00.000Z'),
    deliveryArea: 'Mississauga',
    deliveryDate: '2026-05-08',
    deliveryDateWeekday: 'FRIDAY',
    deliveryDateWeekdayMismatch: false,
    deliveryDateWeekdayVerified: true,
    deliveryDayParseStatus: 'PARSED',
    deliveryDayUnparsedReason: null,
    deliverySession: 'EVENING',
    deliveryWeekday: 'FRIDAY',
    geocodeStatus: 'RESOLVED',
    mappingDiagnostics: { discoveredPathStats: { 'meta_data.delivery_day': 1 } },
    matchedMappingPaths: {
      deliveryArea: 'meta_data.delivery_area',
      deliveryDate: 'meta_data.delivery_date',
      deliveryDay: 'meta_data.delivery_day',
      deliveryTimeWindow: null
    },
    planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Mississauga',
    rawDeliveryArea: 'Mississauga',
    rawDeliveryDate: '2026-05-08',
    rawDeliveryDay: 'Friday 5pm to 9pm *Check delivery map',
    rawDeliveryTimeWindow: null,
    rawPickupDay: null,
    readiness: 'READY_TO_PLAN',
    reviewReasons: [],
    routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
    serviceType: 'EVENING_DELIVERY',
    sourceOrderId: '123',
    sourceOrderNumber: '#1035',
    sourcePlatform: 'WOOCOMMERCE',
    sourceSiteUrl: 'https://woo.example.test',
    sourceUpdatedAt: new Date('2026-05-07T13:00:00.000Z'),
    timeWindowEnd: '21:00',
    timeWindowStart: '17:00'
  };
}

function deliveryFactCandidate(input: {
  latitude?: string | null;
  orderId: string;
  planned?: boolean;
  readiness?: string;
  reviewReasons?: string[];
  stopId: string;
}): Record<string, unknown> {
  return {
    deliveryArea: 'Mississauga',
    deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
    deliveryDateWeekdayMismatch: false,
    deliveryDateWeekdayVerified: true,
    deliveryDayParseStatus: 'PARSED',
    deliverySession: 'EVENING',
    order: {
      deliveryStops: [
        {
          latitude: input.latitude === undefined ? '43.589' : input.latitude,
          longitude: input.latitude === null ? null : '-79.644',
          routePlanStops: input.planned === true ? [{ id: 'route-stop-id' }] : [],
          id: input.stopId
        }
      ]
    },
    orderId: input.orderId,
    planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Mississauga',
    rawDeliveryDay: 'Friday 5pm to 9pm *Check delivery map',
    rawDeliveryTimeWindow: null,
    readiness: input.readiness ?? 'READY_TO_PLAN',
    reviewReasons: input.reviewReasons ?? [],
    routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
    serviceType: 'EVENING_DELIVERY'
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
          routePlan: { id: 'route-plan-id', name: 'Route draft', status: 'PUBLISHED' }
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

function timeBlockedExistingOrder(): {
  deliveryFacts: Array<Record<string, unknown>>;
  deliveryStops: Array<Record<string, unknown>>;
  id: string;
  updatedAtShopify: Date;
} & Record<string, unknown> {
  return {
    ...canonicalOrderRecord(0),
    deliveryFacts: [
      {
        ...canonicalDeliveryFactWithUtcTorontoWindow(),
        deliverySession: 'DAY',
        planningGroupKey: '2026-05-29|DELIVERY|Mississauga',
        readiness: 'NEEDS_REVIEW',
        reviewReasons: [
          'ambiguous_delivery_time_window',
          'delivery_time_window_unparsed'
        ],
        routeScopeKey: '2026-05-29|DELIVERY',
        serviceType: 'DELIVERY',
        timeWindowEnd: null,
        timeWindowStart: null
      }
    ],
    deliveryStops: [
      {
        address1: '300 City Centre Dr',
        address2: null,
        city: 'Mississauga',
        countryCode: 'CA',
        deliveryDate: new Date('2026-05-29T00:00:00.000Z'),
        geocodeStatus: 'RESOLVED',
        latitude: '43.5890000',
        longitude: '-79.6440000',
        postalCode: 'L5B 3C1',
        province: 'ON',
        timeWindowEnd: null,
        timeWindowStart: null
      }
    ],
    id: 'order-id',
    updatedAtShopify: new Date('2026-05-07T12:00:00.000Z')
  };
}

function canonicalDeliveryFactWithUtcTorontoWindow(): Record<string, unknown> {
  return {
    deliveryArea: 'Mississauga',
    deliveryDate: new Date('2026-05-29T00:00:00.000Z'),
    deliveryDateWeekday: 'FRIDAY',
    deliveryDateWeekdayMismatch: false,
    deliveryDateWeekdayVerified: true,
    deliveryDayParseStatus: 'PARSED',
    deliverySession: 'EVENING',
    deliveryWeekday: 'FRIDAY',
    mappingDiagnostics: {
      deliveryMetadata: {
        candidates: [
          {
            parseStatus: 'PARSED',
            path: 'meta_data.delivery_time',
            timeWindowEnd: '21:00',
            timeWindowStart: '17:00',
            valuePreview: 'Friday 5pm to 9pm',
            weekday: 'FRIDAY'
          }
        ],
        status: 'RESOLVED'
      }
    },
    matchedMappingPaths: {
      deliveryDay: 'meta_data.delivery_day',
      deliveryTimeWindow: 'meta_data.delivery_time'
    },
    planningGroupKey: '2026-05-29|EVENING_DELIVERY|17:00|21:00|Mississauga',
    rawDeliveryDay: 'Friday',
    rawDeliveryTimeWindow: 'Friday 5pm to 9pm',
    readiness: 'READY_TO_PLAN',
    reviewReasons: [],
    routeScopeKey: '2026-05-29|EVENING_DELIVERY|17:00|21:00',
    serviceType: 'EVENING_DELIVERY',
    timeWindowEnd: new Date('2026-05-30T01:00:00.000Z'),
    timeWindowStart: new Date('2026-05-29T21:00:00.000Z')
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
    sourceCreatedAt: '2026-05-07T12:00:00.000Z',
    sourceCreatedDate: '2026-05-07',
    sourceSiteUrl: null,
    sourceUpdatedAt: '2026-05-07T13:00:00.000Z',
    sourceUpdatedDate: '2026-05-07',
    timeWindowEnd: '21:00',
    timeWindowStart: '17:00',
    totalPriceAmount: '95.00',
    updatedAtShopify: '2026-05-07T13:00:00.000Z',
    ...overrides
  };
}
