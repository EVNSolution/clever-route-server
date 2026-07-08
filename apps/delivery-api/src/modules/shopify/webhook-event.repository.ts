import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
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
  webhookId: string;
};

type ShopifyWebhookPrivacyPrismaClient = Pick<PrismaClient, 'order' | 'shop' | 'shopifyWebhookEvent'>;

export type ClaimOrderWebhookResult =
  | { action: 'process' }
  | { action: 'noop'; reason: 'already_done' | 'permanent_failure' }
  | { action: 'conflict'; retryAfterSeconds: number };

export class PrismaShopifyWebhookEventRepository {
  constructor(private readonly prisma: ShopifyWebhookPrivacyPrismaClient) {}

  async recordWebhook(
    input: RecordShopifyWebhookEventInput
  ): Promise<RecordShopifyWebhookEventResult> {
    return this.recordWebhookEvent(input);
  }

  async claimOrderWebhook(input: {
    appId?: string | undefined;
    now?: Date | undefined;
    processingStaleAfterMs?: number | undefined;
    shopDomain: string;
    webhookId: string;
  }): Promise<ClaimOrderWebhookResult> {
    const now = input.now ?? new Date();
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) })
    });
    if (shop === null) {
      throw new Error(`Shop not installed: ${input.shopDomain}`);
    }

    const event = await this.prisma.shopifyWebhookEvent.findUnique({
      select: { id: true, lastError: true, status: true, updatedAt: true },
      where: { shopId_webhookId: { shopId: shop.id, webhookId: input.webhookId } }
    });
    if (event === null) {
      throw new Error(`Shopify webhook event not recorded: ${input.webhookId}`);
    }

    if (event.status === 'PROCESSED' || event.status === 'IGNORED') {
      return { action: 'noop', reason: 'already_done' };
    }
    if (event.status === 'FAILED' && event.lastError?.startsWith('PERMANENT:')) {
      return { action: 'noop', reason: 'permanent_failure' };
    }
    if (event.status === 'PROCESSING') {
      const staleAfterMs = input.processingStaleAfterMs ?? 120_000;
      if (now.getTime() - event.updatedAt.getTime() < staleAfterMs) {
        return { action: 'conflict', retryAfterSeconds: Math.ceil(staleAfterMs / 1000) };
      }
    }

    const claimed = await this.prisma.shopifyWebhookEvent.updateMany({
      data: {
        attemptCount: { increment: 1 },
        lastError: null,
        status: 'PROCESSING'
      },
      where: {
        id: event.id,
        status: event.status
      }
    });
    if (claimed.count !== 1) {
      return { action: 'conflict', retryAfterSeconds: 120 };
    }

    return { action: 'process' };
  }

  async markOrderWebhookProcessed(input: {
    appId?: string | undefined;
    shopDomain: string;
    webhookId: string;
  }): Promise<void> {
    await this.updateOrderWebhookStatus({
      ...input,
      data: {
        lastError: null,
        processedAt: new Date(),
        status: 'PROCESSED'
      }
    });
  }

  async markOrderWebhookFailed(input: {
    appId?: string | undefined;
    error: string;
    shopDomain: string;
    webhookId: string;
  }): Promise<void> {
    await this.updateOrderWebhookStatus({
      ...input,
      data: {
        lastError: input.error,
        status: 'FAILED'
      }
    });
  }

  private async updateOrderWebhookStatus(input: {
    appId?: string | undefined;
    data: {
      lastError: string | null;
      processedAt?: Date;
      status: 'PROCESSED' | 'FAILED';
    };
    shopDomain: string;
    webhookId: string;
  }): Promise<void> {
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) })
    });
    if (shop === null) {
      throw new Error(`Shop not installed: ${input.shopDomain}`);
    }

    await this.prisma.shopifyWebhookEvent.update({
      data: input.data,
      where: { shopId_webhookId: { shopId: shop.id, webhookId: input.webhookId } }
    });
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
      return { duplicate: false, webhookId: input.webhookId };
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
          status: getInitialStatus(complianceAction.type),
          topic: input.topic,
          triggeredAt: input.triggeredAt,
          webhookId: input.webhookId
        }
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { duplicate: true, webhookId: input.webhookId };
      }

      throw error;
    }

    return { duplicate: false, webhookId: input.webhookId };
  }
}

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

function getInitialStatus(type: ComplianceAction['type']): 'PROCESSED' | 'RECEIVED' {
  return type === 'customers_redact' ? 'PROCESSED' : 'RECEIVED';
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
