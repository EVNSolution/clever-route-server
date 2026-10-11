import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { PrismaDriverRouteAccessRepository } from '../src/modules/driver/driver-route-access.repository.js';
import {
  createPrivateDriverDemoRoute,
  dispatchPrivateDriverDemoRoute,
  readPrivateDriverDemoRouteState,
  teardownPrivateDriverDemo
} from '../src/modules/driver/private-driver-demo-routes.js';
import { seedPrivateDriverDemo } from '../src/modules/driver/private-driver-demo-seed.js';
import { hashPushToken } from '../src/modules/route-grouping/driver-push-token.service.js';
import { DisabledDriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';

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

(enabled ? describe.sequential : describe.skip)('private driver demo extra routes and teardown (PostgreSQL)', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled' });
  const shopIds: string[] = [];
  const accountIds: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const shopId of shopIds.splice(0).reverse()) {
      await prisma.driverRouteNotificationAttempt.deleteMany({ where: { shopId } });
      await prisma.order.updateMany({ where: { shopId }, data: { currentRouteVersionId: null } });
      await prisma.routePlanStop.deleteMany({ where: { shopId } });
      await prisma.routeGroupingChildVersion.deleteMany({ where: { shopId } });
      await prisma.order.deleteMany({ where: { shopId } });
      await prisma.shop.deleteMany({ where: { id: shopId } });
    }
    await prisma.driverAccount.deleteMany({ where: { id: { in: accountIds.splice(0) } } });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function fixture() {
    const shopId = randomUUID();
    shopIds.push(shopId);
    const account = await prisma.driverAccount.create({ data: { phone: `private-demo-routes-${randomUUID()}` } });
    accountIds.push(account.id);
    await prisma.driverAccountSession.create({ data: {
      accountId: account.id, refreshTokenHash: `synthetic-${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000),
      deliveryProofCapability: 'delivery-proof-v1', capabilityVersionCode: 43,
      capabilityPackageId: 'com.evnsolution.clever.routes', capabilityTokenVersion: account.tokenVersion
    } });
    vi.stubEnv('KFOOD_PRIVATE_DEMO_SHOP_ID', shopId);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', account.id);
    vi.stubEnv('KFOOD_DELIVERY_PROOF_ENABLED', 'true');
    await seedPrivateDriverDemo(prisma, { apply: true });
    await prisma.driverPushToken.create({ data: {
      accountId: account.id, devicePushToken: 'synthetic-device-token', tokenHash: hashPushToken('synthetic-device-token'),
      platform: 'android', appId: 'com.evnsolution.clever.routes', status: 'ACTIVE'
    } });
    return { account, shopId };
  }

  test('the seeded demo stops carry postal codes and every part the driver app requires', async () => {
    const { shopId } = await fixture();
    const stops = await prisma.deliveryStop.findMany({ where: { shopId } });
    expect(stops).toHaveLength(5);
    for (const stop of stops) {
      for (const part of [stop.address1, stop.city, stop.province, stop.postalCode, stop.countryCode]) {
        expect(typeof part === 'string' && part.trim().length > 0).toBe(true);
      }
    }
  });

  test('a new route is hidden until Dispatch, then exposed with its push, once', async () => {
    const { account, shopId } = await fixture();
    const access = new PrismaDriverRouteAccessRepository(prisma);
    const input = { key: 'cashnew', name: 'DEMO NEW · Cash / eTransfer', template: 'cash' } as const;
    const listCount = async () => {
      const list = await access.lookupRouteAccess({ accountId: account.id, routeContext: null });
      return list.status === 'ROUTES_FOUND' ? list.routes.length : 0;
    };
    const baseline = await listCount();
    expect(await readPrivateDriverDemoRouteState(prisma, input)).toBe('absent');
    expect(await createPrivateDriverDemoRoute(prisma, input)).toMatchObject({ status: 'CREATED', stops: 3 });
    expect(await createPrivateDriverDemoRoute(prisma, input)).toMatchObject({ status: 'UNCHANGED' });
    expect(await readPrivateDriverDemoRouteState(prisma, input)).toBe('unpublished');
    expect(await listCount()).toBe(baseline);

    await expect(dispatchPrivateDriverDemoRoute(prisma, new DisabledDriverPushProvider(), input))
      .rejects.toThrow('Driver push provider is not configured.');
    const summary = await dispatchPrivateDriverDemoRoute(prisma, new DisabledDriverPushProvider(), input, { allowDisabledProvider: true });
    expect(summary).toMatchObject({
      appAddressContractOk: true, dispatchReserved: true, exposedInRouteList: true, groupingStatus: 'READY', routeState: 'published'
    });
    expect(summary.attempts).toEqual([expect.objectContaining({ action: 'ASSIGNED' })]);
    expect(await listCount()).toBe(baseline + 1);
    await expect(dispatchPrivateDriverDemoRoute(prisma, new DisabledDriverPushProvider(), input, { allowDisabledProvider: true }))
      .rejects.toThrow('already published');
    expect(await prisma.customerRouteNotificationFact.count({ where: { shopId } })).toBe(0);
    expect(await prisma.driverEvent.count({ where: { shopId } })).toBe(0);
  });

  test('a stop without a postal code is refused before Dispatch', async () => {
    const { shopId } = await fixture();
    const input = { key: 'gapcheck', name: 'DEMO GAP · Missing postal code', template: 'simple' } as const;
    await createPrivateDriverDemoRoute(prisma, input);
    await prisma.deliveryStop.updateMany({ where: { shopId, order: { name: 'DEMO-GAPCHECK-1' } }, data: { postalCode: null } });
    await expect(dispatchPrivateDriverDemoRoute(prisma, new DisabledDriverPushProvider(), input, { allowDisabledProvider: true }))
      .rejects.toThrow('incomplete for the driver app');
    expect(await readPrivateDriverDemoRouteState(prisma, input)).toBe('unpublished');
  });

  test('teardown dry run rolls back and apply keeps only the shop and the driver', async () => {
    const { account, shopId } = await fixture();
    const input = { key: 'proofnew', name: 'DEMO NEW · Photo + Signature', template: 'proof' } as const;
    await createPrivateDriverDemoRoute(prisma, input);
    await dispatchPrivateDriverDemoRoute(prisma, new DisabledDriverPushProvider(), input, { allowDisabledProvider: true });
    const driverBefore = await prisma.driver.findFirstOrThrow({ where: { shopId } });
    const accountBefore = await prisma.driverAccount.findUniqueOrThrow({ where: { id: account.id } });
    const snapshots: Array<Record<string, unknown>> = [];
    const writeEvidence = (snapshot: Record<string, unknown>) => { snapshots.push(snapshot); return Promise.resolve(); };

    const dry = await teardownPrivateDriverDemo(prisma, { dryRun: true, writeEvidence });
    expect(dry.dryRun).toBe(true);
    expect(await prisma.routePlan.count({ where: { shopId } })).toBe(3);
    expect(dry.deleted.route_plans).toBe(3);

    const applied = await teardownPrivateDriverDemo(prisma, { dryRun: false, writeEvidence });
    expect(applied.dryRun).toBe(false);
    expect(snapshots).toHaveLength(2);
    expect(applied.remaining).toEqual({ drivers: 1 });
    expect(await prisma.routePlan.count({ where: { shopId } })).toBe(0);
    expect(await prisma.order.count({ where: { shopId } })).toBe(0);
    expect(await prisma.deliveryStop.count({ where: { shopId } })).toBe(0);
    expect(await prisma.driverRouteNotificationAttempt.count({ where: { shopId } })).toBe(0);
    expect(await prisma.driver.findFirstOrThrow({ where: { shopId } })).toEqual(driverBefore);
    expect(await prisma.driverAccount.findUniqueOrThrow({ where: { id: account.id } })).toEqual(accountBefore);
    expect(await prisma.shop.count({ where: { id: shopId } })).toBe(1);
    expect(await prisma.driverPushToken.count({ where: { accountId: account.id } })).toBe(1);
  });
});
