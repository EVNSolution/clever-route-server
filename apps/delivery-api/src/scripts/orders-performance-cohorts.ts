import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { PrismaClient } from '@prisma/client';

import { PrismaOrderQueryRepository } from '../modules/shopify/order-query.repository.js';

const APP_ID = process.env.ORDERS_PERF_APP_ID?.trim() || 'orders-performance-evidence';
const SHOP_DOMAIN = process.env.ORDERS_PERF_SHOP_DOMAIN?.trim().toLowerCase() || 'orders-performance.invalid';
const ACTOR = 'orders-performance-actor';
const SECRET = 'orders-performance-local-evidence-key-2026';
const ORDER_COUNT = readPositiveInteger(process.env.ORDERS_PERF_ORDER_COUNT, 5_000);
const OUTPUT_PATH = resolve(
  process.env.ORDERS_PERF_OUTPUT ?? '.omx/perf/orders-server-performance-cohorts.json'
);

if (process.env.ORDERS_PERF_ALLOW_SYNTHETIC !== '1') {
  throw new Error('ORDERS_PERF_ALLOW_SYNTHETIC=1 is required');
}
if (!new URL(process.env.DATABASE_URL ?? '').searchParams.get('schema')?.startsWith('orders_perf_')) {
  throw new Error('DATABASE_URL must target an isolated orders_perf_* schema');
}

const prisma = new PrismaClient();

try {
  await seedFixture();
  const repository = new PrismaOrderQueryRepository(prisma, SECRET);
  const cohorts = {
    coldFirstRowBackendMs: await measureRepeated(100, async (index) => {
      await repository.listPage({
        appId: APP_ID,
        filters: { deliveryArea: `Area-${String(index % 50).padStart(2, '0')}` },
        shopDomain: SHOP_DOMAIN
      });
    }),
    exactFacetsMs: await measureRepeated(30, async () => {
      await repository.facets({ appId: APP_ID, filters: {}, shopDomain: SHOP_DOMAIN });
    }),
    mapProjectionMs: await measureRepeated(30, async () => {
      await repository.mapPoints({ appId: APP_ID, filters: {}, limit: 1_000, shopDomain: SHOP_DOMAIN });
    }),
    snapshotCreateMs: [] as number[],
    bulkCompletionMs: [] as number[],
    warmPageTransitionBackendMs: [] as number[]
  };

  const firstPage = await repository.listPage({ appId: APP_ID, shopDomain: SHOP_DOMAIN });
  if (firstPage.pageInfo.endCursor === null) throw new Error('Expected a next-page cursor');
  const nextPageCursor = firstPage.pageInfo.endCursor;
  cohorts.warmPageTransitionBackendMs = await measureRepeated(100, async () => {
    await repository.listPage({
      after: nextPageCursor,
      appId: APP_ID,
      shopDomain: SHOP_DOMAIN
    });
  });

  for (let index = 0; index < 20; index += 1) {
    let selectionToken = '';
    cohorts.snapshotCreateMs.push(await measure(async () => {
      const snapshot = await repository.createSelectionSnapshot({
        actor: ACTOR,
        appId: APP_ID,
        filters: { deliveryArea: 'Area-01' },
        shopDomain: SHOP_DOMAIN
      });
      selectionToken = snapshot.selectionToken;
    }));
    cohorts.bulkCompletionMs.push(await measure(async () => {
      await repository.bulkPatchSelectionSnapshot({
        actor: ACTOR,
        appId: APP_ID,
        field: 'payment',
        selectionToken,
        shopDomain: SHOP_DOMAIN,
        value: index % 2 === 0 ? 'PAID' : 'PENDING'
      });
    }));
  }

  const privacyCanary = await inspectPrivacyCanary();
  const artifact = {
    capturedAt: new Date().toISOString(),
    cohorts,
    environment: {
      database: 'isolated-local-postgresql',
      orderCount: ORDER_COUNT,
      schema: new URL(process.env.DATABASE_URL ?? '').searchParams.get('schema'),
      synthetic: true
    },
    privacyCanary
  };
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(`${OUTPUT_PATH}\n`);
} finally {
  await prisma.$disconnect();
}

async function seedFixture(): Promise<void> {
  await prisma.shop.deleteMany({ where: { appId: APP_ID, shopDomain: SHOP_DOMAIN } });
  const shop = await prisma.shop.create({ data: { appId: APP_ID, shopDomain: SHOP_DOMAIN } });
  const shopId = shop.id.replaceAll("'", "''");
  await prisma.$executeRawUnsafe(`
    INSERT INTO "orders" (
      "id", "shopId", "shopifyOrderGid", "shopifyOrderLegacyId", "displayOrderSequence",
      "sourcePlatform", "sourceOrderId", "sourceOrderNumber", "name", "email", "phone",
      "financialStatus", "fulfillmentStatus", "processedAt", "updatedAtShopify",
      "shippingAddress", "rawPayload", "deliveryStatus", "createdAt", "updatedAt"
    )
    SELECT
      gen_random_uuid(), '${shopId}'::uuid, 'gid://shopify/Order/' || value,
      value::bigint, value::bigint, 'SHOPIFY'::"CommerceSourcePlatform",
      value::text, value::text, '#' || value,
      'canary-' || value || '@invalid.test', '+1555000' || lpad(value::text, 4, '0'),
      'PENDING', 'UNFULFILLED', now() - (value % 30) * interval '1 day', now(),
      jsonb_build_object('address1', value || ' Evidence Street'),
      jsonb_build_object('note', 'privacy-canary-' || value),
      'READY'::"DeliveryOrderStatus", now() - (value % 30) * interval '1 day', now()
    FROM generate_series(1, ${ORDER_COUNT}) AS value
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "order_delivery_facts" (
      "id", "shopId", "orderId", "sourcePlatform", "sourceOrderId", "sourceOrderNumber",
      "matchedMappingPaths", "deliveryDayParseStatus", "deliveryDateWeekdayVerified",
      "deliveryDateWeekdayMismatch", "deliveryDate", "deliveryWeekday", "serviceType",
      "deliveryArea", "readiness", "reviewReasons", "batchEligible", "geocodeStatus",
      "computedAt", "createdAt", "updatedAt"
    )
    SELECT
      gen_random_uuid(), "shopId", "id", 'SHOPIFY'::"CommerceSourcePlatform", "sourceOrderId",
      "sourceOrderNumber", '[]'::jsonb, 'PARSED'::"DeliveryDayParseStatus", true, false,
      current_date + (("displayOrderSequence" % 7)::int),
      CASE ("displayOrderSequence" % 3)::int WHEN 0 THEN 'THURSDAY' WHEN 1 THEN 'FRIDAY' ELSE 'SATURDAY' END,
      'DELIVERY', 'Area-' || lpad(("displayOrderSequence" % 50)::text, 2, '0'),
      'READY_TO_PLAN'::"OrderDeliveryFactReadiness", '[]'::jsonb, true,
      'RESOLVED'::"GeocodeStatus", now(), now(), now()
    FROM "orders" WHERE "shopId" = '${shopId}'::uuid
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "delivery_stops" (
      "id", "shopId", "orderId", "recipientName", "phone", "address1", "city", "province",
      "postalCode", "countryCode", "latitude", "longitude", "geocodeStatus", "deliveryDate",
      "serviceMinutes", "priority", "status", "createdAt", "updatedAt"
    )
    SELECT
      gen_random_uuid(), "shopId", "id", 'Evidence Customer', "phone",
      "displayOrderSequence" || ' Evidence Street', 'Toronto', 'ON', 'M1M 1M1', 'CA',
      43.65 + (("displayOrderSequence" % 100)::numeric / 10000),
      -79.38 + (("displayOrderSequence" % 100)::numeric / 10000),
      'RESOLVED'::"GeocodeStatus", current_date + (("displayOrderSequence" % 7)::int),
      5, 0, 'PENDING'::"DeliveryStopStatus", now(), now()
    FROM "orders" WHERE "shopId" = '${shopId}'::uuid
  `);
  await prisma.$executeRawUnsafe('ANALYZE "orders"');
  await prisma.$executeRawUnsafe('ANALYZE "order_delivery_facts"');
  await prisma.$executeRawUnsafe('ANALYZE "delivery_stops"');
}

async function inspectPrivacyCanary(): Promise<{ pass: boolean; persistedKeys: string[] }> {
  const rows = await prisma.orderSelectionSnapshot.findMany({
    select: {
      actorSubjectHash: true,
      appId: true,
      filterHash: true,
      selectedCount: true,
      sort: true,
      tokenHash: true
    },
    take: 1
  });
  const serialized = JSON.stringify(rows);
  const forbidden = ['orders-performance-actor', '@invalid.test', '+1555', 'privacy-canary', 'Evidence Street'];
  return {
    pass: forbidden.every((value) => !serialized.includes(value)),
    persistedKeys: Object.keys(rows[0] ?? {}).sort()
  };
}

async function measure(operation: () => Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await operation();
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

async function measureRepeated(count: number, operation: (index: number) => Promise<void>): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) samples.push(await measure(() => operation(index)));
  return samples;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 500_000) {
    throw new Error('ORDERS_PERF_ORDER_COUNT must be an integer between 100 and 500000');
  }
  return parsed;
}
