import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { buildWooDeliveryFactsEvidence } from './woocommerce-delivery-facts-evidence.lib.js';
import { appScopedShopWhere } from '../modules/shopify/shopify-app-scope.js';

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
          where: appScopedShopWhere({ shopDomain: normalizeShopDomain(shopDomain) }),
        });

  const facts = await prisma.orderDeliveryFact.findMany({
    include: {
      order: {
        select: {
          deliveryStops: {
            select: {
              latitude: true,
              longitude: true,
              routePlanStops: { select: { id: true } },
            },
            take: 1,
          },
        },
      },
    },
    where: {
      ...(connectionId === null ? {} : { commerceConnectionId: connectionId }),
      ...(shop === null ? {} : { shopId: shop.id }),
      sourcePlatform: 'WOOCOMMERCE',
    },
  });

  const evidence = buildWooDeliveryFactsEvidence({
    connectionId,
    expectedTotal,
    facts,
    shopDomain: shop?.shopDomain ?? shopDomain,
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}
`;
  if (outputPath !== null) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, 'utf8');
  }
  process.stdout.write(serialized);
} finally {
  await prisma.$disconnect();
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
