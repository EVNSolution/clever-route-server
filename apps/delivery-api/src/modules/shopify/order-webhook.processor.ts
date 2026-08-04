import type { ShopifyAdminGraphqlClient } from './admin-graphql.client.js';
import type { ShopifyOrderNode } from './order-sync.mapper.js';
import { mapShopifyOrderNodeToDeliveryInputs } from './order-sync.mapper.js';
import { buildOrderByIdQuery } from './order-sync.query.js';
import type {
  UpsertOrderWithDeliveryStopInput,
  UpsertOrderWithDeliveryStopResult
} from './order-sync.repository.js';
import { redactTelemetryMessage } from '../security/safe-telemetry-redaction.js';
import type { ClaimedShopifyWebhookEvent, ClaimOrderWebhookResult } from './webhook-event.repository.js';

const ORDER_TOPICS = new Set([
  'orders/create',
  'orders/updated',
  'orders/edited',
  'orders/cancelled',
  'orders/fulfilled',
  'orders/partially_fulfilled',
  'orders/delete'
]);

const PROCESSING_STALE_AFTER_MS = 2 * 60 * 1000;
const PROCESSING_DEADLINE_MS = 3_000;

type OrderWebhookEventStore = {
  claimNextOrderWebhook(input: {
    leaseMs: number;
    now?: Date | undefined;
    workerId: string;
  }): Promise<ClaimOrderWebhookResult>;
  getOrderWebhookDeliveryDisposition(input: {
    appId?: string | undefined;
    shopDomain: string;
    webhookId: string;
  }): Promise<ClaimOrderWebhookResult>;
  markOrderWebhookFailed(input: {
    appId?: string | undefined;
    attemptCount: number;
    error: string;
    id: string;
    leaseToken: string;
    maxAttempts: number;
    nextRunAt?: Date | undefined;
    webhookId: string;
  }): Promise<boolean>;
  markOrderWebhookProcessed(input: {
    appId?: string | undefined;
    id: string;
    leaseToken: string;
    webhookId: string;
  }): Promise<boolean>;
};

type ShopTokenReader = {
  getAdminAccessToken(input: { appId?: string | undefined; shopDomain: string }): Promise<string | null>;
};

type OrderRepository = {
  upsertOrderWithDeliveryStop(
    input: UpsertOrderWithDeliveryStopInput
  ): Promise<UpsertOrderWithDeliveryStopResult>;
};

type GraphqlClientFactory = (input: {
  accessToken: string;
  apiVersion: string;
  shopDomain: string;
}) => Pick<ShopifyAdminGraphqlClient, 'request'>;

type OrderByIdResponse = {
  node: ShopifyOrderNode | null;
};

export type ShopifyOrderWebhookProcessorResult = {
  duplicate: boolean;
  statusCode: 200 | 202;
  webhookId: string;
};

export class ShopifyOrderWebhookProcessor {
  constructor(
    private readonly options: {
      defaultApiVersion: string;
      eventStore: OrderWebhookEventStore;
      graphqlClientFactory: GraphqlClientFactory;
      orderRepository: OrderRepository;
      shopTokenService: ShopTokenReader;
    }
  ) {}

  canProcessTopic(topic: string): boolean {
    return ORDER_TOPICS.has(topic);
  }

  async process(input: {
    apiVersion: string | null;
    appId?: string | undefined;
    payload: unknown;
    shopDomain: string;
    topic: string;
    webhookId: string;
  }): Promise<ShopifyOrderWebhookProcessorResult> {
    if (!this.canProcessTopic(input.topic)) {
      return { duplicate: false, statusCode: 200, webhookId: input.webhookId };
    }

    const disposition = await this.options.eventStore.getOrderWebhookDeliveryDisposition({
      appId: input.appId,
      shopDomain: input.shopDomain,
      webhookId: input.webhookId
    });

    if (disposition.action === 'noop' || disposition.action === 'queued') {
      return { duplicate: true, statusCode: 200, webhookId: input.webhookId };
    }

    return { duplicate: false, statusCode: 202, webhookId: input.webhookId };
  }

  async processNextDue(input: {
    leaseMs?: number | undefined;
    now?: Date | undefined;
    workerId: string;
  }): Promise<{ processed: boolean; webhookId: string | null }> {
    const claim = await this.options.eventStore.claimNextOrderWebhook({
      leaseMs: input.leaseMs ?? PROCESSING_STALE_AFTER_MS,
      now: input.now,
      workerId: input.workerId
    });
    if (claim.action !== 'process') return { processed: false, webhookId: null };
    await this.processClaimedEvent(claim.event);
    return { processed: true, webhookId: claim.event.webhookId };
  }

  async processClaimedEvent(input: ClaimedShopifyWebhookEvent): Promise<void> {
    if (input.topic === 'orders/delete') {
      await this.options.eventStore.markOrderWebhookProcessed(input);
      return;
    }

    const orderId = extractShopifyOrderGid(input.payload);
    if (orderId === null) {
      await this.options.eventStore.markOrderWebhookFailed({
        ...input,
        error: 'TRANSIENT:ORDER_NODE_NOT_FOUND',
        nextRunAt: nextRetryAt(input.attemptCount)
      });
      return;
    }

    let accessToken: string | null;
    try {
      accessToken = await this.options.shopTokenService.getAdminAccessToken({
        appId: input.appId,
        shopDomain: input.shopDomain
      });
    } catch (error) {
      await this.options.eventStore.markOrderWebhookFailed({
        ...input,
        error: `TRANSIENT:${redactTelemetryMessage(error instanceof Error ? error : 'SHOPIFY_TOKEN_REFRESH_FAILED')}`,
        nextRunAt: nextRetryAt(input.attemptCount)
      });
      return;
    }
    if (accessToken === null) {
      await this.options.eventStore.markOrderWebhookFailed({
        ...input,
        error: 'PERMANENT:MISSING_OFFLINE_TOKEN'
      });
      return;
    }

    try {
      await withDeadline(
        this.refetchAndUpsert({
          accessToken,
          apiVersion: input.apiVersion ?? this.options.defaultApiVersion,
          appId: input.appId,
          orderId,
          shopDomain: input.shopDomain
        }),
        PROCESSING_DEADLINE_MS
      );
      await this.options.eventStore.markOrderWebhookProcessed(input);
    } catch (error) {
      await this.options.eventStore.markOrderWebhookFailed({
        ...input,
        error: `TRANSIENT:${redactTelemetryMessage(error instanceof Error ? error : 'ORDER_WEBHOOK_PROCESSING_FAILED')}`,
        nextRunAt: nextRetryAt(input.attemptCount)
      });
    }
  }

  private async refetchAndUpsert(input: {
    accessToken: string;
    apiVersion: string;
    appId?: string | undefined;
    orderId: string;
    shopDomain: string;
  }): Promise<void> {
    const client = this.options.graphqlClientFactory(input);
    const data = await client.request<OrderByIdResponse>(buildOrderByIdQuery({ id: input.orderId }));
    if (data.node === null) {
      throw new Error('ORDER_NODE_NOT_FOUND');
    }

    await this.options.orderRepository.upsertOrderWithDeliveryStop({
      appId: input.appId,
      shopDomain: input.shopDomain,
      synced: mapShopifyOrderNodeToDeliveryInputs(data.node)
    });
  }
}

export function extractShopifyOrderGid(payload: unknown): string | null {
  const object = objectOrNull(payload);
  const adminGid = stringOrNull(object?.admin_graphql_api_id);
  if (adminGid !== null) return adminGid;

  const legacyId = object?.id;
  if (typeof legacyId === 'number' && Number.isInteger(legacyId) && legacyId > 0) {
    return `gid://shopify/Order/${legacyId}`;
  }
  if (typeof legacyId === 'string' && /^\d+$/u.test(legacyId)) {
    return `gid://shopify/Order/${legacyId}`;
  }

  return null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('ORDER_WEBHOOK_PROCESSING_TIMEOUT')), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function nextRetryAt(attemptCount: number, now = new Date()): Date {
  const seconds = Math.min(15 * 60, 2 ** Math.max(0, attemptCount - 1) * 30);
  return new Date(now.getTime() + seconds * 1000);
}
