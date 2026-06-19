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


  test('refreshes generated child route projections through the explicit snapshot geometry hook', () => {
    const serviceSource = readFileSync(join(process.cwd(), 'src/modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const dependencySource = readFileSync(join(process.cwd(), 'src/modules/commerce/admin-commerce-connections.dependencies.ts'), 'utf8');

    expect(serviceSource).toContain('refreshRouteGeometryForRoutePlan');
    expect(serviceSource).toContain("source: 'SNAPSHOT'");
    expect(serviceSource).toContain('ROUTE_GROUPING_GEOMETRY_REFRESH_CONCURRENCY');
    expect(serviceSource).toContain('Promise.allSettled');
    expect(serviceSource).toContain('logRouteGeometryRefreshFailure');
    expect(serviceSource).toContain('await this.refreshChildRouteGeometry(projection.childRoutePlanIds, input.shopDomain);');
    expect(dependencySource).toContain('refreshRouteGeometryForRoutePlan.bind(routePlanDeps.routePlanService)');
    expect(dependencySource).toContain('readAdminUiRouteGroupingService(input, routeGeometryRefresher)');
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
