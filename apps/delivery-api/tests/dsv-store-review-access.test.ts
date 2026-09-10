import { describe, expect, test, vi } from 'vitest';
import {
  canAccessDsvStoreReviewData, createDsvAdminPrincipal, dsvOperatorScopes, DsvForbiddenError,
} from '../src/modules/dsv/dsv-principal.js';
import {
  PrismaDsvStoreReviewAccess, type DsvStoreReviewReferences,
} from '../src/modules/dsv/dsv-store-review-access.js';
import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';

const operator = createDsvAdminPrincipal({ shopId: 'shop', scopes: dsvOperatorScopes });
const developer = createDsvAdminPrincipal({ shopId: 'shop' });

describe('store review data boundary', () => {
  test('uses the developer admin boundary, never the ordinary operator or customer role', () => {
    expect(canAccessDsvStoreReviewData(operator)).toBe(false);
    expect(canAccessDsvStoreReviewData(developer)).toBe(true);
    expect(canAccessDsvStoreReviewData({ principalType: 'CUSTOMER_USER', customerId: 'c', shopId: 'shop', scopes: ['dsv:accounts:read'] })).toBe(false);
    expect(canAccessDsvStoreReviewData(createDsvAdminPrincipal({ shopId: 'shop', mustChangePassword: true }))).toBe(false);
  });

  test.each([
    ['driverIds', 'driver'], ['orderIds', 'order'], ['customerIds', 'customer'],
    ['destinationIds', 'deliveryCustomerProfile'], ['routePlanIds', 'routePlan'],
    ['importIds', 'dsvDispatchImport'], ['deliveryStopIds', 'deliveryStop'],
    ['assignmentIds', 'dsvVehicleDriverAssignment'], ['customerAccountIds', 'customerAccount'],
    ['changeRequestIds', 'dsvDispatchChangeRequest'],
  ] as const)('protects direct references through %s', async (reference, model) => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'restricted' });
    const access = new PrismaDsvStoreReviewAccess({ [model]: { findFirst } } as never);
    const refs: DsvStoreReviewReferences = { [reference]: ['restricted'] };
    await expect(access.assertAccessible(operator, refs)).rejects.toBeInstanceOf(DsvForbiddenError);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ shopId: 'shop', id: { in: ['restricted'] } }) as unknown }));
    await expect(access.assertAccessible(developer, refs)).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledTimes(1);
    findFirst.mockResolvedValue(null);
    await expect(access.assertAccessible(operator, refs)).resolves.toBeUndefined();
  });

  test.each([
    [true, true, true, true], [true, true, false, false],
    [true, false, false, false], [false, true, true, false], [false, false, false, true],
  ])('route=%s driver=%s account=%s grants access=%s', async (routeReview, driverReview, accountReview, permitted) => {
    const repository = new PrismaDriverTokenAccessRepository({
      driverAccount: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', tokenVersion: 1 }) },
      routePlan: { findFirst: vi.fn().mockResolvedValue({
        id: 'route', isStoreReviewData: routeReview, shop: { id: 'shop', shopDomain: 'dsv.example' },
        routeGroupingChildVersions: [{ publishedAt: new Date('2026-05-11T12:00:00.000Z') }],
        status: 'READY',
        driver: { id: 'driver', accountId: 'account', authSubject: 'driver-driver', status: 'ACTIVE',
          isStoreReviewData: driverReview, account: { isStoreReviewAccount: accountReview } },
      }) },
    } as never);
    const access = await repository.resolveDriverRouteAccess({ accountId: 'account', routePlanId: 'route', tokenVersion: 1 });
    expect(access !== null).toBe(permitted);
  });
});
