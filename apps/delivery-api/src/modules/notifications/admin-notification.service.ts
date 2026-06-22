import type {
  AdminNotificationDto,
  AdminNotificationList,
  PrismaAdminNotificationRepository,
} from './admin-notification.repository.js';
import {
  createAdminNotificationInputsForEvent,
  type AdminWebNotificationEvent,
} from './admin-web-notification-events.js';
import {
  type AdminNotificationStreamEvent,
  type AdminNotificationStreamHub,
} from './admin-notification.stream.js';

export type AdminNotificationServiceContract = {
  createAdminNotification(
    event: AdminWebNotificationEvent,
  ): Promise<AdminNotificationBatchResult>;
  listNotifications(input: {
    includeRead?: boolean;
    limit?: number;
    shopDomain: string;
  }): Promise<AdminNotificationList>;
  markNotificationRead(input: {
    notificationId: string;
    readAt?: Date;
    shopDomain: string;
  }): Promise<AdminNotificationDto | null>;
  subscribeToNotificationChanges(input: {
    listener: (event: AdminNotificationStreamEvent) => void;
    shopDomain: string;
  }): Promise<(() => void) | null>;
};

export type AdminNotificationBatchResult = {
  createdCount: number;
  dedupedCount: number;
  notifications: AdminNotificationDto[];
};

export type AdminNotificationChangePublisher = {
  publishNotificationsChanged(input: {
    notificationId: string;
    occurredAt?: Date;
    shopId: string;
  }): Promise<void> | void;
};

export class AdminNotificationService
  implements AdminNotificationServiceContract
{
  constructor(
    private readonly repository: PrismaAdminNotificationRepository,
    private readonly streamHub: AdminNotificationStreamHub,
    private readonly streamPublisher: AdminNotificationChangePublisher = streamHub,
  ) {}

  async createAdminNotification(
    event: AdminWebNotificationEvent,
  ): Promise<AdminNotificationBatchResult> {
    const inputs = createAdminNotificationInputsForEvent(event);
    const notifications: AdminNotificationDto[] = [];
    let createdCount = 0;
    let dedupedCount = 0;

    for (const input of inputs) {
      const result = await this.repository.createForShopOnceWithStatus(input);
      notifications.push(result.notification);
      if (result.created) {
        createdCount += 1;
        await this.streamPublisher.publishNotificationsChanged({
          notificationId: result.notification.id,
          shopId: input.shopId,
        });
      } else {
        dedupedCount += 1;
      }
    }

    return { createdCount, dedupedCount, notifications };
  }

  async listNotifications(input: {
    includeRead?: boolean;
    limit?: number;
    shopDomain: string;
  }): Promise<AdminNotificationList> {
    return this.repository.listForShopDomain(input);
  }

  async markNotificationRead(input: {
    notificationId: string;
    readAt?: Date;
    shopDomain: string;
  }): Promise<AdminNotificationDto | null> {
    return this.repository.markReadForShopDomain(input);
  }

  async subscribeToNotificationChanges(input: {
    listener: (event: AdminNotificationStreamEvent) => void;
    shopDomain: string;
  }): Promise<(() => void) | null> {
    const shopId = await this.repository.findShopIdByDomain(input.shopDomain);
    if (shopId === null) return null;
    return this.streamHub.subscribeToShop(shopId, input.listener);
  }
}
