import { describe, expect, test, vi } from 'vitest';

import { AdminNotificationStreamHub } from '../src/modules/notifications/admin-notification.stream.js';

describe('AdminNotificationStreamHub', () => {
  test('publishes notification change invalidations only to matching shop listeners', () => {
    const hub = new AdminNotificationStreamHub();
    const shopListener = vi.fn();
    const otherShopListener = vi.fn();
    const unsubscribe = hub.subscribeToShop('shop-id', shopListener);
    hub.subscribeToShop('other-shop-id', otherShopListener);

    hub.publishNotificationsChanged({
      notificationId: 'notification-id',
      shopId: 'shop-id',
    });

    expect(shopListener).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: 'notification-id',
        type: 'notifications_changed',
      }),
    );
    expect(otherShopListener).not.toHaveBeenCalled();
    expect(hub.listenerCount('shop-id')).toBe(1);
    unsubscribe();
    expect(hub.listenerCount('shop-id')).toBe(0);
  });

  test('continues notifying healthy listeners when one listener throws', () => {
    const hub = new AdminNotificationStreamHub();
    const badListener = vi.fn(() => {
      throw new Error('stream closed');
    });
    const goodListener = vi.fn();
    hub.subscribeToShop('shop-id', badListener);
    hub.subscribeToShop('shop-id', goodListener);

    expect(() =>
      hub.publishNotificationsChanged({
        notificationId: 'notification-id',
        shopId: 'shop-id',
      }),
    ).not.toThrow();
    expect(goodListener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notifications_changed' }),
    );
  });
});
