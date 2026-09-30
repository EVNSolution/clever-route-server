import type { PrismaClient } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';

import {
  KFOOD_STALE_ROUTE_APP_ID,
  KFOOD_STALE_ROUTE_SHOP_DOMAIN,
  PrismaStaleRouteFinalizationService
} from '../src/modules/route-plans/stale-route-finalization.service.js';

describe('PrismaStaleRouteFinalizationService', () => {
  test('finalizes only an exact K-food route after its tracking event window ends', async () => {
    const harness = createHarness();
    const service = new PrismaStaleRouteFinalizationService(harness.prisma);

    const result = await service.processDue(new Date('2026-09-20T00:00:00.000Z'));

    expect(result).toEqual({
      finalized: 1,
      inspected: 1,
      skippedConcurrent: 0,
      skippedNotDue: 0,
      skippedUnresolvableWindow: 0
    });
    expect(harness.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        shop: {
          appId: KFOOD_STALE_ROUTE_APP_ID,
          shopDomain: KFOOD_STALE_ROUTE_SHOP_DOMAIN
        },
        status: 'IN_PROGRESS'
      }
    }));
    expect(harness.lockRoutePlan).toHaveBeenCalledTimes(1);
    expect(harness.lockRoutePlan.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
      harness.findFirst.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(harness.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'route-id',
        shopId: 'shop-id',
        shop: {
          appId: KFOOD_STALE_ROUTE_APP_ID,
          shopDomain: KFOOD_STALE_ROUTE_SHOP_DOMAIN
        },
        status: 'IN_PROGRESS'
      }
    }));
    expect(harness.updateMany).toHaveBeenCalledWith({
      data: { status: 'INCOMPLETE' },
      where: expect.objectContaining({
        assignmentGeneration: 3n,
        id: 'route-id',
        shopId: 'shop-id',
        status: 'IN_PROGRESS'
      }) as unknown
    });
  });

  test('does not finalize before the event window ends', async () => {
    const harness = createHarness();
    const service = new PrismaStaleRouteFinalizationService(harness.prisma);

    const result = await service.processDue(new Date('2026-09-18T12:00:00.000Z'));

    expect(result.skippedNotDue).toBe(1);
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  test.each([
    { finalized: 0, now: '2026-09-19T03:59:59.999Z' },
    { finalized: 1, now: '2026-09-19T04:00:00.000Z' }
  ])('uses the exact Toronto local-date boundary at $now', async ({ finalized, now }) => {
    const harness = createHarness();
    const service = new PrismaStaleRouteFinalizationService(harness.prisma);

    const result = await service.processDue(new Date(now));

    expect(result.finalized).toBe(finalized);
    expect(result.skippedNotDue).toBe(1 - finalized);
    expect(harness.updateMany).toHaveBeenCalledTimes(finalized);
  });

  test('does not finalize a late-started route using its older planned date', async () => {
    const harness = createHarness({
      driverEvents: [{ eventType: 'ROUTE_STARTED', occurredAt: new Date('2026-09-19T03:30:00.000Z') }]
    });
    const service = new PrismaStaleRouteFinalizationService(harness.prisma);

    const beforeActualWindowEnd = await service.processDue(new Date('2026-09-19T04:00:00.000Z'));

    expect(beforeActualWindowEnd.skippedNotDue).toBe(1);
    expect(harness.updateMany).not.toHaveBeenCalled();

    const atActualWindowEnd = await service.processDue(new Date('2026-09-20T04:00:00.000Z'));

    expect(atActualWindowEnd.finalized).toBe(1);
    expect(harness.updateMany).toHaveBeenCalledOnce();
  });

  test('does not finalize when the locked route no longer matches the exact tenant and state scope', async () => {
    const harness = createHarness();
    harness.findFirst.mockResolvedValueOnce(null);
    const service = new PrismaStaleRouteFinalizationService(harness.prisma);

    const result = await service.processDue(new Date('2026-09-20T00:00:00.000Z'));

    expect(result.skippedConcurrent).toBe(1);
    expect(result.finalized).toBe(0);
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  test('fails closed when timezone evidence is unavailable', async () => {
    const harness = createHarness({ constraints: {} });
    const service = new PrismaStaleRouteFinalizationService(harness.prisma);

    const result = await service.processDue(new Date('2026-09-20T00:00:00.000Z'));

    expect(result.skippedUnresolvableWindow).toBe(1);
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  test('does not relabel a route with completion evidence', async () => {
    const harness = createHarness({
      driverEvents: [{ eventType: 'ROUTE_COMPLETED', occurredAt: new Date('2026-09-17T20:00:00.000Z') }]
    });
    const service = new PrismaStaleRouteFinalizationService(harness.prisma);

    const result = await service.processDue(new Date('2026-09-20T00:00:00.000Z'));

    expect(result.skippedConcurrent).toBe(1);
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  test('reports a lost CAS without overwriting concurrent lifecycle changes', async () => {
    const harness = createHarness({ updatedCount: 0 });
    const service = new PrismaStaleRouteFinalizationService(harness.prisma);

    const result = await service.processDue(new Date('2026-09-20T00:00:00.000Z'));

    expect(result.skippedConcurrent).toBe(1);
    expect(result.finalized).toBe(0);
  });

  test('does not inspect or update a candidate whose route row disappeared before lock acquisition', async () => {
    const harness = createHarness({ lockedRows: [] });
    const service = new PrismaStaleRouteFinalizationService(harness.prisma);

    const result = await service.processDue(new Date('2026-09-20T00:00:00.000Z'));

    expect(result.skippedConcurrent).toBe(1);
    expect(harness.findFirst).not.toHaveBeenCalled();
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  test('advances a stable plan-date cursor so an unresolved first page cannot starve later routes', async () => {
    const harness = createHarness();
    const service = new PrismaStaleRouteFinalizationService(harness.prisma, 1);

    await service.processDue(new Date('2026-09-20T00:00:00.000Z'));
    await service.processDue(new Date('2026-09-20T00:00:00.000Z'));

    expect(harness.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { planDate: { gt: new Date('2026-09-17T00:00:00.000Z') } },
          { id: { gt: 'route-id' }, planDate: new Date('2026-09-17T00:00:00.000Z') }
        ]
      }) as unknown
    }));
  });
});

function createHarness(overrides: {
  constraints?: unknown;
  driverEvents?: Array<{ eventType: string; occurredAt: Date }>;
  lockedRows?: Array<{ id: string }>;
  updatedCount?: number;
} = {}) {
  const findMany = vi.fn().mockResolvedValue([{
    id: 'route-id',
    planDate: new Date('2026-09-17T00:00:00.000Z'),
    shopId: 'shop-id'
  }]);
  const findFirst = vi.fn().mockResolvedValue({
    assignmentGeneration: 3n,
    constraints: overrides.constraints ?? { timezone: 'America/Toronto' },
    driverEvents: overrides.driverEvents ?? [
      { eventType: 'ROUTE_STARTED', occurredAt: new Date('2026-09-17T12:00:00.000Z') }
    ],
    id: 'route-id',
    planDate: new Date('2026-09-17T00:00:00.000Z'),
    shopId: 'shop-id',
    updatedAt: new Date('2026-09-17T12:00:00.000Z')
  });
  const updateMany = vi.fn().mockResolvedValue({ count: overrides.updatedCount ?? 1 });
  const lockRoutePlan = vi.fn().mockResolvedValue(overrides.lockedRows ?? [{ id: 'route-id' }]);
  const tx = { $queryRaw: lockRoutePlan, routePlan: { findFirst, updateMany } };
  const prisma = {
    routePlan: { findMany },
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
  } as unknown as PrismaClient;
  return { findFirst, findMany, lockRoutePlan, prisma, updateMany };
}
