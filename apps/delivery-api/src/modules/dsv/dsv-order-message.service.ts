import type { PrismaClient } from '@prisma/client';

import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import type { DsvTimeConstraintActor } from './dsv-time-constraint-command.service.js';
import type { PrismaDsvDriverNotificationDispatcher } from './dsv-driver-notification.dispatcher.js';

export type DsvOrderMessageAudience = 'CUSTOMER' | 'DRIVER';

export type DsvOrderMessageDto = {
  audience: DsvOrderMessageAudience;
  authorId?: string | null;
  authorType: string;
  body: string;
  createdAt: string;
  id: string;
  orderId: string;
  readByDriverAt?: string | null;
};

export type DsvOrderMessageService = {
  create(input: {
    actor: DsvTimeConstraintActor;
    audience: DsvOrderMessageAudience;
    body: string;
    commandId: string;
    sellerOrderId: string;
    shopDomain: string;
  }): Promise<DsvOrderMessageDto>;
  listCustomerMessages(input: { customerId: string; sellerOrderId: string; shopId: string }): Promise<DsvOrderMessageDto[]>;
  markDriverMessageRead(input: {
    driverId: string;
    messageId: string;
    routePlanId: string;
    shopId: string;
  }): Promise<DsvOrderMessageDto>;
  updateCustomerNotificationSettings(input: {
    customerId: string;
    enabled: boolean;
    recipient: string | null;
    shopDomain: string;
  }): Promise<{ customerId: string; notificationEmailEnabled: boolean; notificationEmailRecipient: string | null }>;
};

export class DsvOrderMessageError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' | 'NOT_FOUND' | 'VALIDATION_FAILED', message: string = code) {
    super(message);
    this.name = 'DsvOrderMessageError';
  }
}

type OrderMessagePrismaClient = Pick<PrismaClient, 'customer' | 'customerRouteNotificationFact' | 'driverRouteNotificationAttempt' | 'order' | 'orderMessage' | 'shop'>;

export class PrismaDsvOrderMessageService implements DsvOrderMessageService {
  constructor(
    private readonly prisma: OrderMessagePrismaClient,
    private readonly driverNotificationDispatcher?: Pick<PrismaDsvDriverNotificationDispatcher, 'dispatchByIdempotencyKey'>
  ) {}

  async create(input: {
    actor: DsvTimeConstraintActor;
    audience: DsvOrderMessageAudience;
    body: string;
    commandId: string;
    sellerOrderId: string;
    shopDomain: string;
  }): Promise<DsvOrderMessageDto> {
    const shop = await this.findShop(input.shopDomain);
    const normalizedBody = input.body.trim();
    if (normalizedBody === '' || normalizedBody.length > 500) {
      throw new DsvOrderMessageError('VALIDATION_FAILED', 'Message body must contain 1 to 500 characters');
    }
    const existing = await this.prisma.orderMessage.findUnique({
      where: { shopId_commandId: { commandId: input.commandId, shopId: shop.id } },
    });
    if (existing !== null) {
      if (existing.orderId !== input.sellerOrderId || existing.audience !== input.audience || existing.body !== normalizedBody) {
        throw new DsvOrderMessageError('IDEMPOTENCY_PAYLOAD_MISMATCH');
      }
    }
    const order = await this.prisma.order.findFirst({
      select: {
        currentRouteVersion: { select: { driverId: true, groupingId: true, id: true, routePlanId: true, version: true } },
        customer: { select: { id: true, notificationEmailEnabled: true, notificationEmailRecipient: true } },
        deliveryStops: { orderBy: { createdAt: 'desc' }, select: { id: true }, take: 1 },
        id: true,
      },
      where: { id: input.sellerOrderId, shopId: shop.id },
    });
    if (order === null) throw new DsvOrderMessageError('NOT_FOUND');
    let message = existing;
    if (message === null) {
      try {
        message = await this.prisma.orderMessage.create({
          data: {
            audience: input.audience,
            authorId: input.actor.actorId ?? null,
            authorType: input.actor.actorType,
            body: normalizedBody,
            commandId: input.commandId,
            orderId: order.id,
            shopId: shop.id,
          },
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const concurrent = await this.prisma.orderMessage.findUnique({
          where: { shopId_commandId: { commandId: input.commandId, shopId: shop.id } },
        });
        if (concurrent === null) throw error;
        if (concurrent.orderId !== input.sellerOrderId || concurrent.audience !== input.audience || concurrent.body !== normalizedBody) {
          throw new DsvOrderMessageError('IDEMPOTENCY_PAYLOAD_MISMATCH');
        }
        message = concurrent;
      }
    }
    let driverNotificationIdempotencyKey: string | null = null;
    if (input.audience === 'DRIVER' && order.currentRouteVersion?.routePlanId !== null && order.currentRouteVersion?.routePlanId !== undefined) {
      driverNotificationIdempotencyKey = `dsv-order-message:${message.id}`;
      await this.prisma.driverRouteNotificationAttempt.upsert({
        create: {
          action: 'CHANGED',
          childVersionId: order.currentRouteVersion.id,
          driverId: order.currentRouteVersion.driverId,
          groupingId: order.currentRouteVersion.groupingId,
          groupingVersion: order.currentRouteVersion.version,
          idempotencyKey: driverNotificationIdempotencyKey,
          metadata: { orderMessageId: message.id },
          provider: 'FCM',
          routePlanId: order.currentRouteVersion.routePlanId,
          shopId: shop.id,
          status: 'PENDING',
        },
        update: {},
        where: { idempotencyKey: driverNotificationIdempotencyKey },
      });
    }
    if (input.audience === 'CUSTOMER' && order.customer?.notificationEmailEnabled === true) {
      const recipient = order.customer.notificationEmailRecipient;
      if (recipient !== null && recipient.trim() !== '') {
        await this.prisma.customerRouteNotificationFact.upsert({
          create: {
            deliveryStopId: order.deliveryStops[0]?.id ?? null,
            idempotencyKey: `${shop.id}:${input.commandId}:customer-message-email`,
            metadata: { body: message.body, orderMessageId: message.id },
            orderId: order.id,
            recipientEmailSnapshot: recipient,
            requestedUiStatus: null,
            routePlanId: order.currentRouteVersion?.routePlanId ?? null,
            shopId: shop.id,
            source: 'DSV_CUSTOMER_MESSAGE',
            status: 'QUEUED',
          },
          update: {},
          where: { idempotencyKey: `${shop.id}:${input.commandId}:customer-message-email` },
        });
      }
    }
    if (driverNotificationIdempotencyKey !== null) {
      await this.dispatchDriverNotification(driverNotificationIdempotencyKey);
    }
    return toDto(message);
  }

  async listCustomerMessages(input: { customerId: string; sellerOrderId: string; shopId: string }): Promise<DsvOrderMessageDto[]> {
    const order = await this.prisma.order.findFirst({ select: { id: true }, where: { customerId: input.customerId, id: input.sellerOrderId, shopId: input.shopId } });
    if (order === null) throw new DsvOrderMessageError('NOT_FOUND');
    const messages = await this.prisma.orderMessage.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      where: { audience: 'CUSTOMER', orderId: order.id, shopId: input.shopId },
    });
    return messages.map(toDto);
  }

  async markDriverMessageRead(input: {
    driverId: string;
    messageId: string;
    routePlanId: string;
    shopId: string;
  }): Promise<DsvOrderMessageDto> {
    const message = await this.prisma.orderMessage.findFirst({
      where: {
        audience: 'DRIVER',
        id: input.messageId,
        order: {
          currentRouteVersion: {
            driverId: input.driverId,
            routePlanId: input.routePlanId,
          },
        },
        shopId: input.shopId,
      },
    });
    if (message === null) throw new DsvOrderMessageError('NOT_FOUND');
    if (message.readByDriverAt !== null) return toDto(message);
    const readAt = new Date();
    const updated = await this.prisma.orderMessage.updateMany({
      data: { readByDriverAt: readAt },
      where: { id: message.id, readByDriverAt: null, shopId: input.shopId },
    });
    if (updated.count === 1) return toDto({ ...message, readByDriverAt: readAt });
    const concurrent = await this.prisma.orderMessage.findFirst({ where: { id: message.id, shopId: input.shopId } });
    if (concurrent === null) throw new DsvOrderMessageError('NOT_FOUND');
    return toDto(concurrent);
  }

  async updateCustomerNotificationSettings(input: {
    customerId: string;
    enabled: boolean;
    recipient: string | null;
    shopDomain: string;
  }): Promise<{ customerId: string; notificationEmailEnabled: boolean; notificationEmailRecipient: string | null }> {
    if (input.enabled && !isValidEmail(input.recipient)) {
      throw new DsvOrderMessageError('VALIDATION_FAILED', 'notificationEmailRecipient must be a valid email when enabled');
    }
    const shop = await this.findShop(input.shopDomain);
    const updated = await this.prisma.customer.updateMany({
      data: {
        notificationEmailEnabled: input.enabled,
        notificationEmailRecipient: input.enabled ? input.recipient?.trim() ?? null : input.recipient?.trim() ?? null,
      },
      where: { id: input.customerId, shopId: shop.id },
    });
    if (updated.count !== 1) throw new DsvOrderMessageError('NOT_FOUND');
    return {
      customerId: input.customerId,
      notificationEmailEnabled: input.enabled,
      notificationEmailRecipient: input.enabled ? input.recipient?.trim() ?? null : input.recipient?.trim() ?? null,
    };
  }

  private async findShop(shopDomain: string): Promise<{ id: string }> {
    const shop = await this.prisma.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ shopDomain: shopDomain.trim().toLowerCase() }) });
    if (shop === null) throw new DsvOrderMessageError('NOT_FOUND');
    return shop;
  }

  private async dispatchDriverNotification(idempotencyKey: string): Promise<void> {
    if (this.driverNotificationDispatcher === undefined) return;
    await this.driverNotificationDispatcher.dispatchByIdempotencyKey(idempotencyKey).catch(() => undefined);
  }
}

function toDto(message: { audience: DsvOrderMessageAudience; authorId: string | null; authorType: string; body: string; createdAt: Date; id: string; orderId: string; readByDriverAt: Date | null }): DsvOrderMessageDto {
  return {
    audience: message.audience,
    authorId: message.authorId,
    authorType: message.authorType,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    id: message.id,
    orderId: message.orderId,
    readByDriverAt: message.readByDriverAt?.toISOString() ?? null,
  };
}

function isValidEmail(value: string | null): value is string {
  if (value === null) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
