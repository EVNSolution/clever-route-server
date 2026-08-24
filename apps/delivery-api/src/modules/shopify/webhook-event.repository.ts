import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { redactTelemetryMessage, safeErrorCode } from '../security/safe-telemetry-redaction.js';
import { appScopedShopWhere, normalizeShopifyAppId } from './shopify-app-scope.js';
import {
  lockShopifyOrderPrivacyIdentity,
  lockShopifyShopPrivacyIdentity
} from './order-privacy-redaction.js';

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

type ShopifyWebhookPrivacyPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'order' | 'shop' | 'shopifyOrderRedactionTombstone' | 'shopifyRedactedWebhookReceipt' | 'shopifyShopRedactionTombstone' | 'shopifyWebhookEvent'
>;
type ShopifyWebhookPrivacyWriteClient = Pick<
  PrismaClient,
  '$queryRaw' | 'order' | 'shop' | 'shopifyOrderRedactionTombstone' | 'shopifyRedactedWebhookReceipt' | 'shopifyShopRedactionTombstone' | 'shopifyWebhookEvent'
>;

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

export type DeleteExpiredTerminalWebhookEventsResult = {
  deleted: number;
  scanned: number;
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
          { status: 'PROCESSING', leaseExpiresAt: { lt: now } },
          { status: 'PROCESSING', leaseExpiresAt: null }
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
          { status: 'PROCESSING', leaseExpiresAt: { lt: now } },
          { status: 'PROCESSING', leaseExpiresAt: null }
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
    const processedAt = new Date();
    return await this.updateOrderWebhookStatus({
      ...input,
      data: {
        deadLetteredAt: null,
        lastError: null,
        lastErrorCode: null,
        lastErrorMessageRedacted: null,
        leaseExpiresAt: null,
        leaseToken: null,
        payload: webhookPayloadTombstone('PROCESSED'),
        payloadRedactedAt: processedAt,
        processedAt,
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
      payload?: Prisma.InputJsonValue;
      payloadRedactedAt?: Date;
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

  async deleteExpiredTerminalWebhookEvents(input: {
    completedBefore: Date;
    limit?: number | undefined;
  }): Promise<DeleteExpiredTerminalWebhookEventsResult> {
    const expired = await this.prisma.shopifyWebhookEvent.findMany({
      orderBy: { updatedAt: 'asc' },
      select: { id: true },
      take: input.limit ?? 100,
      where: {
        OR: [
          { processedAt: { lt: input.completedBefore }, status: 'PROCESSED' },
          { status: 'IGNORED', updatedAt: { lt: input.completedBefore } }
        ]
      }
    });
    if (expired.length === 0) return { deleted: 0, scanned: 0 };
    const deleted = await this.prisma.shopifyWebhookEvent.deleteMany({
      where: { id: { in: expired.map(({ id }) => id) } }
    });
    return { deleted: deleted.count, scanned: expired.length };
  }

  async recordWebhookEvent(
    input: RecordShopifyWebhookEventInput
  ): Promise<RecordShopifyWebhookEventResult> {
    const appId = normalizeShopifyAppId(input.appId);
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const complianceAction = getComplianceAction(input.payload, input.topic);
    if (complianceAction.type === 'shop_redact') {
      return this.recordShopRedaction({ appId, input, shopDomain });
    }
    if (complianceAction.type === 'customers_redact') {
      return this.recordCustomerRedaction({ appId, complianceAction, input, shopDomain });
    }

    const createShop =
      input.apiVersion === null
        ? { appId, shopDomain }
        : {
            apiVersion: input.apiVersion,
            appId,
            shopDomain
          };
    try {
      const admitted = await this.prisma.$transaction(async (tx) => {
        const write = tx as ShopifyWebhookPrivacyWriteClient;
        await lockShopifyShopPrivacyIdentity(write, { appId, shopDomain });
        const priorReceipt = await write.shopifyRedactedWebhookReceipt.findUnique({
          where: { appId_shopDomain_webhookId: { appId, shopDomain, webhookId: input.webhookId } }
        });
        if (priorReceipt !== null) return { shopId: null, suppressed: true };
        const suppressed = await write.shopifyShopRedactionTombstone.findUnique({
          select: { id: true, reinstalledAt: true },
          where: { appId_shopDomain: { appId, shopDomain } }
        });
        if (shouldSuppressAfterShopRedaction(suppressed, input.triggeredAt)) {
          await write.shopifyRedactedWebhookReceipt.create({
            data: { appId, redactedAt: new Date(), shopDomain, topic: input.topic, webhookId: input.webhookId }
          });
          return { shopId: null, suppressed: true };
        }
        const shop = await write.shop.upsert({
          create: createShop,
          update: input.apiVersion === null ? {} : { apiVersion: input.apiVersion },
          where: appScopedShopWhere({ appId, shopDomain })
        });
        const storedPayload = getStoredPayload(input.payload, complianceAction.type, input.topic);
        await write.shopifyWebhookEvent.create({
          data: {
            apiVersion: input.apiVersion,
            eventId: input.eventId,
            payload: toPrismaJson(storedPayload),
            ...(isStoredPayloadRedacted(complianceAction.type, input.topic) ? { payloadRedactedAt: new Date() } : {}),
            rawBodySha256: createHash('sha256').update(input.rawBody).digest('hex'),
            shopId: shop.id,
            status: getInitialStatus(complianceAction.type, input.topic),
            topic: input.topic,
            triggeredAt: input.triggeredAt,
            webhookId: input.webhookId
          }
        });
        return { shopId: shop.id, suppressed: false };
      });
      if (admitted.suppressed) {
        return { duplicate: true, status: 'IGNORED', webhookId: input.webhookId };
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const shop = await this.prisma.shop.findUnique({
          select: { id: true },
          where: appScopedShopWhere({ appId, shopDomain })
        });
        const existing = shop === null ? null : await this.prisma.shopifyWebhookEvent.findUnique({
          select: { status: true },
          where: { shopId_webhookId: { shopId: shop.id, webhookId: input.webhookId } }
        });
        if (existing !== null) {
          return { duplicate: true, status: existing.status, webhookId: input.webhookId };
        }
      }

      throw error;
    }

    return { duplicate: false, status: getInitialStatus(complianceAction.type, input.topic), webhookId: input.webhookId };
  }

  private async recordCustomerRedaction(input: {
    appId: string;
    complianceAction: Extract<ComplianceAction, { type: 'customers_redact' }>;
    input: RecordShopifyWebhookEventInput;
    shopDomain: string;
  }): Promise<RecordShopifyWebhookEventResult> {
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const write = tx as ShopifyWebhookPrivacyWriteClient;
        await lockShopifyShopPrivacyIdentity(write, { appId: input.appId, shopDomain: input.shopDomain });
        const priorReceipt = await write.shopifyRedactedWebhookReceipt.findUnique({
          where: { appId_shopDomain_webhookId: { appId: input.appId, shopDomain: input.shopDomain, webhookId: input.input.webhookId } }
        });
        if (priorReceipt !== null) return { shopId: null, suppressed: true };
        const suppressed = await write.shopifyShopRedactionTombstone.findUnique({
          select: { id: true, reinstalledAt: true },
          where: { appId_shopDomain: { appId: input.appId, shopDomain: input.shopDomain } }
        });
        if (shouldSuppressAfterShopRedaction(suppressed, input.input.triggeredAt)) {
          await write.shopifyRedactedWebhookReceipt.create({
            data: {
              appId: input.appId,
              redactedAt: new Date(),
              shopDomain: input.shopDomain,
              topic: input.input.topic,
              webhookId: input.input.webhookId
            }
          });
          return { shopId: null, suppressed: true };
        }
        const shop = await write.shop.upsert({
          create: { appId: input.appId, shopDomain: input.shopDomain },
          update: input.input.apiVersion === null ? {} : { apiVersion: input.input.apiVersion },
          where: appScopedShopWhere({ appId: input.appId, shopDomain: input.shopDomain })
        });
        const redactedAt = new Date();
        const legacyIds = [...new Set(input.complianceAction.orderLegacyIds)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
        for (const orderLegacyId of legacyIds) {
          await lockShopifyOrderPrivacyIdentity(write, {
            appId: input.appId,
            orderLegacyId,
            shopId: shop.id
          });
          await write.shopifyOrderRedactionTombstone.upsert({
            create: {
              appId: input.appId,
              complianceWebhookId: input.input.webhookId,
              redactedAt,
              shopId: shop.id,
              shopifyOrderLegacyId: orderLegacyId
            },
            update: {},
            where: {
              appId_shopId_shopifyOrderLegacyId: {
                appId: input.appId,
                shopId: shop.id,
                shopifyOrderLegacyId: orderLegacyId
              }
            }
          });
        }
        await write.order.deleteMany({
          where: {
            shopId: shop.id,
            shopifyOrderLegacyId: { in: legacyIds }
          }
        });
        for (const orderLegacyId of legacyIds) {
          await write.shopifyWebhookEvent.updateMany({
            data: {
              payload: toPrismaJson(orderReferencePayload(orderLegacyId)),
              payloadRedactedAt: redactedAt
            },
            where: {
              OR: orderPayloadIdentityFilters(orderLegacyId),
              shopId: shop.id,
              topic: { in: ORDER_TOPICS }
            }
          });
        }
        await write.shopifyWebhookEvent.create({
          data: {
            apiVersion: input.input.apiVersion,
            eventId: input.input.eventId,
            payload: webhookPayloadTombstone('PROCESSED'),
            payloadRedactedAt: redactedAt,
            rawBodySha256: createHash('sha256').update(input.input.rawBody).digest('hex'),
            shopId: shop.id,
            status: 'PROCESSED',
            topic: input.input.topic,
            triggeredAt: input.input.triggeredAt,
            webhookId: input.input.webhookId
          }
        });
        return { shopId: shop.id, suppressed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (result.suppressed) return { duplicate: true, status: 'IGNORED', webhookId: input.input.webhookId };
      return { duplicate: false, status: 'PROCESSED', webhookId: input.input.webhookId };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.prisma.shopifyWebhookEvent.findUnique({
          select: { status: true },
          where: { shopId_webhookId: { shopId: (await this.prisma.shop.findUniqueOrThrow({
            select: { id: true },
            where: appScopedShopWhere({ appId: input.appId, shopDomain: input.shopDomain })
          })).id, webhookId: input.input.webhookId } }
        });
        if (existing !== null) {
          return { duplicate: true, status: existing.status, webhookId: input.input.webhookId };
        }
      }
      throw error;
    }
  }

  private async recordShopRedaction(input: {
    appId: string;
    input: RecordShopifyWebhookEventInput;
    shopDomain: string;
  }): Promise<RecordShopifyWebhookEventResult> {
    let duplicate: boolean | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        duplicate = await this.recordShopRedactionTransaction(input);
        break;
      } catch (error) {
        if (!isTransactionWriteConflict(error) || attempt === 2) throw error;
      }
    }
    if (duplicate === undefined) throw new Error('Shop redaction transaction did not complete');
    return {
      duplicate,
      status: duplicate ? 'IGNORED' : 'PROCESSED',
      webhookId: input.input.webhookId
    };
  }

  private recordShopRedactionTransaction(input: {
    appId: string;
    input: RecordShopifyWebhookEventInput;
    shopDomain: string;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const write = tx as ShopifyWebhookPrivacyWriteClient;
      await lockShopifyShopPrivacyIdentity(write, { appId: input.appId, shopDomain: input.shopDomain });
      const receipt = await write.shopifyRedactedWebhookReceipt.findUnique({
        where: {
          appId_shopDomain_webhookId: {
            appId: input.appId,
            shopDomain: input.shopDomain,
            webhookId: input.input.webhookId
          }
        }
      });
      if (receipt !== null) return true;
      const tombstone = await write.shopifyShopRedactionTombstone.findUnique({
        select: { reinstalledAt: true },
        where: { appId_shopDomain: { appId: input.appId, shopDomain: input.shopDomain } }
      });
      const redactedAt = new Date();
      await write.shopifyRedactedWebhookReceipt.create({
        data: {
          appId: input.appId,
          redactedAt,
          shopDomain: input.shopDomain,
          topic: input.input.topic,
          webhookId: input.input.webhookId
        }
      });
      if (tombstone?.reinstalledAt != null && shouldSuppressAfterShopRedaction(tombstone, input.input.triggeredAt)) {
        return true;
      }
      await write.shopifyShopRedactionTombstone.upsert({
        create: {
          appId: input.appId,
          complianceWebhookId: input.input.webhookId,
          redactedAt,
          shopDomain: input.shopDomain
        },
        update: { complianceWebhookId: input.input.webhookId, redactedAt, reinstalledAt: null },
        where: { appId_shopDomain: { appId: input.appId, shopDomain: input.shopDomain } }
      });
      await write.shop.deleteMany({ where: { appId: input.appId, shopDomain: input.shopDomain } });
      return false;
    // The advisory identity lock is the serialization fence. READ COMMITTED is
    // required so a redaction waiting behind a writer refreshes its snapshot
    // and can delete the Shop row that writer committed before releasing it.
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
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

function shouldSuppressAfterShopRedaction(
  tombstone: { reinstalledAt?: Date | null } | null,
  triggeredAt: Date | null
): boolean {
  if (tombstone === null) return false;
  if (tombstone.reinstalledAt == null) return true;
  // Shopify's triggered-at timestamp is the trusted lifecycle boundary. Missing
  // or pre-install timestamps fail closed so delayed prior-install events cannot
  // recreate erased tenant data after an OAuth reinstall.
  return triggeredAt === null || triggeredAt.getTime() <= tombstone.reinstalledAt.getTime();
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

function getStoredPayload(payload: unknown, type: ComplianceAction['type'], topic: string): unknown {
  if (type === 'customers_data_request') {
    return sanitizeCustomerCompliancePayload(payload);
  }

  if (type === 'customers_redact') return webhookPayloadTombstone('PROCESSED');

  if (type === 'shop_redact') {
    return sanitizeShopCompliancePayload(payload);
  }

  if (ORDER_TOPICS.includes(topic)) return orderReferencePayloadFromWebhook(payload);

  return payload;
}

function isStoredPayloadRedacted(type: ComplianceAction['type'], topic: string): boolean {
  return type === 'customers_redact' || ORDER_TOPICS.includes(topic);
}

function webhookPayloadTombstone(terminalStatus: 'IGNORED' | 'PROCESSED'): Prisma.InputJsonObject {
  return {
    redacted: true,
    schema: 'shopify_webhook_tombstone_v1',
    terminalStatus
  };
}

function orderReferencePayload(orderLegacyId: bigint): Prisma.InputJsonObject {
  const orderId = `gid://shopify/Order/${orderLegacyId.toString()}`;
  return {
    admin_graphql_api_id: orderId,
    orderId,
    redacted: true,
    schema: 'shopify_order_reference_v1'
  };
}

function orderReferencePayloadFromWebhook(payload: unknown): Prisma.InputJsonObject {
  const object = objectOrNull(payload);
  const directGid = [object?.admin_graphql_api_id, object?.orderId]
    .find((value): value is string => typeof value === 'string' && /^gid:\/\/shopify\/Order\/[0-9]+$/u.test(value));
  const legacyId = readLegacyIds([object?.id])[0];
  const orderId = directGid ?? (legacyId === undefined ? undefined : `gid://shopify/Order/${legacyId.toString()}`);
  return {
    ...(orderId === undefined ? {} : { admin_graphql_api_id: orderId, orderId }),
    redacted: true,
    schema: 'shopify_order_reference_v1'
  };
}

function orderPayloadIdentityFilters(orderLegacyId: bigint): Prisma.ShopifyWebhookEventWhereInput[] {
  const id = orderLegacyId.toString();
  const filters: Prisma.ShopifyWebhookEventWhereInput[] = [
    { payload: { equals: id, path: ['id'] } },
    { payload: { equals: `gid://shopify/Order/${id}`, path: ['admin_graphql_api_id'] } },
    { payload: { equals: `gid://shopify/Order/${id}`, path: ['orderId'] } }
  ];
  const numericId = Number(id);
  if (Number.isSafeInteger(numericId)) filters.push({ payload: { equals: numericId, path: ['id'] } });
  return filters;
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

function isTransactionWriteConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
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
