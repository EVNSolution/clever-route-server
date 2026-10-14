import { describe, expect, test, vi } from 'vitest';

import {
  archiveDeletedRouteGroupingChildMembership,
  replaceCurrentRouteGroupingChildVersion,
  releaseRouteVersionOrderOwnership
} from '../src/modules/route-grouping/route-grouping.service.js';

describe('route grouping order ownership release', () => {
  test('releases only orders owned by the exact discarded versions in the same shop', async () => {
    const order = {
      updateMany: vi.fn(() => Promise.resolve({ count: 2 }))
    };

    const released = await releaseRouteVersionOrderOwnership(
      { order } as never,
      {
        routeVersionIds: ['discarded-version-1', 'discarded-version-1', 'discarded-version-2'],
        shopId: 'shop-id'
      }
    );

    expect(released).toBe(2);
    expect(order.updateMany).toHaveBeenCalledWith({
      data: { currentRouteVersionId: null },
      where: {
        currentRouteVersionId: { in: ['discarded-version-1', 'discarded-version-2'] },
        shopId: 'shop-id'
      }
    });
  });

  test('releases the archived child version without clearing a newer version binding', async () => {
    const tx = {
      order: {
        updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
      },
      routeGroupingChildVersion: {
        create: vi.fn(() => Promise.resolve({ id: 'deletion-tombstone-id' })),
        update: vi.fn(() => Promise.resolve({ id: 'discarded-version-id' }))
      }
    };

    await archiveDeletedRouteGroupingChildMembership(tx as never, {
      driverId: null,
      groupingId: 'grouping-id',
      groupingVersionId: 'grouping-version-id',
      id: 'discarded-version-id',
      notificationStatus: 'SKIPPED',
      publishedAt: null,
      shopId: 'shop-id',
      snapshot: {
        membershipSchemaVersion: 1,
        routeIdx: 0,
        stops: [{ deliveryStopId: 'stop-id', orderId: 'order-id', sequence: 1, sourceOrderId: 'source-id' }]
      },
      version: 1
    } as never);

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      data: { currentRouteVersionId: null },
      where: {
        currentRouteVersionId: { in: ['discarded-version-id'] },
        shopId: 'shop-id'
      }
    });
    expect(tx.order.updateMany).toHaveBeenCalledOnce();
  });

  test('clears the archived child pointer of an order that left the route when the child is replaced', async () => {
    const tx = {
      order: { updateMany: vi.fn(() => Promise.resolve({ count: 1 })) },
      routeGroupingChildVersion: {
        create: vi.fn(() => Promise.resolve({ id: 'next-child-id' })),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
      },
      routePlan: { updateMany: vi.fn() }
    };

    await replaceCurrentRouteGroupingChildVersion(tx, {
      currentChildId: 'old-child-id',
      driverId: null,
      groupingId: 'grouping-id',
      groupingVersionId: 'grouping-version-id',
      notificationStatus: 'SKIPPED',
      orderIds: ['kept-order-id'],
      publishedAt: null,
      routePlanId: null,
      shopId: 'shop-id',
      snapshot: { membershipSchemaVersion: 1, stops: [] },
      version: 1
    });

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      data: { currentRouteVersionId: null },
      where: {
        currentRouteVersionId: 'old-child-id',
        id: { notIn: ['kept-order-id'] },
        shopId: 'shop-id'
      }
    });
  });
});
