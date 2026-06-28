import { describe, expect, test } from 'vitest';
import { classifyCoordinateInPolygons } from '../src/modules/route-grouping/route-grouping.geometry.js';
import { FakeDriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('route grouping contracts', () => {
  test('keeps RoutePlanStatus free of UI-derived published/superseded values', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const enumBody = /enum RoutePlanStatus \{(?<body>[\s\S]*?)\}/u.exec(schema)?.groups?.body ?? '';
    expect(enumBody).toContain('ASSIGNED');
    expect(enumBody).not.toContain('PUBLISHED');
    expect(enumBody).not.toContain('SUPERSEDED');
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
    expect(source).toContain('const routePlan = await createChildRoutePlan(tx, loaded, candidate, input.actor)');
  });

  test('defaults generated route groups to loop back to the depot', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain("const DEFAULT_ROUTE_GROUPING_ROUTE_END_MODE = 'RETURN_TO_DEPOT'");
    expect(source).toContain('routeEndMode: DEFAULT_ROUTE_GROUPING_ROUTE_END_MODE');
    expect(source).toContain('constraints: routeConstraints(loaded, candidate.depot)');
  });

  test('requires one explicit root draft row before saving route detail edits', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('assertDraftRouteEnvelope(routes)');
    expect(source).toContain('const rootRoutes = routes.filter(isRootDraftRoute)');
    expect(source).toContain("rootRoutes.length !== 1");
    expect(source).toContain("'route draft route keys must be unique'");
  });

  test('keeps ordinary draft save from consuming existing route geometry payloads', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('const draftOptimized = normalizeOptionalText(route.routePlanId) === null ? route.optimized : undefined');
    expect(source).toContain("route.tempId !== null && route.tempId !== undefined && route.tempId !== '' && route.orderIds.length > 0");
    expect(source).toContain('logIgnoredExistingRouteOptimizedPayload(group.id, targetChild.routePlanId, route.routeKey ?? null)');
    expect(source).toContain('logPreservedExistingRouteGeometryCache(group.id, targetChild.routePlanId, route.routeKey ?? null)');
    expect(source).toContain('function routeAssignmentsChanged(child: LoadedChild, assignments: LoadedAssignment[]): boolean');
    expect(source).toContain('errorName: reason instanceof Error ? reason.name : typeof reason');
    expect(source).not.toContain('errorMessage: reason instanceof Error ? reason.message : String(reason)');
  });

  test('materializes non-empty draft branches without saving empty routes', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('async function createDraftChildRoutePlan(');
    expect(source).toContain('if (isRootDraftRoute(route) || normalizeOptionalText(route.routePlanId) !== null || route.orderIds.length === 0) continue');
    expect(source).toContain('routePlanId: routePlan.id');
    expect(source).toContain('snapshot: createChildSnapshot(group, input.assignments, null, routePlan.name, group.currentVersion, input.color ?? null)');
  });

  test('keeps branch colors attached when re-optimization recreates child routes', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain('color: readChildSnapshot(child.snapshot).color ?? null');
    expect(source).toContain('color: effectiveGroup.color ?? null');
    expect(source).toContain('snapshot: createChildSnapshot(loaded, candidate.assignments, candidate.driverId, routePlan.name, loaded.currentVersion, candidate.color)');
  });

  test('allows default unassigned child route generation before dispatch', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).toContain("assignment.assignmentStatus === 'ASSIGNED' ? assignment.assignedDriverId : null");
    expect(source).toContain("assignment.assignmentStatus !== 'ASSIGNED' && assignment.assignmentStatus !== 'UNASSIGNED'");
    expect(source).toContain("driverId === null ? 'Unassigned'");
  });

  test('keeps route group deletion free of child-route status blockers', () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(source).not.toContain('child route status no longer allows delete');
    expect(source).not.toContain('assertGroupingDeleteAllowed');
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
