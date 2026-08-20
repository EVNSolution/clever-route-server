import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('route group virtual copy ownership migration', () => {
  test('aborts on shared or orphan CUSTOM orders before adding or backfilling ownership', () => {
    const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20260820093000_own_virtual_route_group_orders/migration.sql'), 'utf8');
    const guard = sql.indexOf('DO $$');
    const raise = sql.indexOf('RAISE EXCEPTION');
    const addColumn = sql.indexOf('ADD COLUMN "ownedRouteGroupingId"');
    const backfill = sql.indexOf('UPDATE "orders"');

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(raise).toBeGreaterThan(guard);
    expect(raise).toBeLessThan(addColumn);
    expect(addColumn).toBeLessThan(backfill);
    expect(sql).toContain('HAVING COUNT(DISTINCT rgo."groupingId") > 1');
    expect(sql).toContain("o.\"sourcePlatform\" = 'CUSTOM'");
    expect(sql).toContain('foreign_route_plan_count');
    expect(sql.indexOf('foreign_route_plan_count')).toBeLessThan(addColumn);
    expect(sql).not.toMatch(/email|phone|address|rawPayload/iu);
  });

  test('enforces tenant-scoped owner relation and CUSTOM-only ownership', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20260820093000_own_virtual_route_group_orders/migration.sql'), 'utf8');

    expect(schema).toContain('ownedRouteGroupingId');
    expect(schema).toContain('@relation("RouteGroupingOwnedCustomOrders", fields: [ownedRouteGroupingId, shopId], references: [id, shopId], onDelete: Restrict)');
    expect(sql).toContain('FOREIGN KEY ("ownedRouteGroupingId", "shopId")');
    expect(sql).toContain('"sourcePlatform" = \'CUSTOM\' AND "ownedRouteGroupingId" IS NOT NULL');
    expect(sql).toContain('"sourcePlatform" <> \'CUSTOM\' AND "ownedRouteGroupingId" IS NULL');
    expect(sql).toContain('CREATE TRIGGER "route_grouping_orders_custom_owner_match_trigger"');
    expect(sql).toContain('order_owner IS DISTINCT FROM NEW."groupingId"');
    expect(sql).toContain('FOR SHARE;');
    expect(sql).toContain('FOR SHARE OF o;');
    expect(sql.match(/FROM "route_plans" rp[\s\S]*?FOR UPDATE;/g)).toHaveLength(2);
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER "route_grouping_orders_custom_owner_required_trigger"');
    expect(sql).toContain('CREATE TRIGGER "orders_custom_owner_memberships_match_trigger"');
    expect(sql).toContain('rgo."groupingId" IS DISTINCT FROM NEW."ownedRouteGroupingId"');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER "route_plan_stops_custom_owner_match_trigger"');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('child."groupingId" = order_owner');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER "route_grouping_child_versions_custom_owner_match_trigger"');
  });

  test('keeps the PII-free ownership audit runnable before and after the migration', () => {
    const source = readFileSync(join(process.cwd(), 'src/scripts/audit-custom-route-order-ownership.ts'), 'utf8');

    expect(source).toContain('information_schema.columns');
    expect(source).toContain("column_name = 'ownedRouteGroupingId'");
    expect(source).toContain('ownershipColumnPresent');
    expect(source).toContain('ownerMismatchCustomOrders');
    expect(source).toContain('foreignRoutePlanAssociations');
    expect(source).not.toMatch(/SELECT[\s\S]{0,80}(email|phone|address|rawPayload)/iu);
  });
});
