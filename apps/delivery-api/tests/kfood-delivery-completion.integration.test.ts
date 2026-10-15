import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, test } from 'vitest';
import { PrismaDriverEventRepository } from '../src/modules/driver/driver-event.repository.js';
import { PrismaDriverEventReceiptRepository } from '../src/modules/driver/driver-event-receipt.repository.js';
import { PrismaDriverRouteAccessRepository } from '../src/modules/driver/driver-route-access.repository.js';
import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';
import { PrismaRoutePlanRepository } from '../src/modules/route-plans/route-plan.repository.js';
import { PrismaStaleRouteFinalizationService } from '../src/modules/route-plans/stale-route-finalization.service.js';
import { replaceCurrentRouteGroupingChildVersion } from '../src/modules/route-grouping/route-grouping.service.js';
import { PrismaOrderSyncRepository } from '../src/modules/shopify/order-sync.repository.js';
import { KFOOD_DELIVERY_APP_ID, KFOOD_DELIVERY_SHOP_DOMAIN, reconcileKfoodDeliveryWorkCompletion } from '../src/modules/route-plans/kfood-delivery-completion.js';

const url = process.env.KFOOD_COMPLETION_DATABASE_URL;
const enabled = process.env.KFOOD_COMPLETION_DATABASE_TARGET_CLASS === 'safe-local-kfood-completion-disposable';
if (enabled && url !== undefined) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || !parsed.pathname.endsWith('_disposable')) throw new Error('K-food completion tests require a named loopback disposable database');
}

(enabled && url !== undefined ? describe : describe.skip)('K-food delivery completion PostgreSQL contract', () => {
  const prisma = new PrismaClient({ datasourceUrl: url ?? 'postgresql://disabled@127.0.0.1:1/disabled' });
  afterAll(async () => { await prisma.$disconnect(); });

  test('last delivery commits admin Complete and allows unchanged mobile access for exactly two hours', async () => {
    const f = await fixture();
    let now = new Date();
    const repository = new PrismaDriverEventRepository(prisma, { now: () => now });
    const event = {
      driverId: f.driver.id, routePlanId: f.route.id, shopId: f.shop.id, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN,
      clientEventId: randomUUID(), deliveryStopId: f.stops[1]!.id, eventType: 'STOP_DELIVERED',
      driverContractVersion: 2, expectedRouteVersionId: f.version.id, assignmentGeneration: '2',
      occurredAt: now, latitude: null, longitude: null, payload: { source: 'driver-app' }
    };
    const receipts = await Promise.all([repository.recordDriverEvent(event), repository.recordDriverEvent(event)]);
    expect(receipts.map(receipt => receipt.duplicate).sort()).toEqual([false, true]);
    expect(new Set(receipts.map(receipt => receipt.eventId)).size).toBe(1);
    const recorded = await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } });
    expect(recorded.status).toBe('IN_PROGRESS');
    expect(recorded.deliveryWorkCompletedAt).not.toBeNull();
    expect(recorded.driverNavigationUntil!.getTime() - recorded.deliveryWorkCompletedAt!.getTime()).toBe(7_200_000);
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'ROUTE_COMPLETED' } })).toBe(0);
    const admin = new PrismaRoutePlanRepository(prisma);
    const summaries = await admin.listRoutePlans({ appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN });
    expect(summaries.find(r => r.id === f.route.id)?.status).toBe('COMPLETED');

    const access = new PrismaDriverRouteAccessRepository(prisma, undefined, () => now);
    const tokens = new PrismaDriverTokenAccessRepository(prisma, () => now);
    const identity = { accountId: f.account.id, routePlanId: f.route.id, tokenVersion: f.account.tokenVersion };
    now = new Date(recorded.driverNavigationUntil!.getTime() - 1);
    expect(await tokens.resolveDriverRouteAccess(identity)).not.toBeNull();
    expect((await access.lookupRouteAccess({ accountId: f.account.id, routeContext: f.route.id })).status).toBe('INVITED');

    // A queued replay preserves the original deadline even when received later.
    await expect(repository.recordDriverEvent(event)).resolves.toMatchObject({ duplicate: true });
    const replayed = await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } });
    expect(replayed.driverNavigationUntil).toEqual(recorded.driverNavigationUntil);
    const completionCommand = { ...event, clientEventId: randomUUID(), eventType: 'ROUTE_COMPLETED', deliveryStopId: null };
    const completionAck = await repository.recordDriverEvent(completionCommand);
    expect(completionAck.duplicate).toBe(false);
    expect(await prisma.driverEvent.findUnique({ where: { id: completionAck.eventId } })).toMatchObject({
      eventType: 'NOTE_ADDED', payload: { schema: 'kfood_return_navigation_completion_ack_v1' }
    });
    await expect(repository.recordDriverEvent(completionCommand)).resolves.toMatchObject({ duplicate: true, eventId: completionAck.eventId });
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).status).toBe('IN_PROGRESS');
    expect(await tokens.resolveDriverRouteAccess(identity)).not.toBeNull();
    await expect(repository.recordDriverEvent({ ...event, clientEventId: randomUUID(), eventType: 'STOP_ARRIVED' }))
      .rejects.toThrow('only return navigation');

    now = recorded.driverNavigationUntil!;
    await expect(repository.recordDriverEvent(event)).resolves.toMatchObject({ duplicate: true });
    expect(await tokens.resolveDriverRouteAccess(identity)).toBeNull();
    expect(await tokens.resolveDriverRouteAccess(identity, { allowCompleted: true })).toBeNull();
    expect(await access.lookupRouteAccess({ accountId: f.account.id, routeContext: f.route.id })).toEqual({ status: 'NOT_FOUND' });
    expect(await access.lookupRouteAccess({ accountId: f.account.id, routeContext: null })).toEqual({ status: 'ROUTES_FOUND', routes: [] });
    await new PrismaStaleRouteFinalizationService(prisma).processDue(now);
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).status).toBe('COMPLETED');
    expect(await tokens.resolveDriverRouteAccess(identity, { allowCompleted: true })).toBeNull();
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'ROUTE_COMPLETED' } })).toBe(0);
  });

  test('releases completed delivery work once, preserves evidence, and cannot restart it', async () => {
    const { f, repository, event, deliveryReceipt, completedRoute } = await completedFixture();
    const evidence = await prisma.driverEvent.findUniqueOrThrow({ where: { id: deliveryReceipt.eventId } });
    const release = { ...event, clientEventId: randomUUID(), eventType: 'ROUTE_PAUSED', deliveryStopId: null };
    const receipts = await Promise.all([repository.recordDriverEvent(release), repository.recordDriverEvent(release)]);
    expect(receipts.map(receipt => receipt.duplicate).sort()).toEqual([false, true]);
    expect(new Set(receipts.map(receipt => receipt.eventId)).size).toBe(1);
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'ROUTE_PAUSED' } })).toBe(1);
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).toMatchObject({
      status: 'READY', driverId: f.driver.id, assignmentGeneration: completedRoute.assignmentGeneration,
      deliveryWorkCompletedAt: completedRoute.deliveryWorkCompletedAt,
      deliveryWorkCompletedGeneration: completedRoute.deliveryWorkCompletedGeneration,
      deliveryWorkCompletedVersionId: completedRoute.deliveryWorkCompletedVersionId,
      driverNavigationUntil: completedRoute.driverNavigationUntil
    });
    expect(await prisma.driverEvent.findUniqueOrThrow({ where: { id: deliveryReceipt.eventId } })).toEqual(evidence);
    expect(await prisma.deliveryStop.count({ where: { id: { in: f.stops.map(stop => stop.id) }, status: 'DELIVERED' } })).toBe(2);
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'ROUTE_COMPLETED' } })).toBe(0);
    const admin = new PrismaRoutePlanRepository(prisma);
    const summaries = await admin.listRoutePlans({ appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN });
    expect(summaries.find(route => route.id === f.route.id)?.status).toBe('COMPLETED');
    const identity = { accountId: f.account.id, routePlanId: f.route.id, tokenVersion: f.account.tokenVersion };
    const receiptRepository = new PrismaDriverEventReceiptRepository(prisma);
    for (const now of [new Date(), completedRoute.driverNavigationUntil!]) {
      const tokens = new PrismaDriverTokenAccessRepository(prisma, () => now);
      expect(await tokens.resolveDriverRouteAccess(identity)).toBeNull();
      expect(await tokens.resolveDriverRouteAccess(identity, { allowCompleted: true })).toBeNull();
      const access = new PrismaDriverRouteAccessRepository(prisma, undefined, () => now);
      expect(await access.lookupRouteAccess({ accountId: f.account.id, routeContext: f.route.id })).toEqual({ status: 'NOT_FOUND' });
      expect(await access.lookupRouteAccess({ accountId: f.account.id, routeContext: null })).toEqual({ status: 'ROUTES_FOUND', routes: [] });
      expect(await receiptRepository.lookup({ accountId: f.account.id, routePlanId: f.route.id, clientEventId: release.clientEventId }))
        .toMatchObject({ status: 'APPLIED', routeStatus: 'READY', assignmentGeneration: '2', expectedRouteVersionId: f.version.id });
    }
    await expect(receiptRepository.lookup({ accountId: randomUUID(), routePlanId: f.route.id, clientEventId: release.clientEventId }))
      .rejects.toThrow('outside the authenticated account scope');
    await expect(repository.recordDriverEvent({ ...release, clientEventId: randomUUID(), eventType: 'ROUTE_STARTED' }))
      .rejects.toThrow('Completed delivery work cannot be restarted');
    await expect(repository.recordDriverEvent({ ...release, clientEventId: randomUUID() }))
      .rejects.toThrow('Return navigation access has expired');

    const afterGrace = new PrismaDriverEventRepository(prisma, { now: () => completedRoute.driverNavigationUntil! });
    await expect(afterGrace.recordDriverEvent(release)).resolves.toMatchObject({ duplicate: true, eventId: receipts[0].eventId });
  });

  test('keeps an ordinary ready route accessible after release before delivery work completes', async () => {
    const f = await fixture();
    const repository = new PrismaDriverEventRepository(prisma);
    await repository.recordDriverEvent({
      driverId: f.driver.id, routePlanId: f.route.id, shopId: f.shop.id, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN,
      clientEventId: randomUUID(), deliveryStopId: null, eventType: 'ROUTE_PAUSED',
      driverContractVersion: 2, expectedRouteVersionId: f.version.id, assignmentGeneration: '2',
      occurredAt: new Date(), latitude: null, longitude: null, payload: { source: 'driver-app' }
    });
    const tokens = new PrismaDriverTokenAccessRepository(prisma);
    expect(await tokens.resolveDriverRouteAccess({ accountId: f.account.id, routePlanId: f.route.id, tokenVersion: f.account.tokenVersion })).not.toBeNull();
    const access = new PrismaDriverRouteAccessRepository(prisma);
    expect((await access.lookupRouteAccess({ accountId: f.account.id, routeContext: f.route.id })).status).toBe('INVITED');
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).toMatchObject({
      status: 'READY', deliveryWorkCompletedAt: null, driverNavigationUntil: null
    });
  });

  test.each([47, 48])('ends active access exactly once after explicit completion from version %s', async (versionCode) => {
    const { f, repository, event, completedRoute, deliveryReceipt } = await completedFixture();
    const deliveryEvidence = await prisma.driverEvent.findUniqueOrThrow({ where: { id: deliveryReceipt.eventId } });
    const completion = { ...event, clientEventId: randomUUID(), eventType: 'ROUTE_COMPLETED', deliveryStopId: null, versionCode };
    const receipts = await Promise.all([repository.recordDriverEvent(completion), repository.recordDriverEvent(completion)]);
    expect(receipts.map(receipt => receipt.duplicate).sort()).toEqual([false, true]);
    expect(new Set(receipts.map(receipt => receipt.eventId)).size).toBe(1);
    expect(await prisma.driverEvent.findUniqueOrThrow({ where: { id: receipts[0].eventId } })).toMatchObject({ eventType: 'ROUTE_COMPLETED' });
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'ROUTE_COMPLETED' } })).toBe(1);
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).toMatchObject({
      status: 'COMPLETED', assignmentGeneration: completedRoute.assignmentGeneration,
      deliveryWorkCompletedAt: completedRoute.deliveryWorkCompletedAt,
      deliveryWorkCompletedGeneration: completedRoute.deliveryWorkCompletedGeneration,
      deliveryWorkCompletedVersionId: completedRoute.deliveryWorkCompletedVersionId,
      driverNavigationUntil: completedRoute.driverNavigationUntil
    });
    expect(await prisma.driverEvent.findUniqueOrThrow({ where: { id: deliveryReceipt.eventId } })).toEqual(deliveryEvidence);
    expect(await prisma.deliveryStop.count({ where: { id: { in: f.stops.map(stop => stop.id) }, status: 'DELIVERED' } })).toBe(2);
    const tokens = new PrismaDriverTokenAccessRepository(prisma);
    expect(await tokens.resolveDriverRouteAccess({ accountId: f.account.id, routePlanId: f.route.id, tokenVersion: f.account.tokenVersion })).toBeNull();
    const access = new PrismaDriverRouteAccessRepository(prisma);
    expect(await access.lookupRouteAccess({ accountId: f.account.id, routeContext: f.route.id })).toEqual({ status: 'NOT_FOUND' });
    expect(await access.lookupRouteAccess({ accountId: f.account.id, routeContext: null })).toEqual({ status: 'ROUTES_FOUND', routes: [] });
    await expect(repository.recordDriverEvent(completion)).resolves.toMatchObject({ duplicate: true, eventId: receipts[0].eventId });
  });

  test.each([46, undefined])('keeps version %s completion acknowledgements and their upgraded replay unchanged', async (versionCode) => {
    const { f, repository, event, completedRoute } = await completedFixture();
    const completion = {
      ...event, clientEventId: randomUUID(), eventType: 'ROUTE_COMPLETED', deliveryStopId: null,
      ...(versionCode === undefined ? {} : { versionCode })
    };
    const receipt = await repository.recordDriverEvent(completion);
    const acknowledgement = await prisma.driverEvent.findUniqueOrThrow({ where: { id: receipt.eventId } });
    expect(acknowledgement).toMatchObject({ eventType: 'NOTE_ADDED', payload: { schema: 'kfood_return_navigation_completion_ack_v1' } });
    await expect(repository.recordDriverEvent({ ...completion, versionCode: 47 }))
      .resolves.toMatchObject({ duplicate: true, eventId: receipt.eventId });
    expect(await prisma.driverEvent.findUniqueOrThrow({ where: { id: receipt.eventId } })).toEqual(acknowledgement);
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'ROUTE_COMPLETED' } })).toBe(0);
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).toMatchObject({
      status: 'IN_PROGRESS', deliveryWorkCompletedAt: completedRoute.deliveryWorkCompletedAt,
      driverNavigationUntil: completedRoute.driverNavigationUntil
    });
    const tokens = new PrismaDriverTokenAccessRepository(prisma);
    expect(await tokens.resolveDriverRouteAccess({ accountId: f.account.id, routePlanId: f.route.id, tokenVersion: f.account.tokenVersion })).not.toBeNull();
  });

  test.each(['other_driver', 'expired_grace', 'already_completed'] as const)(
    'does not release completed delivery work with %s', async (condition) => {
      const { f, event, completedRoute } = await completedFixture();
      if (condition === 'already_completed') {
        await prisma.routePlan.update({ where: { id: f.route.id }, data: { status: 'COMPLETED' } });
      }
      const now = condition === 'expired_grace' ? completedRoute.driverNavigationUntil! : new Date();
      const repository = new PrismaDriverEventRepository(prisma, { now: () => now });
      const otherDriver = condition === 'other_driver' ? await prisma.driver.create({
        data: { displayName: 'Other release test driver', shopId: f.shop.id }
      }) : null;
      const release = {
        ...event, clientEventId: randomUUID(), eventType: 'ROUTE_PAUSED', deliveryStopId: null,
        driverId: otherDriver?.id ?? f.driver.id
      };
      if (condition === 'other_driver') {
        await expect(repository.recordDriverEvent(release)).rejects.toMatchObject({ code: 'ROUTE_ASSIGNMENT_CHANGED' });
      } else {
        await expect(repository.recordDriverEvent(release)).rejects.toThrow(
          condition === 'expired_grace' ? 'Return navigation access has expired' : 'outside the authenticated driver scope'
        );
      }
      expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'ROUTE_PAUSED' } })).toBe(0);
      expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).toMatchObject({
        status: condition === 'already_completed' ? 'COMPLETED' : 'IN_PROGRESS',
        deliveryWorkCompletedAt: completedRoute.deliveryWorkCompletedAt,
        driverNavigationUntil: completedRoute.driverNavigationUntil
      });
    }
  );

  test('ARRIVED remains unresolved and a corrected stop clears an existing completion marker', async () => {
    const f = await fixture();
    const reconcile = async () => prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${f.route.id}::uuid FOR UPDATE`;
      return reconcileKfoodDeliveryWorkCompletion(tx, { routePlanId: f.route.id, shopId: f.shop.id, now: new Date() });
    });
    expect(await reconcile()).toBeNull();
    const admin = new PrismaRoutePlanRepository(prisma);
    const transition = (status: 'COMPLETED' | 'READY') => admin.transitionAdminRouteStop({
      appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN,
      actor: 'navigation-grace-test', routePlanId: f.route.id, deliveryStopId: f.stops[1]!.id,
      payload: { status, idempotencyKey: randomUUID() }
    });
    await transition('COMPLETED');
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).deliveryWorkCompletedAt).not.toBeNull();
    await transition('READY');
    const reopened = await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } });
    expect(reopened.status).toBe('IN_PROGRESS');
    expect(reopened.deliveryWorkCompletedAt).toBeNull();
    expect(reopened.driverNavigationUntil).toBeNull();
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: f.stops[1]!.id } })).status).toBe('PENDING');
  });

  test('Shopify bulk completion and correction reconcile the current route', async () => {
    const f = await fixture();
    const orders = new PrismaOrderSyncRepository(prisma);
    const patch = (value: 'DELIVERED' | 'ARRIVED') => orders.bulkPatchCanonicalOrderStatus({
      actor: 'navigation-grace-test', appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN,
      field: 'state', orderIds: [f.stops[1]!.orderId], value
    });
    await patch('DELIVERED');
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).deliveryWorkCompletedAt).not.toBeNull();
    await patch('ARRIVED');
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).toMatchObject({
      status: 'IN_PROGRESS', deliveryWorkCompletedAt: null, driverNavigationUntil: null
    });
  });

  test('same-driver child replacement invalidates completion without changing assignment generation', async () => {
    const f = await fixture();
    await new PrismaOrderSyncRepository(prisma).bulkPatchCanonicalOrderStatus({
      actor: 'navigation-grace-test', appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN,
      field: 'state', orderIds: [f.stops[1]!.orderId], value: 'DELIVERED'
    });
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).deliveryWorkCompletedAt).not.toBeNull();
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${f.route.id}::uuid FOR UPDATE`;
      await replaceCurrentRouteGroupingChildVersion(tx, {
        currentChildId: f.version.id, driverId: f.driver.id, groupingId: f.group.id,
        groupingVersionId: f.parent.id, notificationStatus: 'SKIPPED',
        orderIds: f.stops.map(stop => stop.orderId), publishedAt: new Date(), routePlanId: f.route.id,
        shopId: f.shop.id, snapshot: { membershipSchemaVersion: 1, stops: f.members }, version: 2
      });
    });
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).toMatchObject({
      status: 'IN_PROGRESS', assignmentGeneration: 2n, deliveryWorkCompletedAt: null,
      driverNavigationUntil: null, deliveryWorkCompletedVersionId: null
    });
    const admin = await new PrismaRoutePlanRepository(prisma).listRoutePlans({
      appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN
    });
    expect(admin.find(route => route.id === f.route.id)?.status).toBe('IN_PROGRESS');
  });

  async function completedFixture() {
    const f = await fixture();
    const repository = new PrismaDriverEventRepository(prisma);
    const event = {
      driverId: f.driver.id, routePlanId: f.route.id, shopId: f.shop.id, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN,
      clientEventId: randomUUID(), deliveryStopId: f.stops[1]!.id, eventType: 'STOP_DELIVERED',
      driverContractVersion: 2, expectedRouteVersionId: f.version.id, assignmentGeneration: '2',
      occurredAt: new Date(), latitude: null, longitude: null, payload: { source: 'driver-app' }
    };
    const deliveryReceipt = await repository.recordDriverEvent(event);
    const completedRoute = await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } });
    expect(completedRoute.deliveryWorkCompletedAt).not.toBeNull();
    return { f, repository, event, deliveryReceipt, completedRoute };
  }

  async function fixture() {
    const suffix = randomUUID();
    const shop = await prisma.shop.upsert({
      where: { appId_shopDomain: { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN } },
      create: { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN }, update: {}
    });
    const account = await prisma.driverAccount.create({ data: { phone: `grace-${suffix}` } });
    const driver = await prisma.driver.create({ data: { accountId: account.id, authSubject: `grace-${suffix}`, displayName: 'Navigation grace test', shopId: shop.id } });
    const route = await prisma.routePlan.create({ data: { shopId: shop.id, driverId: driver.id, name: `grace-${suffix}`,
      planDate: new Date(), constraints: { timezone: 'America/Toronto' }, metrics: {}, optimizerVersion: 'test', status: 'IN_PROGRESS', assignmentGeneration: 2n } });
    const group = await prisma.routeGrouping.create({ data: { shopId: shop.id, name: `grace-${suffix}`, planDate: new Date() } });
    const parent = await prisma.routeGroupingVersion.create({ data: { shopId: shop.id, groupingId: group.id, version: 1 } });
    const version = await prisma.routeGroupingChildVersion.create({ data: { shopId: shop.id, groupingId: group.id,
      groupingVersionId: parent.id, routePlanId: route.id, driverId: driver.id, version: 1, snapshot: {}, publishedAt: new Date() } });
    const stops = [];
    const members = [];
    for (let index = 0; index < 2; index += 1) {
      const order = await prisma.order.create({ data: { shopId: shop.id, name: `#test-${index}`, rawPayload: {},
        shopifyOrderGid: `gid://shopify/Order/${suffix}-${index}`, currentRouteVersionId: version.id } });
      const stop = await prisma.deliveryStop.create({ data: { shopId: shop.id, orderId: order.id, status: index === 0 ? 'DELIVERED' : 'ARRIVED' } });
      await prisma.routePlanStop.create({ data: { shopId: shop.id, routePlanId: route.id, deliveryStopId: stop.id, sequence: index + 1 } });
      stops.push(stop);
      members.push({ sequence: index + 1, deliveryStopId: stop.id, orderId: order.id });
    }
    await prisma.routeGroupingChildVersion.update({ where: { id: version.id }, data: { snapshot: { membershipSchemaVersion: 1, stops: members } } });
    return { shop, account, driver, route, version, stops, group, parent, members };
  }
});
