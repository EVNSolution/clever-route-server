import { describe, expect, test, vi } from 'vitest';

import { deriveOperateDeliveryStatus, deriveOrderHealth } from '../src/modules/shopify/order-operate-status.js';
import { PrismaAdminNotificationRepository } from '../src/modules/notifications/admin-notification.repository.js';
import { AdminNotificationService } from '../src/modules/notifications/admin-notification.service.js';
import { AdminNotificationStreamHub } from '../src/modules/notifications/admin-notification.stream.js';
import {
  OrderSyncRouteLockedError,
  PrismaOrderSyncRepository,
  toCanonicalOrderWhere,
  type ListCanonicalOrdersFilters,
  type OrderSyncNotificationLogger
} from '../src/modules/shopify/order-sync.repository.js';
import type { CanonicalOrderRow, SyncedOrderWithDeliveryStopInput } from '../src/modules/shopify/order-sync.mapper.js';

describe('PrismaOrderSyncRepository canonical orders', () => {
  test.each([
    { filters: {}, expected: ['DELIVERY', 'EVENING_DELIVERY', 'PICKUP', null] },
    { filters: { serviceCategory: 'DELIVERY' }, expected: ['DELIVERY', 'EVENING_DELIVERY'] },
    { filters: { serviceCategory: 'PICKUP' }, expected: ['PICKUP'] },
    { filters: { serviceType: 'DELIVERY' }, expected: ['DELIVERY'] },
    { filters: { serviceCategory: 'DELIVERY', serviceType: 'EVENING_DELIVERY' }, expected: ['EVENING_DELIVERY'] },
    { filters: { serviceCategory: 'DELIVERY', serviceType: 'PICKUP' }, expected: [] },
  ] satisfies Array<{ filters: ListCanonicalOrdersFilters; expected: Array<string | null> }>)('combines Thursday with service filters $filters', async ({ filters, expected }) => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    const order = canonicalOrderRecord(0);
    prisma.order.findMany.mockResolvedValueOnce(
      ['THURSDAY', 'FRIDAY'].flatMap((deliveryWeekday) =>
        ['DELIVERY', 'EVENING_DELIVERY', 'PICKUP', null].map((serviceType) => ({
          ...order,
          id: `${deliveryWeekday}-${serviceType ?? 'unknown'}`,
          rawPayload: { ...(order.rawPayload as Record<string, unknown>), deliveryWeekday, serviceType },
        })),
      ),
    );
    const rows = await createOrderSyncRepository(prisma).listCanonicalOrders({
      filters: { ...filters, deliveryWeekday: 'THURSDAY' },
      shopDomain: 'example.myshopify.com',
    });
    expect(rows.map((row) => row.serviceType)).toEqual(expected);
    expect(rows.every((row) => row.deliveryWeekday === 'THURSDAY')).toBe(true);
  });

  test.each([
    { serviceCategory: 'DELIVERY', serviceTypes: ['DELIVERY', 'EVENING_DELIVERY'] },
    { serviceCategory: 'PICKUP', serviceTypes: ['PICKUP'] },
  ] as const)('applies $serviceCategory and exact filters to the same database fact before pagination', ({ serviceCategory, serviceTypes }) => {
    expect(toCanonicalOrderWhere('shop-id', {
      deliveryWeekday: 'THURSDAY', serviceCategory, serviceType: 'DELIVERY',
    })).toEqual(expect.objectContaining({
      AND: expect.arrayContaining([{ deliveryFacts: { some: {
        deliveryWeekday: 'THURSDAY',
        serviceType: 'DELIVERY',
        AND: [{ serviceType: { in: serviceTypes } }],
      } } }]) as unknown,
    }));
  });

  test('pushes every user-visible search surface into the canonical database query', () => {
    const customerSearch = JSON.stringify(toCanonicalOrderWhere('shop-id', { search: 'Hannah' }));
    expect(customerSearch).toContain('recipientName');
    expect(customerSearch).toContain('address1');
    expect(customerSearch).toContain('deliveryArea');
    expect(customerSearch).toContain('rawDeliveryDate');
    expect(customerSearch).toContain('serviceType');

    const unplannedSearch = JSON.stringify(toCanonicalOrderWhere('shop-id', { search: 'unplanned' }));
    expect(unplannedSearch).toContain('routePlanStops');
    expect(unplannedSearch).toContain('"none"');
  });

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

  test('skips a permanently redacted Shopify identity before any canonical write', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0, tombstonedOrder: true });
    const repository = createOrderSyncRepository(prisma);

    await expect(repository.upsertOrderWithDeliveryStop({
      appId: 'clever',
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder()
    })).resolves.toEqual({
      orderId: 'gid://shopify/Order/123',
      reason: 'ORDER_PRIVACY_REDACTED',
      status: 'skipped',
      stopId: null
    });
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(prisma.shopifyOrderRedactionTombstone.findUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        appId_shopId_shopifyOrderLegacyId: {
          appId: 'clever',
          shopId: 'shop-id',
          shopifyOrderLegacyId: 123n
        }
      }
    });
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
    expect(prisma.order.upsert).not.toHaveBeenCalled();
    expect(prisma.deliveryStop.upsert).not.toHaveBeenCalled();
  });

  test('returns every route membership and keeps planned orders eligible for another plan', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 2 });
    const repository = createOrderSyncRepository(prisma);

    const rows = await repository.listCanonicalOrders({
      filters: {},
      shopDomain: 'example.myshopify.com'
    });

    expect(rows[0]).toEqual(expect.objectContaining({
      planningStatus: 'PLANNED',
      routeEligible: true,
      routeMemberships: [
        { id: 'route-plan-id-1', name: 'Route draft 1', status: 'READY' },
        { id: 'route-plan-id-2', name: 'Route draft 2', status: 'READY' }
      ]
    }));
  });

  test('rejects an explicit shop id that does not match the app and domain scope', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    prisma.shop.findFirst.mockResolvedValue(null);
    const repository = createOrderSyncRepository(prisma);

    await expect(repository.upsertOrderWithDeliveryStop({
      appId: 'clever-route-dev',
      shopDomain: 'shop-a.myshopify.com',
      shopId: 'shop-b-id',
      synced: syncedOrder()
    })).rejects.toThrow('Shop not installed: shop-a.myshopify.com');
    await expect(repository.listCanonicalOrders({
      appId: 'clever-route-dev',
      filters: {},
      shopDomain: 'shop-a.myshopify.com',
      shopId: 'shop-b-id'
    })).resolves.toEqual([]);

    const exactShopScopeMatcher: unknown = expect.objectContaining({
      appId: 'clever-route-dev',
      id: 'shop-b-id',
      shopDomain: 'shop-a.myshopify.com'
    });
    expect(prisma.shop.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: exactShopScopeMatcher
    });
    expect(prisma.order.upsert).not.toHaveBeenCalled();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
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

  test('exposes the pickup completion deadline without changing a failed route stop', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);
    const order = canonicalOrderRecord(0);
    prisma.order.findMany.mockResolvedValueOnce([{
      ...order,
      deliveryFacts: [{
        ...canonicalDeliveryFactWithUtcTorontoWindow(),
        deliveryDate: new Date('2026-09-04T00:00:00.000Z'),
        deliverySession: 'PICKUP',
        serviceType: 'PICKUP',
        timeWindowEnd: null,
        timeWindowStart: null
      }],
      deliveryStops: [{
        ...(order.deliveryStops as Array<Record<string, unknown>>)[0],
        deliveryDate: new Date('2026-09-04T00:00:00.000Z'),
        status: 'FAILED',
        timeWindowEnd: null,
        timeWindowStart: null
      }],
      rawPayload: {
        ...(order.rawPayload as Record<string, unknown>),
        deliveryDate: '2026-09-04',
        pickup: true,
        serviceType: 'PICKUP'
      }
    }]);

    const rows = await repository.listCanonicalOrders({ filters: {}, shopDomain: 'example.myshopify.com' });

    expect(rows[0]).toEqual(expect.objectContaining({
      deliveryStopStatus: 'FAILED',
      pickupCompleteAfter: '2026-09-05T04:00:00.000Z',
      serviceType: 'PICKUP'
    }));
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
    const manualDeliveryStatusMatcher: unknown = expect.objectContaining({
      cleverManualDeliveryStatus: 'DELIVERED',
      cleverManualDeliveryUpdatedBy: 'shopify-user-id'
    });
    expect(prisma.deliveryStop.upsert).toHaveBeenCalledWith(deliveryStopUpsertMatcher);
    expect(prisma.order.update).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        rawPayload: manualDeliveryStatusMatcher
      },
      where: { id: 'order-id' }
    }));

    await repository.bulkPatchCanonicalOrderStatus({
      actor: 'shopify-user-id',
      field: 'payment',
      orderIds: ['order-id'],
      shopDomain: 'example.myshopify.com',
      value: 'PENDING'
    });

    const paymentRawPayloadMatcher: unknown = expect.objectContaining({
      cleverManualPaymentStatus: 'PENDING',
      cleverManualPaymentUpdatedBy: 'shopify-user-id'
    });
    const paymentUpdateDataMatcher: unknown = expect.objectContaining({
      financialStatus: 'PENDING',
      rawPayload: paymentRawPayloadMatcher
    });
    const paymentUpdateMatcher: unknown = expect.objectContaining({
      data: paymentUpdateDataMatcher,
      where: { id: 'order-id' }
    });
    expect(prisma.order.update).toHaveBeenCalledWith(paymentUpdateMatcher);
  });

  test('bulk delivery correction locks the affected route and starts a valid completion marker', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 1 });
    prisma.order.findMany
      .mockResolvedValueOnce([orderStatusPatchRecord()])
      .mockResolvedValueOnce([orderStatusPatchRecord()])
      .mockResolvedValueOnce([orderStatusPatchRecord()])
      .mockResolvedValueOnce([canonicalOrderRecord(1)]);
    prisma.routePlan.findFirst.mockResolvedValue(orderCompletionReconciliationRoute('DELIVERED'));
    const repository = createOrderSyncRepository(prisma);

    await repository.bulkPatchCanonicalOrderStatus({
      actor: 'shopify-user-id',
      field: 'state',
      orderIds: ['order-id'],
      shopDomain: 'example.myshopify.com',
      value: 'DELIVERED'
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    const lockCalls = prisma.$queryRaw.mock.calls as unknown as Array<[TemplateStringsArray, string, string]>;
    expect(lockCalls[0]?.[1]).toBe('route-plan-id');
    expect(lockCalls[1]?.[1]).toBe('order-id');
    const completionUpdate = prisma.routePlan.updateMany.mock.calls.at(-1)?.[0] as unknown as {
      data: {
        deliveryWorkCompletedAt: Date;
        deliveryWorkCompletedGeneration: bigint;
        deliveryWorkCompletedVersionId: string;
        driverNavigationUntil: Date;
      };
      where: { id: string; shopId: string; status: string };
    } | undefined;
    expect(completionUpdate?.data.deliveryWorkCompletedAt).toBeInstanceOf(Date);
    expect(completionUpdate?.data.deliveryWorkCompletedGeneration).toBe(1n);
    expect(completionUpdate?.data.deliveryWorkCompletedVersionId).toBe('route-version-id');
    expect(completionUpdate?.data.driverNavigationUntil).toBeInstanceOf(Date);
    expect(completionUpdate?.where).toMatchObject({ id: 'route-plan-id', shopId: 'shop-id', status: 'IN_PROGRESS' });
  });

  test('bulk reopen correction clears a previously valid completion marker under the route lock', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 1 });
    prisma.order.findMany
      .mockResolvedValueOnce([orderStatusPatchRecord()])
      .mockResolvedValueOnce([orderStatusPatchRecord()])
      .mockResolvedValueOnce([orderStatusPatchRecord()])
      .mockResolvedValueOnce([canonicalOrderRecord(1)]);
    prisma.routePlan.findFirst.mockResolvedValue(orderCompletionReconciliationRoute('PENDING', true));
    const repository = createOrderSyncRepository(prisma);

    await repository.bulkPatchCanonicalOrderStatus({
      actor: 'shopify-user-id',
      field: 'state',
      orderIds: ['order-id'],
      shopDomain: 'example.myshopify.com',
      value: 'PENDING'
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.routePlan.updateMany).toHaveBeenCalledWith({
      data: {
        deliveryWorkCompletedAt: null,
        deliveryWorkCompletedGeneration: null,
        deliveryWorkCompletedVersionId: null,
        driverNavigationUntil: null
      },
      where: { assignmentGeneration: 1n, id: 'route-plan-id', shopId: 'shop-id', status: 'IN_PROGRESS' }
    });
  });

  test('bulk state correction aborts before writes when route membership changes during lock acquisition', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 1 });
    prisma.order.findMany
      .mockResolvedValueOnce([orderStatusPatchRecord()])
      .mockResolvedValueOnce([orderStatusPatchRecord()])
      .mockResolvedValueOnce([orderStatusPatchRecord('other-route-plan-id')]);
    const repository = createOrderSyncRepository(prisma);

    await expect(repository.bulkPatchCanonicalOrderStatus({
      actor: 'shopify-user-id',
      field: 'state',
      orderIds: ['order-id'],
      shopDomain: 'example.myshopify.com',
      value: 'DELIVERED'
    })).rejects.toBeInstanceOf(OrderSyncRouteLockedError);

    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.deliveryStop.upsert).not.toHaveBeenCalled();
    expect(prisma.routePlan.updateMany).not.toHaveBeenCalled();
  });

  test('keeps manual payment override when Shopify sync refreshes the order', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: {
        ...canonicalOrderRecord(0),
        id: 'order-id',
        rawPayload: { cleverManualPaymentStatus: 'PENDING' },
        updatedAtShopify: new Date('2026-05-07T13:00:00.000Z')
      },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder({ financialStatus: 'PAID' })
    });

    const rawPayloadOverrideMatcher: unknown = expect.objectContaining({ cleverManualPaymentStatus: 'PENDING' });
    const orderUpdateMatcher: unknown = expect.objectContaining({
      rawPayload: rawPayloadOverrideMatcher
    });
    const orderUpsertMatcher: unknown = expect.objectContaining({
      update: orderUpdateMatcher
    });
    expect(prisma.order.upsert).toHaveBeenCalledWith(orderUpsertMatcher);
  });

  test('migrates a legacy payment method out of manual financial status during sync', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: {
        ...canonicalOrderRecord(0),
        id: 'order-id',
        rawPayload: { cleverManualPaymentStatus: 'ETRANSFER' },
        updatedAtShopify: new Date('2026-05-07T13:00:00.000Z')
      },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder({ financialStatus: 'PENDING' })
    });

    const migratedMethodRawPayloadMatcher: unknown = expect.objectContaining({
      cleverManualPaymentMethod: 'ETRANSFER'
    });
    const migratedMethodUpdateMatcher: unknown = expect.objectContaining({
      financialStatus: 'PENDING',
      rawPayload: migratedMethodRawPayloadMatcher
    });
    expect(prisma.order.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: migratedMethodUpdateMatcher
    }));

    const removedLegacyStatusRawPayloadMatcher: unknown = expect.not.objectContaining({
      cleverManualPaymentStatus: 'ETRANSFER'
    });
    const removedLegacyStatusUpdateMatcher: unknown = expect.objectContaining({
      rawPayload: removedLegacyStatusRawPayloadMatcher
    });
    expect(prisma.order.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: removedLegacyStatusUpdateMatcher
    }));
  });

  test('recreates a missing delivery stop with its manual delivery state', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: {
        ...canonicalOrderRecord(0),
        deliveryStops: [],
        id: 'order-id',
        rawPayload: { cleverManualDeliveryStatus: 'DELIVERED' },
        updatedAtShopify: new Date('2026-05-07T13:00:00.000Z')
      },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder()
    });

    const preservedDeliveryStatusMatcher: unknown = expect.objectContaining({ status: 'DELIVERED' });
    expect(prisma.deliveryStop.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: preservedDeliveryStatusMatcher
    }));
  });

  test('reads the current source version inside the write transaction', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: { id: 'order-id', updatedAtShopify: new Date('2026-05-07T12:00:00.000Z') },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: syncedOrder({ updatedAtShopify: new Date('2026-05-08T13:00:00.000Z') })
    });

    const transactionOrder = prisma.$transaction.mock.invocationCallOrder[0] ?? 0;
    const sourceReadOrder = prisma.order.findFirst.mock.invocationCallOrder[0] ?? 0;
    expect(transactionOrder).toBeLessThan(sourceReadOrder);
  });

  test.each(['IN_PROGRESS', 'COMPLETED', 'INCOMPLETE', 'CANCELLED'])(
    'blocks manual refresh before mutating an order shared with a %s route',
    async (routePlanStatus) => {
      const { prisma } = createPrismaHarness({
        existingOrder: routedExistingOrder(routePlanStatus),
        routeStopCount: 0
      });
      const repository = createOrderSyncRepository(prisma);

      await expect(repository.upsertOrderWithDeliveryStop({
        shopDomain: 'example.myshopify.com',
        syncReason: 'manual_refresh',
        synced: syncedOrder({ updatedAtShopify: new Date('2026-05-08T13:00:00.000Z') })
      })).rejects.toBeInstanceOf(OrderSyncRouteLockedError);

      expect(prisma.order.upsert).not.toHaveBeenCalled();
      expect(prisma.deliveryStop.upsert).not.toHaveBeenCalled();
    }
  );

  test('blocks manual refresh while any shared ready route is optimizing', async () => {
    const { prisma } = createPrismaHarness({
      existingOrder: routedExistingOrder('READY', {
        routePlanStops: [{
          routePlan: {
            id: 'route-plan-id',
            name: 'Route draft',
            optimizationJobs: [{ id: 'job-id' }],
            status: 'READY'
          }
        }]
      }),
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await expect(repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      syncReason: 'manual_refresh',
      synced: syncedOrder({ updatedAtShopify: new Date('2026-05-08T13:00:00.000Z') })
    })).rejects.toBeInstanceOf(OrderSyncRouteLockedError);

    expect(prisma.order.upsert).not.toHaveBeenCalled();
  });

  test('preflights the whole manual snapshot before any order write', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    prisma.order.findMany.mockResolvedValueOnce([
      { deliveryStops: routedExistingOrder('IN_PROGRESS').deliveryStops }
    ]);
    const repository = createOrderSyncRepository(prisma);

    await expect(repository.assertOrdersSnapshotRefreshable({
      shopDomain: 'example.myshopify.com',
      shopifyOrderGids: ['gid://shopify/Order/123', 'gid://shopify/Order/456']
    })).rejects.toBeInstanceOf(OrderSyncRouteLockedError);

    expect(prisma.order.upsert).not.toHaveBeenCalled();
    expect(prisma.deliveryStop.upsert).not.toHaveBeenCalled();
  });

  test('infers and preserves legacy planned-order corrections that predate correction metadata', async () => {
    const existing = routedExistingOrder('READY');
    existing.rawPayload = {
      ...syncedOrder().order.rawPayload,
      deliveryArea: 'Source Area',
      deliveryDate: '2026-05-08',
      deliverySession: 'EVENING',
      routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
      serviceType: 'EVENING_DELIVERY'
    };
    existing.shippingAddress = {
      address1: '100 Source St',
      address2: null,
      city: 'Toronto',
      countryCode: 'CA',
      postalCode: 'M1M 1M1',
      province: 'ON'
    };
    existing.deliveryFacts = [{
      batchEligible: true,
      deliveryArea: 'Operator Area',
      deliveryDate: new Date('2026-05-09T00:00:00.000Z'),
      deliveryDateWeekday: 'SATURDAY',
      deliveryDateWeekdayMismatch: false,
      deliveryDateWeekdayVerified: true,
      deliverySession: 'DAY',
      geocodeStatus: 'RESOLVED',
      mappingDiagnostics: {},
      planningGroupKey: '2026-05-09|DELIVERY|||Operator Area',
      readiness: 'READY_TO_PLAN',
      reviewReasons: [],
      routeScopeKey: '2026-05-09|DELIVERY||',
      serviceType: 'DELIVERY',
      timeWindowEnd: null,
      timeWindowStart: null
    }];
    const existingStop = existing.deliveryStops[0] as Record<string, unknown>;
    existingStop.address1 = '200 Corrected St';
    existingStop.latitude = '43.7000000';
    existingStop.longitude = '-79.4000000';

    const { prisma } = createPrismaHarness({ existingOrder: existing, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      syncReason: 'manual_refresh',
      synced: {
        ...syncedOrder({
          sourcePlatform: 'WOOCOMMERCE',
          updatedAtShopify: new Date('2026-05-08T13:00:00.000Z')
        }),
        deliveryFact: syncedDeliveryFact()
      }
    });

    const stopCall = prisma.deliveryStop.upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> } | undefined;
    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> } | undefined;
    expect(stopCall?.update).toMatchObject({
      address1: '200 Corrected St',
      latitude: '43.7000000',
      longitude: '-79.4000000'
    });
    expect(factCall?.update).toMatchObject({
      deliveryArea: 'Operator Area',
      deliveryDate: new Date('2026-05-09T00:00:00.000Z'),
      deliverySession: 'DAY',
      routeScopeKey: '2026-05-09|DELIVERY||',
      serviceType: 'DELIVERY'
    });
    const legacyCorrectionMatcher: unknown = expect.objectContaining({
      source: 'legacy_db_divergence_guard'
    });
    const legacyCorrectionFieldsMatcher: unknown = expect.objectContaining({
      address1: legacyCorrectionMatcher,
      deliveryDate: legacyCorrectionMatcher,
      latitude: legacyCorrectionMatcher
    });
    expect(factCall?.update.mappingDiagnostics).toMatchObject({
      routeOpsCorrections: {
        fields: legacyCorrectionFieldsMatcher
      }
    });
  });

  test('does not mistake old geocoded coordinates for a manual pin after the source address changes', async () => {
    const existing = routedExistingOrder('READY');
    existing.shippingAddress = {
      address1: '100 Old Route St',
      address2: 'Unit 1',
      city: 'Mississauga',
      countryCodeV2: 'CA',
      latitude: null,
      longitude: null,
      province: 'ON',
      zip: 'L5A 1A1'
    };
    const { prisma } = createPrismaHarness({ existingOrder: existing, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      syncReason: 'manual_refresh',
      synced: syncedOrder()
    });

    const sourceCoordinateMatcher: unknown = expect.objectContaining({
      latitude: '43.589',
      longitude: '-79.644'
    });
    expect(prisma.deliveryStop.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: sourceCoordinateMatcher
    }));
  });

  test.each(['READY', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED'])(
    'preserves an existing Shopify route schedule in %s while refreshing other source fields',
    async (routePlanStatus) => {
      const existing = routedExistingOrder(routePlanStatus);
      const routedFacts: Array<Record<string, unknown>> = [
        canonicalDeliveryFactWithUtcTorontoWindow()
      ];
      routedFacts[0] = {
        ...routedFacts[0],
        deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
        planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Mississauga',
        routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
        timeWindowEnd: new Date('2026-05-09T01:00:00.000Z'),
        timeWindowStart: new Date('2026-05-08T21:00:00.000Z')
      };
      existing.deliveryFacts = routedFacts;
      existing.rawPayload = {
        ...(existing.rawPayload as Record<string, unknown>),
        cleverManualPaymentStatus: 'PENDING'
      };
      const { prisma } = createPrismaHarness({ existingOrder: existing, routeStopCount: 0 });
      const repository = createOrderSyncRepository(prisma);
      const incoming = syncedOrder({
        rawPayload: {
          ...syncedOrder().order.rawPayload,
          deliveryBatchEndDate: '2026-05-16',
          deliveryBatchStartDate: '2026-05-14',
          deliveryDate: '2026-05-15',
          note: 'Updated source note',
          normalizedPaymentStatus: 'PAID_CONFIRMED',
          planningGroupKey: '2026-05-15|DELIVERY|||Toronto',
          routeScopeKey: '2026-05-15|DELIVERY||',
          serviceType: 'DELIVERY',
          timeWindowEnd: null,
          timeWindowStart: null
        }
      });

      await repository.upsertOrderWithDeliveryStop({
        shopDomain: 'example.myshopify.com',
        synced: {
          ...incoming,
          deliveryFact: {
            ...syncedDeliveryFact(),
            deliveryDate: '2026-05-15',
            deliverySession: 'DAY',
            planningGroupKey: '2026-05-15|DELIVERY|||Toronto',
            routeScopeKey: '2026-05-15|DELIVERY||',
            serviceType: 'DELIVERY',
            sourcePlatform: 'SHOPIFY',
            timeWindowEnd: null,
            timeWindowStart: null
          },
          deliveryStop: {
            ...incoming.deliveryStop!,
            deliveryDate: '2026-05-15',
            timeWindowEnd: null,
            timeWindowStart: null
          }
        }
      });

      const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
      const stopCall = prisma.deliveryStop.upsert.mock.calls[0];
      const orderCall = prisma.order.upsert.mock.calls[0];
      if (factCall === undefined || stopCall === undefined || orderCall === undefined) {
        throw new Error('expected protected schedule writes');
      }
      const factUpdate = (factCall[0] as { update: Record<string, unknown> }).update;
      const stopUpdate = (stopCall[0] as { update: Record<string, unknown> }).update;
      const orderUpdate = (orderCall[0] as { update: Record<string, unknown> }).update;
      expect(factUpdate).toMatchObject({
        deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
        routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
        serviceType: 'EVENING_DELIVERY'
      });
      expect(factUpdate.mappingDiagnostics).toMatchObject({
        shopifyRouteScheduleGuard: {
          reason: 'existing_route_schedule',
          routePlans: [{ id: 'route-plan-id', status: routePlanStatus }]
        }
      });
      expect(stopUpdate).toMatchObject({
        deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
        timeWindowEnd: new Date('2026-05-09T01:00:00.000Z'),
        timeWindowStart: new Date('2026-05-08T21:00:00.000Z')
      });
      expect(orderUpdate.rawPayload).toEqual(expect.objectContaining({
        deliveryDate: '2026-05-08',
        deliveryBatchEndDate: '2026-05-09',
        deliveryBatchStartDate: '2026-05-07',
        cleverManualPaymentStatus: 'PENDING',
        note: 'Updated source note',
        normalizedPaymentStatus: 'PAID_CONFIRMED',
        routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00'
      }));
    }
  );

  test('does not clear a routed Shopify stop when a refresh omits the shipping address', async () => {
    const existing = routedExistingOrder('PUBLISHED');
    existing.deliveryFacts = [canonicalDeliveryFactWithUtcTorontoWindow()];
    const { prisma } = createPrismaHarness({ existingOrder: existing, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);
    const incoming = syncedOrder({ sourcePlatform: 'SHOPIFY' });

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...incoming,
        deliveryFact: {
          ...syncedDeliveryFact(),
          batchEligible: false,
          readiness: 'NEEDS_REVIEW',
          reviewReasons: ['missing_address', 'missing_coordinates'],
          sourcePlatform: 'SHOPIFY'
        },
        deliveryStop: null
      }
    });

    expect(prisma.deliveryStop.updateMany).not.toHaveBeenCalled();
    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (factCall === undefined) throw new Error('expected routed fact write');
    expect((factCall[0] as { update: Record<string, unknown> }).update).toMatchObject({
      batchEligible: false,
      readiness: 'NEEDS_REVIEW',
      reviewReasons: ['missing_address', 'missing_coordinates']
    });
  });

  test('recomputes cancellation health without replacing a protected route schedule', async () => {
    const existing = routedExistingOrder('PUBLISHED');
    existing.deliveryFacts = [canonicalDeliveryFactWithUtcTorontoWindow()];
    const { prisma } = createPrismaHarness({ existingOrder: existing, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);
    const incoming = syncedOrder({
      cancelledAt: new Date('2026-05-09T12:00:00.000Z'),
      sourcePlatform: 'SHOPIFY'
    });

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...incoming,
        deliveryFact: {
          ...syncedDeliveryFact(),
          batchEligible: false,
          deliveryDate: '2026-06-05',
          readiness: 'NEEDS_REVIEW',
          reviewReasons: ['cancelled_order'],
          sourcePlatform: 'SHOPIFY'
        },
        deliveryStop: { ...incoming.deliveryStop!, deliveryDate: '2026-06-05' }
      }
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (factCall === undefined) throw new Error('expected cancelled fact write');
    expect((factCall[0] as { update: Record<string, unknown> }).update).toMatchObject({
      batchEligible: false,
      deliveryDate: new Date('2026-05-29T00:00:00.000Z'),
      readiness: 'NEEDS_REVIEW',
      reviewReasons: ['cancelled_order']
    });
  });

  test('keeps the protected schedule timezone when the shop timezone later changes', async () => {
    const existing = routedExistingOrder('PUBLISHED');
    const existingFact = {
      ...canonicalDeliveryFactWithUtcTorontoWindow(),
      deliveryDate: new Date('2026-07-17T00:00:00.000Z'),
      mappingDiagnostics: {
        deliveryDateSource: 'LINE_ITEM_DATE_RANGE',
        deliveryTimeZone: 'Asia/Seoul'
      },
      planningGroupKey: '2026-07-17|EVENING_DELIVERY|17:00|21:00|Mississauga',
      routeScopeKey: '2026-07-17|EVENING_DELIVERY|17:00|21:00',
      timeWindowEnd: new Date('2026-07-17T12:00:00.000Z'),
      timeWindowStart: new Date('2026-07-17T08:00:00.000Z')
    };
    existing.deliveryFacts = [existingFact];
    existing.rawPayload = {
      ...(existing.rawPayload as Record<string, unknown>),
      deliveryDate: '2026-07-17',
      deliveryDateSource: 'LINE_ITEM_DATE_RANGE',
      deliveryTimeZone: 'Asia/Seoul',
      planningGroupKey: '2026-07-17|EVENING_DELIVERY|17:00|21:00|Mississauga',
      routeScopeKey: '2026-07-17|EVENING_DELIVERY|17:00|21:00'
    };
    existing.deliveryStops = [{
      ...(existing.deliveryStops[0] as Record<string, unknown>),
      deliveryDate: new Date('2026-07-17T00:00:00.000Z'),
      timeWindowEnd: new Date('2026-07-17T12:00:00.000Z'),
      timeWindowStart: new Date('2026-07-17T08:00:00.000Z')
    }];
    const firstHarness = createPrismaHarness({ existingOrder: existing, routeStopCount: 0 });
    const firstRepository = createOrderSyncRepository(firstHarness.prisma);
    const incoming = syncedOrder({ sourcePlatform: 'SHOPIFY' });

    await firstRepository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...incoming,
        deliveryTimeZone: 'America/Vancouver',
        deliveryFact: {
          ...syncedDeliveryFact(),
          deliveryDate: '2026-07-24',
          mappingDiagnostics: { deliveryTimeZone: 'America/Vancouver' },
          sourcePlatform: 'SHOPIFY'
        },
        deliveryStop: { ...incoming.deliveryStop!, deliveryDate: '2026-07-24' }
      }
    });

    const factCall = firstHarness.prisma.orderDeliveryFact.upsert.mock.calls[0];
    const stopCall = firstHarness.prisma.deliveryStop.upsert.mock.calls[0];
    const orderCall = firstHarness.prisma.order.upsert.mock.calls[0];
    if (factCall === undefined || stopCall === undefined || orderCall === undefined) {
      throw new Error('expected protected timezone writes');
    }
    const factUpdate = (factCall[0] as { update: Record<string, unknown> }).update;
    const stopUpdate = (stopCall[0] as { update: Record<string, unknown> }).update;
    const rawPayload = (orderCall[0] as { update: { rawPayload: Record<string, unknown> } }).update.rawPayload;
    expect(factUpdate.mappingDiagnostics).toMatchObject({
      deliveryDateSource: 'LINE_ITEM_DATE_RANGE',
      deliveryTimeZone: 'Asia/Seoul',
      deliveryTimeZoneProvenance: 'persisted_schedule'
    });
    expect(rawPayload).toMatchObject({
      deliveryDateSource: 'LINE_ITEM_DATE_RANGE',
      deliveryTimeZone: 'Asia/Seoul',
      deliveryTimeZoneProvenance: 'persisted_schedule'
    });

    const secondHarness = createPrismaHarness({
      existingOrder: {
        ...existing,
        deliveryFacts: [{ ...existingFact, ...factUpdate }],
        deliveryStops: [{ ...(existing.deliveryStops[0] as Record<string, unknown>), ...stopUpdate }],
        rawPayload
      },
      routeStopCount: 0
    });
    const secondRepository = createOrderSyncRepository(secondHarness.prisma);
    await secondRepository.patchCanonicalOrder({
      actor: 'dispatcher',
      orderId: 'order-id',
      patch: { timeWindowEnd: '22:00', timeWindowStart: '18:00' },
      shopDomain: 'example.myshopify.com'
    });
    const manualFactCall = secondHarness.prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (manualFactCall === undefined) throw new Error('expected manual fact write');
    const manualFactUpdate = (manualFactCall[0] as { update: Record<string, unknown> }).update;
    expect(manualFactUpdate.timeWindowStart).toEqual(new Date('2026-07-17T09:00:00.000Z'));
    expect(manualFactUpdate.timeWindowEnd).toEqual(new Date('2026-07-17T13:00:00.000Z'));
  });

  test('preserves a delivered Shopify schedule after route membership is removed', async () => {
    const existing = routedExistingOrder('COMPLETED', { routePlanStops: [] });
    existing.deliveryFacts = [canonicalDeliveryFactWithUtcTorontoWindow()];
    (existing.deliveryStops[0] as Record<string, unknown>).status = 'DELIVERED';
    const { prisma } = createPrismaHarness({ existingOrder: existing, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);
    const incoming = syncedOrder({ sourcePlatform: 'SHOPIFY' });

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...incoming,
        deliveryTimeZone: 'America/Vancouver',
        deliveryFact: {
          ...syncedDeliveryFact(),
          deliveryDate: '2026-06-05',
          mappingDiagnostics: { deliveryTimeZone: 'America/Vancouver' },
          sourcePlatform: 'SHOPIFY'
        },
        deliveryStop: {
          ...incoming.deliveryStop!,
          deliveryDate: '2026-06-05'
        }
      }
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (factCall === undefined) throw new Error('expected protected fact write');
    const factUpdate = (factCall[0] as { update: Record<string, unknown> }).update;
    expect(factUpdate.deliveryDate).toEqual(new Date('2026-05-29T00:00:00.000Z'));
    expect(factUpdate.mappingDiagnostics).toMatchObject({
      deliveryTimeZone: 'America/Vancouver',
      deliveryTimeZoneProvenance: 'current_shop',
      shopifyRouteScheduleGuard: {
        reason: 'existing_route_schedule',
        routePlans: [],
        stopStatus: 'DELIVERED'
      }
    });
  });

  test('reconstructs a protected fact from a delivered legacy stop without freezing health', async () => {
    const existing = routedExistingOrder('COMPLETED', { routePlanStops: [] });
    existing.deliveryFacts = [];
    (existing.deliveryStops[0] as Record<string, unknown>).status = 'DELIVERED';
    const { prisma } = createPrismaHarness({ existingOrder: existing, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);
    const incoming = syncedOrder();

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...incoming,
        deliveryFact: {
          ...syncedDeliveryFact(),
          batchEligible: false,
          deliveryDate: '2026-06-05',
          readiness: 'NEEDS_REVIEW',
          reviewReasons: ['missing_address'],
          sourcePlatform: 'SHOPIFY'
        },
        deliveryStop: { ...incoming.deliveryStop!, deliveryDate: '2026-06-05' }
      }
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    const stopCall = prisma.deliveryStop.upsert.mock.calls[0];
    if (factCall === undefined || stopCall === undefined) {
      throw new Error('expected reconstructed legacy schedule writes');
    }
    expect((factCall[0] as { update: Record<string, unknown> }).update).toMatchObject({
      batchEligible: false,
      deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
      readiness: 'NEEDS_REVIEW',
      reviewReasons: ['missing_address'],
      timeWindowEnd: new Date('2026-05-09T01:00:00.000Z'),
      timeWindowStart: new Date('2026-05-08T21:00:00.000Z')
    });
    expect((stopCall[0] as { update: Record<string, unknown> }).update).toMatchObject({
      deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
      timeWindowEnd: new Date('2026-05-09T01:00:00.000Z'),
      timeWindowStart: new Date('2026-05-08T21:00:00.000Z')
    });
  });

  test.each([null, 'EVENING_DELIVERY'] as const)('keeps unknown legacy local schedule metadata unknown with service type %s', async (serviceType) => {
    const existing = routedExistingOrder('COMPLETED', { routePlanStops: [] });
    existing.deliveryFacts = [];
    existing.rawPayload = serviceType === null ? {} : { serviceType };
    (existing.deliveryStops[0] as Record<string, unknown>).status = 'DELIVERED';
    const { prisma } = createPrismaHarness({ existingOrder: existing, routeStopCount: 0 });
    const incoming = syncedOrder({ sourcePlatform: 'SHOPIFY' });

    await createOrderSyncRepository(prisma).upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...incoming,
        deliveryTimeZone: 'Asia/Seoul',
        deliveryFact: {
          ...syncedDeliveryFact(),
          deliveryDate: '2026-06-05',
          mappingDiagnostics: { deliveryTimeZone: 'Asia/Seoul' },
          sourcePlatform: 'SHOPIFY'
        },
        deliveryStop: { ...incoming.deliveryStop!, deliveryDate: '2026-06-05' },
        order: { ...incoming.order, rawPayload: { ...incoming.order.rawPayload, deliveryTimeZone: 'Asia/Seoul' } }
      }
    });

    const factUpdate = (prisma.orderDeliveryFact.upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> }).update;
    const stopUpdate = (prisma.deliveryStop.upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> }).update;
    const orderUpdate = (prisma.order.upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> }).update;
    for (const update of [factUpdate, stopUpdate]) {
      expect(update).toMatchObject({
        deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
        timeWindowEnd: new Date('2026-05-09T01:00:00.000Z'),
        timeWindowStart: new Date('2026-05-08T21:00:00.000Z')
      });
    }
    expect(factUpdate).toMatchObject({
      deliverySession: null, planningGroupKey: null, routeScopeKey: null, serviceType,
      mappingDiagnostics: { deliveryTimeZone: 'Asia/Seoul', deliveryTimeZoneProvenance: 'current_shop' }
    });
    expect(orderUpdate.rawPayload).toMatchObject({
      deliveryTimeZone: 'Asia/Seoul', deliveryTimeZoneProvenance: 'current_shop',
      planningGroupKey: null, routeScopeKey: null, timeWindowEnd: null, timeWindowStart: null
    });
  });

  test('does not protect a schedule from a cancelled-only route membership', async () => {
    const existing = routedExistingOrder('CANCELLED');
    (existing.deliveryStops[0] as Record<string, unknown>).status = 'CANCELLED';
    existing.deliveryFacts = [{
      ...canonicalDeliveryFactWithUtcTorontoWindow(),
      deliveryDate: new Date('2026-05-08T00:00:00.000Z'),
      planningGroupKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00|Mississauga',
      routeScopeKey: '2026-05-08|EVENING_DELIVERY|17:00|21:00',
      timeWindowEnd: new Date('2026-05-09T01:00:00.000Z'),
      timeWindowStart: new Date('2026-05-08T21:00:00.000Z')
    }];
    const { prisma } = createPrismaHarness({ existingOrder: existing, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);
    const incoming = syncedOrder();

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...incoming,
        deliveryFact: {
          ...syncedDeliveryFact(),
          deliveryDate: '2026-06-05',
          sourcePlatform: 'SHOPIFY'
        },
        deliveryStop: { ...incoming.deliveryStop!, deliveryDate: '2026-06-05' }
      }
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    if (factCall === undefined) throw new Error('expected cancelled-route fact write');
    const factUpdate = (factCall[0] as { update: Record<string, unknown> }).update;
    expect(factUpdate.deliveryDate).toEqual(new Date('2026-06-05T00:00:00.000Z'));
    expect(factUpdate.mappingDiagnostics).not.toHaveProperty('shopifyRouteScheduleGuard');
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
        blockedCount: 1,
        missingCoordinatesCount: 1,
        orderCount: 3,
        readyCount: 2
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
        ...syncedOrder({ sourcePlatform: 'WOOCOMMERCE', updatedAtShopify: new Date('2026-05-08T13:00:00.000Z') }),
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

  test('preserves an explicitly cleared Shopify delivery date during ordinary source refresh', async () => {
    const existingRecord = canonicalOrderRecord(0);
    const existingFact = {
      ...canonicalDeliveryFactWithUtcTorontoWindow(),
      batchEligible: false,
      deliveryDate: null,
      deliveryDateWeekday: null,
      deliveryDateWeekdayVerified: false,
      mappingDiagnostics: {
        routeOpsCorrections: {
          fields: {
            deliveryDate: {
              actor: 'dispatcher',
              correctedAt: '2026-05-08T14:00:00.000Z',
              source: 'operator_metadata_patch'
            }
          },
          version: 1
        }
      },
      planningGroupKey: null,
      readiness: 'NEEDS_REVIEW',
      reviewReasons: ['missing_delivery_date', 'missing_route_scope'],
      routeScopeKey: null
    };
    const existingStop = {
      ...(existingRecord.deliveryStops as Array<Record<string, unknown>>)[0],
      deliveryDate: null,
      timeWindowEnd: null,
      timeWindowStart: null
    };
    const { prisma } = createPrismaHarness({
      existingOrder: {
        ...existingRecord,
        deliveryFacts: [existingFact],
        deliveryStops: [existingStop],
        id: 'order-id',
        updatedAtShopify: new Date('2026-05-07T12:00:00.000Z')
      },
      routeStopCount: 0
    });
    const repository = createOrderSyncRepository(prisma);

    await repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...syncedOrder({
          rawPayload: {
            ...syncedOrder().order.rawPayload,
            deliveryDate: '2026-05-15',
            note: 'Source note still refreshes'
          },
          sourcePlatform: 'SHOPIFY'
        }),
        deliveryFact: { ...syncedDeliveryFact(), sourcePlatform: 'SHOPIFY' }
      }
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    const stopCall = prisma.deliveryStop.upsert.mock.calls[0];
    const orderCall = prisma.order.upsert.mock.calls[0];
    if (factCall === undefined || stopCall === undefined || orderCall === undefined) {
      throw new Error('expected corrected schedule writes');
    }
    expect((factCall[0] as { update: Record<string, unknown> }).update.deliveryDate).toBeNull();
    expect((stopCall[0] as { update: Record<string, unknown> }).update.deliveryDate).toBeNull();
    expect((orderCall[0] as { update: Record<string, unknown> }).update.rawPayload)
      .toEqual(expect.objectContaining({
        deliveryDate: null,
        note: 'Source note still refreshes'
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

  test.each([
    ['Asia/Seoul', '2026-01-16', '2026-01-16T08:00:00.000Z'],
    ['America/Vancouver', '2026-07-17', '2026-07-18T00:00:00.000Z'],
    ['America/Toronto', '2026-01-16', '2026-01-16T22:00:00.000Z'],
    ['America/Toronto', '2026-07-17', '2026-07-17T21:00:00.000Z']
  ])(
    'converts store-local delivery windows in %s to UTC',
    async (deliveryTimeZone, deliveryDate, expectedStart) => {
      const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
      const repository = createOrderSyncRepository(prisma);
      const base = syncedOrder({ sourcePlatform: 'SHOPIFY' });

      await repository.upsertOrderWithDeliveryStop({
        shopDomain: 'example.myshopify.com',
        synced: {
          ...base,
          deliveryTimeZone,
          deliveryFact: {
            ...syncedDeliveryFact(),
            deliveryDate,
            sourcePlatform: 'SHOPIFY',
            timeWindowEnd: '21:00',
            timeWindowStart: '17:00'
          },
          deliveryStop: {
            ...base.deliveryStop!,
            deliveryDate,
            timeWindowEnd: '21:00',
            timeWindowStart: '17:00'
          }
        }
      });

      const stopCall = prisma.deliveryStop.upsert.mock.calls[0];
      const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
      if (stopCall === undefined || factCall === undefined) {
        throw new Error('expected schedule writes');
      }
      expect((stopCall[0] as { update: Record<string, unknown> }).update.timeWindowStart)
        .toEqual(new Date(expectedStart));
      expect((factCall[0] as { update: Record<string, unknown> }).update.timeWindowStart)
        .toEqual(new Date(expectedStart));
    }
  );

  test('rejects an explicit invalid delivery timezone before schedule writes', async () => {
    const { prisma } = createPrismaHarness({ existingOrder: null, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);

    await expect(repository.upsertOrderWithDeliveryStop({
      shopDomain: 'example.myshopify.com',
      synced: {
        ...syncedOrder({ sourcePlatform: 'SHOPIFY' }),
        deliveryTimeZone: 'Invalid/Timezone',
        deliveryFact: { ...syncedDeliveryFact(), sourcePlatform: 'SHOPIFY' }
      }
    })).rejects.toThrow('Invalid delivery timezone: Invalid/Timezone');
    expect(prisma.deliveryStop.upsert).not.toHaveBeenCalled();
    expect(prisma.orderDeliveryFact.upsert).not.toHaveBeenCalled();
  });

  test('reuses the persisted delivery timezone for manual metadata patches', async () => {
    const existingOrder = {
      ...canonicalOrderRecord(0),
      deliveryFacts: [{
        ...canonicalDeliveryFactWithUtcTorontoWindow(),
        mappingDiagnostics: { deliveryTimeZone: 'Asia/Seoul' }
      }],
      id: 'order-id',
      updatedAtShopify: new Date('2026-05-07T12:00:00.000Z')
    };
    const { prisma } = createPrismaHarness({ existingOrder, routeStopCount: 0 });
    const repository = createOrderSyncRepository(prisma);

    await repository.patchCanonicalOrder({
      actor: 'dispatcher',
      orderId: 'order-id',
      patch: { timeWindowEnd: '21:00', timeWindowStart: '17:00' },
      shopDomain: 'example.myshopify.com'
    });

    const factCall = prisma.orderDeliveryFact.upsert.mock.calls[0];
    const stopCall = prisma.deliveryStop.upsert.mock.calls[0];
    if (factCall === undefined || stopCall === undefined) {
      throw new Error('expected manual schedule writes');
    }
    expect((factCall[0] as { update: Record<string, unknown> }).update.timeWindowStart)
      .toEqual(new Date('2026-05-29T08:00:00.000Z'));
    expect((stopCall[0] as { update: Record<string, unknown> }).update.timeWindowEnd)
      .toEqual(new Date('2026-05-29T12:00:00.000Z'));
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
  tombstonedOrder?: boolean;
}): {
  prisma: {
    $queryRaw: ReturnType<typeof vi.fn>;
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
    routePlan: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    shopifyOrderRedactionTombstone: { findUnique: ReturnType<typeof vi.fn> };
    shopifyShopRedactionTombstone: { findUnique: ReturnType<typeof vi.fn> };
    shop: {
      create?: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
} {
  const orderRecord = canonicalOrderRecord(input.routeStopCount);
  const prisma = {
    $queryRaw: vi.fn(() => Promise.resolve([{ pg_advisory_xact_lock: null }])),
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
    routePlan: {
      findFirst: vi.fn(() => Promise.resolve(null)),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
    },
    shopifyOrderRedactionTombstone: {
      findUnique: vi.fn(() => Promise.resolve(input.tombstonedOrder === true ? { id: 'tombstone-id' } : null))
    },
    shopifyShopRedactionTombstone: { findUnique: vi.fn(() => Promise.resolve(null)) },
    shop: {
      findFirst: vi.fn(() => Promise.resolve({ id: 'shop-id' })),
      findUnique: vi.fn(() => Promise.resolve({ id: 'shop-id' }))
    }
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

function orderStatusPatchRecord(routePlanId = 'route-plan-id'): Record<string, unknown> {
  return {
    deliveryStops: [{ routePlanStops: [{ routePlanId }] }],
    id: 'order-id',
    rawPayload: {}
  };
}

function orderCompletionReconciliationRoute(stopStatus: string, completed = false): Record<string, unknown> {
  const completedAt = completed ? new Date('2026-10-01T22:00:00.000Z') : null;
  return {
    assignmentGeneration: 1n,
    deliveryWorkCompletedAt: completedAt,
    deliveryWorkCompletedGeneration: completed ? 1n : null,
    deliveryWorkCompletedVersionId: completed ? 'route-version-id' : null,
    driverNavigationUntil: completed ? new Date('2026-10-02T00:00:00.000Z') : null,
    id: 'route-plan-id',
    routeGroupingChildVersions: [{
      id: 'route-version-id',
      snapshot: {
        membershipSchemaVersion: 1,
        stops: [{ deliveryStopId: 'stop-id', orderId: 'order-id', sequence: 1 }]
      }
    }],
    routeStops: [{
      deliveryStop: { order: { currentRouteVersionId: 'route-version-id' }, orderId: 'order-id', status: stopStatus },
      deliveryStopId: 'stop-id',
      sequence: 1
    }],
    status: 'IN_PROGRESS'
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
          routePlan: routeStopCount === 1
            ? { id: 'route-plan-id', name: 'Route draft', status: 'PUBLISHED' }
            : { id: `route-plan-id-${index + 1}`, name: `Route draft ${index + 1}`, status: 'READY' }
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
