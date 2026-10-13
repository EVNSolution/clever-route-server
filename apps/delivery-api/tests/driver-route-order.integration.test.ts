import { randomUUID } from 'node:crypto';

import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PrismaDriverEventRepository } from '../src/modules/driver/driver-event.repository.js';
import {
  PrismaDriverRouteOrderService
} from '../src/modules/driver/driver-route-order.service.js';
import { replaceCurrentRouteGroupingChildVersion } from '../src/modules/route-grouping/route-grouping.service.js';
import { computeRouteShapeSignature } from '../src/modules/route-plans/route-plan-geometry-cache.js';
import { PrismaRoutePlanRepository, refreshPlannedRouteTimes } from '../src/modules/route-plans/route-plan.repository.js';
import { RoutePlanAdminService } from '../src/modules/route-plans/route-plan.service.js';
import type { RoutePlanDetail, RoutePlanRouteResult } from '../src/modules/route-plans/route-plan.types.js';

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

  test('rebuilds the legs of the driver order so the planned ETA and the route-start ETA are READY', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'READY');
    const builtOrders: string[][] = [];
    const service = new PrismaDriverRouteOrderService(prisma, new RoutePlanAdminService(
      new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true }),
      { buildRoute: (detail) => {
        builtOrders.push(detail.stops.map((stop) => stop.deliveryStopId));
        return Promise.resolve(syntheticRoute(detail));
      } }
    ));
    const orderedStopIds = [fixture.stopIds[1]!, fixture.stopIds[0]!];

    const reordered = await service.reorder({
      commandId: 'route-order-ready', driverId: fixture.driverId, expectedVersion: fixture.childVersionId,
      orderedStopIds, routePlanId: fixture.routePlanId, shopId: fixture.shopId
    });

    expect(builtOrders).toEqual([orderedStopIds]);
    const planned = await prisma.routePlanStop.findMany({ orderBy: { sequence: 'asc' }, where: { routePlanId: fixture.routePlanId } });
    expect(planned.map(({ deliveryStopId }) => deliveryStopId)).toEqual(orderedStopIds);
    for (const stop of planned) {
      expect(stop).toMatchObject({ durationFromPreviousSeconds: 600, etaInputRouteVersionId: reordered.routeVersionId, etaStatus: 'READY' });
      expect(stop.estimatedArrivalAt).toBeInstanceOf(Date);
    }

    await new PrismaDriverEventRepository(prisma).recordDriverEvent({
      attemptId: null, clientEventId: randomUUID(), deliveryStopId: null, driverId: fixture.driverId, eventType: 'ROUTE_STARTED',
      latitude: null, longitude: null, occurredAt: new Date('2026-09-07T00:00:00.000Z'), payload: {},
      routePlanId: fixture.routePlanId, shopDomain: fixture.shopDomain, shopId: fixture.shopId
    });
    const started = await prisma.routePlanStop.findMany({ orderBy: { sequence: 'asc' }, where: { routePlanId: fixture.routePlanId } });
    expect(started.map(({ etaFailureCode, etaSource, etaStatus }) => ({ etaFailureCode, etaSource, etaStatus })))
      .toEqual([0, 1].map(() => ({ etaFailureCode: null, etaSource: 'ROUTE_STARTED', etaStatus: 'READY' })));
  });

  test('lets the next driver event of a started route take the legs of the driver order from the rebuilt geometry', async () => {
    const fixture = await createFixture(prisma, createdShopIds);
    const events = new PrismaDriverEventRepository(prisma);
    const eventInput = (eventType: string, deliveryStopId: string | null, occurredAt: string) => ({
      attemptId: null, clientEventId: randomUUID(), deliveryStopId, driverId: fixture.driverId, eventType,
      latitude: null, longitude: null, occurredAt: new Date(occurredAt), payload: {},
      routePlanId: fixture.routePlanId, shopDomain: fixture.shopDomain, shopId: fixture.shopId
    });
    await events.recordDriverEvent(eventInput('ROUTE_STARTED', null, '2026-09-07T00:00:00.000Z'));
    const service = new PrismaDriverRouteOrderService(prisma, new RoutePlanAdminService(
      new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true }),
      { buildRoute: (detail) => Promise.resolve(syntheticRoute(detail)) }
    ));
    const orderedStopIds = [fixture.stopIds[1]!, fixture.stopIds[0]!];

    await service.reorder({
      commandId: 'route-order-started', driverId: fixture.driverId, expectedVersion: fixture.childVersionId,
      orderedStopIds, routePlanId: fixture.routePlanId, shopId: fixture.shopId
    });
    await events.recordDriverEvent(eventInput('STOP_ARRIVED', orderedStopIds[0]!, '2026-09-07T00:10:00.000Z'));

    const stops = await prisma.routePlanStop.findMany({ orderBy: { sequence: 'asc' }, where: { routePlanId: fixture.routePlanId } });
    expect(stops.map(({ deliveryStopId }) => deliveryStopId)).toEqual(orderedStopIds);
    expect(stops.map(({ durationFromPreviousSeconds }) => durationFromPreviousSeconds)).toEqual([600, 600]);
    expect(stops[1]).toMatchObject({ etaFailureCode: null, etaStatus: 'READY' });
    expect(stops[1]?.estimatedArrivalAt).toBeInstanceOf(Date);
  });

  test('keeps the ETA rows on the current route version so a started route accepts driver events after a version change', async () => {
    const fixture = await createFixture(prisma, createdShopIds);
    const events = new PrismaDriverEventRepository(prisma);
    await events.recordDriverEvent(driverEvent(fixture, 'ROUTE_STARTED', null, '2026-09-07T00:00:00.000Z'));
    const child = await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: fixture.childVersionId } });

    const nextVersionId = await prisma.$transaction((tx) => replaceCurrentRouteGroupingChildVersion(tx, {
      currentChildId: child.id, driverId: child.driverId, groupingId: child.groupingId, groupingVersionId: child.groupingVersionId,
      notificationStatus: child.notificationStatus, orderIds: fixture.orderIds, publishedAt: child.publishedAt,
      routePlanId: fixture.routePlanId, shopId: fixture.shopId, snapshot: child.snapshot as Prisma.InputJsonValue, version: child.version
    }));
    await events.recordDriverEvent(driverEvent(fixture, 'STOP_ARRIVED', fixture.stopIds[0]!, '2026-09-07T00:10:00.000Z'));

    const stops = await prisma.routePlanStop.findMany({ orderBy: { sequence: 'asc' }, where: { routePlanId: fixture.routePlanId } });
    expect(stops.map(({ etaInputRouteVersionId }) => etaInputRouteVersionId)).toEqual([nextVersionId, nextVersionId]);
    expect(stops[1]).toMatchObject({ etaSource: 'STOP_ARRIVED', etaStatus: 'READY' });
  });

  test('fails only the stops after a missing leg when the route starts', async () => {
    const fixture = await createFixture(prisma, createdShopIds);
    await prisma.routePlanStop.update({
      data: { durationFromPreviousSeconds: null },
      where: { routePlanId_deliveryStopId: { deliveryStopId: fixture.stopIds[1]!, routePlanId: fixture.routePlanId } }
    });
    await prisma.routePlanGeometryCache.deleteMany({ where: { routePlanId: fixture.routePlanId } });

    await new PrismaDriverEventRepository(prisma).recordDriverEvent(driverEvent(fixture, 'ROUTE_STARTED', null, '2026-09-07T00:00:00.000Z'));

    const [first, second] = await prisma.routePlanStop.findMany({ orderBy: { sequence: 'asc' }, where: { routePlanId: fixture.routePlanId } });
    expect(first).toMatchObject({ etaFailureCode: null, etaSource: 'ROUTE_STARTED', etaStatus: 'READY' });
    expect(first?.estimatedArrivalAt).toBeInstanceOf(Date);
    expect(second).toMatchObject({ estimatedArrivalAt: null, etaFailureCode: 'ETA_INPUT_DURATION_UNAVAILABLE', etaStatus: 'FAILED' });
  });

  test('keeps the STALE ETA of an admin stop move on the current route version and accepts the next driver event', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'READY');

    await new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true }).updateAdminRouteStopOverride({
      actor: 'integration', deliveryStopId: fixture.stopIds[1]!, payload: { latitude: 37.6, longitude: 127.2 },
      routePlanId: fixture.routePlanId, shopDomain: fixture.shopDomain
    });

    const stops = await prisma.routePlanStop.findMany({ orderBy: { sequence: 'asc' }, where: { routePlanId: fixture.routePlanId } });
    const orders = await prisma.order.findMany({ where: { id: { in: fixture.orderIds } } });
    expect(new Set(orders.map(({ currentRouteVersionId }) => currentRouteVersionId))).toEqual(new Set([fixture.childVersionId]));
    expect(stops.map(({ etaInputRouteVersionId, etaStatus }) => ({ etaInputRouteVersionId, etaStatus })))
      .toEqual([0, 1].map(() => ({ etaInputRouteVersionId: fixture.childVersionId, etaStatus: 'STALE' })));
    await expect(new PrismaDriverEventRepository(prisma).recordDriverEvent(driverEvent(fixture, 'ROUTE_STARTED', null, '2026-09-07T00:00:00.000Z')))
      .resolves.toBeDefined();
  });

  test('fails only the stops after a missing leg in the planned ETA, also when the driver Stop time changes later', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'READY');
    const repository = new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true });
    const detail = (await repository.findRoutePlanDetail({ routePlanId: fixture.routePlanId, shopDomain: fixture.shopDomain }))!;
    const route = syntheticRoute(detail);

    await repository.upsertRouteGeometryCache({
      geometry: route.routeGeometry, metrics: route.routeMetrics, provider: 'integration', routePlanId: fixture.routePlanId,
      shapeSignature: computeRouteShapeSignature(detail), source: 'SHAPE_MUTATION',
      stopPoints: route.routeStopPoints.filter(({ deliveryStopId }) => deliveryStopId !== fixture.stopIds[1])
    });

    const [first, second] = await prisma.routePlanStop.findMany({ orderBy: { sequence: 'asc' }, where: { routePlanId: fixture.routePlanId } });
    expect(first).toMatchObject({ etaFailureCode: null, etaInputRouteVersionId: fixture.childVersionId, etaSource: 'PLANNED_DEPARTURE', etaStatus: 'READY' });
    expect(first?.estimatedArrivalAt).toBeInstanceOf(Date);
    expect(second).toMatchObject({ estimatedArrivalAt: null, etaFailureCode: 'ETA_INPUT_DURATION_UNAVAILABLE', etaStatus: 'FAILED' });

    // The geometry of the current shape is stored, so a new driver Stop time computes the ETA again, and the stored
    // missing leg still fails the stop after it.
    const before = new Date('2026-01-01T00:00:00.000Z');
    await prisma.routePlanStop.updateMany({ data: { etaCalculatedAt: before }, where: { routePlanId: fixture.routePlanId } });
    await prisma.driver.update({ data: { averageServiceMinutes: 9 }, where: { id: fixture.driverId } });
    await prisma.$transaction((tx) => refreshPlannedRouteTimes(tx, fixture.routePlanId));
    const refreshed = await prisma.routePlanStop.findMany({ orderBy: { sequence: 'asc' }, where: { routePlanId: fixture.routePlanId } });
    expect(refreshed.map(({ etaFailureCode, etaStatus }) => ({ etaFailureCode, etaStatus }))).toEqual([
      { etaFailureCode: null, etaStatus: 'READY' },
      { etaFailureCode: 'ETA_INPUT_DURATION_UNAVAILABLE', etaStatus: 'FAILED' }
    ]);
    expect(refreshed[0]?.etaCalculatedAt?.getTime()).toBeGreaterThan(before.getTime());
  });

  test('computes every stop of a started route right after the driver reorders it, also the finished ones', async () => {
    const fixture = await createFixture(prisma, createdShopIds);
    const events = new PrismaDriverEventRepository(prisma);
    await events.recordDriverEvent(driverEvent(fixture, 'ROUTE_STARTED', null, '2026-09-07T00:00:00.000Z'));
    await events.recordDriverEvent(driverEvent(fixture, 'STOP_ARRIVED', fixture.stopIds[0]!, '2026-09-07T00:10:00.000Z'));
    await prisma.deliveryStop.update({ data: { status: 'DELIVERED' }, where: { id: fixture.stopIds[0]! } });
    await prisma.driverEvent.create({ data: {
      deliveryStopId: fixture.stopIds[0]!, driverId: fixture.driverId, eventType: 'STOP_DELIVERED', occurredAt: new Date('2026-09-07T00:12:00.000Z'),
      payload: {}, routePlanId: fixture.routePlanId, routeVersionId: fixture.childVersionId, shopId: fixture.shopId
    } });
    const service = new PrismaDriverRouteOrderService(prisma, new RoutePlanAdminService(
      new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true }),
      { buildRoute: (detail) => Promise.resolve(syntheticRoute(detail)) }
    ));

    const reordered = await service.reorder({
      commandId: 'route-order-started', driverId: fixture.driverId, expectedVersion: fixture.childVersionId,
      orderedStopIds: [fixture.stopIds[1]!, fixture.stopIds[0]!], routePlanId: fixture.routePlanId, shopId: fixture.shopId
    });

    const stops = await prisma.routePlanStop.findMany({ orderBy: { sequence: 'asc' }, where: { routePlanId: fixture.routePlanId } });
    for (const stop of stops) {
      expect(stop).toMatchObject({ etaFailureCode: null, etaInputRouteVersionId: reordered.routeVersionId, etaStatus: 'READY' });
      expect(stop.estimatedArrivalAt).toBeInstanceOf(Date);
    }
  });

  test('writes FAILED instead of leaving PENDING when the routing engine cannot rebuild a reordered route', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'READY');
    const service = new PrismaDriverRouteOrderService(prisma, new RoutePlanAdminService(
      new PrismaRoutePlanRepository(prisma, { allowAnyShopDomain: true }),
      { buildRoute: () => Promise.reject(new Error('routing engine unavailable')) }
    ));

    await service.reorder({
      commandId: 'route-order-engine-down', driverId: fixture.driverId, expectedVersion: fixture.childVersionId,
      orderedStopIds: [fixture.stopIds[1]!, fixture.stopIds[0]!], routePlanId: fixture.routePlanId, shopId: fixture.shopId
    });

    const stops = await prisma.routePlanStop.findMany({ orderBy: { sequence: 'asc' }, where: { routePlanId: fixture.routePlanId } });
    expect(stops.map(({ etaFailureCode, etaStatus }) => ({ etaFailureCode, etaStatus })))
      .toEqual([0, 1].map(() => ({ etaFailureCode: 'ETA_INPUT_DURATION_UNAVAILABLE', etaStatus: 'FAILED' })));
  });

  test('keeps a committed reorder when the geometry refresh fails', async () => {
    const fixture = await createFixture(prisma, createdShopIds, 'READY');
    const service = new PrismaDriverRouteOrderService(prisma, {
      refreshRouteGeometryForRoutePlan: () => Promise.reject(new Error('routing engine unavailable'))
    });
    const orderedStopIds = [fixture.stopIds[1]!, fixture.stopIds[0]!];

    await expect(service.reorder({
      commandId: 'route-order-refresh-failed', driverId: fixture.driverId, expectedVersion: fixture.childVersionId,
      orderedStopIds, routePlanId: fixture.routePlanId, shopId: fixture.shopId
    })).resolves.toMatchObject({ routePlanId: fixture.routePlanId });
    await expect(readAuthority(prisma, fixture)).resolves.toMatchObject({ stopIds: orderedStopIds });
  });
});

function driverEvent(
  fixture: Awaited<ReturnType<typeof createFixture>>, eventType: string, deliveryStopId: string | null, occurredAt: string
) {
  return {
    attemptId: null, clientEventId: randomUUID(), deliveryStopId, driverId: fixture.driverId, eventType,
    latitude: null, longitude: null, occurredAt: new Date(occurredAt), payload: {},
    routePlanId: fixture.routePlanId, shopDomain: fixture.shopDomain, shopId: fixture.shopId
  };
}

function syntheticRoute(detail: RoutePlanDetail): RoutePlanRouteResult {
  return {
    routeGeometry: { coordinates: [[127, 37], [127.1, 37.1]], type: 'LineString' },
    routeMetrics: { distanceMeters: detail.stops.length * 1000, durationSeconds: detail.stops.length * 600 },
    routeStopPoints: detail.stops.map((stop) => ({
      deliveryStopId: stop.deliveryStopId, distanceFromPreviousMeters: 1000, durationFromPreviousSeconds: 600,
      inputCoordinates: [127, 37], name: null, sequence: stop.sequence, shopifyOrderGid: stop.shopifyOrderGid,
      snapDistanceMeters: 0, snappedCoordinates: [127, 37]
    }))
  };
}

async function createFixture(prisma: PrismaClient, createdShopIds: string[], status: 'IN_PROGRESS' | 'READY' = 'IN_PROGRESS') {
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
    data: { address1: `${index + 1} Integration Road`, countryCode: 'KR', latitude: 37.5 + index / 100, longitude: 127 + index / 100, orderId: order.id, shopId: shop.id }
  })));
  const grouping = await prisma.routeGrouping.create({
    data: { name: 'Route order integration', planDate: new Date('2026-09-07T00:00:00.000Z'), shopId: shop.id }
  });
  const groupingVersion = await prisma.routeGroupingVersion.create({
    data: { groupingId: grouping.id, shopId: shop.id, status: 'CURRENT', version: 1 }
  });
  const routePlan = await prisma.routePlan.create({
    data: {
      constraints: {}, depotLatitude: 37.4, depotLongitude: 126.9, driverId: driver.id, metrics: {}, name: 'Route order integration',
      optimizerVersion: 'integration', planDate: new Date('2026-09-07T00:00:00.000Z'), shopId: shop.id, status
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
  return { childVersionId: child.id, driverId: driver.id, shopDomain: shop.shopDomain, orderIds: orders.map(({ id }) => id), routePlanId: routePlan.id, shopId: shop.id, stopIds: stops.map(({ id }) => id) };
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
