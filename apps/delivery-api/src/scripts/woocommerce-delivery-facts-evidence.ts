import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

try {
  const connectionId = readOptionalEnv('WOOCOMMERCE_EVIDENCE_CONNECTION_ID');
  const shopDomain = readOptionalEnv('WOOCOMMERCE_EVIDENCE_SHOP_DOMAIN');
  const expectedTotal = readOptionalIntegerEnv('WOOCOMMERCE_EVIDENCE_EXPECTED_TOTAL') ?? 167;
  const outputPath = readOptionalEnv('WOOCOMMERCE_EVIDENCE_OUTPUT');

  const shop =
    shopDomain === null
      ? null
      : await prisma.shop.findUnique({
          select: { id: true, shopDomain: true },
          where: { shopDomain: normalizeShopDomain(shopDomain) }
        });

  const facts = await prisma.orderDeliveryFact.findMany({
    include: {
      order: {
        select: {
          deliveryStops: {
            select: {
              latitude: true,
              longitude: true,
              routePlanStops: { select: { id: true } }
            },
            take: 1
          }
        }
      }
    },
    where: {
      ...(connectionId === null ? {} : { commerceConnectionId: connectionId }),
      ...(shop === null ? {} : { shopId: shop.id }),
      sourcePlatform: 'WOOCOMMERCE'
    }
  });

  const evidence = buildEvidence({
    connectionId,
    expectedTotal,
    facts,
    shopDomain: shop?.shopDomain ?? shopDomain
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputPath !== null) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, 'utf8');
  }
  process.stdout.write(serialized);
} finally {
  await prisma.$disconnect();
}

type FactRecord = Awaited<ReturnType<typeof prisma.orderDeliveryFact.findMany>>[number] & {
  order: {
    deliveryStops: Array<{
      latitude: unknown;
      longitude: unknown;
      routePlanStops: Array<{ id: string }>;
    }>;
  };
};

function buildEvidence(input: {
  connectionId: string | null;
  expectedTotal: number;
  facts: FactRecord[];
  shopDomain: string | null;
}): Record<string, unknown> {
  const reviewReasonCounts = new Map<string, number>();
  let alreadyPlanned = 0;
  let dateDayMismatch = 0;
  let missingCoordinates = 0;
  let ready = 0;
  let unverifiedDayTime = 0;

  for (const fact of input.facts) {
    const reasons = readStringArray(fact.reviewReasons);
    for (const reason of reasons) {
      reviewReasonCounts.set(reason, (reviewReasonCounts.get(reason) ?? 0) + 1);
    }
    const stop = fact.order.deliveryStops[0] ?? null;
    const hasCoordinates = stop?.latitude !== null && stop?.latitude !== undefined && stop.longitude !== null && stop.longitude !== undefined;
    const planned = (stop?.routePlanStops.length ?? 0) > 0;
    const mismatch = fact.deliveryDateWeekdayMismatch || reasons.includes('delivery_date_weekday_mismatch');
    const rawDayOrTimePresent = fact.rawDeliveryDay !== null || fact.rawDeliveryTimeWindow !== null;
    const unverified =
      rawDayOrTimePresent &&
      (!fact.deliveryDateWeekdayVerified ||
        fact.deliveryDayParseStatus === 'UNPARSED' ||
        fact.deliveryDayParseStatus === 'UNVERIFIED' ||
        reasons.includes('delivery_day_unparsed') ||
        reasons.includes('delivery_date_weekday_unverified'));

    if (planned) alreadyPlanned += 1;
    if (mismatch) dateDayMismatch += 1;
    if (!hasCoordinates) missingCoordinates += 1;
    if (unverified) unverifiedDayTime += 1;
    if (fact.readiness === 'READY_TO_PLAN' && hasCoordinates && !planned && !mismatch && !unverified) ready += 1;
  }

  return {
    already_planned: alreadyPlanned,
    blocked: input.facts.length - ready,
    connection_id: input.connectionId,
    count_matches_expected: input.facts.length === input.expectedTotal,
    date_day_mismatch: dateDayMismatch,
    expected_total: input.expectedTotal,
    generated_at: new Date().toISOString(),
    missing_coordinates: missingCoordinates,
    ready,
    review_reason_counts: Object.fromEntries(
      [...reviewReasonCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20)
    ),
    shop_domain: input.shopDomain,
    total: input.facts.length,
    unverified_day_time: unverifiedDayTime
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//iu, '').replace(/\/.*$/u, '');
}

function readOptionalEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? null : value.trim();
}

function readOptionalIntegerEnv(name: string): number | null {
  const value = readOptionalEnv(name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
