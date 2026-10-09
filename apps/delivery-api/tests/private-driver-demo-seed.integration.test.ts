import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { seedPrivateDriverDemo } from '../src/modules/driver/private-driver-demo-seed.js';
import { KFOOD_PRIVATE_DEMO_APP_ID, KFOOD_PRIVATE_DEMO_SHOP_DOMAIN } from '../src/modules/driver/private-driver-demo.js';
import { PrismaDriverAssignedRouteRepository } from '../src/modules/driver/driver-assigned-route.repository.js';
import { PrismaDriverRouteAccessRepository } from '../src/modules/driver/driver-route-access.repository.js';
import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';
import { PrismaDriverEventRepository, type RecordDriverEventInput } from '../src/modules/driver/driver-event.repository.js';
import { PrismaRoutePlanRepository } from '../src/modules/route-plans/route-plan.repository.js';

const databaseUrl = process.env.PRIVATE_DRIVER_DEMO_DATABASE_URL;
const enabled = process.env.PRIVATE_DRIVER_DEMO_DATABASE_TARGET_CLASS === 'safe-local-private-driver-demo-disposable';
if (enabled) {
  const target = new URL(databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled');
  if (target.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || target.pathname !== '/clever_private_demo_test' || target.port === '' || target.hash !== ''
    || [...target.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')) {
    throw new Error('Private demo integration tests require the named loopback disposable database.');
  }
}

(enabled ? describe.sequential : describe.skip)('private driver demo seed PostgreSQL contract', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled' });
  const shopIds: string[] = [];
  const accountIds: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const shopId of shopIds.splice(0).reverse()) {
      await prisma.order.updateMany({ where: { shopId }, data: { currentRouteVersionId: null } });
      await prisma.driverEvent.deleteMany({ where: { shopId } });
      await prisma.routePlanStop.deleteMany({ where: { shopId } });
      await prisma.routeGroupingChildVersion.deleteMany({ where: { shopId } });
      await prisma.order.deleteMany({ where: { shopId } });
      await prisma.shop.deleteMany({ where: { id: shopId } });
    }
    await prisma.driverAccount.deleteMany({ where: { id: { in: accountIds.splice(0) } } });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  test('dry-run makes no rows and apply publishes only the exact account without modifying its real assignment', async () => {
    const f = await fixture();
    const beforeAccount = await prisma.driverAccount.findUniqueOrThrow({ where: { id: f.account.id } });
    const beforeDriver = await prisma.driver.findUniqueOrThrow({ where: { id: f.realDriver.id } });
    const beforeRoute = await prisma.routePlan.findUniqueOrThrow({ where: { id: f.realRoute.id } });
    const beforeSession = await prisma.driverAccountSession.findUniqueOrThrow({ where: { id: f.session.id } });
    const dryRun = await seedPrivateDriverDemo(prisma);
    expect(dryRun).toMatchObject({ status: 'WOULD_CREATE', applied: false, routeCount: 2, stopCount: 5 });
    expect(await prisma.shop.count({ where: { id: f.privateShopId } })).toBe(0);
    const seeded = await seedPrivateDriverDemo(prisma, { apply: true });
    expect(seeded).toMatchObject({ status: 'CREATED', applied: true, routeCount: 2, stopCount: 5 });
    const replay = await seedPrivateDriverDemo(prisma, { apply: true });
    expect(replay).toMatchObject({ status: 'UNCHANGED', applied: false, manifest: seeded.manifest });
    expect(await prisma.driverAccount.findUniqueOrThrow({ where: { id: f.account.id } })).toEqual(beforeAccount);
    expect(await prisma.driver.findUniqueOrThrow({ where: { id: f.realDriver.id } })).toEqual(beforeDriver);
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: f.realRoute.id } })).toEqual(beforeRoute);
    expect(await prisma.driverAccountSession.findUniqueOrThrow({ where: { id: f.session.id } })).toEqual(beforeSession);
    const where = { shopId: f.privateShopId };
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: f.privateShopId } });
    expect(shop).toMatchObject({ appId: KFOOD_PRIVATE_DEMO_APP_ID, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN,
      adminAccessTokenCiphertext: null, adminRefreshTokenCiphertext: null, shopifyShopGid: null,
      customerEmailSettings: { automatic: { enabled: false } } });
    expect(await prisma.commerceConnection.count({ where })).toBe(0);
    expect(await prisma.customer.count({ where })).toBe(0);
    expect(await prisma.deliveryCustomerProfile.count({ where })).toBe(0);
    expect(await prisma.customerRouteNotificationFact.count({ where })).toBe(0);
    expect(await prisma.customerDeliveryNotificationAttempt.count({ where })).toBe(0);
    expect(await prisma.driverRouteNotificationAttempt.count({ where })).toBe(0);
    expect(await prisma.driverEvent.count({ where })).toBe(0);
    for (const order of await prisma.order.findMany({ where })) {
      expect(order).toMatchObject({ sourcePlatform: 'CUSTOM', customerId: null, destinationId: null, email: null, phone: null });
    }
    const access = new PrismaDriverRouteAccessRepository(prisma);
    const tokenAccess = new PrismaDriverTokenAccessRepository(prisma);
    const assigned = new PrismaDriverAssignedRouteRepository(prisma);
    const officeRoutes = await new PrismaRoutePlanRepository(prisma).listRoutePlans({ appId: f.realShop.appId, shopDomain: f.realShop.shopDomain });
    expect(officeRoutes.map(route => route.id)).toContain(f.realRoute.id);
    expect(officeRoutes.some(route => seeded.manifest.routes.some(demo => demo.routePlanId === route.id))).toBe(false);
    expect(await access.lookupRouteAccess({ accountId: f.otherAccount.id, routeContext: null })).toEqual({ status: 'NOT_FOUND' });
    for (const route of seeded.manifest.routes) {
      expect(await access.lookupRouteAccess({ accountId: f.account.id, routeContext: route.routePlanId })).toMatchObject({ status: 'INVITED' });
      expect(await access.lookupRouteAccess({ accountId: f.otherAccount.id, routeContext: route.routePlanId })).toMatchObject({ status: 'NOT_FOUND' });
      expect(await tokenAccess.resolveDriverRouteAccess({ accountId: f.account.id, tokenVersion: f.account.tokenVersion, routePlanId: route.routePlanId })).not.toBeNull();
      const result = await assigned.getAssignedRoute({ shopId: f.privateShopId, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN,
        driverId: seeded.manifest.driverId, routeContext: route.routePlanId });
      expect(result.status).toBe('ASSIGNED_ROUTE');
      if (result.status !== 'ASSIGNED_ROUTE') throw new Error('Expected private assigned route.');
      expect(result.route.routeVersionId).toBe(route.childVersionId);
      expect(result.route.deliveryProof).toEqual({ photoRequired: route.key === 'proof', signatureRequired: route.key === 'proof' });
      expect(result.route.tollPolicy).toBe('ALLOW_TOLLS');
      expect(result.route.routeGeometry?.type).toBe('LineString');
      expect(result.route.stops.map(stop => stop.deliveryStopId)).toEqual(route.stops.map(stop => stop.deliveryStopId));
      expect(result.route.stops.every(stop => stop.phone === null && stop.destinationId === null && stop.completion == null)).toBe(true);
      if (route.key === 'cash') expect(result.route.stops.map(stop => stop.payment)).toMatchObject([
        { method: 'CASH', expectedAmount: '122.25', currencyCode: 'CAD', requiresCashInput: true },
        { method: 'ETRANSFER', expectedAmount: '40.00', currencyCode: 'CAD', requiresCashInput: false },
        { method: 'CASH', expectedAmount: '20.00', currencyCode: 'CAD', requiresCashInput: true }
      ]);
    }
  });

  test('normal ordered-v2 completion records Cash without Arrive and enforces proof only on the opted-in route', async () => {
    const f = await fixture();
    const { manifest } = await seedPrivateDriverDemo(prisma, { apply: true });
    const route = manifest.routes[0]!;
    const proofRoute = manifest.routes[1]!;
    const events = new PrismaDriverEventRepository(prisma);
    const event: RecordDriverEventInput = {
      shopId: f.privateShopId, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN, driverId: manifest.driverId,
      routePlanId: route.routePlanId, driverContractVersion: 2, expectedRouteVersionId: route.childVersionId,
      assignmentGeneration: '2', clientEventId: randomUUID(), deliveryStopId: null, eventType: 'ROUTE_STARTED',
      occurredAt: new Date(), latitude: null, longitude: null, versionCode: 43,
      payload: { source: 'private-demo-integration', deliveryProofCapability: 'delivery-proof-v1' }
    };
    await events.recordDriverEvent(event);
    const delivered = { ...event, clientEventId: randomUUID(), deliveryStopId: route.stops[0]!.deliveryStopId,
      eventType: 'STOP_DELIVERED', payload: { source: 'private-demo-integration', completion: {
        version: 1, cashReceived: { amount: '122.00', currency: 'CAD' }
      } } };
    const receipt = await events.recordDriverEvent(delivered);
    expect(receipt.completion).toMatchObject({ method: 'CASH', expectedAmount: '122.25', actualAmount: '122.00', differenceAmount: '-0.25', currencyCode: 'CAD' });
    expect(await events.recordDriverEvent(delivered)).toMatchObject({ duplicate: true, eventId: receipt.eventId, completion: receipt.completion });
    expect(await prisma.driverEvent.count({ where: { shopId: f.privateShopId, eventType: 'STOP_ARRIVED' } })).toBe(0);
    const transfer = await events.recordDriverEvent({ ...event, clientEventId: randomUUID(), deliveryStopId: route.stops[1]!.deliveryStopId,
      eventType: 'STOP_DELIVERED', payload: { source: 'private-demo-integration', completion: { version: 1 } } });
    expect(transfer.completion).toMatchObject({ method: 'ETRANSFER', expectedAmount: '40.00', actualAmount: null });
    await events.recordDriverEvent({ ...event, clientEventId: randomUUID(), routePlanId: proofRoute.routePlanId, expectedRouteVersionId: proofRoute.childVersionId });
    await expect(events.recordDriverEvent({ ...event, clientEventId: randomUUID(), routePlanId: proofRoute.routePlanId,
      expectedRouteVersionId: proofRoute.childVersionId, eventType: 'STOP_DELIVERED', deliveryStopId: proofRoute.stops[0]!.deliveryStopId
    })).rejects.toMatchObject({ code: 'DELIVERY_PROOF_REQUIRED' });
    expect(await prisma.customerDeliveryNotificationAttempt.count({ where: { shopId: f.privateShopId } })).toBe(0);
    expect(await prisma.customerRouteNotificationFact.count({ where: { shopId: f.privateShopId } })).toBe(0);
    await expect(seedPrivateDriverDemo(prisma, { apply: true })).rejects.toThrow('differs');
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: route.stops[0]!.deliveryStopId } })).status).toBe('DELIVERED');
  });

  test('rejects a pre-existing reserved tenant without adopting or changing it', async () => {
    const f = await fixture();
    const shop = await prisma.shop.create({ data: { id: f.privateShopId, appId: KFOOD_PRIVATE_DEMO_APP_ID, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN } });
    await expect(seedPrivateDriverDemo(prisma, { apply: true })).rejects.toThrow('differs');
    expect(await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).toEqual(shop);
    expect(await prisma.driver.count({ where: { shopId: shop.id } })).toBe(0);
  });

  test('does not recreate a tenant blocked by the shared privacy fence', async () => {
    const f = await fixture();
    const tombstone = await prisma.shopifyShopRedactionTombstone.create({ data: {
      appId: KFOOD_PRIVATE_DEMO_APP_ID, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN,
      complianceWebhookId: randomUUID(), redactedAt: new Date()
    } });
    try {
      await expect(seedPrivateDriverDemo(prisma, { apply: true })).rejects.toMatchObject({ code: 'SHOP_PRIVACY_REDACTED' });
      expect(await prisma.shop.count({ where: { id: f.privateShopId } })).toBe(0);
    } finally {
      await prisma.shopifyShopRedactionTombstone.delete({ where: { id: tombstone.id } });
    }
  });

  test('refuses changed or partly removed seed data instead of silently resetting it', async () => {
    const f = await fixture();
    const seeded = await seedPrivateDriverDemo(prisma, { apply: true });
    const stop = seeded.manifest.routes[0]!.stops[0]!;
    await prisma.deliveryStop.update({ where: { id: stop.deliveryStopId }, data: { status: 'DELIVERED' } });
    await expect(seedPrivateDriverDemo(prisma, { apply: true })).rejects.toThrow('differs');
    expect((await prisma.deliveryStop.findUniqueOrThrow({ where: { id: stop.deliveryStopId } })).status).toBe('DELIVERED');
    await prisma.deliveryStop.update({ where: { id: stop.deliveryStopId }, data: { status: 'ASSIGNED' } });
    await prisma.routePlanStop.delete({ where: { id: stop.routePlanStopId } });
    await expect(seedPrivateDriverDemo(prisma, { apply: true })).rejects.toThrow('differs');
    expect(await prisma.routePlanStop.count({ where: { shopId: f.privateShopId } })).toBe(4);
  });

  test('rejects inactive accounts, stale proof capability, and disabled rollout before creating anything', async () => {
    const f = await fixture();
    await prisma.driverAccount.update({ where: { id: f.account.id }, data: { status: 'SUSPENDED' } });
    await expect(seedPrivateDriverDemo(prisma, { apply: true })).rejects.toThrow('active ordinary');
    await prisma.driverAccount.update({ where: { id: f.account.id }, data: { status: 'ACTIVE', tokenVersion: 1 } });
    await expect(seedPrivateDriverDemo(prisma, { apply: true })).rejects.toThrow('current production');
    vi.stubEnv('KFOOD_DELIVERY_PROOF_ENABLED', 'false');
    await expect(seedPrivateDriverDemo(prisma, { apply: true })).rejects.toThrow('ROLLOUT_DISABLED');
    expect(await prisma.shop.count({ where: { id: f.privateShopId } })).toBe(0);
  });

  async function fixture() {
    const privateShopId = randomUUID();
    shopIds.push(privateShopId);
    const account = await prisma.driverAccount.create({ data: { phone: `private-demo-test-${randomUUID()}` } });
    const otherAccount = await prisma.driverAccount.create({ data: { phone: `private-demo-test-${randomUUID()}` } });
    accountIds.push(account.id, otherAccount.id);
    const session = await prisma.driverAccountSession.create({ data: {
      accountId: account.id, refreshTokenHash: `synthetic-${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000),
      deliveryProofCapability: 'delivery-proof-v1', capabilityVersionCode: 43,
      capabilityPackageId: 'com.evnsolution.clever.routes', capabilityTokenVersion: account.tokenVersion
    } });
    const realShop = await prisma.shop.create({ data: { appId: `synthetic-real-${randomUUID()}`, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN } });
    shopIds.push(realShop.id);
    const realDriver = await prisma.driver.create({ data: { shopId: realShop.id, accountId: account.id, displayName: 'Unmodified existing driver', authSubject: randomUUID() } });
    const realRoute = await prisma.routePlan.create({ data: {
      shopId: realShop.id, driverId: realDriver.id, planDate: new Date(), name: 'Unmodified existing route',
      status: 'IN_PROGRESS', constraints: {}, metrics: {}, optimizerVersion: 'integration'
    } });
    vi.stubEnv('KFOOD_PRIVATE_DEMO_SHOP_ID', privateShopId);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', account.id);
    vi.stubEnv('KFOOD_DELIVERY_PROOF_ENABLED', 'true');
    return { account, otherAccount, session, realShop, realDriver, realRoute, privateShopId };
  }
});
