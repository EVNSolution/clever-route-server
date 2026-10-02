import { describe, expect, test, vi } from 'vitest';
import {
  hasDeliveryNavigationGraceExpired, hasDeliveryWorkCompleted, KFOOD_DELIVERY_APP_ID,
  KFOOD_DELIVERY_SHOP_DOMAIN, KFOOD_RETURN_NAVIGATION_GRACE_MS,
  reconcileKfoodDeliveryWorkCompletion, toRouteDeliveryDisplayStatus
} from '../src/modules/route-plans/kfood-delivery-completion.js';

const completedAt = new Date('2026-10-01T17:30:00Z');
const navigationUntil = new Date(completedAt.getTime() + KFOOD_RETURN_NAVIGATION_GRACE_MS);
const marker = {
  assignmentGeneration: 2n, deliveryWorkCompletedGeneration: 2n,
  deliveryWorkCompletedVersionId: 'current-version', deliveryWorkCompletedAt: completedAt,
  driverNavigationUntil: navigationUntil, status: 'IN_PROGRESS'
};

describe('K-food delivery work completion with return navigation', () => {
  test('shows Complete immediately while preserving the raw mobile execution state', () => {
    expect(toRouteDeliveryDisplayStatus(marker)).toBe('COMPLETED');
    expect(marker.status).toBe('IN_PROGRESS');
    expect(hasDeliveryNavigationGraceExpired(marker, new Date(navigationUntil.getTime() - 1))).toBe(false);
    expect(hasDeliveryNavigationGraceExpired(marker, navigationUntil)).toBe(true);
  });

  test('does not reuse a previous assignment or a malformed interval', () => {
    expect(toRouteDeliveryDisplayStatus({ ...marker, assignmentGeneration: 3n })).toBe('IN_PROGRESS');
    expect(hasDeliveryNavigationGraceExpired({ ...marker, assignmentGeneration: 3n }, navigationUntil)).toBe(false);
    expect(hasDeliveryWorkCompleted({ ...marker, driverNavigationUntil: completedAt })).toBe(false);
    expect(hasDeliveryWorkCompleted({ ...marker, deliveryWorkCompletedVersionId: null })).toBe(false);
    expect(toRouteDeliveryDisplayStatus({ ...marker, status: 'INCOMPLETE' })).toBe('INCOMPLETE');
    expect(toRouteDeliveryDisplayStatus({ status: 'IN_PROGRESS' })).toBe('IN_PROGRESS');
  });

  test('starts a server-time grace only after every current snapshot stop is resolved', async () => {
    const harness = createHarness();
    const result = await reconcileKfoodDeliveryWorkCompletion(harness.tx as never, input());
    expect(result).toEqual({ completedAt, navigationUntil, assignmentGeneration: 2n, routeVersionId: 'current-version' });
    expect(harness.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: 'route', shopId: 'shop', status: 'IN_PROGRESS',
      shop: { appId: KFOOD_DELIVERY_APP_ID, shopDomain: KFOOD_DELIVERY_SHOP_DOMAIN }
    } }));
    expect(harness.updateMany).toHaveBeenCalledWith({
      where: { id: 'route', shopId: 'shop', status: 'IN_PROGRESS', assignmentGeneration: 2n },
      data: { deliveryWorkCompletedAt: completedAt, driverNavigationUntil: navigationUntil,
        deliveryWorkCompletedGeneration: 2n, deliveryWorkCompletedVersionId: 'current-version' }
    });
  });

  test.each(['PENDING', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED'])('keeps %s unresolved rather than inventing completion', async (status) => {
    const harness = createHarness();
    harness.route.routeStops[1]!.deliveryStop.status = status;
    expect(await reconcileKfoodDeliveryWorkCompletion(harness.tx as never, input())).toBeNull();
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  test('does not close empty, truncated, duplicated, or mismatched current membership', async () => {
    for (const corrupt of [
      (route: ReturnType<typeof createHarness>['route']) => { route.routeStops = []; },
      (route: ReturnType<typeof createHarness>['route']) => { route.routeGroupingChildVersions[0]!.snapshot.stops.pop(); },
      (route: ReturnType<typeof createHarness>['route']) => { route.routeStops[1]!.deliveryStop.order.currentRouteVersionId = 'different-version'; },
      (route: ReturnType<typeof createHarness>['route']) => { route.routeGroupingChildVersions[0]!.snapshot.stops[1]!.deliveryStopId = 'stop-1'; },
      (route: ReturnType<typeof createHarness>['route']) => { route.routeGroupingChildVersions.push(route.routeGroupingChildVersions[0]!); }
    ]) {
      const harness = createHarness();
      corrupt(harness.route);
      expect(await reconcileKfoodDeliveryWorkCompletion(harness.tx as never, input())).toBeNull();
      expect(harness.updateMany).not.toHaveBeenCalled();
    }
  });

  test('a retry, return intent, or GPS refresh cannot extend an existing valid grace', async () => {
    const harness = createHarness(marker);
    expect(await reconcileKfoodDeliveryWorkCompletion(harness.tx as never, {
      ...input(), now: new Date('2026-10-01T19:00:00Z')
    })).toEqual({ completedAt, navigationUntil, assignmentGeneration: 2n, routeVersionId: 'current-version' });
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  test('a corrected unresolved stop clears the marker and reopens delivery work', async () => {
    const harness = createHarness(marker);
    harness.route.routeStops[1]!.deliveryStop.status = 'ARRIVED';
    expect(await reconcileKfoodDeliveryWorkCompletion(harness.tx as never, input())).toBeNull();
    expect(harness.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: {
      deliveryWorkCompletedAt: null, driverNavigationUntil: null,
      deliveryWorkCompletedGeneration: null, deliveryWorkCompletedVersionId: null
    } }));
  });

  test('the periodic finalizer never starts a grace for a historical route', async () => {
    const harness = createHarness();
    expect(await reconcileKfoodDeliveryWorkCompletion(harness.tx as never, { ...input(), allowStart: false })).toBeNull();
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  test('a lost ownership CAS does not report successful completion', async () => {
    const harness = createHarness();
    harness.updateMany.mockResolvedValue({ count: 0 });
    expect(await reconcileKfoodDeliveryWorkCompletion(harness.tx as never, input())).toBeNull();
  });

  test('other tenants, terminal routes, and unavailable rows are left untouched', async () => {
    const harness = createHarness();
    harness.findFirst.mockResolvedValue(null);
    expect(await reconcileKfoodDeliveryWorkCompletion(harness.tx as never, input())).toBeNull();
    expect(harness.updateMany).not.toHaveBeenCalled();
  });
});

function input() { return { routePlanId: 'route', shopId: 'shop', now: completedAt }; }
function createHarness(overrides: Partial<typeof marker> = {}) {
  const route = {
    id: 'route', status: 'IN_PROGRESS', assignmentGeneration: 2n,
    deliveryWorkCompletedAt: null as Date | null, driverNavigationUntil: null as Date | null,
    deliveryWorkCompletedGeneration: null as bigint | null, deliveryWorkCompletedVersionId: null as string | null,
    routeGroupingChildVersions: [{ id: 'current-version', snapshot: { membershipSchemaVersion: 1,
      stops: [{ sequence: 1, deliveryStopId: 'stop-1', orderId: 'order-1' },
        { sequence: 2, deliveryStopId: 'stop-2', orderId: 'order-2' }] } }],
    routeStops: [1, 2].map(sequence => ({ sequence, deliveryStopId: `stop-${sequence}`, deliveryStop: {
      status: 'DELIVERED', orderId: `order-${sequence}`, order: { currentRouteVersionId: 'current-version' }
    } })), ...overrides
  };
  const findFirst = vi.fn().mockResolvedValue(route);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  return { route, findFirst, updateMany, tx: { routePlan: { findFirst, updateMany } } };
}
