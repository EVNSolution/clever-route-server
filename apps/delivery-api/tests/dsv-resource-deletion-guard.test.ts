import { describe, expect, test, vi } from 'vitest';

import {
  assertDsvResourceDeletionAllowed,
  DsvResourceInUseError,
} from '../src/modules/dsv/dsv-resource-deletion-guard.js';

describe('DSV resource deletion guard', () => {
  test('locks referenced routes before the driver and rejects a fresh blocker', async () => {
    const sqlCalls: string[] = [];
    const tx = {
      $queryRaw: vi.fn((query: { strings?: readonly string[] }) => {
        const sql = query.strings?.join(' ') ?? '';
        sqlCalls.push(sql);
        if (sql.includes('SELECT DISTINCT resource_route')) {
          return Promise.resolve([{ id: 'route-b' }, { id: 'route-a' }, { id: 'route-b' }]);
        }
        if (sql.includes('AS blocked')) return Promise.resolve([{ blocked: true }]);
        if (sql.includes('FROM drivers driver')) return Promise.resolve([{ id: 'driver-id' }]);
        return Promise.resolve([{ id: 'route-a' }, { id: 'route-b' }]);
      }),
    };

    await expect(assertDsvResourceDeletionAllowed(tx as never, {
      resource: 'driver', resourceId: 'driver-id', shopId: 'shop-id',
    })).rejects.toBeInstanceOf(DsvResourceInUseError);

    expect(sqlCalls).toHaveLength(4);
    expect(sqlCalls[0]).toContain('SELECT DISTINCT resource_route');
    expect(sqlCalls[1]).toContain('ORDER BY route_plan."id"');
    expect(sqlCalls[1]).toContain('FOR UPDATE');
    expect(sqlCalls[2]).toContain('FROM drivers driver');
    expect(sqlCalls[2]).toContain('FOR UPDATE');
    expect(sqlCalls[3]).toContain('AS blocked');
  });

  test('allows an unreferenced vehicle and reports a missing vehicle without a delete attempt', async () => {
    const results = [[], [{ id: 'vehicle-id' }], [{ blocked: false }]];
    const tx = { $queryRaw: vi.fn(() => Promise.resolve(results.shift() ?? [])) };

    await expect(assertDsvResourceDeletionAllowed(tx as never, {
      resource: 'vehicle', resourceId: 'vehicle-id', shopId: 'shop-id',
    })).resolves.toBe(true);

    const missingResults = [[], []];
    const missingTx = { $queryRaw: vi.fn(() => Promise.resolve(missingResults.shift() ?? [])) };
    await expect(assertDsvResourceDeletionAllowed(missingTx as never, {
      resource: 'vehicle', resourceId: 'vehicle-id', shopId: 'shop-id',
    })).resolves.toBe(false);
    expect(missingTx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
