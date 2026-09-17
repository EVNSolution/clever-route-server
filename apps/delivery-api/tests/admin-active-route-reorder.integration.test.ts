import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, test } from 'vitest';

import { PrismaDriverAssignedRouteRepository } from '../src/modules/driver/driver-assigned-route.repository.js';
import { FakeDriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';
import { PrismaRouteGroupingService } from '../src/modules/route-grouping/route-grouping.service.js';
import { PrismaRoutePlanRepository } from '../src/modules/route-plans/route-plan.repository.js';

// Use the disposable local database bootstrap documented in route-grouping-save.integration.test.ts.
const databaseUrl = process.env.ROUTE_GROUPING_SAVE_DATABASE_URL;
const enabled = process.env.ROUTE_GROUPING_SAVE_DATABASE_TARGET_CLASS === 'safe-local-route-grouping-save-disposable';
if (enabled && databaseUrl !== undefined) {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Active route reorder integration requires a disposable loopback PostgreSQL database');
  }
}
const describeDatabase = enabled && databaseUrl !== undefined ? describe : describe.skip;

describeDatabase('admin active route reorder and redispatch', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled' });
  const shopIds: string[] = [];
  const accountIds: string[] = [];

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
    await prisma.driverAccount.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  test.each(['saveRoutePlan', 'updateRoutePlanStops'] as const)('%s preserves live history and dispatches the new order to driver reads', async (method) => {
    const fixture = await seedRoute();
    const { route, shop, driver, stops, events } = fixture;
    const repository = new PrismaRoutePlanRepository(prisma);
    const provider = new FakeDriverPushProvider();
    const publications = new PrismaRouteGroupingService(prisma, provider);
    const scope = { routePlanId: route.id, shopDomain: shop.shopDomain };
    await repository.publishRoutePlan(scope);
    await publications.recordChildRoutePublished(scope);
    expect(provider.sentMessages).toHaveLength(1);

    const before = await prisma.routePlanStop.findMany({ where: { routePlanId: route.id }, orderBy: { sequence: 'asc' } });
    const order = [stops[0]!, stops[2]!, stops[1]!];
    const payload = {
      expectedUpdatedAt: route.updatedAt.toISOString(),
      stops: order.map((stop, index) => ({
        deliveryStopId: stop.id, shopifyOrderGid: stop.order.shopifyOrderGid, sequence: index + 1
      }))
    };
    await repository[method]({ ...scope, payload });

    const after = await prisma.routePlanStop.findMany({ where: { routePlanId: route.id }, orderBy: { sequence: 'asc' } });
    expect(after.map((stop) => stop.deliveryStopId)).toEqual(order.map((stop) => stop.id));
    expect(after.map((stop) => stop.id)).toEqual([before[0]!.id, before[2]!.id, before[1]!.id]);
    expect(after[0]!.estimatedArrivalAt).toEqual(before[0]!.estimatedArrivalAt);
    expect(after.slice(1).map((stop) => [stop.estimatedArrivalAt, stop.etaStatus])).toEqual([[null, 'PENDING'], [null, 'PENDING']]);
    await expect(prisma.routePlan.findUniqueOrThrow({ where: { id: route.id } })).resolves.toMatchObject({
      status: 'IN_PROGRESS', driverId: driver.id, assignmentGeneration: route.assignmentGeneration
    });
    await expect(prisma.driverEvent.findMany({ where: { routePlanId: route.id }, orderBy: { occurredAt: 'asc' } })).resolves.toEqual(events);

    await repository.publishRoutePlan(scope);
    await publications.recordChildRoutePublished(scope);
    expect(provider.sentMessages).toHaveLength(2);
    expect(provider.sentMessages[1]).toMatchObject({ action: 'changed', routePlanId: route.id });
    expect(provider.sentMessages[1]!.publicationVersion).not.toBe(provider.sentMessages[0]!.publicationVersion);
    const assigned = await new PrismaDriverAssignedRouteRepository(prisma).getAssignedRoute({
      driverId: driver.id, routeContext: route.id, shopDomain: shop.shopDomain, shopId: shop.id
    });
    expect(assigned.status).toBe('ASSIGNED_ROUTE');
    if (assigned.status !== 'ASSIGNED_ROUTE') throw new Error('Expected the active driver route');
    expect(assigned.route.stops.map((stop) => [stop.deliveryStopId, stop.status])).toEqual([
      [stops[0]!.id, 'DELIVERED'], [stops[2]!.id, 'PENDING'], [stops[1]!.id, 'ARRIVED']
    ]);

    // Retrying a stale edit or changing membership cannot disturb the saved order.
    await expect(repository.saveRoutePlan({
      ...scope, payload: { ...payload, stops: [...payload.stops].reverse().map((stop, index) => ({ ...stop, sequence: index + 1 })) }
    })).rejects.toMatchObject({ code: 'ROUTE_PLAN_CONFLICT' });
    await expect(repository[method]({ ...scope, payload: { stops: payload.stops.slice(1) } }))
      .rejects.toMatchObject({ code: 'ROUTE_STOP_UPDATE_INVALID' });
    await expect(repository[method]({ ...scope, payload: {
      stops: payload.stops.map((stop, index) => index === 0 ? { ...stop, deliveryStopId: randomUUID() } : stop)
    } })).rejects.toMatchObject({ code: 'ROUTE_STOP_UPDATE_INVALID' });
    await expect(repository.saveRoutePlan({ ...scope, payload: {
      driverId: randomUUID(),
      stops: [...payload.stops].reverse().map((stop, index) => ({ ...stop, sequence: index + 1 }))
    } })).rejects.toMatchObject({ code: 'ROUTE_STOP_UPDATE_INVALID' });
    await expect(prisma.routePlanStop.findMany({ where: { routePlanId: route.id }, orderBy: { sequence: 'asc' } })).resolves.toEqual(after);

    await prisma.routePlan.update({ data: { status: 'READY' }, where: { id: route.id } });
    await prisma.driverEvent.create({ data: {
      driverId: driver.id, eventType: 'ROUTE_PAUSED', occurredAt: new Date('2030-09-17T13:00:00Z'),
      payload: {}, routePlanId: route.id, shopId: shop.id
    } });
    await expect(repository.findRoutePlanDetail(scope)).resolves.toMatchObject({ routePlan: { status: 'READY' } });
  });

  async function seedRoute() {
    const suffix = randomUUID();
    const shop = await prisma.shop.create({ data: { shopDomain: `active-reorder-${suffix}.myshopify.com` } });
    shopIds.push(shop.id);
    const account = await prisma.driverAccount.create({ data: { phone: `integration-${suffix}` } });
    accountIds.push(account.id);
    const driver = await prisma.driver.create({ data: { accountId: account.id, displayName: 'Integration driver', shopId: shop.id } });
    await prisma.driverPushToken.create({ data: {
      accountId: account.id, appId: 'clever', devicePushToken: `fake-${suffix}`, platform: 'android', tokenHash: suffix
    } });
    const route = await prisma.routePlan.create({ data: {
      constraints: {}, driverId: driver.id, metrics: {}, name: 'Active route reorder', optimizerVersion: 'integration',
      planDate: new Date('2030-09-17T00:00:00Z'), shopId: shop.id, status: 'IN_PROGRESS'
    } });
    const stops = [];
    for (const [index, status] of (['DELIVERED', 'ARRIVED', 'PENDING'] as const).entries()) {
      const order = await prisma.order.create({ data: {
        name: `#${index + 1}`, rawPayload: {}, shopId: shop.id, shopifyOrderGid: `gid://shopify/Order/${suffix}-${index}`
      } });
      const stop = await prisma.deliveryStop.create({ data: { orderId: order.id, shopId: shop.id, status } });
      stops.push({ ...stop, order });
      await prisma.routePlanStop.create({ data: {
        deliveryStopId: stop.id, estimatedArrivalAt: new Date('2030-09-17T12:00:00Z'), etaSource: 'ROUTE_STARTED',
        etaStatus: 'READY', routePlanId: route.id, sequence: index + 1, shopId: shop.id
      } });
    }
    const events = [];
    for (const [index, eventType] of (['ROUTE_STARTED', 'STOP_DELIVERED', 'STOP_ARRIVED'] as const).entries()) {
      events.push(await prisma.driverEvent.create({ data: {
        deliveryStopId: index === 0 ? null : stops[index - 1]!.id, driverId: driver.id, eventType,
        occurredAt: new Date(`2030-09-17T12:0${index}:00Z`), payload: {}, routePlanId: route.id, shopId: shop.id
      } }));
    }
    return { driver, events, route, shop, stops };
  }
});
