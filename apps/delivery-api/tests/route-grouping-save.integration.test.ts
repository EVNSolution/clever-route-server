import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { FakeDriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';
import { PrismaRouteGroupingService } from '../src/modules/route-grouping/route-grouping.service.js';
import { PrismaRoutePlanRepository } from '../src/modules/route-plans/route-plan.repository.js';
import { PrismaOrderQueryRepository } from '../src/modules/shopify/order-query.repository.js';

// Bootstrap only a new disposable local database before opting in:
//   psql "$ROUTE_GROUPING_SAVE_DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'
//   DATABASE_URL="$ROUTE_GROUPING_SAVE_DATABASE_URL" npx prisma db push --skip-generate
// Run:
//   ROUTE_GROUPING_SAVE_DATABASE_TARGET_CLASS=safe-local-route-grouping-save-disposable \
//   ROUTE_GROUPING_SAVE_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/EMPTY_DB?schema=public \
//   npx vitest run tests/route-grouping-save.integration.test.ts
const enabled = process.env.ROUTE_GROUPING_SAVE_DATABASE_TARGET_CLASS === 'safe-local-route-grouping-save-disposable';
const databaseUrl = process.env.ROUTE_GROUPING_SAVE_DATABASE_URL;
const safeDatabaseUrl = isLoopbackDatabaseUrl(databaseUrl);
if (enabled && databaseUrl !== undefined && !safeDatabaseUrl) {
  throw new Error('ROUTE_GROUPING_SAVE_DATABASE_URL must use a loopback PostgreSQL host');
}
const describeDatabase = enabled && safeDatabaseUrl ? describe : describe.skip;

function isLoopbackDatabaseUrl(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'postgresql:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

describeDatabase('route grouping save database regressions', () => {
  const prisma = new PrismaClient({
    datasourceUrl: databaseUrl ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled'
  });
  const appId = 'clever-route-kfood';
  const shopDomain = `kfood-grouping-save-${Date.now()}.myshopify.com`;
  const service = new PrismaRouteGroupingService(
    prisma,
    new FakeDriverPushProvider(),
    undefined,
    undefined,
    {
      buildRoute: () => Promise.resolve({
        routeGeometry: { coordinates: [[-79.40, 43.60], [-79.39, 43.61]], type: 'LineString' },
        routeMetrics: { distanceMeters: 1, durationSeconds: 1 },
        routeStopPoints: []
      })
    }
  );
  const routePlans = new PrismaRoutePlanRepository(prisma);
  const orderQueries = new PrismaOrderQueryRepository(
    prisma,
    'route-grouping-save-integration-secret',
    () => new Date('2030-09-10T12:00:00.000Z')
  );
  let shopId = '';
  let orderSequence = 0;

  beforeAll(async () => {
    const shop = await prisma.shop.create({
      data: {
        appId,
        defaultDepotAddress: '1 K-food Test Depot',
        defaultDepotLatitude: 43.6532,
        defaultDepotLongitude: -79.3832,
        shopDomain
      }
    });
    shopId = shop.id;
  });

  afterAll(async () => {
    if (shopId !== '') await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  test('saves an 18, 23, 0 split after deleting the previous route for the same 41 orders', async () => {
    const orders = await seedOrders(41);
    const firstGrouping = await createGrouping('previous grouping', orders.map(({ id }) => id));
    const firstSave = await service.saveDraft({
      appId,
      groupingId: firstGrouping.id,
      mode: 'MANUAL_ORDER',
      routes: [draftRoute('previous-route', orders.map(({ id }) => id))],
      shopDomain
    });
    const previousRoutePlanId = firstSave?.children[0]?.routePlanId;
    expect(previousRoutePlanId).toBeTruthy();

    await expect(routePlans.deleteRoutePlan({ appId, routePlanId: previousRoutePlanId!, shopDomain }))
      .resolves.toEqual({ deleted: true, routePlanId: previousRoutePlanId });

    const secondGrouping = await createGrouping('replacement grouping', orders.map(({ id }) => id));
    const saved = await service.saveDraft({
      appId,
      groupingId: secondGrouping.id,
      mode: 'MANUAL_ORDER',
      routes: [
        draftRoute('replacement-1', orders.slice(0, 18).map(({ id }) => id)),
        draftRoute('replacement-2', orders.slice(18).map(({ id }) => id)),
        draftRoute('replacement-3', [])
      ],
      shopDomain
    });

    expect(saved?.children.map(({ stopsCount }) => stopsCount).sort((left, right) => left - right))
      .toEqual([0, 18, 23]);
  }, 30_000);

  test('deleting a child route releases its version pointer and preserves another active group pointer', async () => {
    const orders = await seedOrders(2);
    const grouping = await createGrouping('deleted ownership grouping', orders.map(({ id }) => id));
    const saved = await service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [draftRoute('delete-me', orders.map(({ id }) => id))],
      shopDomain
    });
    const deletedChild = saved!.children[0]!;
    const foreignOrder = await seedOrder();
    const foreignGrouping = await createGrouping('retained active grouping', [foreignOrder.id]);
    const foreignSaved = await service.saveDraft({
      appId,
      groupingId: foreignGrouping.id,
      mode: 'MANUAL_ORDER',
      routes: [draftRoute('retained-owner', [foreignOrder.id])],
      shopDomain
    });
    const retainedChildVersion = await prisma.routeGroupingChildVersion.findFirstOrThrow({
      select: { id: true },
      where: { routePlanId: foreignSaved!.children[0]!.routePlanId, status: 'CURRENT', supersededAt: null }
    });
    await prisma.order.update({
      data: { currentRouteVersionId: retainedChildVersion.id },
      where: { id: orders[1]!.id }
    });

    await routePlans.deleteRoutePlan({ appId, routePlanId: deletedChild.routePlanId!, shopDomain });

    await expect(prisma.order.findUniqueOrThrow({
      select: { currentRouteVersionId: true },
      where: { id: orders[0]!.id }
    })).resolves.toEqual({ currentRouteVersionId: null });
    await expect(prisma.order.findUniqueOrThrow({
      select: { currentRouteVersionId: true },
      where: { id: orders[1]!.id }
    })).resolves.toEqual({ currentRouteVersionId: retainedChildVersion.id });
  });

  test('retains one Unassigned order when a 42-order group saves only 41 routed orders', async () => {
    const routedOrders = await seedOrders(41);
    const unassignedOrder = await seedOrder({ deliveryDate: null, routeScopeKey: null });
    const grouping = await createGrouping(
      'group with omitted unassigned order',
      [...routedOrders.map(({ id }) => id), unassignedOrder.id]
    );

    const saved = await service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [
        draftRoute('assigned-1', routedOrders.slice(0, 18).map(({ id }) => id)),
        draftRoute('assigned-2', routedOrders.slice(18).map(({ id }) => id)),
        draftRoute('assigned-3', [])
      ],
      shopDomain
    });

    expect(saved?.totalOrders).toBe(42);
    await expect(prisma.routeGroupingOrder.count({ where: { groupingId: grouping.id } })).resolves.toBe(42);
    await expect(prisma.order.findUniqueOrThrow({
      select: { currentRouteVersionId: true },
      where: { id: unassignedOrder.id }
    })).resolves.toEqual({ currentRouteVersionId: null });
  }, 30_000);

  test('permits a pre-existing Unassigned group order to be added to a child route', async () => {
    const orders = await seedOrders(2);
    const grouping = await createGrouping('add unassigned to route', orders.map(({ id }) => id));
    const firstSave = await service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [draftRoute('existing-child', [orders[0]!.id])],
      shopDomain
    });
    const routePlanId = firstSave!.children[0]!.routePlanId!;

    const secondSave = await service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [{
        branchId: null,
        label: 'existing-child',
        orderIds: orders.map(({ id }) => id),
        routeKey: `routePlan:${routePlanId}`,
        routePlanId
      }],
      shopDomain
    });

    expect(secondSave?.children[0]?.stopsCount).toBe(2);
    await expect(prisma.routeGroupingOrder.count({ where: { groupingId: grouping.id } })).resolves.toBe(2);
  });

  test('removes an omitted Unassigned order only when removedOrderIds explicitly names it', async () => {
    const orders = await seedOrders(2);
    const grouping = await createGrouping('explicitly remove unassigned', orders.map(({ id }) => id));
    const firstSave = await service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [draftRoute('kept-child', [orders[0]!.id])],
      shopDomain
    });
    const routePlanId = firstSave!.children[0]!.routePlanId!;

    const secondSave = await service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      removedOrderIds: [orders[1]!.id],
      routes: [{
        branchId: null,
        label: 'kept-child',
        orderIds: [orders[0]!.id],
        routeKey: `routePlan:${routePlanId}`,
        routePlanId
      }],
      shopDomain
    });

    expect(secondSave?.totalOrders).toBe(1);
    await expect(prisma.routeGroupingOrder.count({
      where: { groupingId: grouping.id, orderId: orders[1]!.id }
    })).resolves.toBe(0);
  });

  test('rejects a duplicate order across draft child routes', async () => {
    const order = await seedOrder();
    const grouping = await createGrouping('duplicate draft order', [order.id]);

    await expect(service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [draftRoute('duplicate-1', [order.id]), draftRoute('duplicate-2', [order.id])],
      shopDomain
    })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
  });

  test('rejects a foreign-shop order in a draft child route', async () => {
    const order = await seedOrder();
    const grouping = await createGrouping('foreign draft order', [order.id]);
    const foreignShop = await prisma.shop.create({
      data: { appId, shopDomain: `foreign-${Date.now()}.example.test` }
    });
    const foreignOrder = await seedOrder({ targetShopId: foreignShop.id });

    await expect(service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [draftRoute('foreign-order', [foreignOrder.id])],
      shopDomain
    })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });

    await prisma.shop.delete({ where: { id: foreignShop.id } });
  });

  test('rejects omitting an already routed order while retaining all group membership', async () => {
    const orders = await seedOrders(2);
    const grouping = await createGrouping('routed omission', orders.map(({ id }) => id));
    const saved = await service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [draftRoute('routed-omission', orders.map(({ id }) => id))],
      shopDomain
    });
    await expect(service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [{ ...draftRoute('routed-omission', [orders[0]!.id]), routePlanId: saved!.children[0]!.routePlanId }],
      shopDomain
    })).rejects.toMatchObject({
      blockers: ['route draft must include every current child route order exactly once across routes and removedOrderIds'],
      code: 'ROUTE_GROUPING_INVALID'
    });
    await expect(prisma.routeGroupingOrder.count({ where: { groupingId: grouping.id } })).resolves.toBe(2);
  });

  test('rejects a missing order in a draft child route', async () => {
    const order = await seedOrder();
    const grouping = await createGrouping('missing draft order', [order.id]);

    await expect(service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [draftRoute('missing-order', [randomUUID()])],
      shopDomain
    })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
  });

  test('rejects claiming an order owned by another active group without changing its pointer', async () => {
    const order = await seedOrder();
    const owningGrouping = await createGrouping('active ownership source', [order.id]);
    const owningSave = await service.saveDraft({
      appId,
      groupingId: owningGrouping.id,
      mode: 'MANUAL_ORDER',
      routes: [draftRoute('active-owner', [order.id])],
      shopDomain
    });
    const activeOwnerVersion = await prisma.routeGroupingChildVersion.findFirstOrThrow({
      select: { id: true },
      where: { routePlanId: owningSave!.children[0]!.routePlanId, status: 'CURRENT', supersededAt: null }
    });
    const competingGrouping = await createGrouping('competing grouping', [order.id]);

    await expect(service.saveDraft({
      appId,
      groupingId: competingGrouping.id,
      mode: 'MANUAL_ORDER',
      routes: [draftRoute('competing-owner', [order.id])],
      shopDomain
    })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_STALE_WRITE' });
    await expect(prisma.order.findUniqueOrThrow({
      select: { currentRouteVersionId: true },
      where: { id: order.id }
    })).resolves.toEqual({ currentRouteVersionId: activeOwnerVersion.id });
  });

  test('excludes a cancelled order beyond the first page from an all-filter selection snapshot', async () => {
    const marker = `selection-create-${randomUUID()}`;
    const offPageCancelled = await seedOrder({
      cancelledAt: new Date('2026-09-10T12:00:00.000Z'),
      displayOrderSequence: true,
      namePrefix: marker
    });
    await Promise.all(Array.from({ length: 52 }, () => seedOrder({ displayOrderSequence: true, namePrefix: marker })));
    const visibleCancelled = await seedOrder({
      cancelledAt: new Date('2026-09-10T12:00:00.000Z'),
      displayOrderSequence: true,
      namePrefix: marker
    });

    const snapshot = await orderQueries.createSelectionSnapshot({
      actor: 'integration',
      appId,
      excludeOrderIds: [visibleCancelled.id],
      filters: { search: marker },
      shopDomain
    });

    expect(snapshot).toMatchObject({ selectedCount: 52 });
    const cancelledMemberships = await prisma.orderSelectionSnapshotOrder.findMany({
      orderBy: { orderId: 'asc' },
      select: { excludedAt: true, orderId: true },
      where: {
        orderId: { in: [visibleCancelled.id, offPageCancelled.id] },
        snapshot: { filterHash: snapshot.filterHash }
      }
    });
    expect(cancelledMemberships.map(({ orderId }) => orderId))
      .toEqual([visibleCancelled.id, offPageCancelled.id].sort());
    expect(cancelledMemberships.every(({ excludedAt }) => excludedAt instanceof Date)).toBe(true);
  }, 30_000);

  test('keeps an order cancelled after snapshot creation excluded when exclusions change', async () => {
    const marker = `selection-update-${randomUUID()}`;
    const orders = await Promise.all(Array.from(
      { length: 52 },
      () => seedOrder({ displayOrderSequence: true, namePrefix: marker })
    ));
    const snapshot = await orderQueries.createSelectionSnapshot({
      actor: 'integration',
      appId,
      filters: { search: marker },
      shopDomain
    });
    await prisma.order.update({
      data: { cancelledAt: new Date('2030-09-10T11:00:00.000Z') },
      where: { id: orders[51]!.id }
    });

    await expect(orderQueries.replaceSelectionExclusions({
      actor: 'integration',
      appId,
      excludeOrderIds: [orders[0]!.id],
      selectionToken: snapshot.selectionToken,
      shopDomain
    })).resolves.toMatchObject({ selectedCount: 50 });
    const cancelledMembership = await prisma.orderSelectionSnapshotOrder.findFirstOrThrow({
      select: { excludedAt: true },
      where: { orderId: orders[51]!.id, snapshot: { filterHash: snapshot.filterHash } }
    });
    expect(cancelledMembership.excludedAt).toBeInstanceOf(Date);
  }, 30_000);

  test('rejects creating a grouping containing a cancelled order', async () => {
    const cancelled = await seedOrder({ cancelledAt: new Date('2026-09-10T12:00:00.000Z') });

    await expect(createGrouping('cancelled create', [cancelled.id]))
      .rejects.toMatchObject({
        blockers: ['cancelled orders cannot be added to a route grouping'],
        code: 'ROUTE_GROUPING_INVALID'
      });
  });

  test('rejects adding a cancelled order to an existing grouping', async () => {
    const valid = await seedOrder();
    const cancelled = await seedOrder({ cancelledAt: new Date('2026-09-10T12:00:00.000Z') });
    const grouping = await createGrouping('cancelled add', [valid.id]);

    await expect(service.updateGroupingOrders({
      addOrderIds: [cancelled.id],
      appId,
      groupingId: grouping.id,
      shopDomain
    })).rejects.toMatchObject({
      blockers: ['cancelled orders cannot be added to a route grouping'],
      code: 'ROUTE_GROUPING_INVALID'
    });
  });

  test('creates a grouping containing only valid READY_TO_PLAN orders', async () => {
    const orders = await seedOrders(2);

    await expect(createGrouping('valid create', orders.map(({ id }) => id)))
      .resolves.toMatchObject({ totalOrders: 2 });
  });

  function createGrouping(name: string, orderIds: string[]) {
    return service.createGrouping({
      appId,
      createdBy: 'integration',
      name,
      orderIds,
      planDate: '2026-09-10',
      shopDomain
    });
  }

  function draftRoute(routeKey: string, orderIds: string[]) {
    return {
      branchId: null,
      label: routeKey,
      orderIds,
      routeKey: `new:${routeKey}`,
      routePlanId: null,
      tempId: routeKey
    };
  }

  function seedOrders(count: number) {
    return Promise.all(Array.from({ length: count }, () => seedOrder()));
  }

  async function seedOrder(input: {
    cancelledAt?: Date | null;
    deliveryDate?: Date | null;
    displayOrderSequence?: boolean;
    namePrefix?: string;
    routeScopeKey?: string | null;
    targetShopId?: string;
  } = {}) {
    orderSequence += 1;
    const sequence = orderSequence;
    const targetShopId = input.targetShopId ?? shopId;
    const deliveryDate = input.deliveryDate === undefined
      ? new Date('2026-09-10T00:00:00.000Z')
      : input.deliveryDate;
    const order = await prisma.order.create({
      data: {
        cancelledAt: input.cancelledAt ?? null,
        displayOrderSequence: input.displayOrderSequence === true ? BigInt(sequence) : null,
        name: `${input.namePrefix ?? '#kfood-regression'}-${sequence}`,
        rawPayload: { source: 'route-grouping-save-integration' },
        shopId: targetShopId,
        shopifyOrderGid: `gid://shopify/Order/kfood-regression-${sequence}-${randomUUID()}`,
        sourceOrderId: `kfood-regression-${sequence}-${randomUUID()}`,
        sourceOrderNumber: String(2000 + sequence),
        sourcePlatform: 'SHOPIFY',
        deliveryFacts: {
          create: {
            batchEligible: true,
            deliveryArea: 'Toronto',
            deliveryDate,
            deliveryDayParseStatus: deliveryDate === null ? 'NOT_PROVIDED' : 'PARSED',
            geocodeStatus: 'RESOLVED',
            matchedMappingPaths: {},
            readiness: 'READY_TO_PLAN',
            reviewReasons: [],
            routeScopeKey: input.routeScopeKey === undefined ? 'thursday-delivery' : input.routeScopeKey,
            serviceType: 'DELIVERY',
            shopId: targetShopId,
            sourceOrderId: `kfood-regression-fact-${sequence}-${randomUUID()}`,
            sourceOrderNumber: String(2000 + sequence),
            sourcePlatform: 'SHOPIFY'
          }
        },
        deliveryStops: {
          create: {
            address1: `${100 + sequence} King St`,
            city: 'Toronto',
            countryCode: 'CA',
            deliveryDate,
            geocodeStatus: 'RESOLVED',
            latitude: 43.60 + sequence / 10_000,
            longitude: -79.40 - sequence / 10_000,
            recipientName: `K-food Recipient ${sequence}`
          }
        }
      },
      include: { deliveryStops: true }
    });
    return { deliveryStopId: order.deliveryStops[0]!.id, id: order.id };
  }
});
