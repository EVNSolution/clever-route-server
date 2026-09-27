import { describe, expect, test, vi } from 'vitest';
import { createDsvAdminPrincipal, dsvOperatorScopes, DsvForbiddenError } from '../src/modules/dsv/dsv-principal.js';
import {
  PrismaDsvStoreReviewAccess, type DsvStoreReviewReferences,
} from '../src/modules/dsv/dsv-store-review-access.js';
import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';

const operator = createDsvAdminPrincipal({ shopId: 'shop', scopes: dsvOperatorScopes });
const developer = createDsvAdminPrincipal({ shopId: 'shop' });
const customer = { principalType: 'CUSTOMER_USER' as const, customerId: 'customer', shopId: 'shop', scopes: ['dsv:customer-deliveries:read' as const] };

describe('store review data boundary', () => {
  test.each([
    ['driverIds', 'driver'], ['orderIds', 'order'], ['customerIds', 'customer'],
    ['destinationIds', 'deliveryCustomerProfile'], ['routePlanIds', 'routePlan'],
    ['importIds', 'dsvDispatchImport'], ['deliveryStopIds', 'deliveryStop'],
    ['proofMediaIds', 'driverProofMedia'],
    ['assignmentIds', 'dsvVehicleDriverAssignment'], ['customerAccountIds', 'customerAccount'],
    ['changeRequestIds', 'dsvDispatchChangeRequest'],
  ] as const)('protects direct references through %s', async (reference, model) => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'restricted' });
    const access = new PrismaDsvStoreReviewAccess({ [model]: { findFirst } } as never);
    const refs: DsvStoreReviewReferences = { [reference]: ['restricted'] };
    await expect(access.assertAccessible(operator, refs)).rejects.toBeInstanceOf(DsvForbiddenError);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ shopId: 'shop', id: { in: ['restricted'] } }) as unknown }));
    await expect(access.assertAccessible(developer, refs)).rejects.toBeInstanceOf(DsvForbiddenError);
    await expect(access.assertAccessible(customer, refs)).rejects.toBeInstanceOf(DsvForbiddenError);
    expect(findFirst).toHaveBeenCalledTimes(3);
    findFirst.mockResolvedValue(null);
    await expect(access.assertAccessible(operator, refs)).resolves.toBeUndefined();
    await expect(access.assertAccessible(developer, refs)).resolves.toBeUndefined();
    await expect(access.assertAccessible(customer, refs)).resolves.toBeUndefined();
  });

  test('checks every relation that can tie proof media to review data', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const access = new PrismaDsvStoreReviewAccess({ driverProofMedia: { findFirst } } as never);

    await access.assertAccessible(developer, { proofMediaIds: ['media'] });

    expect(findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        id: { in: ['media'] },
        shopId: 'shop',
        OR: [
          { routePlan: { isStoreReviewData: true } },
          { driver: { is: { isStoreReviewData: true } } },
          { deliveryStop: { order: { isStoreReviewData: true } } },
          { deliveryStopLinks: { some: { deliveryStop: { order: { isStoreReviewData: true } } } } },
        ],
      },
    });
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
