import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { FakeDriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';
import { PrismaRouteGroupingService } from '../src/modules/route-grouping/route-grouping.service.js';
import { PrismaRoutePlanRepository } from '../src/modules/route-plans/route-plan.repository.js';

const enabled = process.env.ROUTE_COPY_DATABASE_TARGET_CLASS === 'safe-local-route-copy-disposable';
const databaseUrl = process.env.ROUTE_COPY_DATABASE_URL;
const describeDatabase = enabled && databaseUrl ? describe : describe.skip;

describeDatabase('route group copy database invariants', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled' });
  const shopDomain = `route-copy-${Date.now()}.example.test`;
  let shopId = '';

  beforeAll(async () => {
    const shop = await prisma.shop.create({ data: { appId: 'clever', shopDomain } });
    shopId = shop.id;
  });

  afterAll(async () => {
    if (shopId !== '') await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  test('two independent VIRTUAL copies survive deleting either sibling without mutating the source', async () => {
    const sourceOrder = await prisma.order.create({
      data: {
        email: 'recipient@example.test',
        name: '#route-copy-source',
        phone: '+14165550100',
        rawPayload: { source: 'integration-fixture' },
        shopId,
        shopifyOrderGid: `gid://shopify/Order/${Date.now()}`,
        sourceOrderId: `source-${Date.now()}`,
        sourcePlatform: 'SHOPIFY',
        deliveryStops: {
          create: {
            address1: '100 King St',
            address2: 'Dock 2',
            city: 'Toronto',
            countryCode: 'CA',
            deliveryDate: new Date('2026-08-20T00:00:00.000Z'),
            geocodeStatus: 'RESOLVED',
            instructions: 'Use loading dock',
            latitude: 43.65,
            longitude: -79.38,
            phone: '+14165550100',
            postalCode: 'M5H 1J9',
            priority: 7,
            province: 'ON',
            recipientName: 'Receiving',
            serviceMinutes: 12,
            timeWindowEnd: new Date('2026-08-20T16:00:00.000Z'),
            timeWindowStart: new Date('2026-08-20T14:00:00.000Z')
          }
        }
      },
      include: { deliveryStops: true }
    });
    const sourceStop = sourceOrder.deliveryStops[0];
    expect(sourceStop).toBeDefined();
    const source = await prisma.routeGrouping.create({
      data: {
        name: 'Copy source',
        planDate: new Date('2026-08-20T00:00:00.000Z'),
        shopId,
        versions: { create: { actor: 'integration', shopId, status: 'CURRENT', version: 1 } },
        orders: {
          create: { deliveryStopId: sourceStop!.id, orderId: sourceOrder.id, shopId, sourceSequence: 1 }
        }
      }
    });
    const service = new PrismaRouteGroupingService(prisma, new FakeDriverPushProvider());

    const first = await service.copyGrouping({ actor: 'integration', expectedUpdatedAt: source.updatedAt.toISOString(), groupingId: source.id, mode: 'VIRTUAL', shopDomain });
    const second = await service.copyGrouping({ actor: 'integration', expectedUpdatedAt: source.updatedAt.toISOString(), groupingId: source.id, mode: 'VIRTUAL', shopDomain });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.assignments[0]?.orderId).not.toBe(sourceOrder.id);
    expect(second!.assignments[0]?.orderId).not.toBe(sourceOrder.id);
    expect(first!.assignments[0]?.orderId).not.toBe(second!.assignments[0]?.orderId);
    expect(first!.assignments[0]?.deliveryStopId).not.toBe(second!.assignments[0]?.deliveryStopId);
    expect(first!.assignments[0]).toMatchObject({
      address1: '100 King St',
      coordinates: { latitude: 43.65, longitude: -79.38 },
      sourcePlatform: 'CUSTOM'
    });

    const firstVirtualAssignment = first!.assignments[0]!;
    await expect(prisma.routeGroupingOrder.create({
      data: {
        deliveryStopId: firstVirtualAssignment.deliveryStopId,
        groupingId: second!.id,
        orderId: firstVirtualAssignment.orderId,
        shopId,
        sourceSequence: 99
      }
    })).rejects.toThrow('CUSTOM order membership must match its owning route group');
    await expect(prisma.routeGroupingOrder.count({
      where: { groupingId: second!.id, orderId: firstVirtualAssignment.orderId }
    })).resolves.toBe(0);
    await expect(prisma.order.update({
      data: { ownedRouteGroupingId: second!.id },
      where: { id: firstVirtualAssignment.orderId }
    })).rejects.toThrow('CUSTOM order owner must match every route group membership');
    await expect(prisma.order.findUnique({
      select: { ownedRouteGroupingId: true },
      where: { id: firstVirtualAssignment.orderId }
    })).resolves.toEqual({ ownedRouteGroupingId: first!.id });

    const secondVersion = await prisma.routeGroupingVersion.findFirstOrThrow({ where: { groupingId: second!.id } });
    const foreignRoutePlan = await prisma.routePlan.create({
      data: {
        constraints: {},
        metrics: {},
        name: 'Foreign custom stop route',
        optimizerVersion: 'integration',
        planDate: new Date('2026-08-20T00:00:00.000Z'),
        shopId
      }
    });
    const foreignChild = await prisma.routeGroupingChildVersion.create({
      data: {
        groupingId: second!.id,
        groupingVersionId: secondVersion.id,
        routePlanId: foreignRoutePlan.id,
        shopId,
        snapshot: {},
        status: 'CURRENT',
        version: 1
      }
    });
    await expect(prisma.routePlanStop.create({
      data: {
        deliveryStopId: firstVirtualAssignment.deliveryStopId,
        routePlanId: foreignRoutePlan.id,
        sequence: 1,
        shopId
      }
    })).rejects.toThrow('CUSTOM stop route plan must belong to its owning route group');

    const secondVirtualAssignment = second!.assignments[0]!;
    let releaseConcurrentCommits = () => {};
    const concurrentCommitGate = new Promise<void>((resolve) => { releaseConcurrentCommits = resolve; });
    let markStopInserted = () => {};
    const stopInserted = new Promise<void>((resolve) => { markStopInserted = resolve; });
    let markChildDeleted = () => {};
    const childDeleted = new Promise<void>((resolve) => { markChildDeleted = resolve; });
    const concurrentPrisma = new PrismaClient({ datasourceUrl: databaseUrl! });
    const insertStop = concurrentPrisma.$transaction(async (tx) => {
      await tx.routePlanStop.create({
        data: {
          deliveryStopId: secondVirtualAssignment.deliveryStopId,
          routePlanId: foreignRoutePlan.id,
          sequence: 1,
          shopId
        }
      });
      markStopInserted();
      await concurrentCommitGate;
    });
    const deleteChild = prisma.$transaction(async (tx) => {
      await tx.routeGroupingChildVersion.delete({ where: { id: foreignChild.id } });
      markChildDeleted();
      await concurrentCommitGate;
    });
    await Promise.all([stopInserted, childDeleted]);
    releaseConcurrentCommits();
    const concurrentResults = await Promise.allSettled([insertStop, deleteChild]);
    await concurrentPrisma.$disconnect();
    expect(concurrentResults.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const [remainingChildCount, remainingStopCount] = await Promise.all([
      prisma.routeGroupingChildVersion.count({ where: { id: foreignChild.id } }),
      prisma.routePlanStop.count({
        where: { deliveryStopId: secondVirtualAssignment.deliveryStopId, routePlanId: foreignRoutePlan.id }
      })
    ]);
    expect(remainingChildCount).toBe(remainingStopCount);
    if (remainingStopCount > 0) {
      await prisma.routePlanStop.deleteMany({
        where: { deliveryStopId: secondVirtualAssignment.deliveryStopId, routePlanId: foreignRoutePlan.id }
      });
      await prisma.routeGroupingChildVersion.deleteMany({ where: { id: foreignChild.id } });
    }

    const standaloneForeignRoutePlan = await prisma.routePlan.create({
      data: {
        constraints: {},
        metrics: {},
        name: 'Standalone foreign custom stop route',
        optimizerVersion: 'integration',
        planDate: new Date('2026-08-20T00:00:00.000Z'),
        shopId
      }
    });

    await expect(prisma.routeGroupingOrder.create({
      data: {
        deliveryStopId: sourceStop!.id,
        groupingId: second!.id,
        orderId: sourceOrder.id,
        shopId,
        sourceSequence: 100
      }
    })).resolves.toMatchObject({ groupingId: second!.id, orderId: sourceOrder.id });

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.routeGroupingOrder.create({
        data: {
          deliveryStopId: firstVirtualAssignment.deliveryStopId,
          groupingId: second!.id,
          orderId: firstVirtualAssignment.orderId,
          shopId,
          sourceSequence: 101
        }
      });
      await tx.routePlanStop.create({
        data: {
          deliveryStopId: firstVirtualAssignment.deliveryStopId,
          routePlanId: standaloneForeignRoutePlan.id,
          sequence: 1,
          shopId
        }
      });
    });
    await expect(service.deleteGrouping({ groupingId: first!.id, shopDomain })).rejects.toMatchObject({
      blockers: [
        'owned CUSTOM orders are linked to another route group',
        'owned CUSTOM stops are linked to another route plan'
      ],
      code: 'ROUTE_GROUPING_DELETE_BLOCKED'
    });
    await expect(prisma.routeGrouping.findUnique({ where: { id: first!.id } })).resolves.not.toBeNull();
    await expect(prisma.order.findUnique({ where: { id: firstVirtualAssignment.orderId } })).resolves.not.toBeNull();
    await expect(prisma.routePlanStop.count({
      where: { deliveryStopId: firstVirtualAssignment.deliveryStopId, routePlanId: standaloneForeignRoutePlan.id }
    })).resolves.toBe(1);
    await prisma.routePlanStop.deleteMany({
      where: { deliveryStopId: firstVirtualAssignment.deliveryStopId, routePlanId: standaloneForeignRoutePlan.id }
    });
    await prisma.routeGroupingOrder.deleteMany({
      where: { groupingId: second!.id, orderId: firstVirtualAssignment.orderId }
    });

    await service.deleteGrouping({ groupingId: first!.id, shopDomain });

    await expect(prisma.order.findUnique({ where: { id: sourceOrder.id } })).resolves.not.toBeNull();
    await expect(prisma.routeGrouping.findUnique({ where: { id: second!.id } })).resolves.not.toBeNull();
    await expect(prisma.order.count({ where: { ownedRouteGroupingId: first!.id } })).resolves.toBe(0);
    await expect(prisma.deliveryStop.count({ where: { order: { ownedRouteGroupingId: first!.id } } })).resolves.toBe(0);
    await expect(prisma.routeGroupingOrder.count({ where: { groupingId: first!.id } })).resolves.toBe(0);
    await expect(prisma.inventory.count({ where: { routeGroupingId: first!.id } })).resolves.toBe(0);

    await expect(service.copyGrouping({ actor: 'integration', expectedUpdatedAt: source.updatedAt.toISOString(), groupingId: first!.id, mode: 'REFERENCE', shopDomain }))
      .resolves.toBeNull();
    await expect(service.copyGrouping({ actor: 'integration', expectedUpdatedAt: new Date(0).toISOString(), groupingId: source.id, mode: 'VIRTUAL', shopDomain }))
      .rejects.toMatchObject({ code: 'ROUTE_GROUPING_STALE_WRITE' });
    await expect(service.copyGrouping({ actor: 'integration', expectedUpdatedAt: second!.updatedAt, groupingId: second!.id, mode: 'REFERENCE', shopDomain }))
      .rejects.toMatchObject({ code: 'CUSTOM_ORDER_REFERENCE_COPY_NOT_ALLOWED' });
  });

  test('keeps mixed-date grouping membership and child route date boundaries explicit', async () => {
    await prisma.shop.update({
      data: {
        defaultDepotAddress: '1 Integration Depot',
        defaultDepotLatitude: 43.6532,
        defaultDepotLongitude: -79.3832
      },
      where: { id: shopId }
    });
    const suffix = Date.now();
    const orders = await Promise.all([
      { date: '2026-08-22', index: 2 },
      { date: '2026-08-20', index: 1 }
    ].map(({ date, index }) => prisma.order.create({
      data: {
        email: `mixed-date-${index}@route-copy.invalid`,
        name: `#mixed-date-${index}`,
        rawPayload: { source: 'mixed-date-integration-fixture' },
        shopId,
        shopifyOrderGid: `gid://shopify/Order/mixed-date-${suffix}-${index}`,
        sourceOrderId: `mixed-date-${suffix}-${index}`,
        sourcePlatform: 'SHOPIFY',
        deliveryFacts: {
          create: {
            batchEligible: true,
            deliveryDate: new Date(`${date}T00:00:00.000Z`),
            geocodeStatus: 'RESOLVED',
            matchedMappingPaths: {},
            readiness: 'READY_TO_PLAN',
            reviewReasons: [],
            shopId,
            sourcePlatform: 'SHOPIFY'
          }
        },
        deliveryStops: {
          create: {
            address1: `${index} Mixed Date Road`,
            countryCode: 'CA',
            deliveryDate: new Date(`${date}T00:00:00.000Z`),
            geocodeStatus: 'RESOLVED',
            latitude: 43.65 + index / 100,
            longitude: -79.38 - index / 100,
            recipientName: `Mixed Date ${index}`
          }
        }
      },
      include: { deliveryStops: true }
    })));
    const service = new PrismaRouteGroupingService(prisma, new FakeDriverPushProvider());
    const grouping = await service.createGrouping({
      createdBy: 'integration',
      dateRangeEnd: '2026-08-22',
      dateRangeStart: '2026-08-20',
      name: 'Mixed date grouping',
      orderIds: orders.map(({ id }) => id),
      shopDomain
    });

    expect(grouping).toMatchObject({
      dateRangeEnd: '2026-08-22',
      dateRangeStart: '2026-08-20',
      planDate: '2026-08-20',
      totalOrders: 2
    });
    const memberships = await prisma.routeGroupingOrder.findMany({
      orderBy: { sourceSequence: 'asc' },
      select: { deliveryStop: { select: { deliveryDate: true } }, orderId: true },
      where: { groupingId: grouping.id }
    });
    const membershipDates = memberships.map(({ deliveryStop }) => deliveryStop.deliveryDate?.toISOString().slice(0, 10));
    const sortedMembershipDates = membershipDates
      .filter((date): date is string => date !== undefined)
      .sort((left, right) => left.localeCompare(right));
    expect(memberships.map(({ orderId }) => orderId)).toEqual(orders.map(({ id }) => id));
    expect(membershipDates).toEqual(['2026-08-22', '2026-08-20']);
    expect([sortedMembershipDates.at(0), sortedMembershipDates.at(-1)]).toEqual([
      grouping.dateRangeStart,
      grouping.dateRangeEnd
    ]);

    const drivers = await Promise.all([1, 2].map((index) => prisma.driver.create({
      data: { displayName: `Mixed Date Driver ${index}`, shopId }
    })));
    await prisma.$transaction((tx) => service.saveDraftInTransaction(tx, {
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: orders.map((order, index) => ({
        branchId: null,
        driverId: drivers[index]!.id,
        label: `Mixed date route ${index + 1}`,
        orderIds: [order.id],
        routeKey: `new:mixed-date-${index + 1}`,
        routePlanId: null
      })),
      shopDomain
    }));
    const children = await prisma.routeGroupingChildVersion.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        routePlan: {
          select: {
            constraints: true,
            planDate: true,
            routeStops: {
              select: { deliveryStop: { select: { deliveryDate: true } } }
            }
          }
        }
      },
      where: { groupingId: grouping.id, status: 'CURRENT', supersededAt: null }
    });
    expect(children).toHaveLength(2);
    // Child routes use the grouping start date; save does not split the group by stop date.
    expect(children.map(({ routePlan }) => routePlan?.planDate.toISOString().slice(0, 10)))
      .toEqual(['2026-08-20', '2026-08-20']);
    expect(children.map(({ routePlan }) => (
      routePlan?.constraints as { routeScope?: { deliveryDate?: unknown } } | undefined
    )?.routeScope?.deliveryDate)).toEqual(['2026-08-20', '2026-08-20']);
    expect(children.map(({ routePlan }) => routePlan?.routeStops[0]?.deliveryStop.deliveryDate?.toISOString().slice(0, 10)))
      .toEqual(['2026-08-22', '2026-08-20']);

    const standalone = await prisma.routePlan.create({
      data: {
        constraints: { routeScope: { deliveryDate: '2026-08-20' } },
        metrics: {},
        name: 'Single-date route contract',
        optimizerVersion: 'integration',
        planDate: new Date('2026-08-20T00:00:00.000Z'),
        routeStops: {
          create: {
            deliveryStopId: orders[1]!.deliveryStops[0]!.id,
            sequence: 1
          }
        },
        shopId
      }
    });
    const routePlanRepository = new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true });
    await expect(routePlanRepository.updateRoutePlanStops({
      payload: {
        stops: [{
          deliveryStopId: orders[0]!.deliveryStops[0]!.id,
          sequence: 1,
          shopifyOrderGid: orders[0]!.shopifyOrderGid
        }]
      },
      routePlanId: standalone.id,
      shopDomain
    })).rejects.toThrow('Route stops must share the same delivery date as the route');
    await expect(prisma.routePlanStop.findMany({
      select: { deliveryStopId: true },
      where: { routePlanId: standalone.id }
    })).resolves.toEqual([{ deliveryStopId: orders[1]!.deliveryStops[0]!.id }]);
  });
});
