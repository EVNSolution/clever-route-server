import type { ShopifyAdminGraphqlClient } from './admin-graphql.client.js';
import type { ShopifyOrderNode } from './order-sync.mapper.js';
import { mapShopifyOrderNodeToDeliveryInputs } from './order-sync.mapper.js';
import { buildOrderByIdQuery } from './order-sync.query.js';
import type {
  UpsertOrderWithDeliveryStopInput,
  UpsertOrderWithDeliveryStopResult
} from './order-sync.repository.js';
import type { ClaimOrderWebhookResult } from './webhook-event.repository.js';

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
  claimOrderWebhook(input: {
    appId?: string | undefined;
    now?: Date | undefined;
    processingStaleAfterMs?: number | undefined;
    shopDomain: string;
    webhookId: string;
  }): Promise<ClaimOrderWebhookResult>;
  markOrderWebhookFailed(input: {
    appId?: string | undefined;
    error: string;
    shopDomain: string;
    webhookId: string;
  }): Promise<void>;
  markOrderWebhookProcessed(input: {
    appId?: string | undefined;
    shopDomain: string;
    webhookId: string;
  }): Promise<void>;
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
  statusCode: 200 | 409 | 500;
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

    const claim = await this.options.eventStore.claimOrderWebhook({
      appId: input.appId,
      processingStaleAfterMs: PROCESSING_STALE_AFTER_MS,
      shopDomain: input.shopDomain,
      webhookId: input.webhookId
    });

    if (claim.action === 'noop') {
      return { duplicate: true, statusCode: 200, webhookId: input.webhookId };
    }
    if (claim.action === 'conflict') {
      return { duplicate: true, statusCode: 409, webhookId: input.webhookId };
    }

    if (input.topic === 'orders/delete') {
      await this.options.eventStore.markOrderWebhookProcessed(input);
      return { duplicate: false, statusCode: 200, webhookId: input.webhookId };
    }

    const orderId = extractShopifyOrderGid(input.payload);
    if (orderId === null) {
      await this.options.eventStore.markOrderWebhookFailed({
        ...input,
        error: 'TRANSIENT:ORDER_NODE_NOT_FOUND'
      });
      return { duplicate: false, statusCode: 500, webhookId: input.webhookId };
    }

    const accessToken = await this.options.shopTokenService.getAdminAccessToken({
      appId: input.appId,
      shopDomain: input.shopDomain
    });
    if (accessToken === null) {
      await this.options.eventStore.markOrderWebhookFailed({
        ...input,
        error: 'PERMANENT:MISSING_OFFLINE_TOKEN'
      });
      return { duplicate: false, statusCode: 200, webhookId: input.webhookId };
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
      return { duplicate: false, statusCode: 200, webhookId: input.webhookId };
    } catch (error) {
      await this.options.eventStore.markOrderWebhookFailed({
        ...input,
        error: `TRANSIENT:${error instanceof Error ? error.message : 'ORDER_WEBHOOK_PROCESSING_FAILED'}`
      });
      return { duplicate: false, statusCode: 500, webhookId: input.webhookId };
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
