import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { redactTelemetryMessage, safeErrorCode } from '../security/safe-telemetry-redaction.js';
import { appScopedShopWhere, normalizeShopifyAppId } from './shopify-app-scope.js';

export type RecordShopifyWebhookEventInput = {
  appId?: string | undefined;
  apiVersion: string | null;
  eventId: string | null;
  payload: unknown;
  rawBody: string;
  shopDomain: string;
  topic: string;
  triggeredAt: Date | null;
  webhookId: string;
};

export type RecordShopifyWebhookEventResult = {
  duplicate: boolean;
  status: string;
  webhookId: string;
};

type ShopifyWebhookPrivacyPrismaClient = Pick<PrismaClient, '$transaction' | 'order' | 'shop' | 'shopifyWebhookEvent'>;

export type ClaimOrderWebhookResult =
  | { action: 'process'; event: ClaimedShopifyWebhookEvent }
  | { action: 'noop'; reason: 'already_done' | 'permanent_failure' }
  | { action: 'queued'; reason: 'already_queued' | 'retry_wait' | 'processing' };

export type ClaimedShopifyWebhookEvent = {
  apiVersion: string | null;
  appId: string;
  attemptCount: number;
  id: string;
  leaseToken: string;
  maxAttempts: number;
  payload: unknown;
  shopDomain: string;
  shopId: string;
  topic: string;
  triggeredAt: Date | null;
  webhookId: string;
};

export class PrismaShopifyWebhookEventRepository {
  constructor(private readonly prisma: ShopifyWebhookPrivacyPrismaClient) {}

  async recordWebhook(
    input: RecordShopifyWebhookEventInput
  ): Promise<RecordShopifyWebhookEventResult> {
    return this.recordWebhookEvent(input);
  }

  async getOrderWebhookDeliveryDisposition(input: {
    appId?: string | undefined;
    shopDomain: string;
    webhookId: string;
  }): Promise<ClaimOrderWebhookResult> {
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) })
    });
    if (shop === null) {
      throw new Error(`Shop not installed: ${input.shopDomain}`);
    }

    const event = await this.prisma.shopifyWebhookEvent.findUnique({
      select: { id: true, lastError: true, status: true },
      where: { shopId_webhookId: { shopId: shop.id, webhookId: input.webhookId } }
    });
    if (event === null) {
      throw new Error(`Shopify webhook event not recorded: ${input.webhookId}`);
    }

    if (event.status === 'PROCESSED' || event.status === 'IGNORED') {
      return { action: 'noop', reason: 'already_done' };
    }
    if (event.status === 'DEAD_LETTER' || (event.status === 'FAILED' && event.lastError?.startsWith('PERMANENT:'))) {
      return { action: 'noop', reason: 'permanent_failure' };
    }

    return {
      action: 'queued',
      reason: event.status === 'PROCESSING'
        ? 'processing'
        : event.status === 'RETRY_WAIT' || event.status === 'FAILED'
          ? 'retry_wait'
          : 'already_queued'
    };
  }

  async claimNextOrderWebhook(input: {
    leaseMs: number;
    now?: Date | undefined;
    workerId: string;
  }): Promise<ClaimOrderWebhookResult> {
    const now = input.now ?? new Date();
    const due = await this.prisma.shopifyWebhookEvent.findFirst({
      orderBy: { nextRunAt: 'asc' },
      select: { id: true, status: true },
      where: {
        topic: { in: ORDER_TOPICS },
        OR: [
          { status: { in: ['RECEIVED', 'QUEUED', 'RETRY_WAIT', 'FAILED'] }, nextRunAt: { lte: now } },
          { status: 'PROCESSING', leaseExpiresAt: { lt: now } }
        ]
      }
    });
    if (due === null) {
      return { action: 'queued', reason: 'already_queued' };
    }

    const leaseToken = randomUUID();
    const claimed = await this.prisma.shopifyWebhookEvent.updateMany({
      data: {
        attemptCount: { increment: 1 },
        lastError: null,
        lastErrorCode: null,
        lastErrorMessageRedacted: null,
        leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
        leaseToken,
        status: 'PROCESSING',
        workerId: input.workerId
      },
      where: {
        id: due.id,
        OR: [
          { status: { in: ['RECEIVED', 'QUEUED', 'RETRY_WAIT', 'FAILED'] }, nextRunAt: { lte: now } },
          { status: 'PROCESSING', leaseExpiresAt: { lt: now } }
        ]
      }
    });
    if (claimed.count !== 1) {
      return { action: 'queued', reason: 'processing' };
    }

    const event = await this.prisma.shopifyWebhookEvent.findUnique({
      select: {
        apiVersion: true,
        id: true,
        attemptCount: true,
        leaseToken: true,
        maxAttempts: true,
        payload: true,
        shop: { select: { appId: true, id: true, shopDomain: true } },
        topic: true,
        triggeredAt: true,
        webhookId: true
      },
      where: { id: due.id }
    });
    if (event === null || event.leaseToken === null) return { action: 'queued', reason: 'already_queued' };

    return {
      action: 'process',
      event: {
        apiVersion: event.apiVersion,
        appId: event.shop.appId,
        attemptCount: event.attemptCount,
        id: event.id,
        leaseToken: event.leaseToken,
        maxAttempts: event.maxAttempts,
        payload: event.payload,
        shopDomain: event.shop.shopDomain,
        shopId: event.shop.id,
        topic: event.topic,
        triggeredAt: event.triggeredAt,
        webhookId: event.webhookId
      }
    };
  }

  async markOrderWebhookProcessed(input: {
    appId?: string | undefined;
    id: string;
    leaseToken: string;
  }): Promise<boolean> {
    return await this.updateOrderWebhookStatus({
      ...input,
      data: {
        deadLetteredAt: null,
        lastError: null,
        lastErrorCode: null,
        lastErrorMessageRedacted: null,
        leaseExpiresAt: null,
        leaseToken: null,
        processedAt: new Date(),
        status: 'PROCESSED',
        workerId: null
      }
    });
  }

  async markOrderWebhookFailed(input: {
    appId?: string | undefined;
    attemptCount: number;
    error: string;
    id: string;
    leaseToken: string;
    maxAttempts: number;
    nextRunAt?: Date | undefined;
  }): Promise<boolean> {
    const permanent = input.error.startsWith('PERMANENT:') || input.attemptCount >= input.maxAttempts;
    return await this.updateOrderWebhookStatus({
      ...input,
      data: {
        deadLetteredAt: permanent ? new Date() : null,
        lastError: input.error,
        lastErrorCode: safeErrorCode(input.error.split(':')[0] ?? 'ERROR'),
        lastErrorMessageRedacted: redactTelemetryMessage(input.error),
        leaseExpiresAt: null,
        leaseToken: null,
        nextRunAt: input.nextRunAt ?? nextRetryAt(input.attemptCount),
        status: permanent ? 'DEAD_LETTER' : 'RETRY_WAIT',
        workerId: null
      }
    });
  }

  private async updateOrderWebhookStatus(input: {
    appId?: string | undefined;
    data: {
      deadLetteredAt?: Date | null;
      lastError: string | null;
      lastErrorCode?: string | null;
      lastErrorMessageRedacted?: string | null;
      leaseExpiresAt?: Date | null;
      leaseToken?: string | null;
      nextRunAt?: Date;
      processedAt?: Date;
      status: 'PROCESSED' | 'RETRY_WAIT' | 'DEAD_LETTER';
      workerId?: string | null;
    };
    id: string;
    leaseToken: string;
  }): Promise<boolean> {
    const updated = await this.prisma.shopifyWebhookEvent.updateMany({
      data: input.data,
      where: { id: input.id, leaseToken: input.leaseToken, status: 'PROCESSING' }
    });
    return updated.count === 1;
  }

  async recordWebhookEvent(
    input: RecordShopifyWebhookEventInput
  ): Promise<RecordShopifyWebhookEventResult> {
    const appId = normalizeShopifyAppId(input.appId);
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const createShop =
      input.apiVersion === null
        ? { appId, shopDomain }
        : {
            apiVersion: input.apiVersion,
            appId,
            shopDomain
          };
    const shop = await this.prisma.shop.upsert({
      create: createShop,
      update: input.apiVersion === null ? {} : { apiVersion: input.apiVersion },
      where: appScopedShopWhere({ appId, shopDomain })
    });
    const complianceAction = getComplianceAction(input.payload, input.topic);

    if (complianceAction.type === 'shop_redact') {
      await this.prisma.shop.delete({ where: { id: shop.id } });
      return { duplicate: false, status: 'PROCESSED', webhookId: input.webhookId };
    }

    if (complianceAction.type === 'customers_redact') {
      await this.prisma.order.deleteMany({
        where: {
          shopId: shop.id,
          shopifyOrderLegacyId: { in: complianceAction.orderLegacyIds }
        }
      });
    }

    try {
      await this.prisma.shopifyWebhookEvent.create({
        data: {
          apiVersion: input.apiVersion,
          eventId: input.eventId,
          payload: toPrismaJson(getStoredPayload(input.payload, complianceAction.type)),
          rawBodySha256: createHash('sha256').update(input.rawBody).digest('hex'),
          shopId: shop.id,
          status: getInitialStatus(complianceAction.type, input.topic),
          topic: input.topic,
          triggeredAt: input.triggeredAt,
          webhookId: input.webhookId
        }
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.prisma.shopifyWebhookEvent.findUnique({
          select: { status: true },
          where: { shopId_webhookId: { shopId: shop.id, webhookId: input.webhookId } }
        });
        return { duplicate: true, status: existing?.status ?? 'QUEUED', webhookId: input.webhookId };
      }

      throw error;
    }

    return { duplicate: false, status: getInitialStatus(complianceAction.type, input.topic), webhookId: input.webhookId };
  }
}

const ORDER_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/edited',
  'orders/cancelled',
  'orders/fulfilled',
  'orders/partially_fulfilled',
  'orders/delete'
];

type ComplianceAction =
  | { type: 'customers_data_request' }
  | { orderLegacyIds: bigint[]; type: 'customers_redact' }
  | { type: 'none' }
  | { type: 'shop_redact' };

function getComplianceAction(payload: unknown, topic: string): ComplianceAction {
  if (topic === 'customers/data_request') {
    return { type: 'customers_data_request' };
  }

  if (topic === 'customers/redact') {
    return {
      orderLegacyIds: readLegacyIds(objectOrNull(payload)?.orders_to_redact),
      type: 'customers_redact'
    };
  }

  if (topic === 'shop/redact') {
    return { type: 'shop_redact' };
  }

  return { type: 'none' };
}

function getStoredPayload(payload: unknown, type: ComplianceAction['type']): unknown {
  if (type === 'customers_data_request' || type === 'customers_redact') {
    return sanitizeCustomerCompliancePayload(payload);
  }

  if (type === 'shop_redact') {
    return sanitizeShopCompliancePayload(payload);
  }

  return payload;
}

function getInitialStatus(type: ComplianceAction['type'], topic: string): 'PROCESSED' | 'QUEUED' | 'RECEIVED' {
  if (type === 'customers_redact') return 'PROCESSED';
  return ORDER_TOPICS.includes(topic) ? 'QUEUED' : 'RECEIVED';
}

function sanitizeCustomerCompliancePayload(payload: unknown): Record<string, unknown> {
  const object = objectOrNull(payload);
  if (object === null) {
    return {};
  }

  const dataRequest = objectOrNull(object.data_request);

  return {
    customer: sanitizeCustomerPayload(object.customer),
    data_request: dataRequest === null ? undefined : { id: dataRequest.id },
    orders_requested: sanitizeLegacyIdList(object.orders_requested),
    orders_to_redact: sanitizeLegacyIdList(object.orders_to_redact),
    shop_domain: object.shop_domain,
    shop_id: object.shop_id
  };
}

function sanitizeShopCompliancePayload(payload: unknown): Record<string, unknown> {
  const object = objectOrNull(payload);
  if (object === null) {
    return {};
  }

  return {
    shop_domain: object.shop_domain,
    shop_id: object.shop_id
  };
}

function sanitizeCustomerPayload(value: unknown): Record<string, unknown> | undefined {
  const object = objectOrNull(value);
  if (object === null) {
    return undefined;
  }

  return { id: object.id };
}

function readLegacyIds(value: unknown): bigint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    try {
      if (typeof item === 'bigint') {
        return item >= 0n ? [item] : [];
      }

      if (typeof item === 'number') {
        return Number.isSafeInteger(item) && item >= 0 ? [BigInt(item)] : [];
      }

      if (typeof item === 'string' && /^\d+$/u.test(item)) {
        return [BigInt(item)];
      }
    } catch {
      return [];
    }

    return [];
  });
}

function sanitizeLegacyIdList(value: unknown): string[] | undefined {
  const ids = readLegacyIds(value);
  return ids.length === 0 ? undefined : ids.map((id) => id.toString());
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function nextRetryAt(attemptCount: number, now = new Date()): Date {
  const seconds = Math.min(15 * 60, 2 ** Math.max(0, attemptCount - 1) * 30);
  return new Date(now.getTime() + seconds * 1000);
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '').replace(/\/$/u, '');

  if (!withoutProtocol.endsWith('.myshopify.com')) {
    throw new Error('Shop domain must end with .myshopify.com');
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(withoutProtocol)) {
    throw new Error('Shop domain is not a valid myshopify.com domain');
  }

  return withoutProtocol;
}
