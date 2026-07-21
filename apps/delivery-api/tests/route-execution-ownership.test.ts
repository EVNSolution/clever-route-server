import { describe, expect, test, vi } from 'vitest';

import {
  assertRouteExecutionOwnership,
  RouteExecutionConflictError
} from '../src/modules/route-plans/route-execution-ownership.js';

describe('route execution ownership', () => {
  test('locks unique stop ids in deterministic order before checking active overlap', async () => {
    const tx = {
      $queryRaw: vi.fn(() => Promise.resolve([])),
      routePlanStop: {
        findFirst: vi.fn(() => Promise.resolve({
          deliveryStopId: 'stop-a',
          routePlanId: 'other-route'
        })),
        findMany: vi.fn(() => Promise.resolve([]))
      }
    };

    await expect(assertRouteExecutionOwnership(tx, {
      deliveryStopIds: ['stop-b', 'stop-a', 'stop-b'],
      routePlanId: 'route-current',
      shopId: 'shop-id'
    })).rejects.toBeInstanceOf(RouteExecutionConflictError);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.routePlanStop.findFirst).toHaveBeenCalledWith({
      select: { deliveryStopId: true, routePlanId: true },
      where: {
        deliveryStopId: { in: ['stop-a', 'stop-b'] },
        routePlanId: { not: 'route-current' },
        routePlan: { shopId: 'shop-id', status: 'IN_PROGRESS' }
      }
    });
  });

  test('fails closed when the transaction lock cannot be acquired', async () => {
    const lockError = new Error('database lock unavailable');
    const tx = {
      $queryRaw: vi.fn(() => Promise.reject(lockError)),
      routePlanStop: {
        findFirst: vi.fn(() => Promise.resolve(null)),
        findMany: vi.fn(() => Promise.resolve([]))
      }
    };

    await expect(assertRouteExecutionOwnership(tx, {
      deliveryStopIds: ['stop-a'],
      routePlanId: 'route-current',
      shopId: 'shop-id'
    })).rejects.toBe(lockError);

    expect(tx.routePlanStop.findFirst).not.toHaveBeenCalled();
  });
});
