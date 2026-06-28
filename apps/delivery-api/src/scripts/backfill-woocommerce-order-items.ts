import { PrismaClient } from '@prisma/client';

import {
  hasItemReviewReason,
  mergeItemReviewReasons,
  parseWooCommerceOrderItems
} from '../modules/order-items/order-items.js';
import type { WooCommerceLineItem } from '../modules/woocommerce/woocommerce-order.types.js';
import { recordInventorySourceItemDeltas } from '../modules/inventory/inventory.service.js';
import { toOrderItemDto } from '../modules/order-items/order-items.js';

const prisma = new PrismaClient();

type Mode = 'apply' | 'dry-run';

type Counts = {
  applied: number;
  failed: number;
  invalid: number;
  scanned: number;
  skipped: number;
  wouldApply: number;
};

async function main(): Promise<void> {
  const mode = readMode(process.argv.slice(2));
  const counts: Counts = { applied: 0, failed: 0, invalid: 0, scanned: 0, skipped: 0, wouldApply: 0 };
  const orders = await prisma.order.findMany({
    include: {
      deliveryFacts: { take: 1 },
      orderItems: true
    },
    orderBy: { updatedAt: 'asc' },
    where: { sourcePlatform: 'WOOCOMMERCE' }
  });

  for (const order of orders) {
    counts.scanned += 1;
    const lineItems = readWooLineItems(order.rawPayload);
    const parsed = parseWooCommerceOrderItems(lineItems);
    const existingFact = order.deliveryFacts[0] ?? null;
    const existingReasons = readStringArray(existingFact?.reviewReasons) ?? [];
    const nextReasons = mergeItemReviewReasons(existingReasons, parsed.reviewReasons);
    const invalid = parsed.reviewReasons.length > 0;
    if (invalid) counts.invalid += 1;

    const alreadyBackfilled = order.orderItems.length > 0 && !hasItemReviewReason(existingReasons);
    if (!invalid && alreadyBackfilled) {
      counts.skipped += 1;
      continue;
    }

    if (mode === 'dry-run') {
      counts.wouldApply += 1;
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        const previousItems = await tx.orderItem.findMany({ orderBy: { lineIndex: 'asc' }, where: { orderId: order.id, shopId: order.shopId } });
        await tx.orderItem.deleteMany({ where: { orderId: order.id, shopId: order.shopId } });
        if (parsed.items.length > 0) {
          await tx.orderItem.createMany({
            data: parsed.items.map((item, index) => ({
              lineIndex: index,
              name: item.name,
              options: item.options,
              orderId: order.id,
              productId: item.productId,
              quantity: item.quantity,
              shopId: order.shopId,
              sku: item.sku,
              variationId: item.variationId
            }))
          });
        }
        const currentItems = await tx.orderItem.findMany({ orderBy: { lineIndex: 'asc' }, where: { orderId: order.id, shopId: order.shopId } });
        await recordInventorySourceItemDeltas(tx, {
          actor: 'woocommerce-order-items-backfill',
          currentItems: currentItems.map(toOrderItemDto),
          orderId: order.id,
          previousItems: previousItems.map(toOrderItemDto),
          shopId: order.shopId
        });
        if (existingFact !== null) {
          const readiness = nextReasons.length === 0 && existingFact.deliveryDate !== null && existingFact.routeScopeKey !== null && existingFact.serviceType !== null
            ? 'READY_TO_PLAN'
            : 'NEEDS_REVIEW';
          await tx.orderDeliveryFact.update({
            data: {
              batchEligible: readiness === 'READY_TO_PLAN',
              readiness,
              reviewReasons: nextReasons
            },
            where: { id: existingFact.id }
          });
        }
      });
      counts.applied += 1;
    } catch (error) {
      counts.failed += 1;
      console.error(`failed order ${order.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(JSON.stringify({ mode, ...counts }, null, 2));
  if (counts.failed > 0) {
    process.exitCode = 1;
  }
}

function readMode(args: string[]): Mode {
  if (args.includes('--apply')) return 'apply';
  if (args.includes('--dry-run')) return 'dry-run';
  throw new Error('Usage: tsx src/scripts/backfill-woocommerce-order-items.ts --dry-run|--apply');
}

function readWooLineItems(rawPayload: unknown): WooCommerceLineItem[] | null {
  const raw = objectOrNull(rawPayload);
  const lineItems = raw?.line_items;
  return Array.isArray(lineItems) ? lineItems as WooCommerceLineItem[] : null;
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
