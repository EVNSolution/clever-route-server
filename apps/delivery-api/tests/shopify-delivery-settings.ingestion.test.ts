import { describe, expect, test, vi } from 'vitest';

import type {
  ShopifyAdminGraphqlClient,
  ShopifyAdminGraphqlRequest
} from '../src/modules/shopify/admin-graphql.client.js';
import { ShopifyDeliverySettingsError } from '../src/modules/shopify/order-delivery-settings.js';
import { ShopifyOrderReconciliationService } from '../src/modules/shopify/order-reconciliation.service.js';
import type { ClaimedShopifyOrderReconciliationJob } from '../src/modules/shopify/order-reconciliation.types.js';
import type { ShopifyOrderNode } from '../src/modules/shopify/order-sync.mapper.js';
import type {
  UpsertOrderWithDeliveryStopInput,
  UpsertOrderWithDeliveryStopResult
} from '../src/modules/shopify/order-sync.repository.js';
import { ShopifyOrderSyncService } from '../src/modules/shopify/order-sync.service.js';
import { ShopifyOrderWebhookProcessor } from '../src/modules/shopify/order-webhook.processor.js';
import type { ClaimedShopifyWebhookEvent } from '../src/modules/shopify/webhook-event.repository.js';

const cutoffTime = '17:00';
const cutoffWeekday = 'TUESDAY';
const orderInstant = '2026-09-29T20:30:00.000Z';

describe('Shopify delivery settings ingestion', () => {
  test.each([
    ['America/Toronto', '2026-10-02'],
    ['Asia/Seoul', '2026-10-09']
  ] as const)('pull sync applies the combined %s settings before upsert', async (timeZone, deliveryDate) => {
    const graphql = graphqlRequestMock((graphqlRequest) => {
      expect(graphqlRequest.query).toContain('currentAppInstallation');
      expect(graphqlRequest.query).toContain('orders(');
      return {
        ...deliverySettings(timeZone),
        orders: {
          nodes: [orderNode()],
          pageInfo: { endCursor: null, hasNextPage: false }
        }
      };
    });
    const upsertOrderWithDeliveryStop = upsertMock();
    const service = new ShopifyOrderSyncService({
      graphqlClient: { request: graphql.request },
      repository: { listCanonicalOrders: vi.fn(() => Promise.resolve([])), upsertOrderWithDeliveryStop }
    });

    await service.syncUpdatedOrdersPage({
      appId: timeZone === 'Asia/Seoul' ? 'clever-route-dev' : 'clever',
      first: 25,
      shopDomain: timeZone === 'Asia/Seoul' ? 'seoul.myshopify.com' : 'toronto.myshopify.com',
      updatedSince: new Date('2026-09-01T00:00:00.000Z')
    });

    expect(graphql.calls).toHaveBeenCalledOnce();
    expect(upsertOrderWithDeliveryStop).toHaveBeenCalledOnce();
    const synced = upsertOrderWithDeliveryStop.mock.calls[0]?.[0].synced;
    expect(synced).toEqual(expect.objectContaining({ deliveryTimeZone: timeZone }));
    expect(synced?.order).toEqual(expect.objectContaining({
      deliveryDate,
      deliveryDateSource: 'ORDER_DATE_CYCLE_RULE'
    }));
  });

  test.each([
    ['missing shop settings', { currentAppInstallation: { metafield: null, legacyMetafield: null }, shop: null }],
    ['incomplete installation settings', { currentAppInstallation: { metafield: null }, shop: { ianaTimezone: 'America/Toronto' } }]
  ])('%s stops pull ingestion before upsert', async (_label, response) => {
    const upsertOrderWithDeliveryStop = upsertMock();
    const graphql = graphqlRequestMock(() => ({
      ...response,
      orders: { nodes: [orderNode()], pageInfo: { endCursor: null, hasNextPage: false } }
    }));
    const service = new ShopifyOrderSyncService({
      graphqlClient: { request: graphql.request },
      repository: { listCanonicalOrders: vi.fn(() => Promise.resolve([])), upsertOrderWithDeliveryStop }
    });

    await expect(service.syncUpdatedOrdersPage({
      first: 25,
      shopDomain: 'invalid-settings.myshopify.com',
      updatedSince: new Date('2026-09-01T00:00:00.000Z')
    })).rejects.toBeInstanceOf(ShopifyDeliverySettingsError);
    expect(upsertOrderWithDeliveryStop).not.toHaveBeenCalled();
  });

  test('webhook refetch carries the combined settings into its claimed upsert', async () => {
    const graphql = graphqlRequestMock((graphqlRequest) => {
      expect(graphqlRequest.query).toContain('currentAppInstallation');
      expect(graphqlRequest.query).toContain('node(id: $id)');
      return { ...deliverySettings('America/Toronto'), node: orderNode() };
    });
    const upsertOrderWithDeliveryStop = upsertMock();
    const eventStore = webhookEventStore();
    const processor = new ShopifyOrderWebhookProcessor({
      defaultApiVersion: '2026-04',
      eventStore,
      graphqlClientFactory: () => ({ request: graphql.request }),
      orderRepository: { upsertOrderWithDeliveryStop },
      shopTokenService: { getAdminAccessToken: vi.fn(() => Promise.resolve('offline-token')) }
    });

    await processor.processClaimedEvent(webhookEvent());

    expect(graphql.calls).toHaveBeenCalledOnce();
    expect(upsertOrderWithDeliveryStop.mock.calls[0]?.[0]).toMatchObject({
      appId: 'clever',
      shopDomain: 'toronto.myshopify.com',
      synced: {
        deliveryTimeZone: 'America/Toronto',
        order: { deliveryDate: '2026-10-02' }
      },
      webhookClaim: { eventId: 'event-row-id', leaseToken: 'lease-token' }
    });
    expect(eventStore.markOrderWebhookProcessed).toHaveBeenCalledOnce();
    expect(eventStore.markOrderWebhookFailed).not.toHaveBeenCalled();
  });

  test('malformed webhook settings produce a retryable failure without upsert', async () => {
    const upsertOrderWithDeliveryStop = upsertMock();
    const eventStore = webhookEventStore();
    const graphql = graphqlRequestMock(() => ({
      currentAppInstallation: { legacyMetafield: null, metafield: { value: '{invalid' } },
      node: orderNode(),
      shop: { ianaTimezone: 'America/Toronto' }
    }));
    const processor = new ShopifyOrderWebhookProcessor({
      defaultApiVersion: '2026-04',
      eventStore,
      graphqlClientFactory: () => ({ request: graphql.request }),
      orderRepository: { upsertOrderWithDeliveryStop },
      shopTokenService: { getAdminAccessToken: vi.fn(() => Promise.resolve('offline-token')) }
    });

    await processor.processClaimedEvent(webhookEvent());

    expect(upsertOrderWithDeliveryStop).not.toHaveBeenCalled();
    expect(eventStore.markOrderWebhookProcessed).not.toHaveBeenCalled();
    expect(eventStore.markOrderWebhookFailed).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringMatching(/^TRANSIENT:/u) as unknown
    }));
  });

  test('reconciliation commits only after applying the combined settings', async () => {
    const graphql = graphqlRequestMock(() => ({
      ...deliverySettings('Asia/Seoul'),
      orders: { nodes: [orderNode()], pageInfo: { endCursor: null, hasNextPage: false } }
    }));
    const upsertOrderWithDeliveryStop = upsertMock();
    const repository = reconciliationRepository();
    const service = reconciliationService({ repository, request: graphql.request, upsertOrderWithDeliveryStop });

    await service.processClaimed(reconciliationJob({ appId: 'clever-route-dev', shopDomain: 'seoul.myshopify.com' }));

    expect(graphql.calls).toHaveBeenCalledOnce();
    expect(upsertOrderWithDeliveryStop.mock.calls[0]?.[0]).toMatchObject({
      appId: 'clever-route-dev',
      shopDomain: 'seoul.myshopify.com',
      synced: {
        deliveryTimeZone: 'Asia/Seoul',
        order: { deliveryDate: '2026-10-09' }
      }
    });
    expect(upsertOrderWithDeliveryStop).toHaveBeenCalledBefore(repository.markPageCommitted);
    expect(repository.markPageCommitted).toHaveBeenCalledOnce();
    expect(repository.markSucceeded).toHaveBeenCalledOnce();
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  test('reconciliation settings failure does not commit a cursor or succeed', async () => {
    const upsertOrderWithDeliveryStop = upsertMock();
    const repository = reconciliationRepository();
    const graphql = graphqlRequestMock(() => ({
      currentAppInstallation: null,
      orders: { nodes: [orderNode()], pageInfo: { endCursor: null, hasNextPage: false } },
      shop: { ianaTimezone: 'America/Toronto' }
    }));
    const service = reconciliationService({
      repository,
      request: graphql.request,
      upsertOrderWithDeliveryStop
    });

    await service.processClaimed(reconciliationJob());

    expect(upsertOrderWithDeliveryStop).not.toHaveBeenCalled();
    expect(repository.markPageCommitted).not.toHaveBeenCalled();
    expect(repository.markSucceeded).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledOnce();
  });

  test('snapshot provider remains shop/app scoped and overrides a stale request cycle', async () => {
    const upsertOrderWithDeliveryStop = upsertMock();
    const provider = vi.fn((input: { appId?: string | undefined; shopDomain: string }) => Promise.resolve(
      input.appId === 'clever-route-dev' && input.shopDomain === 'seoul.myshopify.com'
        ? deliveryCycle('Asia/Seoul')
        : deliveryCycle('America/Toronto')
    ));
    const service = new ShopifyOrderSyncService({
      deliveryCycleProvider: provider,
      graphqlClient: { request: vi.fn() },
      repository: {
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
        listCanonicalOrdersBySourceIdentity: vi.fn(() => Promise.resolve([])),
        upsertOrderWithDeliveryStop
      }
    });

    await service.syncOrdersSnapshot(snapshotInput({
      appId: 'clever',
      deliveryCycle: deliveryCycle('Asia/Seoul'),
      shopDomain: 'toronto.myshopify.com'
    }));
    await service.syncOrdersSnapshot(snapshotInput({
      appId: 'clever-route-dev',
      deliveryCycle: deliveryCycle('America/Toronto'),
      shopDomain: 'seoul.myshopify.com'
    }));

    expect(provider).toHaveBeenNthCalledWith(1, { appId: 'clever', shopDomain: 'toronto.myshopify.com' });
    expect(provider).toHaveBeenNthCalledWith(2, { appId: 'clever-route-dev', shopDomain: 'seoul.myshopify.com' });
    expect(upsertOrderWithDeliveryStop.mock.calls.map(([input]) => ({
      appId: input.appId,
      deliveryDate: input.synced.order.deliveryDate,
      deliveryTimeZone: input.synced.deliveryTimeZone,
      shopDomain: input.shopDomain
    }))).toEqual([
      {
        appId: 'clever',
        deliveryDate: '2026-10-02',
        deliveryTimeZone: 'America/Toronto',
        shopDomain: 'toronto.myshopify.com'
      },
      {
        appId: 'clever-route-dev',
        deliveryDate: '2026-10-09',
        deliveryTimeZone: 'Asia/Seoul',
        shopDomain: 'seoul.myshopify.com'
      }
    ]);
  });

  test('snapshot provider failure happens before manual-refresh preflight or writes', async () => {
    const assertOrdersSnapshotRefreshable = vi.fn();
    const upsertOrderWithDeliveryStop = upsertMock();
    const service = new ShopifyOrderSyncService({
      deliveryCycleProvider: vi.fn(() => Promise.reject(new ShopifyDeliverySettingsError())),
      graphqlClient: { request: vi.fn() },
      repository: {
        assertOrdersSnapshotRefreshable,
        listCanonicalOrders: vi.fn(() => Promise.resolve([])),
        upsertOrderWithDeliveryStop
      }
    });

    await expect(service.syncOrdersSnapshot({
      ...snapshotInput({ appId: 'clever', shopDomain: 'toronto.myshopify.com' }),
      reason: 'manual_refresh'
    })).rejects.toBeInstanceOf(ShopifyDeliverySettingsError);
    expect(assertOrdersSnapshotRefreshable).not.toHaveBeenCalled();
    expect(upsertOrderWithDeliveryStop).not.toHaveBeenCalled();
  });
});

function deliverySettings(timeZone: string) {
  return {
    currentAppInstallation: {
      legacyMetafield: null,
      metafield: { value: JSON.stringify({ deliveryCycle: { cutoffTime, cutoffWeekday } }) }
    },
    shop: { ianaTimezone: timeZone }
  };
}

function deliveryCycle(timeZone: string) {
  return { cutoffTime, cutoffWeekday: 'TUESDAY' as const, timeZone };
}

function orderNode(): ShopifyOrderNode {
  return {
    cancelledAt: null,
    createdAt: orderInstant,
    currentTotalPriceSet: { shopMoney: { amount: '95.00', currencyCode: 'CAD' } },
    customAttributes: [
      { key: 'Delivery Area', value: 'Downtown' },
      { key: 'Delivery Day', value: 'Friday' }
    ],
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: null,
    id: 'gid://shopify/Order/123',
    legacyResourceId: '123',
    lineItems: { nodes: [{ title: 'Kimchi', quantity: 1, sku: 'KIMCHI' }] },
    name: '#1001',
    note: null,
    paymentGatewayNames: ['manual'],
    phone: null,
    processedAt: orderInstant,
    shippingAddress: {
      address1: '1 Main St',
      address2: null,
      city: 'Toronto',
      countryCodeV2: 'CA',
      latitude: 43.65,
      longitude: -79.38,
      name: 'Customer',
      phone: null,
      province: 'ON',
      provinceCode: 'ON',
      zip: 'M5E 1E5'
    },
    tags: [],
    updatedAt: orderInstant
  };
}

function upsertMock() {
  return vi.fn((input: UpsertOrderWithDeliveryStopInput) => {
    void input;
    return Promise.resolve({
      orderId: 'order-id',
      status: 'created',
      stopId: 'stop-id'
    } satisfies UpsertOrderWithDeliveryStopResult);
  });
}

function webhookEventStore() {
  return {
    claimNextOrderWebhook: vi.fn(),
    getOrderWebhookDeliveryDisposition: vi.fn(),
    markOrderWebhookFailed: vi.fn(() => Promise.resolve(true)),
    markOrderWebhookProcessed: vi.fn(() => Promise.resolve(true))
  };
}

function webhookEvent(): ClaimedShopifyWebhookEvent {
  return {
    apiVersion: '2026-04',
    appId: 'clever',
    attemptCount: 1,
    id: 'event-row-id',
    leaseToken: 'lease-token',
    maxAttempts: 8,
    payload: { id: 123 },
    shopDomain: 'toronto.myshopify.com',
    shopId: 'shop-id',
    topic: 'orders/updated',
    triggeredAt: new Date(orderInstant),
    webhookId: 'webhook-id'
  };
}

function reconciliationRepository() {
  return {
    claimNext: vi.fn(),
    enqueue: vi.fn(),
    enqueueDueInstalledShops: vi.fn(),
    enqueueIfIdle: vi.fn(),
    findById: vi.fn(),
    markFailed: vi.fn(() => Promise.resolve(reconciliationJob())),
    markPageCommitted: vi.fn(() => Promise.resolve(reconciliationJob())),
    markSucceeded: vi.fn(() => Promise.resolve(reconciliationJob()))
  };
}

function reconciliationService(input: {
  repository: ReturnType<typeof reconciliationRepository>;
  request: ShopifyAdminGraphqlClient['request'];
  upsertOrderWithDeliveryStop: ReturnType<typeof upsertMock>;
}) {
  return new ShopifyOrderReconciliationService({
    defaultApiVersion: '2026-04',
    graphqlClientFactory: () => ({ request: input.request }),
    orderRepository: {
      listCanonicalOrders: vi.fn(() => Promise.resolve([])),
      upsertOrderWithDeliveryStop: input.upsertOrderWithDeliveryStop
    } as never,
    repository: input.repository,
    shopTokenService: { getAdminAccessToken: vi.fn(() => Promise.resolve('offline-token')) }
  });
}

function graphqlRequestMock(response: (request: ShopifyAdminGraphqlRequest) => unknown): {
  calls: ReturnType<typeof vi.fn<(request: ShopifyAdminGraphqlRequest) => unknown>>;
  request: ShopifyAdminGraphqlClient['request'];
} {
  const calls = vi.fn((request: ShopifyAdminGraphqlRequest) => response(request));
  const request: ShopifyAdminGraphqlClient['request'] = <TData = unknown>(
    graphqlRequest: ShopifyAdminGraphqlRequest,
    options?: { signal?: AbortSignal | undefined }
  ): Promise<TData> => {
    void options;
    return Promise.resolve(calls(graphqlRequest) as TData);
  };
  return { calls, request };
}

function reconciliationJob(overrides: Partial<ClaimedShopifyOrderReconciliationJob> = {}): ClaimedShopifyOrderReconciliationJob {
  return {
    appId: 'clever',
    attemptCount: 0,
    correlationId: 'correlation-id',
    counts: { created: 0, failed: 0, finalCanonical: null, scanned: 0, staleSkipped: 0, unchanged: 0, updated: 0 },
    createdAt: '2026-09-29T20:00:00.000Z',
    deadLetteredAt: null,
    finishedAt: null,
    highWatermark: null,
    id: 'job-id',
    lastError: null,
    leaseToken: 'lease-token',
    mode: 'INCREMENTAL',
    nextRunAt: '2026-09-29T20:00:00.000Z',
    overlapWindowSeconds: 600,
    pageCursor: null,
    pageSize: 25,
    requestedBy: 'system:test',
    shopDomain: 'toronto.myshopify.com',
    startedAt: '2026-09-29T20:00:01.000Z',
    startedFrom: '2026-09-01T00:00:00.000Z',
    status: 'RUNNING',
    updatedAt: '2026-09-29T20:00:01.000Z',
    warningCount: 0,
    ...overrides
  };
}

function snapshotInput(input: {
  appId: string;
  deliveryCycle?: ReturnType<typeof deliveryCycle>;
  shopDomain: string;
}) {
  return {
    appId: input.appId,
    ...(input.deliveryCycle === undefined ? {} : { deliveryCycle: input.deliveryCycle }),
    orders: [orderNode()],
    reason: 'orders_page_open' as const,
    shopDomain: input.shopDomain,
    source: 'clever-app-orders' as const,
    subject: 'shopify-user-id'
  };
}
