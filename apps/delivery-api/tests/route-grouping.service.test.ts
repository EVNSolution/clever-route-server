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

  test('classifies inside, outside, overlap, and boundary deterministically', () => {
    const first = { id: 'a', vertices: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 10 }, { latitude: 10, longitude: 10 }, { latitude: 10, longitude: 0 }] };
    const second = { id: 'b', vertices: [{ latitude: 5, longitude: 5 }, { latitude: 5, longitude: 15 }, { latitude: 15, longitude: 15 }, { latitude: 15, longitude: 5 }] };
    expect(classifyCoordinateInPolygons({ latitude: 1, longitude: 1 }, [first, second])).toEqual({ status: 'ASSIGNED', polygonIds: ['a'] });
    expect(classifyCoordinateInPolygons({ latitude: 20, longitude: 20 }, [first, second])).toEqual({ status: 'UNASSIGNED', polygonIds: [] });
    expect(classifyCoordinateInPolygons({ latitude: 6, longitude: 6 }, [first, second])).toEqual({ status: 'OVERLAP', polygonIds: ['a', 'b'] });
    expect(classifyCoordinateInPolygons({ latitude: 0, longitude: 5 }, [first])).toEqual({ status: 'ASSIGNED', polygonIds: ['a'] });
  });


  test('precomputes optimized child route projections before committing current children', () => {
    const serviceSource = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const dependencySource = readFileSync(join(process.cwd(), 'src/modules/commerce/admin-commerce-connections.dependencies.ts'), 'utf8');

    expect(serviceSource).toContain('prepareOptimizedChildRouteCandidates(initial, input.shopDomain)');
    expect(serviceSource).toContain('createCurrentGroupingVersion(tx, loaded');
    expect(serviceSource).toContain("changeReason: 'generate_child_routes', status: 'CURRENT'");
    expect(serviceSource).toContain('validateChildRouteStopsNearDepot(assignments, depot, this.maxChildRouteStopDistanceFromDepotMeters())');
    expect(serviceSource).toContain('routeGeometryCacheCreateData');
    expect(serviceSource).toContain('child route contains stops outside depot coverage');
    expect(serviceSource).toContain('routeOptimizationService.optimizeStopOrderWithDiagnostics');
    expect(serviceSource).toContain('resolveChildRouteOptimization(this.routeOptimizationService, sourceDetail, shopDomain)');
    expect(serviceSource).toContain('buildChildRouteGeometry(this.routeGeometryProvider, optimizedDetail)');
    expect(serviceSource).toContain('child route geometry failed');
    expect(serviceSource).toContain('createChildRouteGeometryCache(tx, routePlan.id, candidate)');
    expect(serviceSource).toContain('return `${group.name} — ${driverName}`;');
    expect(serviceSource).not.toContain('return `${group.name} — ${driverName} v${version}`;');
    expect(serviceSource).toContain('stripGeneratedChildRouteVersion(snapshot.name)');
    expect(serviceSource).toContain("source: 'SNAPSHOT'");
    expect(serviceSource).toContain('await this.refreshChildRouteGeometry(projection.childRoutePlanIds, input.shopDomain);');
    expect(serviceSource).not.toContain('await this.refreshChildRouteGeometry(projection.childRoutePlanIds, input.shopDomain);\\n    return this.getGrouping({ groupingId: projection.groupingId, shopDomain: input.shopDomain });\\n  }\\n\\n  async rollback');
    expect(dependencySource).toContain('refreshRouteGeometryForRoutePlan.bind(routePlanDeps.routePlanService)');
    expect(dependencySource).toContain('routeOptimizationDeps.routeOptimizationService');
    expect(dependencySource).toContain('routeGeometryProvider');
  });

  test('polygon saves are stale-write guarded and require explicit deletion', () => {
    const serviceSource = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const routeSource = readFileSync(join(process.cwd(), 'src/routes/admin-commerce-connections-ui.routes.ts'), 'utf8');
    const typesSource = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.types.ts'), 'utf8');

    expect(typesSource).toContain('expectedUpdatedAt: string');
    expect(typesSource).toContain('deletePolygonIds?: string[]');
    expect(typesSource).toContain('RouteGroupingConflictError');
    expect(serviceSource).toContain('updatedAt: expectedUpdatedAt');
    expect(serviceSource).toContain('throw new RouteGroupingConflictError()');
    expect(serviceSource).toContain('existing polygons cannot be omitted without explicit deletion');
    expect(serviceSource).toContain('await tx.routeGroupingPolygon.deleteMany');
    expect(serviceSource).toContain('await tx.routeGroupingPolygon.update({ data, where: { id: polygonId } })');
    expect(routeSource).toContain('const deletePolygonIds = readOptionalJsonStringArray(body, "deletePolygonIds")');
    expect(routeSource).toContain('...(deletePolygonIds === undefined ? {} : { deletePolygonIds })');
    expect(routeSource).toContain('expectedUpdatedAt: readRequiredJsonString(body, "expectedUpdatedAt")');
    expect(routeSource).toContain('id: typeof row.id === "string"');
    expect(routeSource).toContain('RouteGroupingConflictError');
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
