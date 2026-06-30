import { describe, expect, test } from 'vitest';
import { classifyCoordinateInPolygons } from '../src/modules/route-grouping/route-grouping.geometry.js';
import { FakeDriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('route grouping contracts', () => {
  test('keeps app-created route lifecycles limited to draft/published/cancelled', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const routePlanModel = /model RoutePlan \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    const routeGroupModel = /model RouteGrouping \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    expect(routePlanModel).toContain('status');
    expect(routePlanModel).toContain('@default(DRAFT)');
    expect(routeGroupModel).toContain('status');
    expect(routeGroupModel).toContain('@default(DRAFT)');

    const service = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(service).toContain("status: 'DRAFT'");
    expect(service).toContain("status: 'PUBLISHED'");
    expect(service).toContain("status: 'CANCELLED'");
    expect(service).not.toContain("status: 'OPTIMIZED'");
    expect(service).not.toContain("status: 'IN_PROGRESS'");
    expect(service).not.toContain("status: 'COMPLETED'");
  });

  test('keeps parent route group date range on the canonical model', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const modelBody = /model RouteGrouping \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    expect(modelBody).toContain('dateRangeStart       DateTime?');
    expect(modelBody).toContain('dateRangeEnd         DateTime?');
    expect(modelBody).toContain('@@index([shopId, dateRangeStart, dateRangeEnd, status])');
  });

  test('keeps branch ownership as an explicit active lock table', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const branchBody = /model RouteGroupingBranch \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    const lockBody = /model RouteGroupingBranchOrderLock \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    expect(branchBody).toContain('orderLocks');
    expect(lockBody).toContain('@@unique([shopId, orderId])');
    expect(lockBody).not.toContain('releasedAt');
    expect(lockBody).not.toContain('status');
  });

  test('links route groups to inventory without child branch deltas', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const inventoryBody = /model Inventory \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    const routeGroupBody = /model RouteGrouping \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    expect(inventoryBody).toContain('routeGroupingId');
    expect(inventoryBody).toContain('@unique');
    expect(inventoryBody).toContain('onDelete: SetNull');
    expect(routeGroupBody).toContain('inventory');

    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('createRouteGroupingInventory(tx');
    expect(source).toContain('syncRouteGroupingInventoryOrders(tx');
    expect(source).toContain('await recomputeAssignments(tx, group.id)');
    expect(source).not.toContain('syncRouteGroupingInventoryOrders(tx, input.branch');
  });

  test('keeps inventory history after order item replacement', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const eventBody = /model InventoryEvent \{(?<body>[\s\S]*?)\n\}/u.exec(schema)?.groups?.body ?? '';
    expect(eventBody).toMatch(/orderItemId\s+String\?/u);
    expect(eventBody).toContain('onDelete: SetNull');
    expect(eventBody).toContain('quantityDelta Int?');

    const source = readFileSync(join(process.cwd(), 'src/modules/shopify/order-sync.repository.ts'), 'utf8');
    expect(source).toContain('const previousItems = await input.tx.orderItem.findMany');
    expect(source).toContain('recordInventorySourceItemDeltas(input.tx');
    expect(source).toContain('actor: "order-sync"');
  });


  test('backfills existing route groups into linked inventories during migration', () => {
    const migration = readFileSync(join(process.cwd(), 'prisma/migrations/20260629183000_link_route_grouping_inventory/migration.sql'), 'utf8');
    expect(migration).toContain('WITH missing_group_inventories AS');
    expect(migration).toContain('FROM "route_groupings" rg');
    expect(migration).toContain('JOIN "route_grouping_orders" rgo');
    expect(migration).toContain('ON CONFLICT ("inventoryId", "orderId") DO NOTHING');
  });

  test('allows standalone inventory creation while keeping route-group inventory sync separate', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/inventory/inventory.service.ts'), 'utf8');
    const routes = readFileSync(join(process.cwd(), 'src/routes/admin-inventories.routes.ts'), 'utf8');
    expect(source).toContain('async createInventory(input: CreateInventoryInput)');
    expect(source).toContain('routeGroupingId: null');
    expect(source).toContain('route group inventory is managed by route groups');
    expect(routes).toContain('inventoryService.createInventory');
    expect(routes).not.toContain('inventory is managed by route groups');
  });

  test('classifies overlapping split polygons by latest draw order', () => {
    const first = { id: 'a', vertices: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 10 }, { latitude: 10, longitude: 10 }, { latitude: 10, longitude: 0 }] };
    const second = { id: 'b', vertices: [{ latitude: 5, longitude: 5 }, { latitude: 5, longitude: 15 }, { latitude: 15, longitude: 15 }, { latitude: 15, longitude: 5 }] };
    expect(classifyCoordinateInPolygons({ latitude: 1, longitude: 1 }, [first, second])).toEqual({ status: 'ASSIGNED', polygonIds: ['a'] });
    expect(classifyCoordinateInPolygons({ latitude: 20, longitude: 20 }, [first, second])).toEqual({ status: 'UNASSIGNED', polygonIds: [] });
    expect(classifyCoordinateInPolygons({ latitude: 6, longitude: 6 }, [first, second])).toEqual({ status: 'ASSIGNED', polygonIds: ['b'] });
    expect(classifyCoordinateInPolygons({ latitude: 0, longitude: 5 }, [first])).toEqual({ status: 'ASSIGNED', polygonIds: ['a'] });
  });


  test('lets re-optimization persist visible route slots without a pre-save blocker', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).not.toContain('save route changes before re-optimizing new routes');
    expect(source).toContain('const routeSlotCount = Math.max(routeAssignmentGroups.length, currentChildren.length)');
    expect(source).toContain('const numberedCandidate = { ...candidate, name: `Route ${routeIdx}`, routeIdx }');
    expect(source).toContain('const routePlan = await createChildRoutePlan(tx, loaded, numberedCandidate, input.actor)');
  });

  test('defaults generated route groups to loop back to the depot', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain("const DEFAULT_ROUTE_GROUPING_ROUTE_END_MODE = 'RETURN_TO_DEPOT'");
    expect(source).toContain('routeEndMode: DEFAULT_ROUTE_GROUPING_ROUTE_END_MODE');
    expect(source).toContain('constraints: routeConstraints(loaded, candidate.depot)');
  });

  test('keeps draft saves child-only without root or branch rows', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('assertChildOnlyDraftRouteEnvelope(routes)');
    expect(source).toContain('routePlanId !== null ? `routePlan:${routePlanId}`');
    expect(source).toContain('tempId !== null ? `temp:${tempId}`');
    expect(source).toContain('routeIdx !== undefined ? `routeIdx:${routeIdx}`');
    expect(source).toContain("route draft must not include a root route row");
    expect(source).toContain("route draft must include child routes only");
    expect(source).toContain("'route draft route keys must be unique'");
  });

  test('keeps ordinary draft save from consuming existing route geometry payloads', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('if (route.optimized !== undefined && targetChild.routePlanId !== null)');
    expect(source).toContain('optimized: route.optimized ?? null');
    expect(source).toContain('logIgnoredExistingRouteOptimizedPayload(group.id, targetChild.routePlanId, route.routeKey ?? null)');
    expect(source).toContain('logPreservedExistingRouteGeometryCache(group.id, targetChild.routePlanId, route.routeKey ?? null)');
    expect(source).toContain('function routeAssignmentsChanged(child: LoadedChild, assignments: LoadedAssignment[]): boolean');
    expect(source).toContain('errorName: reason instanceof Error ? reason.name : typeof reason');
    expect(source).not.toContain('errorMessage: reason instanceof Error ? reason.message : String(reason)');
  });

  test('materializes child draft rows with server-assigned routeIdx', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('async function createDraftChildRoutePlan(');
    expect(source).toContain('const routeIdx = await nextGlobalRouteIdx(tx, group.shopId)');
    expect(source).toContain('name: route.label ?? `Route ${routeIdx}`');
    expect(source).toContain('routeIdx,');
    expect(source).toContain('routePlanId: routePlan.id');
    expect(source).toContain('snapshot: createChildSnapshot(group, input.assignments, null, routePlan.name, group.currentVersion, input.color ?? null, input.sortOrder, input.routeIdx)');
  });

  test('does not replace a single generated child route when no split exists', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('if (candidates.length < 2)');
    expect(source).toContain('if (routeAssignmentGroups.length < 2) return []');
    expect(source).toContain('createDraftChildRoutePlan(tx, loaded');
    expect(source).toContain('name: `Route ${routeIdx}`');
  });

  test('keeps child colors and routeIdx attached when re-optimization recreates child routes', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('color: readChildSnapshot(child.snapshot).color ?? null');
    expect(source).toContain('color: effectiveGroup.color ?? null');
    expect(source).toContain('const existingRouteIdx = existingChildSnapshot.routeIdx ?? await nextGlobalRouteIdx(tx, loaded.shopId)');
    expect(source).toContain('snapshot: createChildSnapshot(loaded, numberedCandidate.assignments, numberedCandidate.driverId, routePlan.name, loaded.currentVersion, numberedCandidate.color, routeIdx, routeIdx)');
  });

  test('persists global routeIdx separately from editable names', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');

    expect(source).toContain('routeIdx?: number;');
    expect(source).toContain('sortOrder?: number;');
    expect(source).toContain('routeIdx: snapshot.routeIdx ?? null');
    expect(source).toContain('sortOrder: snapshot.sortOrder ?? null');
    expect(source).toContain('function nextGlobalRouteIdx');
    expect(source).not.toContain('return Math.max(max._max.sortOrder ?? 1, 1) + 1');
    expect(types).toContain('routeIdx: number | null');
    expect(types).toContain('sortOrder: number | null');
  });


  test('allocates child route indexes globally instead of per-group sort order', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');

    expect(types).toContain('routeIdx: number | null');
    expect(source).toContain('routeIdx?: number;');
    expect(source).toContain('function nextGlobalRouteIdx');
    expect(source).toContain('pg_advisory_xact_lock');
    expect(source).toContain('routeIdx: snapshot.routeIdx ?? null');
    expect(source).not.toContain('return Math.max(max._max.sortOrder ?? 1, 1) + 1');
  });

  test('creates a default child route when a route group is created', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const start = source.indexOf('async createGrouping(');
    const end = source.indexOf('async getGrouping(', start);
    const createGroupingBody = source.slice(start, end);

    expect(createGroupingBody).toContain('const routeIdx = await nextGlobalRouteIdx');
    expect(createGroupingBody).toContain('createDraftChildRoutePlan');
    expect(createGroupingBody).toContain('name: `Route ${routeIdx}`');
    expect(createGroupingBody).toContain('routeIdx');
    expect(createGroupingBody).toContain("status: 'CURRENT'");
  });

  test('keeps draft save child-only and rejects stale route indexes', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const start = source.indexOf('async saveDraft(');
    const end = source.indexOf('async savePolygons(', start);
    const saveDraftBody = source.slice(start, end);

    expect(saveDraftBody).toContain('assertChildOnlyDraftRouteEnvelope(routes)');
    expect(saveDraftBody).toContain('route draft routeIdx changed; reload and retry');
    expect(saveDraftBody).toContain('routeIdx: readChildSnapshot(targetChild.snapshot).routeIdx');
    expect(saveDraftBody).not.toContain('routeGroupingBranch.create');
    expect(saveDraftBody).not.toContain('routeGroupingBranch.update');
    expect(saveDraftBody).not.toContain('routeGroupingBranchOrderLock.createMany');
    expect(saveDraftBody).not.toContain('routeBranchId');
  });

  test('uses numbered child route names before dispatch', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain("assignment.assignmentStatus === 'ASSIGNED' ? assignment.assignedDriverId : null");
    expect(source).toContain("assignment.assignmentStatus !== 'ASSIGNED' && assignment.assignmentStatus !== 'UNASSIGNED'");
    expect(source).toContain('name: `Route ${index + 1}`');
    expect(source).not.toContain('return `${group.name} — ${driverName}`');
  });

  test('keeps route group deletion free of child-route status blockers', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).not.toContain('child route status no longer allows delete');
    expect(source).not.toContain('assertGroupingDeleteAllowed');
  });

  test('marks the parent route group published when a child route is published', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain("this.prisma.routeGrouping.updateMany({ data: { status: 'PUBLISHED' }");
    expect(source).toContain("where: { id: child.groupingId, status: { not: 'CANCELLED' } }");
  });

  test('keeps parent switch route on the group id, not the first child route', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');

    expect(source).toContain('add(group.name, null, group.id)');
    expect(source).not.toContain('add(group.name, currentChildren.find');
    expect(types).toContain('routeGroupId?: string | null');
  });

  test('fake FCM provider records string-safe route payload fields', async () => {
    const provider = new FakeDriverPushProvider();
    const result = await provider.sendRouteNotification({
      action: 'changed',
      childVersion: 2,
      devicePushToken: 'token',
      routeGroupingId: 'group',
      routePlanId: 'route'
    });
    expect(result.status).toBe('SENT');
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]?.childVersion).toBe(2);
  });
});
