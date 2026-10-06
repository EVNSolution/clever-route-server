import { describe, expect, test, vi } from 'vitest';

import {
  assertRouteDispatchOwnership,
  RouteExecutionConflictError
} from '../src/modules/route-plans/route-execution-ownership.js';

describe('route execution ownership', () => {
  test('locks unique stop ids in deterministic order before rejecting an active dispatch overlap', async () => {
    const lockSql: string[] = [];
    const lockedStopIds: unknown[] = [];
    const tx = {
      $queryRaw: vi.fn((query: TemplateStringsArray | { strings: readonly string[]; values: readonly unknown[] }) => {
        const strings = 'strings' in query ? query.strings : query;
        const sql = Array.from(strings).join('?');
        if (sql.includes('SELECT DISTINCT')) return Promise.resolve([{
          deliveryStopId: 'stop-a',
          orderId: 'order-a',
          orderName: '#1001',
          routePlanId: 'other-route',
          routeName: 'Other route'
        }]);
        lockSql.push(sql);
        if ('strings' in query) lockedStopIds.push(query.values[0]);
        return Promise.resolve([{ locked: true }]);
      })
    };

    await expect(assertRouteDispatchOwnership(tx, {
      deliveryStopIds: ['stop-b', 'stop-a', 'stop-b'],
      routePlanId: 'route-current',
      shopId: 'shop-id'
    })).rejects.toBeInstanceOf(RouteExecutionConflictError);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(lockSql).toEqual([
      'SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(710027, hashtext(?))',
      'SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(710027, hashtext(?))'
    ]);
    expect(lockedStopIds).toEqual(['stop-a', 'stop-b']);
  });

  test('fails closed when the transaction lock cannot be acquired', async () => {
    const lockError = new Error('database lock unavailable');
    const tx = {
      $queryRaw: vi.fn(() => Promise.reject(lockError))
    };

    await expect(assertRouteDispatchOwnership(tx, {
      deliveryStopIds: ['stop-a'],
      routePlanId: 'route-current',
      shopId: 'shop-id'
    })).rejects.toBe(lockError);

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
  });
});
