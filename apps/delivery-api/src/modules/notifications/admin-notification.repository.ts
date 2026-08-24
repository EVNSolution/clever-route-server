import { Prisma, type PrismaClient } from '@prisma/client';

import { normalizeShopDomain } from '../commerce/commerce-connection.repository.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import type { PrismaOperationalAlertRepository } from './operational-alert.repository.js';

export const WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED_NOTIFICATION =
  'WOO_ASSIGNED_ROUTE_ADDRESS_CHANGED';
export const DRIVER_STOP_SEQUENCE_DEVIATED_NOTIFICATION =
  'DRIVER_STOP_SEQUENCE_DEVIATED';
export const DRIVER_STOP_SKIPPED_ASSIGNMENT_ERROR_NOTIFICATION =
  'DRIVER_STOP_SKIPPED_ASSIGNMENT_ERROR';

export type AdminNotificationSeverity =
  | 'critical'
  | 'info'
  | 'success'
  | 'warning';

export type AdminNotificationDto = {
  acknowledgedAt?: string | null;
  alertCycleId?: string | null;
  body: string | null;
  createdAt: string;
  href: string | null;
  id: string;
  lastObservedAt?: string;
  openedAt?: string;
  orderId: string | null;
  payload: Prisma.JsonValue | null;
  readAt: string | null;
  resolvedAt?: string | null;
  routePlanId: string | null;
  severity: AdminNotificationSeverity;
  title: string;
  type: string;
};

export type AdminNotificationList = {
  notifications: AdminNotificationDto[];
  unreadCount: number;
};

export type AdminNotificationCreateResult = {
  created: boolean;
  notification: AdminNotificationDto;
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
  '$transaction' | 'adminNotification' | 'alertCycle' | 'shop'
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
  alertCycles: {
    orderBy: { openedAt: 'desc' as const },
    select: { acknowledgedAt: true, id: true, lastObservedAt: true, openedAt: true, resolvedAt: true },
    take: 1
  },
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
  constructor(
    private readonly prisma: AdminNotificationPrismaClient,
    private readonly operationalAlerts?: PrismaOperationalAlertRepository
  ) {}

  async createForShopOnceWithStatus(
    input: CreateAdminNotificationInput,
  ): Promise<AdminNotificationCreateResult> {
    if (this.operationalAlerts !== undefined) {
      const observedAt = input.createdAt ?? new Date();
      const cycle = await this.operationalAlerts.openOrObserve({
        ...(input.body === undefined ? {} : { body: input.body }),
        dedupeKey: input.dedupeKey,
        ...(input.href === undefined ? {} : { href: input.href }),
        observedAt,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        ...(input.routePlanId === undefined ? {} : { routePlanId: input.routePlanId }),
        severity: input.severity === 'critical' ? 'CRITICAL' : 'WARNING',
        shopId: input.shopId,
        title: input.title,
        type: input.type
      });
      const projected = await this.prisma.adminNotification.findUnique({
        select: adminNotificationSelect,
        where: { shopId_dedupeKey: { dedupeKey: input.dedupeKey, shopId: input.shopId } }
      });
      if (projected === null) throw new Error('Atomic alert projection was not created');
      return { created: cycle.openedAt === cycle.lastObservedAt, notification: toAdminNotificationDto(projected) };
    }
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
      return { created: true, notification: toAdminNotificationDto(created) };
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
      return { created: false, notification: toAdminNotificationDto(existing) };
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
    const notification = await this.prisma.$transaction(async (tx) => {
      const projected = await tx.adminNotification.findFirst({
        select: {
          alertCycles: { orderBy: { openedAt: 'desc' }, select: { readAt: true }, take: 1 },
          id: true,
          readAt: true
        },
        where: { id: input.notificationId, shopId: shop.id }
      });
      if (projected === null) return null;
      const effectiveReadAt = projected.alertCycles[0]?.readAt ?? projected.readAt ?? readAt;
      await tx.alertCycle.updateMany({
        data: { readAt: effectiveReadAt },
        where: { legacyNotificationId: projected.id, readAt: null }
      });
      await tx.adminNotification.updateMany({
        data: { readAt: effectiveReadAt },
        where: { id: projected.id, readAt: null, shopId: shop.id }
      });
      return tx.adminNotification.findFirst({
        select: adminNotificationSelect,
        where: { id: projected.id, shopId: shop.id }
      });
    });
    return notification === null ? null : toAdminNotificationDto(notification);
  }

  async acknowledgeForShopDomain(input: { actor: string; notificationId: string; shopDomain: string }): Promise<AdminNotificationDto | null> {
    if (this.operationalAlerts === undefined) return null;
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) return null;
    const cycle = await this.prisma.adminNotification.findFirst({
      select: { alertCycles: { orderBy: { openedAt: 'desc' }, select: { id: true }, take: 1, where: { resolvedAt: null } } },
      where: { id: input.notificationId, shopId: shop.id }
    });
    const cycleId = cycle?.alertCycles[0]?.id;
    if (cycleId === undefined) return null;
    const acknowledged = await this.operationalAlerts.acknowledge({ actor: input.actor, alertId: cycleId, shopDomain: input.shopDomain });
    if (acknowledged === null) return null;
    const notification = await this.prisma.adminNotification.findFirst({ select: adminNotificationSelect, where: { id: input.notificationId, shopId: shop.id } });
    return notification === null ? null : toAdminNotificationDto(notification);
  }

  async findShopIdByDomain(shopDomain: string): Promise<string | null> {
    return (await this.findShop(shopDomain))?.id ?? null;
  }

  private async findShop(shopDomain: string): Promise<{ id: string } | null> {
    return this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain: normalizeShopDomain(shopDomain) }),
    });
  }
}

export function toAdminNotificationDto(
  row: AdminNotificationRow,
): AdminNotificationDto {
  const cycle = row.alertCycles?.[0] ?? null;
  return {
    ...(cycle === null ? {} : {
      acknowledgedAt: cycle.acknowledgedAt?.toISOString() ?? null,
      alertCycleId: cycle.id,
      lastObservedAt: cycle.lastObservedAt.toISOString(),
      openedAt: cycle.openedAt.toISOString(),
      resolvedAt: cycle.resolvedAt?.toISOString() ?? null
    }),
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
