import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, test } from 'vitest';

import { runReviewVariantDemo } from '../src/scripts/dsv-review-variant-demo.js';

const safeTargetClass = 'safe-local-g003-temp-cluster';
const isSafeDisposableTarget = process.env.G003_DATABASE_TARGET_CLASS === safeTargetClass
  && /^postgresql:\/\/clever_g003:clever_g003@127\.0\.0\.1:55433\/clever_g003(?:\?|$)/u.test(process.env.DATABASE_URL ?? '');

(isSafeDisposableTarget ? describe.sequential : describe.skip)('DSV review variant demo against a disposable DB', () => {
  const prisma = new PrismaClient();
  const shopIds: string[] = [];

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
    await prisma.$disconnect();
  });

  test('imports every merged spelling as hidden review data that the driver sees as one stop', async () => {
    const unique = randomUUID();
    const shop = await prisma.shop.create({ data: { appId: 'clever', shopDomain: `variant-${unique}.example.test`, shopifyShopGid: `gid://shopify/Shop/${unique}` } });
    shopIds.push(shop.id);
    const account = await prisma.driverAccount.create({ data: { loginId: `login-${unique}`, name: '임지인', phone: `phone-${unique}`, status: 'ACTIVE' } });
    const driver = await prisma.driver.create({ data: {
      accountId: account.id, authSubject: `auth-${unique}`, displayName: '임지인', shopId: shop.id, status: 'ACTIVE',
      dsvProfile: { create: { lookupName: '임지인' } },
    } });
    await prisma.dsvTransportCondition.create({ data: {
      activatedAt: new Date('2026-07-22T00:00:00.000Z'), code: 'TS01', comparisonKey: 'TS01', createdBy: 'test',
      description: 'Standard', name: 'Standard', rawValue: 'TS01', shopId: shop.id, status: 'ACTIVE',
    } });
    const place = (name: string, address: string, mergedIntoProfileId: string | null = null) => prisma.deliveryCustomerProfile.create({ data: {
      addressFingerprint: `fp-${randomUUID()}`, canonicalName: name, mergedIntoProfileId, shopId: shop.id,
      normalizedAddress: { address, latitude: 37.39, longitude: 126.96, name },
    } });
    const survivor = await place('지오영', '경기 안양시 동안구 흥안대로439번길30, 1층');
    await place('지오영', '경기 안양시 동안구 흥안대로439번길 30,1층', survivor.id);
    await place('(주)지오영', '경기도 안양시 동안구 흥안대로439번길 30 2층', survivor.id);
    const config = { accountId: account.id, driverId: driver.id, groups: 6, planDate: '2026-10-16', shopId: shop.id };

    const dryRun = await runReviewVariantDemo(prisma, config, false);
    expect(dryRun).toMatchObject({ mode: 'dry-run', rows: 3, groups: 1, predictedStopsPerGroup: [1], alreadyCreated: false });

    process.env.DSV_REVIEW_DEMO_EXPECTED_FINGERPRINT = dryRun.fingerprint;
    process.env.DSV_REVIEW_DEMO_SNAPSHOT_PATH = join(await mkdtemp(join(tmpdir(), 'variant-demo-')), 'snapshot.json');
    const applied = await runReviewVariantDemo(prisma, config, true);
    expect(applied).toMatchObject({ mode: 'apply', driverStops: 3, driverDestinationsPerGroup: [1] });

    const [storedAccount, storedDriver, orders, route] = await Promise.all([
      prisma.driverAccount.findUniqueOrThrow({ where: { id: account.id } }),
      prisma.driver.findUniqueOrThrow({ where: { id: driver.id } }),
      prisma.order.findMany({ where: { shopId: shop.id } }),
      prisma.routePlan.findFirstOrThrow({ where: { shopId: shop.id, driverId: driver.id } }),
    ]);
    expect(storedAccount.isStoreReviewAccount && storedDriver.isStoreReviewData && route.isStoreReviewData).toBe(true);
    expect(orders).toHaveLength(3);
    expect(orders.every((order) => order.isStoreReviewData)).toBe(true);
    expect(new Set(orders.map((order) => order.destinationId)).size).toBe(1);
    await expect(runReviewVariantDemo(prisma, config, true)).rejects.toThrow();
  });
});
