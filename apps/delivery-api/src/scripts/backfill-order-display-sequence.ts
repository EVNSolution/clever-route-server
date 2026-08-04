import { PrismaClient } from '@prisma/client';
import { parseOrderDisplaySequence } from '../modules/shopify/order-display-sequence.js';

const prisma = new PrismaClient();
const batchSize = readBatchSize(process.env.ORDERS_DISPLAY_SEQUENCE_BACKFILL_BATCH_SIZE);

let updated = 0;
let rejected = 0;
let lastId: string | undefined;
const outcomes = new Map<string, { rejected: number; scanned: number; updated: number }>();

try {
  for (;;) {
    const rows = await prisma.order.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, sourceOrderNumber: true, sourcePlatform: true },
      take: batchSize,
      where: {
        displayOrderSequence: null,
        ...(lastId === undefined ? {} : { id: { gt: lastId } })
      }
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      lastId = row.id;
      const outcome = outcomes.get(row.sourcePlatform) ?? { rejected: 0, scanned: 0, updated: 0 };
      outcome.scanned += 1;
      outcomes.set(row.sourcePlatform, outcome);
      const sequence = parseOrderDisplaySequence(row.sourceOrderNumber ?? row.name);
      if (sequence === null) {
        rejected += 1;
        outcome.rejected += 1;
        continue;
      }
      const result = await prisma.order.updateMany({
        data: { displayOrderSequence: sequence },
        where: { displayOrderSequence: null, id: row.id }
      });
      updated += result.count;
      outcome.updated += result.count;
    }
    process.stdout.write(`${JSON.stringify({ batchCount: rows.length, rejected, updated })}\n`);
  }
  const remaining = await prisma.order.count({ where: { displayOrderSequence: null } });
  process.stdout.write(`${JSON.stringify({
    complete: remaining === 0,
    outcomesBySource: Object.fromEntries([...outcomes.entries()].sort(([left], [right]) => left.localeCompare(right))),
    rejected,
    remaining,
    updated
  })}\n`);
  if (remaining > 0) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}

function readBatchSize(value: string | undefined): number {
  const parsed = Number(value ?? '500');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5_000) throw new Error('Invalid backfill batch size');
  return parsed;
}
