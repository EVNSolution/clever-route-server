import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
  DriverEventAssignmentChangedError,
  DriverEventRouteVersionMismatchError,
  PrismaDriverEventRepository
} from '../src/modules/driver/driver-event.repository.js';
import { PrismaDriverAssignedRouteRepository } from '../src/modules/driver/driver-assigned-route.repository.js';
import { PrismaDriverRouteAccessRepository } from '../src/modules/driver/driver-route-access.repository.js';
import { FakeDriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';
import { PrismaRouteGroupingService, rebindCurrentOrdersToRouteVersion } from '../src/modules/route-grouping/route-grouping.service.js';
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
  const driverAccountIds: string[] = [];

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
    if (driverAccountIds.length > 0) await prisma.driverAccount.deleteMany({ where: { id: { in: driverAccountIds } } });
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

  test('reorders a started child route without replacing execution rows and rejects a completed successor change', async () => {
    const orders = await seedOrders(2);
    const driverAccount = await prisma.driverAccount.create({ data: { phone: `started-reorder-${randomUUID()}` } });
    driverAccountIds.push(driverAccount.id);
    const driver = await prisma.driver.create({
      data: {
        accountId: driverAccount.id,
        authSubject: `started-reorder-${randomUUID()}`,
        displayName: 'Started reorder driver',
        shopId
      }
    });
    const grouping = await createGrouping('started route reorder', orders.map(({ id }) => id));
    const firstSave = await service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [{ ...draftRoute('started-child', orders.map(({ id }) => id)), driverId: driver.id }],
      shopDomain
    });
    const routePlanId = firstSave!.children[0]!.routePlanId!;
    const firstChild = await prisma.routeGroupingChildVersion.findFirstOrThrow({
      where: { routePlanId, status: 'CURRENT', supersededAt: null }
    });
    const originalStops = await prisma.routePlanStop.findMany({
      orderBy: { sequence: 'asc' },
      where: { routePlanId }
    });
    const terminalEta = new Date('2026-09-10T13:00:00.000Z');
    const activeEta = new Date('2026-09-10T13:30:00.000Z');
    await prisma.deliveryStop.update({ data: { status: 'DELIVERED' }, where: { id: orders[0]!.deliveryStopId } });
    await prisma.deliveryStop.update({ data: { status: 'EN_ROUTE' }, where: { id: orders[1]!.deliveryStopId } });
    await prisma.routePlanStop.update({
      data: {
        distanceFromPreviousMeters: 100,
        durationFromPreviousSeconds: 60,
        estimatedArrivalAt: terminalEta,
        etaCalculatedAt: new Date('2026-09-10T12:00:00.000Z'),
        etaInputRouteVersionId: firstChild.id,
        etaSource: 'INTEGRATION',
        etaStatus: 'READY'
      },
      where: { id: originalStops[0]!.id }
    });
    await prisma.routePlanStop.update({
      data: {
        distanceFromPreviousMeters: 200,
        durationFromPreviousSeconds: 120,
        estimatedArrivalAt: activeEta,
        etaCalculatedAt: new Date('2026-09-10T12:00:00.000Z'),
        etaInputRouteVersionId: firstChild.id,
        etaSource: 'INTEGRATION',
        etaStatus: 'READY'
      },
      where: { id: originalStops[1]!.id }
    });
    const assignedRoute = await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } });
    const eventRepository = new PrismaDriverEventRepository(prisma);
    const startedEvent = await eventRepository.recordDriverEvent({
      assignmentGeneration: assignedRoute.assignmentGeneration.toString(),
      attemptId: null,
      clientEventId: randomUUID(),
      deliveryStopId: null,
      driverContractVersion: 2,
      driverId: driver.id,
      eventType: 'ROUTE_STARTED',
      expectedRouteVersionId: firstChild.id,
      latitude: null,
      longitude: null,
      occurredAt: new Date('2026-09-10T12:15:00.000Z'),
      payload: { source: 'route-grouping-save-integration' },
      routePlanId,
      shopDomain,
      shopId
    });
    const lockedRoute = await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } });
    await eventRepository.recordDriverEvent({
      assignmentGeneration: lockedRoute.assignmentGeneration.toString(),
      attemptId: null,
      clientEventId: randomUUID(),
      deliveryStopId: null,
      driverContractVersion: 2,
      driverId: driver.id,
      eventType: 'PICKUP_COMPLETED',
      expectedRouteVersionId: firstChild.id,
      latitude: null,
      longitude: null,
      occurredAt: new Date('2026-09-10T12:20:00.000Z'),
      payload: { source: 'route-grouping-save-integration' },
      routePlanId,
      shopDomain,
      shopId
    });
    await eventRepository.recordDriverEvent({
      assignmentGeneration: lockedRoute.assignmentGeneration.toString(),
      attemptId: null,
      clientEventId: randomUUID(),
      deliveryStopId: orders[1]!.deliveryStopId,
      driverContractVersion: 2,
      driverId: driver.id,
      eventType: 'STOP_ARRIVED',
      expectedRouteVersionId: firstChild.id,
      latitude: null,
      longitude: null,
      occurredAt: new Date('2026-09-10T12:25:00.000Z'),
      payload: { source: 'route-grouping-save-integration' },
      routePlanId,
      shopDomain,
      shopId
    });
    const terminalBeforeReorder = await prisma.routePlanStop.findUniqueOrThrow({
      where: { id: originalStops[0]!.id }
    });

    const reordered = await service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [{
        branchId: null,
        expectedRoutePlanUpdatedAt: lockedRoute.updatedAt.toISOString(),
        label: lockedRoute.name,
        orderIds: [orders[1]!.id, orders[0]!.id],
        routeKey: `routePlan:${routePlanId}`,
        routePlanId,
        scheduledStartAt: null,
        scheduledStartTimeZone: null,
        vehicleId: null
      }],
      shopDomain
    });

    expect(reordered?.children[0]?.routePlanId).toBe(routePlanId);
    const nextChild = await prisma.routeGroupingChildVersion.findFirstOrThrow({
      where: { routePlanId, status: 'CURRENT', supersededAt: null }
    });
    expect(nextChild.id).not.toBe(firstChild.id);
    expect(nextChild.snapshot).toMatchObject({ predecessorChildVersionId: firstChild.id });
    expect(nextChild.snapshot).toMatchObject({
      reorderCompatibility: {
        assignmentGeneration: lockedRoute.assignmentGeneration.toString()
      }
    });
    const routeAccess = await new PrismaDriverRouteAccessRepository(prisma).lookupRouteAccess({
      accountId: driverAccount.id,
      routeContext: routePlanId
    });
    expect(routeAccess).toMatchObject({
      routeAccess: {
        assignmentGeneration: lockedRoute.assignmentGeneration.toString(),
        expectedRouteVersionId: nextChild.id,
        routePlanId
      },
      status: 'INVITED'
    });
    const archivedFirstChild = await prisma.routeGroupingChildVersion.findUniqueOrThrow({ where: { id: firstChild.id } });
    expect(archivedFirstChild.status).toBe('ARCHIVED');
    expect(archivedFirstChild.supersededAt).toBeInstanceOf(Date);
    const reorderedStops = await prisma.routePlanStop.findMany({
      include: { deliveryStop: { select: { status: true } } },
      orderBy: { sequence: 'asc' },
      where: { routePlanId }
    });
    expect(reorderedStops.map(({ deliveryStopId, id, sequence }) => ({ deliveryStopId, id, sequence }))).toEqual([
      { deliveryStopId: orders[1]!.deliveryStopId, id: originalStops[1]!.id, sequence: 1 },
      { deliveryStopId: orders[0]!.deliveryStopId, id: originalStops[0]!.id, sequence: 2 }
    ]);
    expect(reorderedStops[0]).toMatchObject({
      deliveryStop: { status: 'ARRIVED' },
      distanceFromPreviousMeters: null,
      durationFromPreviousSeconds: null,
      estimatedArrivalAt: null,
      etaCalculatedAt: null,
      etaInputRouteVersionId: nextChild.id,
      etaStatus: 'PENDING'
    });
    expect(reorderedStops[1]).toMatchObject({
      deliveryStop: { status: 'DELIVERED' },
      distanceFromPreviousMeters: 100,
      durationFromPreviousSeconds: 60,
      estimatedArrivalAt: terminalBeforeReorder.estimatedArrivalAt,
      etaInputRouteVersionId: nextChild.id,
      etaStatus: 'READY'
    });
    await expect(prisma.order.findMany({
      orderBy: { id: 'asc' },
      select: { currentRouteVersionId: true },
      where: { id: { in: orders.map(({ id }) => id) } }
    })).resolves.toEqual([{ currentRouteVersionId: nextChild.id }, { currentRouteVersionId: nextChild.id }]);
    await expect(prisma.driverEvent.findUniqueOrThrow({ where: { id: startedEvent.eventId } }))
      .resolves.toMatchObject({ routePlanId, routeVersionId: firstChild.id });

    const offlineDelivery = await eventRepository.recordDriverEvent({
      assignmentGeneration: lockedRoute.assignmentGeneration.toString(),
      attemptId: null,
      clientEventId: randomUUID(),
      deliveryStopId: orders[1]!.deliveryStopId,
      driverContractVersion: 2,
      driverId: driver.id,
      eventType: 'STOP_DELIVERED',
      expectedRouteVersionId: firstChild.id,
      latitude: null,
      longitude: null,
      occurredAt: new Date('2026-09-10T12:30:00.000Z'),
      payload: { source: 'route-grouping-save-integration' },
      routePlanId,
      shopDomain,
      shopId
    });
    await expect(prisma.driverEvent.findUniqueOrThrow({ where: { id: offlineDelivery.eventId } }))
      .resolves.toMatchObject({
        expectedRouteVersionId: firstChild.id,
        routePlanId,
        routeVersionId: nextChild.id
      });
    await expect(prisma.deliveryStop.findUniqueOrThrow({ where: { id: orders[1]!.deliveryStopId } }))
      .resolves.toMatchObject({ status: 'DELIVERED' });
    await expect(eventRepository.recordDriverEvent({
      assignmentGeneration: lockedRoute.assignmentGeneration.toString(),
      attemptId: null,
      clientEventId: randomUUID(),
      deliveryStopId: orders[1]!.deliveryStopId,
      driverContractVersion: 2,
      driverId: driver.id,
      eventType: 'STOP_DELIVERED',
      expectedRouteVersionId: randomUUID(),
      latitude: null,
      longitude: null,
      occurredAt: new Date('2026-09-10T12:31:00.000Z'),
      payload: { source: 'route-grouping-save-integration' },
      routePlanId,
      shopDomain,
      shopId
    })).rejects.toBeInstanceOf(DriverEventRouteVersionMismatchError);

    const repeatedRoute = await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } });
    await expect(service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [{
        branchId: null,
        expectedRoutePlanUpdatedAt: repeatedRoute.updatedAt.toISOString(),
        label: repeatedRoute.name,
        orderIds: orders.map(({ id }) => id),
        routeKey: `routePlan:${routePlanId}`,
        routePlanId,
        scheduledStartAt: null,
        scheduledStartTimeZone: null,
        vehicleId: null
      }],
      shopDomain
    })).resolves.toMatchObject({ id: grouping.id });
    const repeatedChild = await prisma.routeGroupingChildVersion.findFirstOrThrow({
      where: { routePlanId, status: 'CURRENT', supersededAt: null }
    });
    expect(repeatedChild.snapshot).toMatchObject({
      predecessorChildVersionId: nextChild.id,
      reorderCompatibility: {
        assignmentGeneration: repeatedRoute.assignmentGeneration.toString()
      }
    });

    const changedGenerationRoute = await prisma.routePlan.update({
      data: { assignmentGeneration: { increment: 1 } },
      where: { id: routePlanId }
    });
    await expect(eventRepository.recordDriverEvent({
      assignmentGeneration: repeatedRoute.assignmentGeneration.toString(),
      attemptId: null,
      clientEventId: randomUUID(),
      deliveryStopId: orders[1]!.deliveryStopId,
      driverContractVersion: 2,
      driverId: driver.id,
      eventType: 'STOP_FAILED',
      expectedRouteVersionId: repeatedChild.id,
      latitude: null,
      longitude: null,
      occurredAt: new Date('2026-09-10T12:35:00.000Z'),
      payload: { source: 'route-grouping-save-integration' },
      routePlanId,
      shopDomain,
      shopId
    })).rejects.toBeInstanceOf(DriverEventAssignmentChangedError);
    await expect(service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [{
        branchId: null,
        expectedRoutePlanUpdatedAt: changedGenerationRoute.updatedAt.toISOString(),
        label: changedGenerationRoute.name,
        orderIds: [orders[1]!.id, orders[0]!.id],
        routeKey: `routePlan:${routePlanId}`,
        routePlanId,
        scheduledStartAt: null,
        scheduledStartTimeZone: null,
        vehicleId: null
      }],
      shopDomain
    })).resolves.toMatchObject({ id: grouping.id });
    const changedGenerationChild = await prisma.routeGroupingChildVersion.findFirstOrThrow({
      where: { routePlanId, status: 'CURRENT', supersededAt: null }
    });
    expect(changedGenerationChild.snapshot).toMatchObject({
      predecessorChildVersionId: repeatedChild.id,
      reorderCompatibility: {
        assignmentGeneration: changedGenerationRoute.assignmentGeneration.toString()
      }
    });

    const pausedEvent = await prisma.driverEvent.create({
      data: {
        eventType: 'ROUTE_PAUSED',
        occurredAt: new Date('2026-09-10T12:45:00.000Z'),
        payload: { source: 'route-grouping-save-integration' },
        routePlanId,
        routeVersionId: changedGenerationChild.id,
        shopId
      }
    });
    const pausedRoute = await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } });
    await expect(service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [{
        branchId: null,
        expectedRoutePlanUpdatedAt: pausedRoute.updatedAt.toISOString(),
        label: pausedRoute.name,
        orderIds: [orders[1]!.id, orders[0]!.id],
        routeKey: `routePlan:${routePlanId}`,
        routePlanId,
        scheduledStartAt: '2026-09-10T13:00:00.000Z',
        scheduledStartTimeZone: 'UTC',
        vehicleId: null
      }],
      shopDomain
    })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_INVALID' });
    await expect(prisma.driverEvent.findUniqueOrThrow({ where: { id: pausedEvent.id } }))
      .resolves.toMatchObject({ routePlanId, routeVersionId: changedGenerationChild.id });

    await prisma.driverEvent.update({
      data: {
        eventType: 'ROUTE_COMPLETED',
        occurredAt: new Date('2026-09-10T14:00:00.000Z'),
        payload: { source: 'route-grouping-save-integration' },
        routePlanId,
        routeVersionId: changedGenerationChild.id,
        shopId
      },
      where: { id: pausedEvent.id }
    });
    await prisma.routePlan.update({ data: { status: 'COMPLETED' }, where: { id: routePlanId } });
    const completedRoute = await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } });
    await expect(service.saveDraft({
      appId,
      groupingId: grouping.id,
      mode: 'MANUAL_ORDER',
      routes: [{
        branchId: null,
        expectedRoutePlanUpdatedAt: completedRoute.updatedAt.toISOString(),
        label: completedRoute.name,
        orderIds: orders.map(({ id }) => id),
        routeKey: `routePlan:${routePlanId}`,
        routePlanId,
        scheduledStartAt: null,
        scheduledStartTimeZone: null,
        vehicleId: null
      }],
      shopDomain
    })).rejects.toMatchObject({
      blockers: ['route membership cannot change after route completion'],
      code: 'ROUTE_GROUPING_INVALID'
    });
    await expect(prisma.routeGroupingChildVersion.findFirstOrThrow({
      where: { routePlanId, status: 'CURRENT', supersededAt: null }
    })).resolves.toMatchObject({ id: changedGenerationChild.id });
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
    })).resolves.toMatchObject({ children: [expect.objectContaining({ orderIds: [order.id] })] });
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

  test('creates one named Friday route, replays the request, then saves and reloads a split', async () => {
    const orders = await Promise.all(Array.from({ length: 41 }, () => seedOrder({
      deliveryDate: new Date('2026-09-11T00:00:00.000Z'), routeScopeKey: 'friday-delivery'
    })));
    const input = {
      appId, createdBy: 'integration', initialRoute: { requestId: randomUUID() },
      name: '금요일 전체 배송 v2', orderIds: orders.map(({ id }) => id), planDate: '2026-09-11', shopDomain
    };
    const [created, replayed] = await Promise.all([service.createGrouping(input), service.createGrouping(input)]);
    expect(replayed.id).toBe(created.id);
    expect(created.children).toHaveLength(1);
    expect(created.children[0]?.routePlan).toMatchObject({ name: input.name, status: 'READY', stopsCount: 41 });
    expect(created.children[0]?.orderIds).toEqual(input.orderIds);
    const child = created.children[0]!;
    const saved = await service.saveDraft({
      appId, expectedUpdatedAt: created.updatedAt, groupingId: created.id, mode: 'MANUAL_ORDER', shopDomain,
      routes: [
        { branchId: null, expectedChildUpdatedAt: child.updatedAt, expectedRoutePlanUpdatedAt: child.routePlan!.updatedAt,
          label: input.name, orderIds: input.orderIds.slice(0, 18), routePlanId: child.routePlanId },
        draftRoute('Friday remaining', input.orderIds.slice(18)), draftRoute('Friday empty', [])
      ]
    });
    const reread = await service.getGrouping({ appId, groupingId: created.id, shopDomain });
    expect(reread).toEqual(saved);
    expect(reread?.children.map(({ stopsCount }) => stopsCount).sort((a, b) => a - b)).toEqual([0, 18, 23]);
    const copy = await service.copyGrouping({
      actor: 'integration', appId, expectedUpdatedAt: reread!.updatedAt,
      groupingId: created.id, mode: 'VIRTUAL', shopDomain
    });
    expect(copy?.children.map(({ stopsCount }) => stopsCount).sort((a, b) => a - b)).toEqual([0, 18, 23]);
    expect(await prisma.routeGrouping.count({ where: { id: input.initialRoute.requestId } })).toBe(1);
  }, 30_000);

  test('initial route failure rolls back the group and can be retried with the same request', async () => {
    const orders = await seedOrders(2);
    const input = { appId, createdBy: 'integration', initialRoute: { requestId: randomUUID() },
      name: 'atomic failure', orderIds: orders.map(({ id }) => id), planDate: '2026-09-10', shopDomain };
    const before = await prisma.routePlan.count({ where: { shopId } });
    const save = vi.spyOn(service, 'saveDraftInTransaction').mockRejectedValueOnce(new Error('fixture materialization failure'));
    await expect(service.createGrouping(input)).rejects.toThrow('fixture materialization failure');
    save.mockRestore();
    expect(await prisma.routeGrouping.count({ where: { id: input.initialRoute.requestId } })).toBe(0);
    expect(await prisma.routePlan.count({ where: { shopId } })).toBe(before);
    const created = await service.createGrouping(input);
    expect(created.children).toHaveLength(1);
    await expect(service.createGrouping({ ...input, name: 'changed request' })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_STALE_WRITE' });
  });

  test('Copy preserves route partitions, titles and unassigned orders while resetting execution settings', async () => {
    const orders = await seedOrders(4);
    const driverAccount = await prisma.driverAccount.create({ data: { phone: `copy-${randomUUID()}` } });
    driverAccountIds.push(driverAccount.id);
    const driver = await prisma.driver.create({ data: {
      accountId: driverAccount.id, authSubject: `copy-${randomUUID()}`, displayName: 'Copy source driver', shopId
    } });
    const grouping = await createGrouping('Copy partition source', orders.slice(0, 3).map(({ id }) => id));
    const saved = await service.saveDraft({
      appId, groupingId: grouping.id, mode: 'MANUAL_ORDER', shopDomain,
      routes: [
        { ...draftRoute('first', [orders[1]!.id, orders[0]!.id]), driverId: driver.id,
          scheduledStartAt: '2026-09-10T13:00:00.000Z', scheduledStartTimeZone: 'UTC' },
        draftRoute('second', [orders[2]!.id]), draftRoute('empty', [])
      ]
    });
    await prisma.routePlan.update({ where: { id: saved!.children[0]!.routePlanId! }, data: { name: 'Merchant title v2' } });
    const source = await service.updateGroupingOrders({
      addOrderIds: [orders[3]!.id], appId, groupingId: grouping.id, shopDomain
    });
    const sourceRoutes = await prisma.routePlan.findMany({ where: { id: { in: source!.children.map((child) => child.routePlanId!) } } });
    const copy = await service.copyGrouping({
      actor: 'integration', appId, expectedUpdatedAt: source!.updatedAt,
      groupingId: grouping.id, mode: 'VIRTUAL', shopDomain
    });
    expect(copy!.name).toBe(`${source!.name} Copy`);
    expect(copy!.children.map((child) => child.routePlan!.name)).toEqual(source!.children.map((child) => child.routePlan!.name));
    const sourceSequence = new Map(source!.assignments.map((order) => [order.orderId, order.sourceSequence]));
    const copySequence = new Map(copy!.assignments.map((order) => [order.orderId, order.sourceSequence]));
    expect(copy!.children.map((child) => child.orderIds.map((id) => copySequence.get(id))))
      .toEqual(source!.children.map((child) => child.orderIds.map((id) => sourceSequence.get(id))));
    expect(copy!.assignments).toHaveLength(4);
    expect(copy!.children.flatMap((child) => child.orderIds)).toHaveLength(3);
    expect(copy!.children.every((child) => child.driverId === null)).toBe(true);
    const copiedRoutes = await prisma.routePlan.findMany({ where: { id: { in: copy!.children.map((child) => child.routePlanId!) } } });
    expect(copiedRoutes.every((route) => route.driverId === null && route.vehicleId === null)).toBe(true);
    expect(copiedRoutes.every((route) => !JSON.stringify(route.constraints).includes('2026-09-10T13:00'))).toBe(true);
    expect(await service.getGrouping({ appId, groupingId: grouping.id, shopDomain })).toEqual(source);
    expect(await prisma.routePlan.findMany({ where: { id: { in: sourceRoutes.map((route) => route.id) } } })).toEqual(sourceRoutes);
    const reference = await service.copyGrouping({ actor: 'integration', appId, expectedUpdatedAt: source!.updatedAt,
      groupingId: source!.id, mode: 'REFERENCE', shopDomain });
    expect(reference!.children.map((child) => child.orderIds)).toEqual(source!.children.map((child) => child.orderIds));
    expect(reference!.assignments.map((assignment) => assignment.orderId))
      .toEqual(source!.assignments.map((assignment) => assignment.orderId));
    const boundSourceRoute = source!.children.find((child) => child.orderIds.length > 0)!;
    const sourceChild = await prisma.routeGroupingChildVersion.findFirstOrThrow({
      where: { groupingId: source!.id, routePlanId: boundSourceRoute.routePlanId, status: 'CURRENT' }
    });
    await expect(prisma.$transaction((tx) => rebindCurrentOrdersToRouteVersion(tx, {
      groupingId: reference!.id, nextRouteVersionId: sourceChild.id,
      orderIds: boundSourceRoute.orderIds, shopId
    }))).rejects.toMatchObject({ code: 'ROUTE_GROUPING_STALE_WRITE' });
    expect(await service.getGrouping({ appId, groupingId: grouping.id, shopDomain })).toEqual(source);
    const legacy = await createGrouping('legacy without children', [orders[3]!.id]);
    const legacyCopy = await service.copyGrouping({ actor: 'integration', appId,
      expectedUpdatedAt: legacy.updatedAt, groupingId: legacy.id, mode: 'VIRTUAL', shopDomain });
    expect(legacyCopy!.children).toHaveLength(1);
    expect(legacyCopy!.assignments).toHaveLength(1);
  });

  test('Copy failure rolls back its group, virtual orders, inventory and child routes', async () => {
    const orders = await seedOrders(2);
    const group = await createGrouping('Copy rollback source', orders.map(({ id }) => id));
    const source = await service.saveDraft({ appId, groupingId: group.id, mode: 'MANUAL_ORDER', shopDomain,
      routes: [draftRoute('Copy rollback child', orders.map(({ id }) => id))] });
    const counts = async () => Promise.all([
      prisma.routeGrouping.count({ where: { shopId } }), prisma.order.count({ where: { shopId } }),
      prisma.inventory.count({ where: { shopId } }), prisma.routePlan.count({ where: { shopId } })
    ]);
    const before = await counts();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION kfood_copy_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = 'Copy rollback child' THEN RAISE EXCEPTION 'fixture copy failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER kfood_copy_fixture_failure BEFORE INSERT ON route_plans
      FOR EACH ROW EXECUTE FUNCTION kfood_copy_fixture_failure()`);
    try {
      await expect(service.copyGrouping({ actor: 'integration', appId, expectedUpdatedAt: source!.updatedAt,
        groupingId: source!.id, mode: 'VIRTUAL', shopDomain })).rejects.toThrow('fixture copy failure');
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER kfood_copy_fixture_failure ON route_plans');
      await prisma.$executeRawUnsafe('DROP FUNCTION kfood_copy_fixture_failure()');
    }
    expect(await counts()).toEqual(before);
    expect(await service.getGrouping({ appId, groupingId: source!.id, shopDomain })).toEqual(source);
    const retry = await service.copyGrouping({ actor: 'integration', appId, expectedUpdatedAt: source!.updatedAt,
      groupingId: source!.id, mode: 'VIRTUAL', shopDomain });
    expect(retry!.children).toHaveLength(1);
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

  test.each(['REFERENCE', 'VIRTUAL'] as const)('%s Copy request replay/concurrency creates one resource, while a new attempt creates another', async (mode) => {
    const orders = await seedOrders(2);
    const source = await service.createGrouping({ appId, createdBy: 'integration', initialRoute: { requestId: randomUUID() },
      name: 'idempotent Copy source', orderIds: orders.map(({ id }) => id), planDate: '2026-09-10', shopDomain });
    await prisma.deliveryStop.update({ where: { id: orders[0]!.deliveryStopId }, data: { status: 'DELIVERED' } });
    const requestId = randomUUID();
    const input = { actor: 'integration', appId, expectedUpdatedAt: source.updatedAt, groupingId: source.id, mode, requestId, shopDomain };
    const counts = async () => Promise.all([prisma.routeGrouping.count({ where: { shopId } }), prisma.order.count({ where: { shopId } }), prisma.inventory.count({ where: { shopId } })]);
    const before = await counts();
    const [first, duplicate, concurrent] = await Promise.all([service.copyGrouping(input), service.copyGrouping(input), service.copyGrouping(input)]);
    expect(first!.id).toBe(requestId);
    expect(duplicate!.id).toBe(requestId);
    expect(concurrent!.id).toBe(requestId);
    const after = await counts();
    expect(after).toEqual([before[0] + 1, before[1] + (mode === 'VIRTUAL' ? 2 : 0), before[2] + 1]);
    expect((await service.copyGrouping({ ...input, requestId: randomUUID() }))!.id).not.toBe(requestId);
    for (const changed of [{ mode: mode === 'VIRTUAL' ? 'REFERENCE' as const : 'VIRTUAL' as const }, { actor: 'other' },
      { expectedUpdatedAt: '2000-01-01T00:00:00Z' }, { groupingId: first!.id }]) {
      await expect(service.copyGrouping({ ...input, ...changed })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_STALE_WRITE' });
    }
    const foreign = await prisma.shop.create({ data: { appId, shopDomain: `copy-foreign-${randomUUID()}.myshopify.com` } });
    try {
      await expect(service.copyGrouping({ ...input, shopDomain: foreign.shopDomain })).rejects.toMatchObject({ code: 'ROUTE_GROUPING_STALE_WRITE' });
    } finally { await prisma.shop.delete({ where: { id: foreign.id } }); }
    const sourceBefore = await service.getGrouping({ appId, groupingId: source.id, shopDomain });
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: orders[0]!.deliveryStopId } })).status).toBe('DELIVERED');
    await prisma.routeGrouping.update({ where: { id: source.id }, data: { name: 'source edited after Copy' } });
    expect((await service.copyGrouping(input))!.id).toBe(requestId);
    expect((await service.getGrouping({ appId, groupingId: source.id, shopDomain }))!.children).toEqual(sourceBefore!.children);
    const copiedStops = await prisma.deliveryStop.findMany({ where: { orderId: { in: first!.children.flatMap(({ orderIds }) => orderIds) } } });
    expect(copiedStops.some(({ status }) => status === 'DELIVERED')).toBe(true);
  });

  test.each(['REFERENCE', 'VIRTUAL'] as const)('%s Copy failure rolls back its request identity and same-key retry succeeds', async (mode) => {
    const orders = await seedOrders(2);
    const source = await service.createGrouping({ appId, createdBy: 'integration', initialRoute: { requestId: randomUUID() },
      name: 'idempotency rollback fixture', orderIds: orders.map(({ id }) => id), planDate: '2026-09-10', shopDomain });
    const input = { actor: 'integration', appId, expectedUpdatedAt: source.updatedAt, groupingId: source.id, mode, requestId: randomUUID(), shopDomain };
    const before = await prisma.order.count({ where: { shopId } });
    await prisma.$executeRawUnsafe(`CREATE FUNCTION copy_retry_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = 'idempotency rollback fixture' THEN RAISE EXCEPTION 'copy retry fixture'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER copy_retry_failure BEFORE INSERT ON route_plans FOR EACH ROW EXECUTE FUNCTION copy_retry_failure()');
    try { await expect(service.copyGrouping(input)).rejects.toThrow('copy retry fixture'); }
    finally { await prisma.$executeRawUnsafe('DROP TRIGGER copy_retry_failure ON route_plans'); await prisma.$executeRawUnsafe('DROP FUNCTION copy_retry_failure()'); }
    expect(await prisma.routeGrouping.findUnique({ where: { id: input.requestId } })).toBeNull();
    expect(await prisma.order.count({ where: { shopId } })).toBe(before);
    expect((await service.copyGrouping(input))!.id).toBe(input.requestId);
    expect(await service.getGrouping({ appId, groupingId: source.id, shopDomain })).toEqual(source);
  });

  test.each([
    ['2026-07-14', '2026-07-14T04:00:00Z', '2026-07-15T04:00:00Z'],
    ['2026-01-13', '2026-01-13T05:00:00Z', '2026-01-14T05:00:00Z'],
    ['2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
    ['2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z']
  ])('Toronto %s DB filters include start and end-minus-1ms, exclude either outside edge (%s/%s)', async (date, start, end) => {
    const marker = `date-boundary-${randomUUID()}`;
    const timestamps = [new Date(new Date(start).getTime() - 1), new Date(start), new Date(new Date(end).getTime() - 1), new Date(end)];
    const orders = await Promise.all(timestamps.map(async (processedAt, index) => {
      const order = await seedOrder({ displayOrderSequence: true, namePrefix: marker });
      await prisma.order.update({ where: { id: order.id }, data: { processedAt, rawPayload: { orderCreatedAt: processedAt.toISOString() } } });
      return { ...order, index };
    }));
    const filters = { search: marker, orderedDateFrom: date, orderedDateTo: date, orderedDateTimeZone: 'America/Toronto' };
    const result = await orderQueries.listPage({ appId, filters, shopDomain });
    expect(result.rows.map(({ orderId }) => orderId).sort()).toEqual([orders[1]!.id, orders[2]!.id].sort());
    const snapshot = await orderQueries.createSelectionSnapshot({ actor: 'integration', appId, filters, shopDomain });
    expect(snapshot.selectedCount).toBe(2);
    expect((await orderQueries.facets({ appId, filters, shopDomain })).totalCount).toBe(2);
    expect((await orderQueries.mapPoints({ appId, filters, limit: 10, shopDomain })).points.map(({ orderId }) => orderId).sort())
      .toEqual([orders[1]!.id, orders[2]!.id].sort());
  });

  test('Reference Copy saves and splits real-order plans without resetting terminal state or changing the source', async () => {
    const orders = await seedOrders(2);
    const sourceGroup = await materializedGroup('Reference terminal source', orders.map((order) => order.id));
    await prisma.deliveryStop.update({ where: { id: orders[0]!.deliveryStopId }, data: { status: 'DELIVERED' } });
    const source = await service.getGrouping({ appId, groupingId: sourceGroup.id, shopDomain });
    const sourcePlans = await prisma.routePlan.findMany({ where: { id: { in: source!.children.map((child) => child.routePlanId!) } } });
    const copy = await service.copyGrouping({ actor: 'integration', appId, expectedUpdatedAt: source!.updatedAt,
      groupingId: source!.id, mode: 'REFERENCE', shopDomain });
    expect(copy!.children).toHaveLength(1);
    const copiedRoute = copy!.children[0]!;
    const split = await service.saveDraft({ appId, groupingId: copy!.id, mode: 'MANUAL_ORDER', shopDomain,
      routes: [{ ...draftRoute('copied existing', [orders[0]!.id]), routePlanId: copiedRoute.routePlanId,
        routeKey: `route:${copiedRoute.routePlanId}` }, draftRoute('copied split', [orders[1]!.id])] });
    expect(split!.children.find((child) => child.routePlanId === copiedRoute.routePlanId)?.orderIds).toEqual([orders[0]!.id]);
    expect(split!.children.filter((child) => child.routePlanId !== copiedRoute.routePlanId).map((child) => child.orderIds)).toEqual([[orders[1]!.id]]);
    expect(await service.getGrouping({ appId, groupingId: copy!.id, shopDomain })).toEqual(split);
    expect(await service.getGrouping({ appId, groupingId: source!.id, shopDomain })).toEqual(source);
    expect(await prisma.routePlan.findMany({ where: { id: { in: sourcePlans.map((plan) => plan.id) } } })).toEqual(sourcePlans);
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: orders[0]!.deliveryStopId } })).status).toBe('DELIVERED');
  });

  test('Virtual Copy retains terminal outcomes and resets only active execution on its independent identities', async () => {
    const orders = await seedOrders(5);
    const sourceGroup = await materializedGroup('Virtual terminal source', orders.map((order) => order.id));
    const statuses = ['DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED', 'EN_ROUTE'] as const;
    for (const [index, status] of statuses.entries()) {
      await prisma.deliveryStop.update({ where: { id: orders[index]!.deliveryStopId }, data: { status } });
    }
    const source = await service.getGrouping({ appId, groupingId: sourceGroup.id, shopDomain });
    const copy = await service.copyGrouping({ actor: 'integration', appId, groupingId: sourceGroup.id,
      expectedUpdatedAt: source!.updatedAt, mode: 'VIRTUAL', shopDomain });
    const cloned = await prisma.order.findMany({ where: { ownedRouteGroupingId: copy!.id }, include: { deliveryStops: true } });
    for (const [index, status] of statuses.entries()) {
      const original = await prisma.order.findUniqueOrThrow({ where: { id: orders[index]!.id } });
      const duplicate = cloned.find((order) => order.name === original.name)!;
      expect(duplicate.id).not.toBe(orders[index]!.id);
      expect(duplicate.deliveryStops[0]!.status).toBe(status === 'EN_ROUTE' ? 'PENDING' : status);
    }
    expect(await service.getGrouping({ appId, groupingId: sourceGroup.id, shopDomain })).toEqual(source);
  });

  test('Reference planning remains available while the source is in progress; Dispatch still rejects its active orders', async () => {
    const order = await seedOrder();
    const source = await materializedGroup('Active source', [order.id]);
    const sourceRouteId = source.children[0]!.routePlanId!;
    await startRoute(sourceRouteId);
    const activeSource = await service.getGrouping({ appId, groupingId: source.id, shopDomain });
    const copy = await service.copyGrouping({ actor: 'integration', appId,
      expectedUpdatedAt: activeSource!.updatedAt, groupingId: source.id, mode: 'REFERENCE', shopDomain });
    expect(copy!.children[0]!.orderIds).toEqual([order.id]);
    const saved = await service.saveDraft({ appId, groupingId: copy!.id, mode: 'MANUAL_ORDER', shopDomain,
      routes: [{ ...draftRoute('Saved while active', [order.id]), routePlanId: copy!.children[0]!.routePlanId,
        routeKey: `route:${copy!.children[0]!.routePlanId}` }] });
    await expect(routePlans.publishRoutePlan({ appId, routePlanId: saved!.children[0]!.routePlanId!, shopDomain }))
      .rejects.toMatchObject({ code: 'ROUTE_EXECUTION_CONFLICT' });
    expect(await service.getGrouping({ appId, groupingId: source.id, shopDomain })).toEqual(activeSource);
  });

  test('concurrent overlapping Dispatch has one winner; partial conflict rejects all publication and notifications', async () => {
    const orders = await seedOrders(2);
    const first = await materializedGroup('Dispatch first', [orders[0]!.id]);
    const second = await materializedGroup('Dispatch second', orders.map((order) => order.id));
    const firstId = first.children[0]!.routePlanId!;
    const secondId = second.children[0]!.routePlanId!;
    const dispatch = async (routePlanId: string) => {
      await routePlans.publishRoutePlan({ appId, routePlanId, shopDomain });
      return service.recordChildRoutePublished({ routePlanId, shopDomain });
    };
    const results = await Promise.allSettled([dispatch(firstId), dispatch(secondId)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected === undefined) throw new Error('Expected one rejected overlapping Dispatch');
    expect(rejected.reason).toMatchObject({ code: 'ROUTE_EXECUTION_CONFLICT' });
    const winner = results[0].status === 'fulfilled' ? firstId : secondId;
    const loser = winner === firstId ? secondId : firstId;
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orders[0]!.id } });
    expect(String((rejected.reason as Error).message)).toContain(order.name);
    expect(String((rejected.reason as Error).message)).toContain(winner === firstId ? 'Dispatch first' : 'Dispatch second');
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: loser } })).constraints).not.toHaveProperty('cleverDispatchReservedAt');
    expect((await prisma.routeGroupingChildVersion.findFirstOrThrow({ where: { routePlanId: loser, status: 'CURRENT' } })).publishedAt).toBeNull();
    expect(await prisma.driverRouteNotificationAttempt.count({ where: { routePlanId: loser } })).toBe(0);
    await expect(dispatch(winner)).resolves.toBeDefined();
    await expect(startRoute(loser)).rejects.toMatchObject({ code: 'ROUTE_EXECUTION_CONFLICT' });
    await expect(startRoute(winner)).resolves.toMatchObject({ duplicate: false });
    await prisma.routePlan.update({ where: { id: winner }, data: { status: 'CANCELLED' } });
    await expect(dispatch(loser)).resolves.toBeDefined();
  }, 30_000);

  test('concurrent Start/Dispatch and overlapping Starts serialize execution while preserving route-local driver versions', async () => {
    const order = await seedOrder();
    const first = await materializedGroup('Start first', [order.id]);
    const second = await materializedGroup('Start second', [order.id]);
    const firstId = first.children[0]!.routePlanId!;
    const secondId = second.children[0]!.routePlanId!;
    const driverReads = new PrismaDriverAssignedRouteRepository(prisma);
    for (const routePlanId of [firstId, secondId]) {
      const plan = await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } });
      const child = await prisma.routeGroupingChildVersion.findFirstOrThrow({ where: { routePlanId, status: 'CURRENT' } });
      expect(await driverReads.getAssignedRoute({ driverId: plan.driverId!, routeContext: routePlanId, shopDomain, shopId }))
        .toMatchObject({ status: 'ASSIGNED_ROUTE', route: { id: routePlanId, routeVersionId: child.id } });
    }
    const race = await Promise.allSettled([
      startRoute(firstId), routePlans.publishRoutePlan({ appId, routePlanId: secondId, shopDomain })
    ]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((race.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ code: 'ROUTE_EXECUTION_CONFLICT' });
    await prisma.routePlan.updateMany({ where: { id: { in: [firstId, secondId] } }, data: { status: 'COMPLETED' } });
    const third = await materializedGroup('Start third', [order.id]);
    const fourth = await materializedGroup('Start fourth', [order.id]);
    const starts = await Promise.allSettled([startRoute(third.children[0]!.routePlanId!), startRoute(fourth.children[0]!.routePlanId!)]);
    expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((starts.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ code: 'ROUTE_EXECUTION_CONFLICT' });
  }, 30_000);

  test('legacy started events reserve execution until completion', async () => {
    const order = await seedOrder();
    const source = await materializedGroup('Legacy started route', [order.id]);
    const target = await materializedGroup('Legacy overlapping plan', [order.id]);
    const sourceId = source.children[0]!.routePlanId!;
    const targetId = target.children[0]!.routePlanId!;
    await prisma.driverEvent.create({ data: {
      eventType: 'ROUTE_STARTED', occurredAt: new Date('2026-09-10T12:00:00.000Z'),
      payload: { source: 'legacy execution fixture' }, routePlanId: sourceId, shopId
    } });
    await expect(routePlans.publishRoutePlan({ appId, routePlanId: targetId, shopDomain }))
      .rejects.toMatchObject({ code: 'ROUTE_EXECUTION_CONFLICT' });
    await expect(startRoute(targetId)).rejects.toMatchObject({ code: 'ROUTE_EXECUTION_CONFLICT' });
    await prisma.driverEvent.create({ data: {
      eventType: 'ROUTE_COMPLETED', occurredAt: new Date('2026-09-10T13:00:00.000Z'),
      payload: { source: 'legacy execution fixture' }, routePlanId: sourceId, shopId
    } });
    await expect(routePlans.publishRoutePlan({ appId, routePlanId: targetId, shopDomain })).resolves.toBeDefined();
  });

  test('adding a reserved order to an already dispatched route rejects the whole Save without changing either plan', async () => {
    const orders = await seedOrders(2);
    const source = await materializedGroup('Save reservation owner', [orders[0]!.id]);
    const group = await createGrouping('Save reservation target', orders.map((order) => order.id));
    const target = (await service.saveDraft({ appId, groupingId: group.id, mode: 'MANUAL_ORDER', shopDomain,
      routes: [draftRoute('Save reservation target', [orders[1]!.id])] }))!;
    const sourceId = source.children[0]!.routePlanId!;
    const targetId = target.children[0]!.routePlanId!;
    await routePlans.publishRoutePlan({ appId, routePlanId: sourceId, shopDomain });
    await routePlans.publishRoutePlan({ appId, routePlanId: targetId, shopDomain });
    const sourceBefore = await service.getGrouping({ appId, groupingId: source.id, shopDomain });
    const targetBefore = await service.getGrouping({ appId, groupingId: group.id, shopDomain });
    const pointerBefore = await prisma.order.findUniqueOrThrow({ where: { id: orders[0]!.id } });
    await expect(service.saveDraft({ appId, groupingId: group.id, mode: 'MANUAL_ORDER', shopDomain,
      routes: [{ ...draftRoute('Save reservation target', orders.map((order) => order.id)),
        routeKey: `routePlan:${targetId}`, routePlanId: targetId }] }))
      .rejects.toMatchObject({ code: 'ROUTE_EXECUTION_CONFLICT' });
    expect(await service.getGrouping({ appId, groupingId: source.id, shopDomain })).toEqual(sourceBefore);
    expect(await service.getGrouping({ appId, groupingId: group.id, shopDomain })).toEqual(targetBefore);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orders[0]!.id } })).currentRouteVersionId)
      .toBe(pointerBefore.currentRouteVersionId);
  });

  async function materializedGroup(name: string, orderIds: string[]) {
    const account = await prisma.driverAccount.create({ data: { phone: `execution-${randomUUID()}` } });
    driverAccountIds.push(account.id);
    const driver = await prisma.driver.create({ data: {
      accountId: account.id, authSubject: `execution-${randomUUID()}`, displayName: 'Fixture driver', shopId
    } });
    const group = await createGrouping(name, orderIds);
    return (await service.saveDraft({ appId, groupingId: group.id, mode: 'MANUAL_ORDER', shopDomain,
      routes: [{ ...draftRoute(name, orderIds), driverId: driver.id }] }))!;
  }

  async function startRoute(routePlanId: string) {
    const plan = await prisma.routePlan.findUniqueOrThrow({ where: { id: routePlanId } });
    const child = await prisma.routeGroupingChildVersion.findFirstOrThrow({ where: { routePlanId, status: 'CURRENT', supersededAt: null } });
    return new PrismaDriverEventRepository(prisma).recordDriverEvent({
      assignmentGeneration: plan.assignmentGeneration.toString(), attemptId: null,
      clientEventId: randomUUID(), deliveryStopId: null, driverContractVersion: 2,
      driverId: plan.driverId!, eventType: 'ROUTE_STARTED', expectedRouteVersionId: child.id,
      latitude: null, longitude: null, occurredAt: new Date('2026-09-10T12:15:00.000Z'),
      payload: { source: 'isolated execution policy fixture' }, routePlanId, shopDomain, shopId
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
