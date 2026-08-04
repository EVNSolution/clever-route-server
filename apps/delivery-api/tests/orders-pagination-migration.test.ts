import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('orders pagination migration and backfill', () => {
  test('keeps schema expansion non-destructive and moves population to a bounded restartable script', () => {
    const migration = readFileSync(new URL('../prisma/migrations/20260804020000_orders_pagination_selection/migration.sql', import.meta.url), 'utf8');
    const backfill = readFileSync(new URL('../src/scripts/backfill-order-display-sequence.ts', import.meta.url), 'utf8');
    expect(migration).toContain('ADD COLUMN "displayOrderSequence" BIGINT');
    expect(migration).not.toMatch(/UPDATE\s+"orders"/u);
    expect(migration).toContain('"displayOrderSequence" DESC, "id" DESC');
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(migration).toContain('"delivery_stops" USING GIN ("recipientName" gin_trgm_ops)');
    expect(migration).toContain('"order_delivery_facts" USING GIN ("deliveryArea" gin_trgm_ops)');
    expect(backfill).toContain('take: batchSize');
    expect(backfill).toContain('displayOrderSequence: null');
    expect(backfill).not.toContain('batchLastId');
    expect(backfill).toContain('outcomesBySource');
  });
});
