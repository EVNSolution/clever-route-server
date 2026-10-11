import { afterEach, describe, expect, test, vi } from 'vitest';
import { PrismaDriverRouteAccessRepository } from '../src/modules/driver/driver-route-access.repository.js';
import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';
import {
  getPrivateDriverDemoConfig, isPrivateDriverDemoAppId, isPrivateDriverDemoScope,
  KFOOD_PRIVATE_DEMO_APP_ID, KFOOD_PRIVATE_DEMO_SHOP_DOMAIN
} from '../src/modules/driver/private-driver-demo.js';

const shopId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const routeId = '33333333-3333-4333-8333-333333333333';
const config = { KFOOD_PRIVATE_DEMO_SHOP_ID: shopId, KFOOD_PRIVATE_DEMO_ACCOUNT_ID: accountId };
const scope = { shopId, accountId, appId: KFOOD_PRIVATE_DEMO_APP_ID, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN };
afterEach(() => vi.unstubAllEnvs());

function activate() {
  for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
}

function route(owner = accountId) {
  return {
    id: routeId, status: 'IN_PROGRESS', name: 'Private route', planDate: new Date('2030-10-09'), constraints: {},
    assignmentGeneration: 1n,
    shop: { id: shopId, appId: scope.appId, shopDomain: scope.shopDomain },
    driver: { id: 'driver', accountId: owner, authSubject: 'demo-driver', status: 'ACTIVE',
      account: { id: owner, status: 'ACTIVE', tokenVersion: 1 } },
    routeGroupingChildVersions: [{ id: 'version', driverId: 'driver', routePlanId: routeId, publishedAt: new Date() }]
  };
}

describe('private driver demo activation', () => {
  test.each([{}, { KFOOD_PRIVATE_DEMO_SHOP_ID: shopId }, { ...config, KFOOD_PRIVATE_DEMO_ACCOUNT_ID: 'invalid' },
    { ...config, KFOOD_PRIVATE_DEMO_SHOP_ID: ` ${shopId}` }])('fails closed for incomplete or invalid settings %#', env => {
    expect(getPrivateDriverDemoConfig(env)).toBeNull();
    expect(isPrivateDriverDemoScope(scope, env)).toBe(false);
    expect(isPrivateDriverDemoAppId(scope.appId)).toBe(true);
  });

  test('requires the exact owner, tenant, application and domain together', () => {
    expect(getPrivateDriverDemoConfig(config)).toEqual({ shopId, accountId });
    expect(isPrivateDriverDemoScope(scope, config)).toBe(true);
    for (const key of ['accountId', 'shopId', 'appId', 'shopDomain'] as const) {
      expect(isPrivateDriverDemoScope({ ...scope, [key]: 'other' }, config)).toBe(false);
    }
    expect(isPrivateDriverDemoAppId('clever-route-kfood')).toBe(false);
  });
});

describe('private route access projections', () => {
  test.each([null, routeId, 'shared-scope'])('hides private routes before any projection with configuration absent (%s)', async routeContext => {
    vi.stubEnv('KFOOD_PRIVATE_DEMO_SHOP_ID', undefined);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', undefined);
    const privateRoute = route();
    const prisma = { routePlan: { findUnique: vi.fn().mockResolvedValue(privateRoute), findMany: vi.fn().mockResolvedValue([privateRoute]) },
      driver: { findMany: vi.fn().mockResolvedValue([]) } };
    await expect(new PrismaDriverRouteAccessRepository(prisma as never).lookupRouteAccess({ accountId, routeContext }))
      .resolves.toEqual({ status: 'NOT_FOUND' });
  });

  test('allows the configured owner and rejects reassignment even when the new account owns the driver', async () => {
    activate();
    const privateRoute = route();
    const findUnique = vi.fn().mockResolvedValue(privateRoute);
    const repository = new PrismaDriverRouteAccessRepository({ routePlan: { findUnique } } as never);
    await expect(repository.lookupRouteAccess({ accountId, routeContext: routeId })).resolves.toMatchObject({ status: 'INVITED' });
    findUnique.mockResolvedValue(route('other-account'));
    await expect(repository.lookupRouteAccess({ accountId: 'other-account', routeContext: routeId })).resolves.toEqual({ status: 'NOT_FOUND' });
  });

  test('excludes private matches before shared-scope ambiguity can reveal their guidance', async () => {
    activate();
    const privateRoute = route('other-account');
    const publicRoute = { ...route('other-account'), id: 'public-route', name: 'Ordinary route',
      shop: { id: 'public-shop', appId: 'clever', shopDomain: 'ordinary.myshopify.com' },
      routeGroupingChildVersions: [{ id: 'public-version', driverId: 'driver', routePlanId: 'public-route', publishedAt: new Date() }] };
    const repository = new PrismaDriverRouteAccessRepository({ routePlan: {
      findMany: vi.fn().mockResolvedValue([privateRoute, publicRoute])
    } } as never);
    const result = await repository.lookupRouteAccess({ accountId: 'other-account', routeContext: 'shared-scope' });
    expect(result).toMatchObject({ status: 'INVITED', routeAccess: { routePlanId: 'public-route' } });
    expect(JSON.stringify(result)).not.toContain('Private route');
  });

  test('never accepts legacy driver-only tokens for the reserved application', async () => {
    activate();
    const driver = { tokenVersion: 1, shop: { appId: scope.appId } };
    const repository = new PrismaDriverTokenAccessRepository({ driver: { findFirst: vi.fn().mockResolvedValue(driver) } } as never);
    await expect(repository.isDriverAccessTokenActive({ driverId: 'driver', shopDomain: scope.shopDomain, tokenVersion: 1 })).resolves.toBe(false);
  });

  test('revalidates exact private scope for cached account route tokens and navigation grace', async () => {
    activate();
    const privateRoute = route();
    const findFirst = vi.fn().mockResolvedValue(privateRoute);
    const repository = new PrismaDriverTokenAccessRepository({
      driverAccount: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', tokenVersion: 1 }) }, routePlan: { findFirst }
    } as never, () => new Date('2030-10-09T12:00:00Z'));
    const input = { accountId, routePlanId: routeId, tokenVersion: 1 };
    await expect(repository.resolveDriverRouteAccess(input)).resolves.toMatchObject({ shopId, accountId });
    findFirst.mockResolvedValue({ ...privateRoute, deliveryWorkCompletedAt: new Date('2030-10-09T10:00:00Z'),
      deliveryWorkCompletedGeneration: 1n, deliveryWorkCompletedVersionId: 'version', driverNavigationUntil: new Date('2030-10-09T12:00:00Z') });
    await expect(repository.resolveDriverRouteAccess(input)).resolves.toBeNull();
    findFirst.mockResolvedValue(privateRoute);
    vi.stubEnv('KFOOD_PRIVATE_DEMO_ACCOUNT_ID', undefined);
    await expect(repository.resolveDriverRouteAccess(input)).resolves.toBeNull();
  });
});
