import type {
  AdminNotificationDto,
  AdminNotificationList,
  CreateAdminNotificationInput,
  PrismaAdminNotificationRepository,
} from './admin-notification.repository.js';

export type AdminNotificationServiceContract = {
  createNotificationOnce(
    input: CreateAdminNotificationInput,
  ): Promise<AdminNotificationDto>;
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
};

export class AdminNotificationService
  implements AdminNotificationServiceContract
{
  constructor(private readonly repository: PrismaAdminNotificationRepository) {}

  async createNotificationOnce(
    input: CreateAdminNotificationInput,
  ): Promise<AdminNotificationDto> {
    return this.repository.createForShopOnce(input);
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
}
