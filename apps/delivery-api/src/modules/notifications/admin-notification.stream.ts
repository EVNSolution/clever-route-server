export type AdminNotificationStreamEvent = {
  notificationId: string;
  occurredAt: string;
  type: "notifications_changed";
};

type AdminNotificationStreamListener = (
  event: AdminNotificationStreamEvent,
) => void;

/**
 * Process-local fanout for Route Ops browser invalidation streams.
 *
 * The database remains the durable source of truth. Before running delivery-api
 * horizontally, bridge this boundary to a shared pub/sub transport so a
 * notification created on one process can invalidate EventSource clients on
 * another process.
 */
export class AdminNotificationStreamHub {
  private readonly listenersByShopId = new Map<
    string,
    Set<AdminNotificationStreamListener>
  >();

  subscribeToShop(
    shopId: string,
    listener: AdminNotificationStreamListener,
  ): () => void {
    const listeners = this.listenersByShopId.get(shopId) ?? new Set();
    listeners.add(listener);
    this.listenersByShopId.set(shopId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listenersByShopId.delete(shopId);
    };
  }

  publishNotificationsChanged(input: {
    notificationId: string;
    occurredAt?: Date;
    shopId: string;
  }): void {
    const listeners = this.listenersByShopId.get(input.shopId);
    if (listeners === undefined || listeners.size === 0) return;
    const event: AdminNotificationStreamEvent = {
      notificationId: input.notificationId,
      occurredAt: (input.occurredAt ?? new Date()).toISOString(),
      type: "notifications_changed",
    };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Browser stream listeners are advisory fanout. One failed listener must
        // not prevent other tabs for the same shop from receiving invalidation.
      }
    }
  }

  listenerCount(shopId?: string): number {
    if (shopId !== undefined) return this.listenersByShopId.get(shopId)?.size ?? 0;
    let count = 0;
    for (const listeners of this.listenersByShopId.values()) {
      count += listeners.size;
    }
    return count;
  }
}
