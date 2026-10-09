import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { DriverEventReceiptScopeError, PrismaDriverEventReceiptRepository } from '../src/modules/driver/driver-event-receipt.repository.js';
import { PrismaDriverSyncHealthService } from '../src/modules/driver/driver-sync-health.service.js';
import { KFOOD_PRIVATE_DEMO_APP_ID, KFOOD_PRIVATE_DEMO_SHOP_DOMAIN } from '../src/modules/driver/private-driver-demo.js';

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

(enabled ? describe.sequential : describe.skip)('private demo account-only receipt and takeover boundaries', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled' });
  const shops: string[] = [];
  const accounts: string[] = [];
  const now = new Date('2026-10-09T08:00:00.000Z');
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const shopId of shops.splice(0)) {
      await prisma.driverEvent.deleteMany({ where: { shopId } });
      await prisma.shop.deleteMany({ where: { id: shopId } });
    }
    await prisma.driverAccount.deleteMany({ where: { id: { in: accounts.splice(0) } } });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  test('fences committed, rejected and unknown receipts after disabling or changing the exact private scope', async () => {
    const f = await fixture(true);
    const receipts = new PrismaDriverEventReceiptRepository(prisma);
    const read = (clientEventId: string, accountId = f.owner.id) => receipts.lookup({ accountId, clientEventId, routePlanId: f.route.id });
    for (const [clientEventId, status] of [['applied', 'APPLIED'], ['rejected', 'REJECTED'], ['unknown', 'UNKNOWN']] as const) {
      await expect(read(clientEventId)).resolves.toMatchObject({ status });
      await expect(read(clientEventId, f.other.id)).rejects.toBeInstanceOf(DriverEventReceiptScopeError);
    }
    // Even a historical event attributed to another account cannot expose a
    // private route that remains assigned to the configured owner.
    await prisma.driverEvent.create({ data: { shopId: f.shop.id, driverId: f.otherDriver.id, routePlanId: f.route.id,
      clientEventId: 'other-history', eventType: 'ROUTE_STARTED', occurredAt: now, payload: {} } });
    await expect(read('other-history', f.other.id)).rejects.toBeInstanceOf(DriverEventReceiptScopeError);

    for (const badAccountId of [undefined, 'invalid', f.other.id]) {
      vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', badAccountId);
      for (const clientEventId of ['applied', 'rejected', 'unknown']) {
        await expect(read(clientEventId)).rejects.toBeInstanceOf(DriverEventReceiptScopeError);
      }
    }
    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', f.owner.id);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_SHOP_ID', randomUUID());
    await expect(read('applied')).rejects.toBeInstanceOf(DriverEventReceiptScopeError);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_SHOP_ID', f.shop.id);
    await prisma.driver.update({ where: { id: f.driver.id }, data: { accountId: f.other.id } });
    for (const clientEventId of ['applied', 'rejected', 'unknown']) {
      await expect(read(clientEventId)).rejects.toBeInstanceOf(DriverEventReceiptScopeError);
      await expect(read(clientEventId, f.other.id)).rejects.toBeInstanceOf(DriverEventReceiptScopeError);
    }
  });

  test('refuses private takeover without changing leases when activation or owner no longer matches', async () => {
    const f = await fixture(true);
    const service = new PrismaDriverSyncHealthService(prisma, undefined, () => now);
    const input = { accountId: f.owner.id, deviceInstanceHash: 'a'.repeat(64), routePlanId: f.route.id, sessionGeneration: f.sessionGeneration };
    await expect(service.takeover(input)).resolves.toBe(true);
    const before = await prisma.driverRouteSessionLease.findMany({ where: { routePlanId: f.route.id } });
    for (const badAccountId of [undefined, 'invalid', f.other.id]) {
      vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', badAccountId);
      await expect(service.takeover(input)).resolves.toBe(false);
    }
    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', f.owner.id);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_SHOP_ID', randomUUID());
    await expect(service.takeover(input)).resolves.toBe(false);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_SHOP_ID', f.shop.id);
    await prisma.driver.update({ where: { id: f.driver.id }, data: { accountId: f.other.id } });
    await expect(service.takeover(input)).resolves.toBe(false);
    await expect(service.takeover({ ...input, accountId: f.other.id })).resolves.toBe(false);
    expect(await prisma.driverRouteSessionLease.findMany({ where: { routePlanId: f.route.id } })).toEqual(before);
  });

  test('preserves ordinary receipt replay after route reassignment and ordinary takeover with no demo config', async () => {
    const f = await fixture(false);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', undefined);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_SHOP_ID', undefined);
    const receipts = new PrismaDriverEventReceiptRepository(prisma);
    const service = new PrismaDriverSyncHealthService(prisma, undefined, () => now);
    await expect(service.takeover({ accountId: f.owner.id, deviceInstanceHash: 'a'.repeat(64), routePlanId: f.route.id, sessionGeneration: f.sessionGeneration })).resolves.toBe(true);
    await prisma.routePlan.update({ where: { id: f.route.id }, data: { driverId: f.otherDriver.id } });
    for (const [clientEventId, status] of [['applied', 'APPLIED'], ['rejected', 'REJECTED']] as const) {
      await expect(receipts.lookup({ accountId: f.owner.id, clientEventId, routePlanId: f.route.id })).resolves.toMatchObject({ status });
    }
  });

  async function fixture(isPrivate: boolean) {
    const owner = await prisma.driverAccount.create({ data: { phone: `private-endpoint-${randomUUID()}` } });
    const other = await prisma.driverAccount.create({ data: { phone: `private-endpoint-${randomUUID()}` } });
    accounts.push(owner.id, other.id);
    const shop = await prisma.shop.create({ data: { appId: isPrivate ? KFOOD_PRIVATE_DEMO_APP_ID : `synthetic-ordinary-${randomUUID()}`,
      shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN } });
    shops.push(shop.id);
    const driver = await prisma.driver.create({ data: { shopId: shop.id, accountId: owner.id, displayName: 'Synthetic owner', authSubject: randomUUID() } });
    const otherDriver = await prisma.driver.create({ data: { shopId: shop.id, accountId: other.id, displayName: 'Synthetic other', authSubject: randomUUID() } });
    const route = await prisma.routePlan.create({ data: { shopId: shop.id, driverId: driver.id, name: 'Synthetic boundary fixture',
      planDate: now, status: 'IN_PROGRESS', optimizerVersion: 'test', constraints: {}, metrics: {} } });
    await prisma.driverEvent.create({ data: { shopId: shop.id, driverId: driver.id, routePlanId: route.id,
      clientEventId: 'applied', eventType: 'ROUTE_STARTED', occurredAt: now, payload: {} } });
    await prisma.driverEventAttempt.create({ data: { shopId: shop.id, driverId: driver.id, routePlanId: route.id,
      clientEventId: 'rejected', requestId: randomUUID(), driverContractVersion: 2, status: 'REJECTED', retryable: false,
      errorCode: 'SYNTHETIC_REJECTION', retainedUntil: new Date(now.getTime() + 86_400_000) } });
    const sessionGeneration = now.toISOString();
    await prisma.driverSyncSession.create({ data: { shopId: shop.id, driverId: driver.id, routePlanId: route.id,
      deviceInstanceHash: 'a'.repeat(64), sessionGeneration, driverContractVersion: 2, appVersion: '1.3.7', versionCode: 43,
      firstObservedAt: now, lastObservedAt: now, expiresAt: new Date(now.getTime() + 3_600_000) } });
    vi.stubEnv('KFOOD_PRIVATE_DEMO_SHOP_ID', shop.id);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', owner.id);
    return { owner, other, shop, driver, otherDriver, route, sessionGeneration };
  }
});
