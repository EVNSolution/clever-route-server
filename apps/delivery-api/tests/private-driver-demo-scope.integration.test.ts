import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { PrismaDriverRouteAccessRepository } from '../src/modules/driver/driver-route-access.repository.js';
import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';
import { PrismaDriverSelfServiceRepository } from '../src/modules/driver/driver-self-service.repository.js';
import { PrismaCompletionAssistanceService } from '../src/modules/driver/completion-assistance.service.js';
import { getAdminLiveRouteChange } from '../src/modules/route-plans/live-route-change.js';
import { PrismaLiveRouteChangeService } from '../src/modules/route-plans/live-route-change.service.js';
import { reconcileKfoodDeliveryWorkCompletion } from '../src/modules/route-plans/kfood-delivery-completion.js';
import { KFOOD_PRIVATE_DEMO_APP_ID, KFOOD_PRIVATE_DEMO_SHOP_DOMAIN } from '../src/modules/driver/private-driver-demo.js';

const databaseUrl = process.env.PRIVATE_DRIVER_DEMO_DATABASE_URL;
const enabled = process.env.PRIVATE_DRIVER_DEMO_DATABASE_TARGET_CLASS === 'safe-local-private-driver-demo-disposable';
if (enabled) {
  const target = new URL(databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled');
  if (target.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || target.pathname !== '/clever_private_demo_test' || target.port === '') {
    throw new Error('Private demo scope tests require the named loopback disposable database');
  }
}

(enabled ? describe.sequential : describe.skip)('private demo PostgreSQL scope', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled' });
  afterAll(async () => { await prisma.$disconnect(); });
  afterEach(() => vi.unstubAllEnvs());

  test('retains KFood driver behavior only for the exact private tenant and owner across cached and historical access', async () => {
    const shop = await prisma.shop.upsert({
      where: { appId_shopDomain: { appId: KFOOD_PRIVATE_DEMO_APP_ID, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN } },
      create: { appId: KFOOD_PRIVATE_DEMO_APP_ID, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN }, update: {}
    });
    const ordinaryShop = await prisma.shop.upsert({
      where: { appId_shopDomain: { appId: 'clever-route-kfood', shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN } },
      create: { appId: 'clever-route-kfood', shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN }, update: {}
    });
    expect(ordinaryShop.id).not.toBe(shop.id);
    const account = await prisma.driverAccount.create({ data: { phone: `private-scope-${randomUUID()}` } });
    const stranger = await prisma.driverAccount.create({ data: { phone: `private-scope-${randomUUID()}` } });
    const driver = await prisma.driver.create({ data: {
      accountId: account.id, shopId: shop.id, displayName: 'Synthetic scope driver', authSubject: `private-scope-${randomUUID()}`
    } });
    const route = await prisma.routePlan.create({ data: {
      shopId: shop.id, driverId: driver.id, name: 'Synthetic private scope', planDate: new Date('2030-10-09'),
      status: 'IN_PROGRESS', optimizerVersion: 'private-test', constraints: {}, metrics: {}
    } });
    const grouping = await prisma.routeGrouping.create({ data: { shopId: shop.id, name: 'Synthetic private scope', planDate: route.planDate } });
    const groupingVersion = await prisma.routeGroupingVersion.create({ data: { shopId: shop.id, groupingId: grouping.id, version: 1 } });
    const version = await prisma.routeGroupingChildVersion.create({ data: {
      shopId: shop.id, groupingId: grouping.id, groupingVersionId: groupingVersion.id, version: 1,
      routePlanId: route.id, driverId: driver.id, publishedAt: new Date(), snapshot: {}
    } });
    const members = [];
    for (let index = 0; index < 2; index += 1) {
      const order = await prisma.order.create({ data: {
        shopId: shop.id, shopifyOrderGid: `gid://private-scope/${randomUUID()}`, name: 'Synthetic stop',
        sourcePlatform: 'CUSTOM', rawPayload: {}, currentRouteVersionId: version.id, ownedRouteGroupingId: grouping.id
      } });
      const stop = await prisma.deliveryStop.create({ data: { shopId: shop.id, orderId: order.id, status: index === 0 ? 'ARRIVED' : 'PENDING' } });
      await prisma.routePlanStop.create({ data: { shopId: shop.id, routePlanId: route.id, deliveryStopId: stop.id, sequence: index + 1 } });
      members.push({ deliveryStopId: stop.id, orderId: order.id, sequence: index + 1 });
    }
    await prisma.routeGroupingChildVersion.update({ where: { id: version.id }, data: { snapshot: { membershipSchemaVersion: 1, stops: members } } });
    const lookup = new PrismaDriverRouteAccessRepository(prisma);
    const token = new PrismaDriverTokenAccessRepository(prisma);
    const input = { accountId: account.id, routePlanId: route.id, tokenVersion: account.tokenVersion };
    const admin = { appId: KFOOD_PRIVATE_DEMO_APP_ID, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN, routePlanId: route.id };
    const live = new PrismaLiveRouteChangeService(prisma);

    vi.stubEnv('KFOOD_PRIVATE_DEMO_SHOP_ID', undefined);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', undefined);
    await expect(token.resolveDriverRouteAccess(input)).resolves.toBeNull();
    await expect(lookup.lookupRouteAccess({ accountId: account.id, routeContext: null })).resolves.toEqual({ status: 'NOT_FOUND' });
    await expect(live.getAdminDraft(admin)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getAdminLiveRouteChange(prisma, { shopId: shop.id, routePlanId: route.id })).rejects.toMatchObject({ statusCode: 404 });

    vi.stubEnv('KFOOD_PRIVATE_DEMO_SHOP_ID', shop.id);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', account.id);
    await expect(lookup.lookupRouteAccess({ accountId: account.id, routeContext: route.id })).resolves.toMatchObject({ status: 'INVITED' });
    await expect(token.resolveDriverRouteAccess(input)).resolves.toMatchObject({ shopId: shop.id, driverId: driver.id });
    await expect(token.resolveDriverRouteAccess({ ...input, accountId: stranger.id, tokenVersion: stranger.tokenVersion })).resolves.toBeNull();
    await expect(token.isDriverAccessTokenActive({ driverId: driver.id, shopDomain: admin.shopDomain, tokenVersion: driver.tokenVersion })).resolves.toBe(false);
    await expect(live.getAdminDraft(admin)).resolves.toMatchObject({ routePlanId: route.id });
    await expect(live.getAdminDraft({ ...admin, appId: 'clever-route-kfood' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(live.getDriverPublication({ ...input, driverId: driver.id, shopId: shop.id })).resolves.toBeDefined();

    const completion = new PrismaCompletionAssistanceService(prisma, { env: process.env });
    const run = (await completion.snapshot(account.id)).runs.find(row => row.routePlanId === route.id);
    expect(run).toBeDefined();
    const history = new PrismaDriverSelfServiceRepository(prisma);
    const historyInput = { driverId: driver.id, shopDomain: admin.shopDomain, shopId: shop.id, cursor: null, from: null, to: null, status: null };
    expect((await history.listDriverRoutes(historyInput)).routes.some(row => row.routePlanId === route.id)).toBe(true);

    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', undefined);
    expect((await completion.snapshot(account.id)).runs.some(row => row.routePlanId === route.id)).toBe(false);
    await expect(history.listDriverRoutes(historyInput)).rejects.toThrow();
    await expect(live.getDriverPublication({ ...input, driverId: driver.id, shopId: shop.id })).rejects.toMatchObject({ statusCode: 403 });
    await expect(completion.command(account.id, { kind: 'return_intent', commandId: randomUUID(),
      runId: run!.runId, routePlanId: route.id, assignmentGeneration: run!.assignmentGeneration,
      expectedRouteVersionId: version.id, occurredAt: new Date().toISOString() })).rejects.toThrow();

    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', account.id);
    await prisma.driver.update({ where: { id: driver.id }, data: { accountId: stranger.id } });
    await expect(token.resolveDriverRouteAccess({ ...input, accountId: stranger.id, tokenVersion: stranger.tokenVersion })).resolves.toBeNull();
    await expect(lookup.lookupRouteAccess({ accountId: stranger.id, routeContext: route.id })).resolves.toEqual({ status: 'NOT_FOUND' });
    await expect(live.getAdminDraft(admin)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getAdminLiveRouteChange(prisma, { shopId: shop.id, routePlanId: route.id })).rejects.toMatchObject({ statusCode: 404 });
    await prisma.driver.update({ where: { id: driver.id }, data: { accountId: account.id } });
    await prisma.deliveryStop.updateMany({ where: { id: { in: members.map(row => row.deliveryStopId) } }, data: { status: 'DELIVERED' } });
    const now = new Date('2030-10-09T12:00:00Z');
    await expect(prisma.$transaction(tx => reconcileKfoodDeliveryWorkCompletion(tx, { shopId: shop.id, routePlanId: route.id, now })))
      .resolves.toMatchObject({ completedAt: now, routeVersionId: version.id, navigationUntil: new Date('2030-10-09T14:00:00Z') });
    await expect(new PrismaDriverTokenAccessRepository(prisma, () => new Date('2030-10-09T14:00:00Z')).resolveDriverRouteAccess(input)).resolves.toBeNull();
  });
});
