import { describe, expect, test, vi } from 'vitest';

import type { ShopifyAdminGraphqlRequest } from '../src/modules/shopify/admin-graphql.client.js';
import { ShopifyOrderReconciliationService } from '../src/modules/shopify/order-reconciliation.service.js';
import type { ClaimedShopifyOrderReconciliationJob } from '../src/modules/shopify/order-reconciliation.types.js';
import type {
  UpsertOrderWithDeliveryStopInput,
  UpsertOrderWithDeliveryStopResult
} from '../src/modules/shopify/order-sync.repository.js';

describe('ShopifyOrderReconciliationService', () => {
  test('commits cursor only after page sync and marks final high-watermark/counts', async () => {
    const requests: ShopifyAdminGraphqlRequest[] = [];
    const repository = {
      claimNext: vi.fn(),
      enqueue: vi.fn(),
      findById: vi.fn(),
      markFailed: vi.fn(),
      markPageCommitted: vi.fn(() => Promise.resolve(job())),
      markSucceeded: vi.fn(() => Promise.resolve(null))
    };
    const orderRepository = {
      listCanonicalOrders: vi.fn(() => Promise.resolve([{}, {}])),
      upsertOrderWithDeliveryStop: vi.fn((input: UpsertOrderWithDeliveryStopInput) => {
        void input;
        return Promise.resolve({ orderId: 'order-id', status: 'created', stopId: null } satisfies UpsertOrderWithDeliveryStopResult);
      })
    };
    const service = new ShopifyOrderReconciliationService({
      defaultApiVersion: '2026-04',
      graphqlClientFactory: () => ({
        request: <TData>(request: ShopifyAdminGraphqlRequest): Promise<TData> => {
          requests.push(request);
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
              pageInfo: { endCursor: 'cursor-2', hasNextPage: false }
            }
          } as TData);
        }
      }),
      orderRepository: orderRepository as never,
      repository,
      shopTokenService: { getAdminAccessToken: vi.fn(() => Promise.resolve('offline-token')) }
    });

    await service.processClaimed(job());

    expect(requests[0]?.variables).toMatchObject({ after: null, first: 25 });
    expect(orderRepository.upsertOrderWithDeliveryStop).toHaveBeenCalledBefore(repository.markPageCommitted);
    expect(repository.markPageCommitted).toHaveBeenCalledWith({
      counts: {
        created: 1,
        scanned: 1,
        staleSkipped: 0,
        unchanged: 0,
        updated: 0
      },
      highWatermark: new Date('2026-05-07T05:00:00Z'),
      jobId: 'job-id',
      leaseExpiresAt: expect.any(Date) as Date,
      leaseToken: 'lease-token',
      pageCursor: 'cursor-2'
    });
    expect(repository.markSucceeded).toHaveBeenCalledWith({
      finalCanonicalCount: 2,
      highWatermark: new Date('2026-05-07T05:00:00Z'),
      jobId: 'job-id',
      leaseToken: 'lease-token'
    });
  });

  test('stops without succeeding when page commit loses lease ownership', async () => {
    const repository = repositoryHarness({ markPageCommitted: vi.fn(() => Promise.resolve(null)) });
    const service = serviceHarness({ repository });

    await service.processClaimed(job());

    expect(repository.markPageCommitted).toHaveBeenCalledOnce();
    expect(repository.markSucceeded).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  test('fails without committing cap page when Shopify still has more pages at cap', async () => {
    const repository = repositoryHarness();
    const service = serviceHarness({
      hasNextPage: true,
      maxPages: 1,
      repository
    });

    await service.processClaimed(job());

    expect(repository.markPageCommitted).not.toHaveBeenCalled();
    expect(repository.markSucceeded).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledWith({
      error: expect.any(Error) as Error,
      jobId: 'job-id',
      leaseToken: 'lease-token',
      maxAttemptsReached: false,
      nextRunAt: expect.any(Date) as Date
    });
  });
});

function repositoryHarness(overrides: Partial<{
  claimNext: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
  markPageCommitted: ReturnType<typeof vi.fn>;
  markSucceeded: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    claimNext: overrides.claimNext ?? vi.fn(),
    enqueue: overrides.enqueue ?? vi.fn(),
    findById: overrides.findById ?? vi.fn(),
    markFailed: overrides.markFailed ?? vi.fn(),
    markPageCommitted: overrides.markPageCommitted ?? vi.fn(() => Promise.resolve(job())),
    markSucceeded: overrides.markSucceeded ?? vi.fn(() => Promise.resolve(job()))
  };
}

function serviceHarness(input: {
  hasNextPage?: boolean;
  maxPages?: number;
  repository: ReturnType<typeof repositoryHarness>;
}) {
  return new ShopifyOrderReconciliationService({
    defaultApiVersion: '2026-04',
    graphqlClientFactory: () => ({
      request: <TData>(): Promise<TData> =>
        Promise.resolve({
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
            pageInfo: { endCursor: 'cursor-2', hasNextPage: input.hasNextPage ?? false }
          }
        } as TData)
    }),
    ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
    orderRepository: {
      listCanonicalOrders: vi.fn(() => Promise.resolve([{}, {}])),
      upsertOrderWithDeliveryStop: vi.fn(() =>
        Promise.resolve({ orderId: 'order-id', status: 'created', stopId: null } satisfies UpsertOrderWithDeliveryStopResult)
      )
    } as never,
    repository: input.repository as never,
    shopTokenService: { getAdminAccessToken: vi.fn(() => Promise.resolve('offline-token')) }
  });
}

function job(): ClaimedShopifyOrderReconciliationJob {
  return {
    appId: 'clever',
    attemptCount: 0,
    correlationId: 'corr-1',
    counts: {
      created: 0,
      failed: 0,
      finalCanonical: null,
      scanned: 0,
      staleSkipped: 0,
      unchanged: 0,
      updated: 0
    },
    createdAt: '2026-05-07T00:00:00.000Z',
    deadLetteredAt: null,
    finishedAt: null,
    highWatermark: null,
    id: 'job-id',
    lastError: null,
    leaseToken: 'lease-token',
    mode: 'INCREMENTAL',
    nextRunAt: '2026-05-07T00:00:00.000Z',
    overlapWindowSeconds: 600,
    pageCursor: null,
    pageSize: 25,
    requestedBy: 'shopify-user-id',
    shopDomain: 'example.myshopify.com',
    startedAt: '2026-05-07T00:00:01.000Z',
    startedFrom: '2026-05-01T00:00:00.000Z',
    status: 'RUNNING',
    updatedAt: '2026-05-07T00:00:01.000Z',
    warningCount: 0
  };
}
