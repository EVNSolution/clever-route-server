import { Prisma } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';

import { PrismaAdminNotificationRepository } from '../src/modules/notifications/admin-notification.repository.js';

const createdAt = new Date('2026-06-05T07:00:00.000Z');
const anyObjectMatcher: unknown = expect.any(Object);

const notificationRow = {
  body: 'Woo changed the destination after routing.',
  createdAt,
  href: '/admin/ui/app/routes/route-plan-id',
  id: 'notification-id',
  orderId: 'order-id',
  payload: { afterAddressHash: 'hash-after' },
  readAt: null as Date | null,
  routePlanId: 'route-plan-id',
  severity: 'critical',
  title: 'Route assigned order address changed',
  type: 'WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED'
};

describe('PrismaAdminNotificationRepository', () => {
  test('lists notifications only for the requested shop and counts unread for the same tenant', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaAdminNotificationRepository(prisma as never);

    const result = await repository.listForShopDomain({
      limit: 10,
      shopDomain: 'https://Tenant-A.Example.Test/wp-admin/'
    });

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: { appId_shopDomain: { appId: 'clever', shopDomain: 'tenant-a.example.test' } }
    });
    expect(prisma.adminNotification.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: 'desc' }],
      select: anyObjectMatcher,
      take: 10,
      where: { shopId: 'shop-id' }
    });
    expect(prisma.adminNotification.count).toHaveBeenCalledWith({
      where: { readAt: null, shopId: 'shop-id' }
    });
    expect(result).toEqual({
      notifications: [
        expect.objectContaining({
          createdAt: '2026-06-05T07:00:00.000Z',
          id: 'notification-id',
          readAt: null,
          severity: 'critical'
        })
      ],
      unreadCount: 1
    });
  });

  test('deduplicates notification creation by shop id and dedupe key', async () => {
    const { prisma } = createPrismaHarness();
    prisma.adminNotification.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        clientVersion: 'test',
        code: 'P2002',
        meta: { target: ['shopId', 'dedupeKey'] }
      })
    );
    const repository = new PrismaAdminNotificationRepository(prisma as never);

    const result = await repository.createForShopOnceWithStatus({
      body: notificationRow.body,
      dedupeKey: 'woo_address_changed_route_assigned:shop-id:order-id:route-plan-id:hash-after',
      href: notificationRow.href,
      orderId: notificationRow.orderId,
      payload: notificationRow.payload,
      routePlanId: notificationRow.routePlanId,
      severity: 'critical',
      shopId: 'shop-id',
      title: notificationRow.title,
      type: notificationRow.type
    });

    expect(prisma.adminNotification.findUnique).toHaveBeenCalledWith({
      select: anyObjectMatcher,
      where: {
        shopId_dedupeKey: {
          dedupeKey: 'woo_address_changed_route_assigned:shop-id:order-id:route-plan-id:hash-after',
          shopId: 'shop-id'
        }
      }
    });
    expect(result.created).toBe(false);
    expect(result.notification.id).toBe('notification-id');
  });

  test('reports whether createForShopOnceWithStatus created or deduped a notification', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaAdminNotificationRepository(prisma as never);

    const created = await repository.createForShopOnceWithStatus({
      body: notificationRow.body,
      dedupeKey: 'created-key',
      href: notificationRow.href,
      orderId: notificationRow.orderId,
      payload: notificationRow.payload,
      routePlanId: notificationRow.routePlanId,
      severity: 'critical',
      shopId: 'shop-id',
      title: notificationRow.title,
      type: notificationRow.type
    });

    prisma.adminNotification.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        clientVersion: 'test',
        code: 'P2002',
        meta: { target: ['shopId', 'dedupeKey'] }
      })
    );
    const deduped = await repository.createForShopOnceWithStatus({
      dedupeKey: 'deduped-key',
      severity: 'critical',
      shopId: 'shop-id',
      title: notificationRow.title,
      type: notificationRow.type
    });

    expect(created.created).toBe(true);
    expect(created.notification.id).toBe('notification-id');
    expect(deduped.created).toBe(false);
    expect(deduped.notification.id).toBe('notification-id');
  });

  test('finds a shop id by normalized domain for stream subscriptions', async () => {
    const { prisma } = createPrismaHarness();
    const repository = new PrismaAdminNotificationRepository(prisma as never);

    await expect(repository.findShopIdByDomain('https://Tenant-A.Example.Test/wp-admin/')).resolves.toBe('shop-id');

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: { appId_shopDomain: { appId: 'clever', shopDomain: 'tenant-a.example.test' } }
    });
  });

  test('marks only the requested shop notification as read', async () => {
    const { prisma } = createPrismaHarness({
      notification: { ...notificationRow, readAt: new Date('2026-06-05T07:02:00.000Z') }
    });
    const repository = new PrismaAdminNotificationRepository(prisma as never);

    const result = await repository.markReadForShopDomain({
      notificationId: 'notification-id',
      readAt: new Date('2026-06-05T07:02:00.000Z'),
      shopDomain: 'tenant-a.example.test'
    });

    expect(prisma.adminNotification.updateMany).toHaveBeenCalledWith({
      data: { readAt: new Date('2026-06-05T07:02:00.000Z') },
      where: { id: 'notification-id', readAt: null, shopId: 'shop-id' }
    });
    expect(result).toEqual(
      expect.objectContaining({
        id: 'notification-id',
        readAt: '2026-06-05T07:02:00.000Z'
      })
    );
  });

  test('returns an already-read notification without changing its original read timestamp', async () => {
    const originalReadAt = new Date('2026-06-05T07:01:00.000Z');
    const { prisma } = createPrismaHarness({
      notification: { ...notificationRow, readAt: originalReadAt },
      updateCount: 0
    });
    const repository = new PrismaAdminNotificationRepository(prisma as never);

    const result = await repository.markReadForShopDomain({
      notificationId: 'notification-id',
      readAt: new Date('2026-06-05T07:05:00.000Z'),
      shopDomain: 'tenant-a.example.test'
    });

    expect(prisma.adminNotification.updateMany).toHaveBeenCalledWith({
      data: { readAt: new Date('2026-06-05T07:05:00.000Z') },
      where: { id: 'notification-id', readAt: null, shopId: 'shop-id' }
    });
    expect(result?.readAt).toBe('2026-06-05T07:01:00.000Z');
  });
});

function createPrismaHarness(input: {
  notification?: typeof notificationRow;
  shop?: { id: string } | null;
  updateCount?: number;
} = {}) {
  const row = input.notification ?? notificationRow;
  const prisma = {
    adminNotification: {
      count: vi.fn(() => Promise.resolve(1)),
      create: vi.fn(() => Promise.resolve(row)),
      findFirst: vi.fn(() => Promise.resolve(row)),
      findMany: vi.fn(() => Promise.resolve([row])),
      findUnique: vi.fn(() => Promise.resolve(row)),
      updateMany: vi.fn(() => Promise.resolve({ count: input.updateCount ?? 1 }))
    },
    shop: {
      findUnique: vi.fn(() => Promise.resolve(input.shop === undefined ? { id: 'shop-id' } : input.shop))
    }
  };
  return { prisma };
}
