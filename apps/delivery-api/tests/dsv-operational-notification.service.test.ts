import { describe, expect, test, vi } from 'vitest';

import { PrismaDsvOperationalNotificationService } from '../src/modules/dsv/dsv-operational-notification.service.js';

describe('PrismaDsvOperationalNotificationService', () => {
  test('combines pending changes, failed delivery alerts, and recoverable cancelled orders', async () => {
    const prisma = {
      driverRouteNotificationAttempt: {
        findMany: vi.fn().mockResolvedValue([{
          errorCode: 'NO_ACTIVE_TOKEN',
          id: 'attempt-1',
          metadata: { changeRequestId: 'change-1' },
          status: 'SKIPPED',
          updatedAt: new Date('2026-08-06T09:01:00.000Z'),
        }]),
      },
      dsvDispatchChangeRequest: {
        findMany: vi.fn().mockResolvedValue([{
          createdAt: new Date('2026-08-06T09:00:00.000Z'),
          id: 'change-1',
          sellerOrder: { sellerOrderKey: 'SO-001' },
          sellerOrderId: 'order-1',
          status: 'PENDING_ACK',
          type: 'ACTIVE_ROUTE_ORDER_REMOVAL',
          updatedAt: new Date('2026-08-06T09:00:00.000Z'),
        }]),
      },
      order: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'order-2',
          sellerOrderKey: 'SO-002',
          updatedAt: new Date('2026-08-06T09:02:00.000Z'),
        }]),
      },
      shop: { findUnique: vi.fn().mockResolvedValue({ id: 'shop-1' }) },
    };
    const service = new PrismaDsvOperationalNotificationService(prisma as never);

    await expect(service.list({ shopDomain: 'Example.MyShopify.Com' })).resolves.toMatchObject({
      items: [
        { kind: 'CANCELLED_ORDER', recoverable: true, sellerOrderId: 'order-2' },
        { changeRequestId: 'change-1', kind: 'DRIVER_NOTIFICATION_FAILED', recoverable: false },
        { changeRequestId: 'change-1', kind: 'CHANGE_PENDING', recoverable: false, sellerOrderId: 'order-1' },
      ],
    });
  });

  test('surfaces pending driver account links without exposing phone numbers', async () => {
    const prisma = {
      driverRouteNotificationAttempt: { findMany: vi.fn().mockResolvedValue([]) },
      dsvDispatchChangeRequest: { findMany: vi.fn().mockResolvedValue([]) },
      order: { findMany: vi.fn().mockResolvedValue([]) },
      shop: { findUnique: vi.fn().mockResolvedValue({ id: 'shop-1' }) },
    };
    const linkService = {
      listPending: vi.fn().mockResolvedValue([{
        accountId: 'account-id',
        accountName: '정재연',
        accountPhoneLast4: '4444',
        createdAt: '2026-08-26T02:00:00.000Z',
        driverId: 'driver-id',
        driverName: '정재연',
        driverPhoneLast4: '2222',
        reason: 'PHONE_MISMATCH',
      }]),
    };
    const service = new PrismaDsvOperationalNotificationService(prisma as never, linkService);

    const result = await service.list({ shopDomain: 'dsv.example' });

    expect(result.items).toEqual([expect.objectContaining({
      id: 'driver-account-link:account-id:driver-id',
      kind: 'DRIVER_ACCOUNT_LINK_PENDING',
      recoverable: false,
      severity: 'warning',
      title: '배송원 앱 계정 연결 검토',
    })]);
    expect(JSON.stringify(result)).not.toContain('4444');
    expect(JSON.stringify(result)).not.toContain('2222');
  });

  test('returns an empty list when the shop is unavailable', async () => {
    const prisma = {
      shop: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new PrismaDsvOperationalNotificationService(prisma as never);

    await expect(service.list({ shopDomain: 'missing.example' })).resolves.toEqual({ items: [] });
  });
});
