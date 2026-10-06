import { describe, expect, test, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

import {
  assertDsvAttributionDriversPrelocked,
  assertDsvAttributionRoutesPrelocked,
  DsvDriverAttributionConflictError,
  DsvDriverAttributionTopologyChangedError,
  lockDsvDriverAttributionAccounts,
  lockDsvDriverAttributionTopology,
  runWithDsvDriverAttributionRetry,
} from '../src/modules/dsv/dsv-driver-attribution-lock.js';

describe('DSV driver attribution lock', () => {
  test('locks all routes before all drivers and returns a stable proof', async () => {
    const calls: string[] = [];
    let topologyRead = 0;
    const tx = operationalTx((sql) => {
      calls.push(sql);
      if (sql.includes('SELECT DISTINCT attribution_route')) {
        topologyRead += 1;
        return [{ id: 'route-b' }, { id: 'route-a' }, { id: 'route-b' }];
      }
      if (sql.includes('FROM drivers driver')) return [{ id: 'driver-b' }, { id: 'driver-a' }];
      return [{ id: 'route-a' }, { id: 'route-b' }];
    });

    const proof = await lockDsvDriverAttributionTopology(tx, ['driver-b', 'driver-a', 'driver-b']);

    expect(topologyRead).toBe(2);
    expect(proof).toEqual({
      lockedDriverIds: ['driver-a', 'driver-b'],
      routePlanIds: ['route-a', 'route-b'],
      status: 'LOCKED',
    });
    expect(calls[0]).toContain('SELECT DISTINCT attribution_route');
    expect(calls[1]).toContain('FROM route_plans route_plan');
    expect(calls[1]).toContain('FOR UPDATE');
    expect(calls[2]).toContain('FROM drivers driver');
    expect(calls[2]).toContain('FOR UPDATE');
    expect(calls[3]).toContain('SELECT DISTINCT attribution_route');
    expect(() => assertDsvAttributionRoutesPrelocked(proof, ['route-b'])).not.toThrow();
  });

  test('rolls back when fresh topology contains a route outside the prelocked set', async () => {
    let topologyRead = 0;
    const tx = operationalTx((sql) => {
      if (sql.includes('SELECT DISTINCT attribution_route')) {
        topologyRead += 1;
        return topologyRead === 1 ? [{ id: 'route-a' }] : [{ id: 'route-a' }, { id: 'route-new' }];
      }
      if (sql.includes('FROM drivers driver')) return [{ id: 'driver-a' }];
      return [{ id: 'route-a' }];
    });

    await expect(lockDsvDriverAttributionTopology(tx, ['driver-a']))
      .rejects.toBeInstanceOf(DsvDriverAttributionTopologyChangedError);
  });

  test('locks existing accounts before route topology and reports missing drivers to the caller', async () => {
    const calls: string[] = [];
    const tx = operationalTx((sql) => {
      calls.push(sql);
      if (sql.includes('FROM driver_accounts account')) return [{ id: 'account-a' }];
      if (sql.includes('SELECT DISTINCT attribution_route')) return [];
      if (sql.includes('FROM drivers driver')) return [{ id: 'driver-a' }];
      return [];
    });

    await expect(lockDsvDriverAttributionAccounts(tx, ['account-b', 'account-a']))
      .resolves.toEqual(['account-a']);
    await expect(lockDsvDriverAttributionTopology(tx, ['driver-b', 'driver-a']))
      .resolves.toEqual({ lockedDriverIds: ['driver-a'], routePlanIds: [], status: 'LOCKED' });
    expect(calls[0]).toContain('FOR UPDATE');
  });

  test('retries only topology changes three times and exposes a domain conflict', async () => {
    const transaction = vi.fn(() => Promise.reject(new DsvDriverAttributionTopologyChangedError()));

    await expect(runWithDsvDriverAttributionRetry({ $transaction: transaction }, vi.fn()))
      .rejects.toBeInstanceOf(DsvDriverAttributionConflictError);
    expect(transaction).toHaveBeenCalledTimes(3);

    const ordinary = new Error('storage failed');
    const failedTransaction = vi.fn(() => Promise.reject(ordinary));
    await expect(runWithDsvDriverAttributionRetry({ $transaction: failedTransaction }, vi.fn()))
      .rejects.toBe(ordinary);
    expect(failedTransaction).toHaveBeenCalledTimes(1);

    const deadlock = Object.assign(new Error('deadlock detected'), {
      code: 'P2010',
      meta: { code: '40P01' },
    });
    const deadlockedTransaction = vi.fn(() => Promise.reject(deadlock));
    await expect(runWithDsvDriverAttributionRetry({ $transaction: deadlockedTransaction }, vi.fn()))
      .rejects.toBe(deadlock);
    expect(deadlockedTransaction).toHaveBeenCalledTimes(1);
  });

  test('retries and rejects when a fresh matching driver is outside the locked proof', async () => {
    const transaction = vi.fn();
    const runTransaction = async <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
      transaction();
      return operation({} as Prisma.TransactionClient);
    };

    await expect(runWithDsvDriverAttributionRetry({ $transaction: runTransaction }, () => {
      assertDsvAttributionDriversPrelocked({
        lockedDriverIds: ['driver-a'],
        routePlanIds: [],
        status: 'LOCKED',
      }, ['driver-a', 'driver-new']);
      return Promise.resolve();
    })).rejects.toBeInstanceOf(DsvDriverAttributionConflictError);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  test('skips only legacy transactions without execution delegates and rejects partial operational ports', async () => {
    await expect(lockDsvDriverAttributionTopology({ driver: {} }, ['driver-a']))
      .resolves.toEqual({ lockedDriverIds: [], routePlanIds: [], status: 'LEGACY_UNAVAILABLE' });
    await expect(lockDsvDriverAttributionTopology({ driver: {}, dsvExecutionContext: {} }, ['driver-a']))
      .rejects.toThrow('complete operational transaction delegates');
  });
});

function operationalTx(run: (sql: string) => unknown[]) {
  return {
    $queryRaw: vi.fn((query: { strings?: readonly string[] }) =>
      Promise.resolve(run(query.strings?.join(' ') ?? ''))),
    driver: {},
    dsvExecutionContext: {},
    routePlan: {},
  };
}
