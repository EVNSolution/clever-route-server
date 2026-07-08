import { describe, expect, test, vi } from 'vitest';

import type { ShopifyAdminGraphqlRequest } from '../src/modules/shopify/admin-graphql.client.js';
import type { ShopifyOrderNode } from '../src/modules/shopify/order-sync.mapper.js';
import type {
  UpsertOrderWithDeliveryStopInput,
  UpsertOrderWithDeliveryStopResult
} from '../src/modules/shopify/order-sync.repository.js';
import {
  extractShopifyOrderGid,
  ShopifyOrderWebhookProcessor
} from '../src/modules/shopify/order-webhook.processor.js';

describe('ShopifyOrderWebhookProcessor', () => {
  test('refetches fulfilled order webhooks through mapper/upsert without marking stop delivered', async () => {
    const harness = createHarness({ graphqlNode: orderNode({ displayFulfillmentStatus: 'FULFILLED' }) });

    await expect(harness.processor.process(orderWebhook())).resolves.toEqual({
      duplicate: false,
      statusCode: 200,
      webhookId: 'webhook-1'
    });

    expect(harness.claimOrderWebhook).toHaveBeenCalledWith(expect.objectContaining({ webhookId: 'webhook-1' }));
    expect(harness.graphqlRequests[0]).toEqual(
      expect.objectContaining({ variables: { id: 'gid://shopify/Order/123' } })
    );
    const upsertInput = harness.upsertOrderWithDeliveryStop.mock.calls[0]?.[0];
    expect(upsertInput?.synced.order.fulfillmentStatus).toBe('FULFILLED');
    expect(upsertInput?.synced.deliveryStop).not.toEqual(expect.objectContaining({ status: 'DELIVERED' }));
    expect(harness.markOrderWebhookProcessed).toHaveBeenCalledWith(expect.objectContaining({ webhookId: 'webhook-1' }));
  });

  test('keeps orders/delete receipt-only and non-destructive', async () => {
    const harness = createHarness();

    await expect(harness.processor.process(orderWebhook({ topic: 'orders/delete' }))).resolves.toEqual({
      duplicate: false,
      statusCode: 200,
      webhookId: 'webhook-1'
    });

    expect(harness.getAdminAccessToken).not.toHaveBeenCalled();
    expect(harness.upsertOrderWithDeliveryStop).not.toHaveBeenCalled();
    expect(harness.markOrderWebhookProcessed).toHaveBeenCalledWith(expect.objectContaining({ topic: 'orders/delete' }));
  });

  test('maps duplicate and in-flight lifecycle states to no-op or retry responses', async () => {
    const processed = createHarness({ claim: { action: 'noop', reason: 'already_done' } });
    await expect(processed.processor.process(orderWebhook())).resolves.toMatchObject({ duplicate: true, statusCode: 200 });
    expect(processed.upsertOrderWithDeliveryStop).not.toHaveBeenCalled();

    const permanent = createHarness({ claim: { action: 'noop', reason: 'permanent_failure' } });
    await expect(permanent.processor.process(orderWebhook())).resolves.toMatchObject({ duplicate: true, statusCode: 200 });
    expect(permanent.upsertOrderWithDeliveryStop).not.toHaveBeenCalled();

    const recentProcessing = createHarness({ claim: { action: 'conflict', retryAfterSeconds: 120 } });
    await expect(recentProcessing.processor.process(orderWebhook())).resolves.toMatchObject({
      duplicate: true,
      statusCode: 409
    });
    expect(recentProcessing.upsertOrderWithDeliveryStop).not.toHaveBeenCalled();
  });

  test('marks transient missing-node failure for non-delete missing order id and permanent failure for offline token', async () => {
    const missingId = createHarness();
    await expect(missingId.processor.process(orderWebhook({ payload: { name: '#1001' } }))).resolves.toMatchObject({
      statusCode: 500
    });
    expect(missingId.markOrderWebhookFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'TRANSIENT:ORDER_NODE_NOT_FOUND' })
    );
    expect(missingId.getAdminAccessToken).not.toHaveBeenCalled();

    const missingToken = createHarness({ accessToken: null });
    await expect(missingToken.processor.process(orderWebhook())).resolves.toMatchObject({ statusCode: 200 });
    expect(missingToken.markOrderWebhookFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'PERMANENT:MISSING_OFFLINE_TOKEN' })
    );
  });

  test('marks timeout failure as transient and returns a retryable response', async () => {
    vi.useFakeTimers();
    try {
      const timeout = createHarness({ graphqlResponse: new Promise(() => {}) });
      const result = timeout.processor.process(orderWebhook());

      await vi.advanceTimersByTimeAsync(3_000);

      await expect(result).resolves.toMatchObject({ statusCode: 500 });
      expect(timeout.markOrderWebhookFailed).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'TRANSIENT:ORDER_WEBHOOK_PROCESSING_TIMEOUT' })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('marks transient failures for missing refetch node and upsert errors', async () => {
    const missingNode = createHarness({ graphqlNode: null });
    await expect(missingNode.processor.process(orderWebhook())).resolves.toMatchObject({ statusCode: 500 });
    expect(missingNode.markOrderWebhookFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'TRANSIENT:ORDER_NODE_NOT_FOUND' })
    );

    const upsertFailure = createHarness({ upsertError: new Error('database unavailable') });
    await expect(upsertFailure.processor.process(orderWebhook())).resolves.toMatchObject({ statusCode: 500 });
    expect(upsertFailure.markOrderWebhookFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'TRANSIENT:database unavailable' })
    );
  });
});

describe('extractShopifyOrderGid', () => {
  test('prefers admin GraphQL id and falls back to numeric legacy id', () => {
    expect(extractShopifyOrderGid({ admin_graphql_api_id: 'gid://shopify/Order/999', id: 123 })).toBe(
      'gid://shopify/Order/999'
    );
    expect(extractShopifyOrderGid({ id: 123 })).toBe('gid://shopify/Order/123');
    expect(extractShopifyOrderGid({ id: '456' })).toBe('gid://shopify/Order/456');
    expect(extractShopifyOrderGid({ id: 'not-an-id' })).toBeNull();
  });
});

type Claim = { action: 'process' } | { action: 'noop'; reason: 'already_done' | 'permanent_failure' } | { action: 'conflict'; retryAfterSeconds: number };

function createHarness(input: {
  accessToken?: string | null;
  claim?: Claim;
  graphqlNode?: ShopifyOrderNode | null;
  graphqlResponse?: Promise<{ node: ShopifyOrderNode | null }>;
  upsertError?: Error;
} = {}) {
  const graphqlRequests: ShopifyAdminGraphqlRequest[] = [];
  const defaultClaim: Claim = { action: 'process' };
  const claimOrderWebhook = vi.fn(() => Promise.resolve(input.claim ?? defaultClaim));
  const markOrderWebhookFailed = vi.fn(() => Promise.resolve());
  const markOrderWebhookProcessed = vi.fn(() => Promise.resolve());
  const getAdminAccessToken = vi.fn(() => Promise.resolve(input.accessToken === undefined ? 'token-1' : input.accessToken));
  const upsertOrderWithDeliveryStop = vi.fn((upsertInput: UpsertOrderWithDeliveryStopInput) => {
    if (input.upsertError !== undefined) return Promise.reject(input.upsertError);
    void upsertInput;
    return Promise.resolve({ orderId: 'order-1', status: 'updated', stopId: 'stop-1' } satisfies UpsertOrderWithDeliveryStopResult);
  });
  const processor = new ShopifyOrderWebhookProcessor({
    defaultApiVersion: '2026-04',
    eventStore: { claimOrderWebhook, markOrderWebhookFailed, markOrderWebhookProcessed },
    graphqlClientFactory: () => ({
      request: <TData>(request: ShopifyAdminGraphqlRequest): Promise<TData> => {
        graphqlRequests.push(request);
        if (input.graphqlResponse !== undefined) return input.graphqlResponse as Promise<TData>;
        return Promise.resolve({ node: input.graphqlNode === undefined ? orderNode() : input.graphqlNode } as TData);
      }
    }),
    orderRepository: { upsertOrderWithDeliveryStop },
    shopTokenService: { getAdminAccessToken }
  });

  return {
    claimOrderWebhook,
    getAdminAccessToken,
    graphqlRequests,
    markOrderWebhookFailed,
    markOrderWebhookProcessed,
    processor,
    upsertOrderWithDeliveryStop
  };
}

function orderWebhook(overrides: Partial<Parameters<ShopifyOrderWebhookProcessor['process']>[0]> = {}) {
  return {
    apiVersion: '2026-04',
    appId: 'clever',
    payload: { id: 123 },
    shopDomain: 'clever-route-test.myshopify.com',
    topic: 'orders/updated',
    webhookId: 'webhook-1',
    ...overrides
  };
}

function orderNode(overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
  return {
    cancelledAt: null,
    currentTotalPriceSet: { shopMoney: { amount: '95.00', currencyCode: 'CAD' } },
    customAttributes: [
      { key: 'Delivery Area', value: 'Mississauga' },
      { key: 'Delivery Day', value: 'Thursday' }
    ],
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: 'customer@clever.invalid',
    id: 'gid://shopify/Order/123',
    legacyResourceId: '123',
    lineItems: { nodes: [{ title: 'Kimchi', quantity: 1, sku: 'KIMCHI' }] },
    name: '#1001',
    note: null,
    paymentGatewayNames: ['manual'],
    phone: '+14165550000',
    processedAt: '2026-05-07T12:00:00Z',
    shippingAddress: {
      address1: '300 City Centre Dr',
      address2: '#08',
      city: 'Mississauga',
      countryCodeV2: 'CA',
      latitude: 43.589,
      longitude: -79.644,
      name: 'Noah Yoon',
      phone: '+14165550000',
      province: 'ON',
      provinceCode: 'ON',
      zip: 'L5B 3C1'
    },
    updatedAt: '2026-05-07T13:00:00Z',
    ...overrides
  };
}
