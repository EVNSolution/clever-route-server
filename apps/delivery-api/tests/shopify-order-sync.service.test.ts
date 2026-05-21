import { describe, expect, test, vi } from 'vitest';

import type {
  ShopifyAdminGraphqlClient,
  ShopifyAdminGraphqlRequest
} from '../src/modules/shopify/admin-graphql.client.js';
import type { CanonicalOrderRow, ShopifyOrderNode } from '../src/modules/shopify/order-sync.mapper.js';
import type {
  UpsertOrderWithDeliveryStopInput,
  UpsertOrderWithDeliveryStopResult
} from '../src/modules/shopify/order-sync.repository.js';
import { ShopifyOrderSyncService } from '../src/modules/shopify/order-sync.service.js';

describe('ShopifyOrderSyncService', () => {
  test('fetches a page of updated Shopify orders and stores mapped records', async () => {
    const graphqlRequests: ShopifyAdminGraphqlRequest[] = [];
    const graphqlClient: Pick<ShopifyAdminGraphqlClient, 'request'> = {
      request: <TData>(request: ShopifyAdminGraphqlRequest): Promise<TData> => {
        graphqlRequests.push(request);
        return Promise.resolve({
          orders: {
            nodes: [
              {
                currentTotalPriceSet: null,
                displayFinancialStatus: 'PAID',
                displayFulfillmentStatus: 'UNFULFILLED',
                email: null,
                id: 'gid://shopify/Order/123',
                legacyResourceId: '123',
                name: '#1001',
                phone: null,
                processedAt: null,
                shippingAddress: null,
                updatedAt: '2026-05-07T05:00:00Z'
              }
            ],
            pageInfo: {
              endCursor: 'cursor-2',
              hasNextPage: true
            }
          }
        } as TData);
      }
    };
    const repository: {
      upsertOrderWithDeliveryStop: ReturnType<
        typeof vi.fn<
          (input: UpsertOrderWithDeliveryStopInput) => Promise<UpsertOrderWithDeliveryStopResult>
        >
      >;
    } = {
      upsertOrderWithDeliveryStop: vi.fn((input: UpsertOrderWithDeliveryStopInput) => {
        void input;
        return Promise.resolve({ orderId: 'local-order-id', status: 'created', stopId: null });
      })
    };
    const service = new ShopifyOrderSyncService({
      graphqlClient,
      repository: {
        ...repository,
        listCanonicalOrders: () => Promise.resolve([] satisfies CanonicalOrderRow[])
      }
    });

    await expect(
      service.syncUpdatedOrdersPage({
        first: 25,
        shopDomain: 'example.myshopify.com',
        updatedSince: new Date('2026-05-07T00:00:00Z')
      })
    ).resolves.toEqual({
      endCursor: 'cursor-2',
      hasNextPage: true,
      ordersSynced: 1
    });

    expect(graphqlRequests[0]?.variables?.first).toBe(25);
    const firstRepositoryCall = repository.upsertOrderWithDeliveryStop.mock.calls[0];
    expect(firstRepositoryCall).toBeDefined();
    if (firstRepositoryCall === undefined) {
      throw new Error('Expected order sync repository call');
    }
    const [repositoryInput] = firstRepositoryCall;
    expect(repositoryInput.shopDomain).toBe('example.myshopify.com');
    expect(repositoryInput.synced.order.shopifyOrderGid).toBe('gid://shopify/Order/123');
  });
});

test('syncs app-provided order snapshots and summarizes repository outcomes', async () => {
  const repository = {
    listCanonicalOrders: vi.fn(() => Promise.resolve([])),
    upsertOrderWithDeliveryStop: vi
      .fn()
      .mockResolvedValueOnce({ orderId: 'order-1', status: 'created', stopId: 'stop-1' })
      .mockResolvedValueOnce({ orderId: 'order-2', status: 'unchanged', stopId: 'stop-2' }),
    findCanonicalOrderById: vi
      .fn()
      .mockResolvedValueOnce({ readiness: 'READY_TO_PLAN' })
      .mockResolvedValueOnce({ readiness: 'NEEDS_REVIEW' })
  };
  const service = new ShopifyOrderSyncService({
    graphqlClient: { request: vi.fn() },
    repository
  });

  await expect(
    service.syncOrdersSnapshot({
      orders: [snapshotOrder({ id: 'gid://shopify/Order/1' }), snapshotOrder({ id: 'gid://shopify/Order/2' })],
      reason: 'manual_refresh',
      shopDomain: 'example.myshopify.com',
      source: 'clever-app-orders',
      subject: 'shopify-user-id'
    })
  ).resolves.toEqual({
    orders: [{ readiness: 'READY_TO_PLAN' }, { readiness: 'NEEDS_REVIEW' }],
    sync: {
      created: 1,
      needsReview: 1,
      readyToPlan: 1,
      received: 2,
      skipped: 0,
      unchanged: 1,
      updated: 0
    }
  });
});

function snapshotOrder(overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
  return {
    cancelledAt: null,
    currentTotalPriceSet: { shopMoney: { amount: '95.00', currencyCode: 'CAD' } },
    customAttributes: [
      { key: 'Delivery Area', value: 'Mississauga' },
      { key: 'Delivery Day', value: 'Thursday' }
    ],
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    email: 'customer@example.com',
    id: 'gid://shopify/Order/123',
    legacyResourceId: '123',
    name: '#1035',
    note: null,
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
