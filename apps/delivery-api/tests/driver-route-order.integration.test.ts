import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  PrismaDriverRouteOrderService
} from '../src/modules/driver/driver-route-order.service.js';

const safeTargetClass = 'safe-local-driver-route-order-temp-cluster';
const exactDatabaseUrl = 'postgresql://clever_route_order:clever_route_order@127.0.0.1:55467/clever_route_order?schema=public';
const databaseUrl = process.env.DATABASE_URL ?? '';
const targetClass = process.env.DRIVER_ROUTE_ORDER_DATABASE_TARGET_CLASS ?? '';
const isTargetClass = targetClass === safeTargetClass;
const isSafeDisposableTarget = isTargetClass && databaseUrl === exactDatabaseUrl;
const describeDisposable = isTargetClass ? describe.sequential : describe.skip;

describeDisposable('driver route order PostgreSQL integration', () => {
  const prisma = new PrismaClient();
  const createdShopIds: string[] = [];

  beforeAll(async () => {
    if (!isSafeDisposableTarget) {
      throw new Error(
        `Refusing unsafe driver route order target: DRIVER_ROUTE_ORDER_DATABASE_TARGET_CLASS=${targetClass || '<missing>'} DATABASE_URL=${databaseUrl || '<missing>'}`
      );
    }
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const shopId of createdShopIds.reverse()) await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  test('atomically replaces route authority, invalidates derived legs, and preserves state across stale/replay conflicts', async () => {
    const fixture = await createFixture(prisma, createdShopIds);
    const service = new PrismaDriverRouteOrderService(prisma);
    const input = {
      commandId: 'route-order-success',
      driverId: fixture.driverId,
      expectedVersion: fixture.childVersionId,
      orderedStopIds: [fixture.stopIds[1]!, fixture.stopIds[0]!],
      routePlanId: fixture.routePlanId,
      shopId: fixture.shopId
    };

    await expect(service.reorder({ ...input, commandId: 'route-order-stale-before', expectedVersion: randomUUID() }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(readAuthority(prisma, fixture)).resolves.toMatchObject({
      currentVersionId: fixture.childVersionId,
      geometryCount: 1,
      sequences: [1, 2]
    });

    const first = await service.reorder(input);
    const replay = await service.reorder(input);
    expect(replay).toEqual(first);
    expect(first.stops).toEqual([
      { deliveryStopId: fixture.stopIds[1], sequence: 1 },
      { deliveryStopId: fixture.stopIds[0], sequence: 2 }
    ]);

    const authority = await readAuthority(prisma, fixture);
    expect(authority.sequences).toEqual([1, 2]);
    expect(authority.stopIds).toEqual(input.orderedStopIds);
    expect(authority.geometryCount).toBe(0);
    expect(authority.currentVersionId).toBe(first.routeVersionId);
    expect(authority.archivedVersion).toMatchObject({ id: fixture.childVersionId, status: 'ARCHIVED' });
    expect(authority.orderVersionIds).toEqual([first.routeVersionId, first.routeVersionId]);
    expect(authority.derivedStops).toEqual([
      expect.objectContaining({ distanceFromPreviousMeters: null, durationFromPreviousSeconds: null, estimatedArrivalAt: null, etaCalculatedAt: null, etaInputRouteVersionId: first.routeVersionId, etaStatus: 'PENDING' }),
      expect.objectContaining({ distanceFromPreviousMeters: null, durationFromPreviousSeconds: null, estimatedArrivalAt: null, etaCalculatedAt: null, etaInputRouteVersionId: first.routeVersionId, etaStatus: 'PENDING' })
    ]);
    expect(snapshotStopIds(authority.currentSnapshot)).toEqual(input.orderedStopIds);
    await expect(prisma.dsvCommandReceipt.count({ where: { commandId: input.commandId, shopId: fixture.shopId } })).resolves.toBe(1);

    await expect(service.reorder({ ...input, orderedStopIds: [...input.orderedStopIds].reverse() }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    await expect(service.reorder({ ...input, commandId: 'route-order-stale-after' }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const afterConflicts = await readAuthority(prisma, fixture);
    expect(afterConflicts.currentVersionId).toBe(first.routeVersionId);
    expect(afterConflicts.stopIds).toEqual(input.orderedStopIds);
    expect(afterConflicts.orderVersionIds).toEqual([first.routeVersionId, first.routeVersionId]);
  });
});

async function createFixture(prisma: PrismaClient, createdShopIds: string[]) {
  const suffix = randomUUID();
  const shop = await prisma.shop.create({ data: { shopDomain: `route-order-${suffix}.example.com` } });
  createdShopIds.push(shop.id);
  const driver = await prisma.driver.create({ data: { displayName: 'Route Order Driver', shopId: shop.id } });
  const orders = await Promise.all([1, 2].map((index) => prisma.order.create({
    data: {
      name: `#RO-${index}`,
      rawPayload: {},
      shopId: shop.id,
      shopifyOrderGid: `gid://shopify/Order/route-order-${suffix}-${index}`
    }
  })));
  const stops = await Promise.all(orders.map((order, index) => prisma.deliveryStop.create({
    data: { address1: `${index + 1} Integration Road`, countryCode: 'KR', orderId: order.id, shopId: shop.id }
  })));
  const grouping = await prisma.routeGrouping.create({
    data: { name: 'Route order integration', planDate: new Date('2026-09-07T00:00:00.000Z'), shopId: shop.id }
  });
  const groupingVersion = await prisma.routeGroupingVersion.create({
    data: { groupingId: grouping.id, shopId: shop.id, status: 'CURRENT', version: 1 }
  });
  const routePlan = await prisma.routePlan.create({
    data: {
      constraints: {}, driverId: driver.id, metrics: {}, name: 'Route order integration', optimizerVersion: 'integration',
      planDate: new Date('2026-09-07T00:00:00.000Z'), shopId: shop.id, status: 'IN_PROGRESS'
    }
  });
  await prisma.routeGroupingOrder.createMany({
    data: orders.map((order, index) => ({
      assignedDriverId: driver.id, assignmentStatus: 'ASSIGNED', deliveryStopId: stops[index]!.id,
      groupingId: grouping.id, orderId: order.id, shopId: shop.id, sourceSequence: index + 1
    }))
  });
  const child = await prisma.routeGroupingChildVersion.create({
    data: {
      driverId: driver.id, groupingId: grouping.id, groupingVersionId: groupingVersion.id, routePlanId: routePlan.id,
      shopId: shop.id, snapshot: { name: 'Route order integration', stops: orders.map((order, index) => ({ deliveryStopId: stops[index]!.id, orderId: order.id, sequence: index + 1 })) },
      status: 'CURRENT', version: 1
    }
  });
  await Promise.all([
    ...orders.map((order) => prisma.order.update({ data: { currentRouteVersionId: child.id }, where: { id: order.id } })),
    prisma.routePlanStop.createMany({ data: stops.map((stop, index) => ({
      deliveryStopId: stop.id, distanceFromPreviousMeters: 1000 + index, durationFromPreviousSeconds: 500 + index,
      estimatedArrivalAt: new Date(`2026-09-07T0${index + 1}:00:00.000Z`), etaCalculatedAt: new Date('2026-09-07T00:30:00.000Z'),
      etaInputRouteVersionId: child.id, etaSource: 'INTEGRATION', etaStatus: 'READY', routePlanId: routePlan.id,
      sequence: index + 1, shopId: shop.id
    })) }),
    prisma.routePlanGeometryCache.create({ data: {
      geometry: { coordinates: [[127, 37], [128, 38]], type: 'LineString' }, provider: 'integration', routePlanId: routePlan.id,
      shapeSignature: `route-order-${suffix}`, source: 'integration', stopPoints: stops.map(({ id }) => ({ deliveryStopId: id }))
    } })
  ]);
  return { childVersionId: child.id, driverId: driver.id, orderIds: orders.map(({ id }) => id), routePlanId: routePlan.id, shopId: shop.id, stopIds: stops.map(({ id }) => id) };
}

async function readAuthority(prisma: PrismaClient, fixture: Awaited<ReturnType<typeof createFixture>>) {
  const [routeStops, currentVersion, archivedVersion, orders, geometryCount] = await Promise.all([
    prisma.routePlanStop.findMany({ orderBy: { sequence: 'asc' }, where: { routePlanId: fixture.routePlanId } }),
    prisma.routeGroupingChildVersion.findFirstOrThrow({ where: { routePlanId: fixture.routePlanId, status: 'CURRENT', supersededAt: null } }),
    prisma.routeGroupingChildVersion.findFirst({ where: { id: fixture.childVersionId } }),
    prisma.order.findMany({ orderBy: { id: 'asc' }, where: { id: { in: fixture.orderIds } } }),
    prisma.routePlanGeometryCache.count({ where: { routePlanId: fixture.routePlanId } })
  ]);
  return {
    archivedVersion,
    currentSnapshot: currentVersion.snapshot,
    currentVersionId: currentVersion.id,
    derivedStops: routeStops,
    geometryCount,
    orderVersionIds: orders.map(({ currentRouteVersionId }) => currentRouteVersionId),
    sequences: routeStops.map(({ sequence }) => sequence),
    stopIds: routeStops.map(({ deliveryStopId }) => deliveryStopId)
  };
}

function snapshotStopIds(snapshot: unknown): string[] {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];
  const stops = (snapshot as Record<string, unknown>).stops;
  if (!Array.isArray(stops)) return [];
  return stops.map((stop) => stop !== null && typeof stop === 'object' && !Array.isArray(stop)
    ? (stop as Record<string, unknown>).deliveryStopId
    : null).filter((deliveryStopId): deliveryStopId is string => typeof deliveryStopId === 'string');
}
