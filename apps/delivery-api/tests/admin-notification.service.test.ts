import { describe, expect, test, vi } from 'vitest';

import {
  AdminNotificationService,
  type AdminNotificationBatchResult,
} from '../src/modules/notifications/admin-notification.service.js';
import { AdminNotificationStreamHub } from '../src/modules/notifications/admin-notification.stream.js';
import type {
  AdminNotificationDto,
} from '../src/modules/notifications/admin-notification.repository.js';
import type { AssignedRouteAddressChangedEvent } from '../src/modules/notifications/admin-web-notification-events.js';

const notification: AdminNotificationDto = {
  body: 'Address changed after routing.',
  createdAt: '2026-06-05T07:00:00.000Z',
  href: '/admin/ui/app/routes/route-plan-id',
  id: 'notification-id',
  orderId: 'order-id',
  payload: { routePlanName: 'Route draft' },
  readAt: null,
  routePlanId: 'route-plan-id',
  severity: 'critical',
  title: 'Route assigned order address changed',
  type: 'WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED',
};

describe('AdminNotificationService', () => {
  test('routes admin web notification events through the repository and emits only created changes', async () => {
    const repository = createRepositoryHarness();
    repository.createForShopOnceWithStatus
      .mockResolvedValueOnce({ created: true, notification })
      .mockResolvedValueOnce({ created: false, notification });
    const hub = new AdminNotificationStreamHub();
    const service = new AdminNotificationService(repository as never, hub);
    const streamEvents: Array<{ notificationId: string; type: string }> = [];
    const unsubscribe = hub.subscribeToShop('shop-id', (event) => {
      streamEvents.push({
        notificationId: event.notificationId,
        type: event.type,
      });
    });

    const first = await service.createAdminNotification(addressChangedEvent());
    const second = await service.createAdminNotification(addressChangedEvent());
    unsubscribe();

    const dedupeKeyMatcher: unknown = expect.stringMatching(
      /^woo_address_changed_route_assigned:shop-id:order-id:route-plan-id:/u,
    );
    expect(repository.createForShopOnceWithStatus).toHaveBeenCalledTimes(2);
    expect(repository.createForShopOnceWithStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: dedupeKeyMatcher,
        routePlanId: 'route-plan-id',
        severity: 'critical',
        shopId: 'shop-id',
        type: 'WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED',
      }),
    );
    expect(first).toEqual<AdminNotificationBatchResult>({
      createdCount: 1,
      dedupedCount: 0,
      notifications: [notification],
    });
    expect(second).toEqual<AdminNotificationBatchResult>({
      createdCount: 0,
      dedupedCount: 1,
      notifications: [notification],
    });
    expect(streamEvents).toEqual([
      { notificationId: 'notification-id', type: 'notifications_changed' },
    ]);
  });



  test('uses the configured publisher for created notifications', async () => {
    const repository = createRepositoryHarness();
    repository.createForShopOnceWithStatus.mockResolvedValueOnce({
      created: true,
      notification,
    });
    const hub = new AdminNotificationStreamHub();
    const publisher = { publishNotificationsChanged: vi.fn(() => Promise.resolve()) };
    const service = new AdminNotificationService(
      repository as never,
      hub,
      publisher,
    );

    await service.createAdminNotification(addressChangedEvent());

    expect(publisher.publishNotificationsChanged).toHaveBeenCalledWith({
      notificationId: 'notification-id',
      shopId: 'shop-id',
    });
  });

  test('does not write or emit when an event is not notification-worthy', async () => {
    const repository = createRepositoryHarness();
    const hub = new AdminNotificationStreamHub();
    const service = new AdminNotificationService(repository as never, hub);
    const listener = vi.fn();
    hub.subscribeToShop('shop-id', listener);

    const result = await service.createAdminNotification({
      ...addressChangedEvent(),
      existingStop: null,
    });

    expect(result).toEqual({
      createdCount: 0,
      dedupedCount: 0,
      notifications: [],
    });
    expect(repository.createForShopOnceWithStatus).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  test('formats an out-of-order driver stop as a warning linked to the affected route', async () => {
    const repository = createRepositoryHarness();
    repository.createForShopOnceWithStatus.mockResolvedValueOnce({
      created: true,
      notification,
    });
    const service = new AdminNotificationService(repository as never, new AdminNotificationStreamHub());

    await service.createAdminNotification({
      createdAt: new Date('2026-05-07T06:10:00.000Z'),
      driverId: 'driver-id',
      eventId: 'driver-event-id',
      eventType: 'STOP_ARRIVED',
      expectedDeliveryStopId: 'stop-1',
      expectedSequence: 1,
      occurredAt: new Date('2026-05-07T06:09:30.000Z'),
      routePlanId: 'route-plan-id',
      selectedDeliveryStopId: 'stop-2',
      selectedSequence: 2,
      shopId: 'shop-id',
      type: 'driver.stop_sequence_deviated',
    });

    expect(repository.createForShopOnceWithStatus).toHaveBeenCalledWith({
      body: 'Stop 2 was handled before planned Stop 1. Review the active route and updated ETAs.',
      createdAt: new Date('2026-05-07T06:10:00.000Z'),
      dedupeKey: 'driver_stop_sequence_deviation:route-plan-id:stop-2',
      href: '/admin/ui/app/routes/route-plan-id',
      payload: {
        driverId: 'driver-id',
        eventId: 'driver-event-id',
        eventType: 'STOP_ARRIVED',
        expectedDeliveryStopId: 'stop-1',
        expectedSequence: 1,
        occurredAt: '2026-05-07T06:09:30.000Z',
        selectedDeliveryStopId: 'stop-2',
        selectedSequence: 2,
        version: 1,
      },
      routePlanId: 'route-plan-id',
      severity: 'warning',
      shopId: 'shop-id',
      title: 'Driver changed the planned stop order',
      type: 'DRIVER_STOP_SEQUENCE_DEVIATED',
    });
  });


  test('subscribes browser streams by normalized shop domain lookup', async () => {
    const repository = createRepositoryHarness();
    repository.findShopIdByDomain.mockResolvedValueOnce('shop-id');
    const hub = new AdminNotificationStreamHub();
    const service = new AdminNotificationService(repository as never, hub);
    const listener = vi.fn();

    const unsubscribe = await service.subscribeToNotificationChanges({
      listener,
      shopDomain: 'Tenant-A.Example.Test',
    });

    expect(repository.findShopIdByDomain).toHaveBeenCalledWith(
      'Tenant-A.Example.Test',
    );
    expect(unsubscribe).toEqual(expect.any(Function));
    hub.publishNotificationsChanged({
      notificationId: 'notification-id',
      shopId: 'shop-id',
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notifications_changed' }),
    );
    unsubscribe?.();
    expect(hub.listenerCount('shop-id')).toBe(0);
  });
});

function createRepositoryHarness() {
  return {
    createForShopOnceWithStatus: vi.fn(),
    findShopIdByDomain: vi.fn(),
  };
}


function addressChangedEvent(): AssignedRouteAddressChangedEvent {
  return {
    existingStop: {
      address1: '100 Old Route St',
      address2: 'Unit 1',
      city: 'Mississauga',
      countryCode: 'CA',
      postalCode: 'L5A 1A1',
      province: 'ON',
      routePlanStops: [
        {
          routePlan: {
            id: 'route-plan-id',
            name: 'Route draft',
            status: 'DRAFT',
          },
        },
      ],
    },
    incomingStop: {
      address1: '300 City Centre Dr',
      address2: '#08',
      city: 'Mississauga',
      countryCode: 'CA',
      postalCode: 'L5B 3C1',
      province: 'ON',
    },
    orderId: 'order-id',
    orderName: '#1035',
    shopId: 'shop-id',
    type: 'woo.assigned_route_address_changed',
  };
}
