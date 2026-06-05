import { Prisma, type PrismaClient } from '@prisma/client';

import { normalizeShopDomain } from '../commerce/commerce-connection.repository.js';

export const WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED_NOTIFICATION =
  'WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED';

export type AdminNotificationSeverity =
  | 'critical'
  | 'info'
  | 'success'
  | 'warning';

export type AdminNotificationDto = {
  body: string | null;
  createdAt: string;
  href: string | null;
  id: string;
  orderId: string | null;
  payload: Prisma.JsonValue | null;
  readAt: string | null;
  routePlanId: string | null;
  severity: AdminNotificationSeverity;
  title: string;
  type: string;
};

export type AdminNotificationList = {
  notifications: AdminNotificationDto[];
  unreadCount: number;
};

export type CreateAdminNotificationInput = {
  body?: string | null;
  createdAt?: Date;
  dedupeKey: string;
  href?: string | null;
  orderId?: string | null;
  payload?: Prisma.InputJsonValue | null;
  routePlanId?: string | null;
  severity: AdminNotificationSeverity;
  shopId: string;
  title: string;
  type: string;
};

type AdminNotificationPrismaClient = Pick<
  PrismaClient,
  'adminNotification' | 'shop'
>;

type ListForShopDomainInput = {
  includeRead?: boolean;
  limit?: number;
  shopDomain: string;
};

type MarkReadInput = {
  notificationId: string;
  readAt?: Date;
  shopDomain: string;
};

const adminNotificationSelect = {
  body: true,
  createdAt: true,
  href: true,
  id: true,
  orderId: true,
  payload: true,
  readAt: true,
  routePlanId: true,
  severity: true,
  title: true,
  type: true,
} satisfies Prisma.AdminNotificationSelect;

type AdminNotificationRow = Prisma.AdminNotificationGetPayload<{
  select: typeof adminNotificationSelect;
}>;

export class PrismaAdminNotificationRepository {
  constructor(private readonly prisma: AdminNotificationPrismaClient) {}

  async createForShopOnce(
    input: CreateAdminNotificationInput,
  ): Promise<AdminNotificationDto> {
    try {
      const created = await this.prisma.adminNotification.create({
        data: {
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.createdAt === undefined
            ? {}
            : { createdAt: input.createdAt }),
          dedupeKey: input.dedupeKey,
          ...(input.href === undefined ? {} : { href: input.href }),
          ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
          ...(input.payload === undefined || input.payload === null
            ? {}
            : { payload: input.payload }),
          ...(input.routePlanId === undefined
            ? {}
            : { routePlanId: input.routePlanId }),
          severity: input.severity,
          shopId: input.shopId,
          title: input.title,
          type: input.type,
        },
        select: adminNotificationSelect,
      });
      return toAdminNotificationDto(created);
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) throw error;
      const existing = await this.prisma.adminNotification.findUnique({
        select: adminNotificationSelect,
        where: {
          shopId_dedupeKey: {
            dedupeKey: input.dedupeKey,
            shopId: input.shopId,
          },
        },
      });
      if (existing === null) throw error;
      return toAdminNotificationDto(existing);
    }
  }

  async listForShopDomain(
    input: ListForShopDomainInput,
  ): Promise<AdminNotificationList> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) return { notifications: [], unreadCount: 0 };

    const includeRead = input.includeRead !== false;
    const where: Prisma.AdminNotificationWhereInput = {
      shopId: shop.id,
      ...(includeRead ? {} : { readAt: null }),
    };
    const [notifications, unreadCount] = await Promise.all([
      this.prisma.adminNotification.findMany({
        orderBy: [{ createdAt: 'desc' }],
        select: adminNotificationSelect,
        take: clampNotificationLimit(input.limit),
        where,
      }),
      this.prisma.adminNotification.count({
        where: { shopId: shop.id, readAt: null },
      }),
    ]);

    return {
      notifications: notifications.map(toAdminNotificationDto),
      unreadCount,
    };
  }

  async markReadForShopDomain(
    input: MarkReadInput,
  ): Promise<AdminNotificationDto | null> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) return null;

    const readAt = input.readAt ?? new Date();
    await this.prisma.adminNotification.updateMany({
      data: { readAt },
      where: {
        id: input.notificationId,
        readAt: null,
        shopId: shop.id,
      },
    });

    const notification = await this.prisma.adminNotification.findFirst({
      select: adminNotificationSelect,
      where: {
        id: input.notificationId,
        shopId: shop.id,
      },
    });
    return notification === null ? null : toAdminNotificationDto(notification);
  }

  private async findShop(shopDomain: string): Promise<{ id: string } | null> {
    return this.prisma.shop.findUnique({
      select: { id: true },
      where: { shopDomain: normalizeShopDomain(shopDomain) },
    });
  }
}

export function toAdminNotificationDto(
  row: AdminNotificationRow,
): AdminNotificationDto {
  return {
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    href: row.href,
    id: row.id,
    orderId: row.orderId,
    payload: row.payload,
    readAt: row.readAt?.toISOString() ?? null,
    routePlanId: row.routePlanId,
    severity: readNotificationSeverity(row.severity),
    title: row.title,
    type: row.type,
  };
}

function clampNotificationLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 30;
  return Math.min(Math.max(Math.floor(value), 1), 100);
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function readNotificationSeverity(value: string): AdminNotificationSeverity {
  return value === 'critical' ||
    value === 'info' ||
    value === 'success' ||
    value === 'warning'
    ? value
    : 'info';
}
