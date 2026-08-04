import type { ShopifyAdminGraphqlClient } from './admin-graphql.client.js';
import type { DeliveryCycleConfig } from './order-delivery-scope.js';
import type { CanonicalOrderRow, ShopifyOrderNode, SyncedOrderWithDeliveryStopInput } from './order-sync.mapper.js';
import { mapShopifyOrderNodeToDeliveryInputs } from './order-sync.mapper.js';
import { buildOrdersUpdatedSinceQuery } from './order-sync.query.js';
import type {
  AssertOrdersSnapshotRefreshableInput,
  DeliveryBatchCandidate,
  BulkPatchCanonicalOrderStatusInput,
  ListCanonicalOrdersFilters,
  ListDeliveryBatchCandidatesInput,
  PatchCanonicalOrderCoordinatesInput,
  PatchCanonicalOrderGeocodeDiagnosticsInput,
  PatchCanonicalOrderInput,
  UpsertOrderWithDeliveryStopInput,
  UpsertOrderWithDeliveryStopResult
} from './order-sync.repository.js';
import type { PrismaOrderQueryRepository } from './order-query.repository.js';

export type SyncUpdatedOrdersPageInput = {
  after?: string | null;
  first: number;
  appId?: string | undefined;
  shopDomain: string;
  updatedSince: Date;
};

export type SyncUpdatedOrdersPageResult = {
  endCursor: string | null;
  hasNextPage: boolean;
  highWatermark: Date | null;
  ordersSynced: number;
  sync: Pick<OrdersSyncSummary, 'created' | 'skipped' | 'unchanged' | 'updated'>;
};

export type SyncOrdersSnapshotInput = {
  deliveryCycle?: DeliveryCycleConfig;
  orders: ShopifyOrderNode[];
  reason: 'orders_page_open' | 'manual_refresh' | 'route_create_preflight';
  appId?: string | undefined;
  shopDomain: string;
  source: 'clever-app-orders';
  subject: string;
};

export type OrdersSyncSummary = {
  created: number;
  needsReview: number;
  readyToPlan: number;
  received: number;
  skipped: number;
  unchanged: number;
  updated: number;
};

export type SyncOrdersSnapshotResult = {
  orders: CanonicalOrderRow[];
  sync: OrdersSyncSummary;
};

type OrdersUpdatedSinceResponse = {
  orders: {
    nodes: ShopifyOrderNode[];
    pageInfo: {
      endCursor: string | null;
      hasNextPage: boolean;
    };
  };
};

type OrderSyncRepository = {
  assertOrdersSnapshotRefreshable?(input: AssertOrdersSnapshotRefreshableInput): Promise<void>;
  findCanonicalOrderById?(input: {
    appId?: string | undefined;
    orderId: string;
    shopDomain: string;
  }): Promise<CanonicalOrderRow | null>;
  listCanonicalOrdersBySourceIdentity?(input: {
    identities: Array<{
      shopifyOrderGid: string;
      sourceOrderId: string | null;
      sourcePlatform: ReturnType<typeof mapShopifyOrderNodeToDeliveryInputs>['order']['sourcePlatform'];
      sourceSiteUrl: string | null;
    }>;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<CanonicalOrderRow[]>;
  listCanonicalOrders(input: {
    filters?: ListCanonicalOrdersFilters;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<CanonicalOrderRow[]>;
  bulkPatchCanonicalOrderStatus?(input: BulkPatchCanonicalOrderStatusInput): Promise<CanonicalOrderRow[]>;
  listDeliveryBatchCandidates?(input: ListDeliveryBatchCandidatesInput): Promise<DeliveryBatchCandidate[]>;
  patchCanonicalOrder?(input: PatchCanonicalOrderInput): Promise<CanonicalOrderRow | null>;
  patchCanonicalOrderCoordinates?(input: PatchCanonicalOrderCoordinatesInput): Promise<CanonicalOrderRow | null>;
  patchCanonicalOrderGeocodeDiagnostics?(input: PatchCanonicalOrderGeocodeDiagnosticsInput): Promise<CanonicalOrderRow | null>;
  upsertOrderWithDeliveryStop(
    input: UpsertOrderWithDeliveryStopInput
  ): Promise<UpsertOrderWithDeliveryStopResult>;
};

export class ShopifyOrderSyncService {
  constructor(
    private readonly options: {
      graphqlClient: Pick<ShopifyAdminGraphqlClient, 'request'>;
      queryRepository?: PrismaOrderQueryRepository;
      repository: OrderSyncRepository;
    }
  ) {}

  async syncUpdatedOrdersPage(
    input: SyncUpdatedOrdersPageInput
  ): Promise<SyncUpdatedOrdersPageResult> {
    const data = await this.options.graphqlClient.request<OrdersUpdatedSinceResponse>(
      buildOrdersUpdatedSinceQuery(input)
    );

    let highWatermark: Date | null = null;
    let ordersSynced = 0;
    const sync = { created: 0, skipped: 0, unchanged: 0, updated: 0 };
    for (const node of data.orders.nodes) {
      const synced: SyncedOrderWithDeliveryStopInput = mapShopifyOrderNodeToDeliveryInputs(node);
      await this.options.repository.upsertOrderWithDeliveryStop({
        appId: input.appId,
        shopDomain: input.shopDomain,
        synced
      }).then((result) => {
        sync[result.status] += 1;
      });
      const sourceUpdatedAt = synced.order.sourceUpdatedAt ?? synced.order.updatedAtShopify;
      if (sourceUpdatedAt.getTime() > (highWatermark?.getTime() ?? 0)) {
        highWatermark = sourceUpdatedAt;
      }
      ordersSynced += 1;
    }

    return {
      endCursor: data.orders.pageInfo.endCursor,
      hasNextPage: data.orders.pageInfo.hasNextPage,
      highWatermark,
      ordersSynced,
      sync
    };
  }

  async syncOrdersSnapshot(input: SyncOrdersSnapshotInput): Promise<SyncOrdersSnapshotResult> {
    const summary: OrdersSyncSummary = {
      created: 0,
      needsReview: 0,
      readyToPlan: 0,
      received: input.orders.length,
      skipped: 0,
      unchanged: 0,
      updated: 0
    };
    const orders: CanonicalOrderRow[] = [];
    const syncedOrders = input.orders.map((node) => mapShopifyOrderNodeToDeliveryInputs(node, {
      ...(input.deliveryCycle === undefined ? {} : { deliveryCycle: input.deliveryCycle })
    }));

    if (input.reason === 'manual_refresh' && this.options.repository.assertOrdersSnapshotRefreshable !== undefined) {
      await this.options.repository.assertOrdersSnapshotRefreshable({
        appId: input.appId,
        shopDomain: input.shopDomain,
        shopifyOrderGids: syncedOrders.map((synced) => synced.order.shopifyOrderGid)
      });
    }

    const orderIds: string[] = [];
    for (const synced of syncedOrders) {
      const result = await this.options.repository.upsertOrderWithDeliveryStop({
        appId: input.appId,
        shopDomain: input.shopDomain,
        syncReason: input.reason,
        synced
      });
      summary[result.status] += 1;
      orderIds.push(result.orderId);
    }

    const canonicalOrders = await this.readCanonicalOrdersAfterSnapshot({
      appId: input.appId,
      orderIds,
      shopDomain: input.shopDomain,
      syncedOrders
    });
    for (const canonical of canonicalOrders) {
      orders.push(canonical);
      if (canonical.readiness === 'READY_TO_PLAN') summary.readyToPlan += 1;
      if (canonical.readiness === 'NEEDS_REVIEW') summary.needsReview += 1;
    }

    return { orders, sync: summary };
  }

  listCanonicalOrders(input: {
    filters?: ListCanonicalOrdersFilters;
    appId?: string | undefined;
    shopDomain: string;
  }): Promise<CanonicalOrderRow[]> {
    return this.options.repository.listCanonicalOrders(input);
  }

  listCanonicalOrdersPage(input: Parameters<PrismaOrderQueryRepository['listPage']>[0]) {
    if (this.options.queryRepository === undefined) throw new Error('Orders pagination is not configured');
    return this.options.queryRepository.listPage(input);
  }

  listCanonicalOrderFacets(input: Parameters<PrismaOrderQueryRepository['facets']>[0]) {
    if (this.options.queryRepository === undefined) throw new Error('Orders facets are not configured');
    return this.options.queryRepository.facets(input);
  }

  listCanonicalOrderMapPoints(input: Parameters<PrismaOrderQueryRepository['mapPoints']>[0]) {
    if (this.options.queryRepository === undefined) throw new Error('Orders map projection is not configured');
    return this.options.queryRepository.mapPoints(input);
  }

  createOrderSelectionSnapshot(input: Parameters<PrismaOrderQueryRepository['createSelectionSnapshot']>[0]) {
    if (this.options.queryRepository === undefined) throw new Error('Order selection snapshots are not configured');
    return this.options.queryRepository.createSelectionSnapshot(input);
  }

  replaceOrderSelectionExclusions(input: Parameters<PrismaOrderQueryRepository['replaceSelectionExclusions']>[0]) {
    if (this.options.queryRepository === undefined) throw new Error('Order selection snapshots are not configured');
    return this.options.queryRepository.replaceSelectionExclusions(input);
  }

  consumeOrderSelectionSnapshot(input: Parameters<PrismaOrderQueryRepository['consumeSelectionSnapshot']>[0]) {
    if (this.options.queryRepository === undefined) throw new Error('Order selection snapshots are not configured');
    return this.options.queryRepository.consumeSelectionSnapshot(input);
  }

  bulkPatchOrderSelectionSnapshot(input: Parameters<PrismaOrderQueryRepository['bulkPatchSelectionSnapshot']>[0]) {
    if (this.options.queryRepository === undefined) throw new Error('Order selection snapshots are not configured');
    return this.options.queryRepository.bulkPatchSelectionSnapshot(input);
  }

  listDeliveryBatchCandidates(input: ListDeliveryBatchCandidatesInput): Promise<DeliveryBatchCandidate[]> {
    if (this.options.repository.listDeliveryBatchCandidates === undefined) {
      return Promise.resolve([]);
    }
    return this.options.repository.listDeliveryBatchCandidates(input);
  }

  bulkPatchCanonicalOrderStatus(input: BulkPatchCanonicalOrderStatusInput): Promise<CanonicalOrderRow[]> {
    if (this.options.repository.bulkPatchCanonicalOrderStatus === undefined) {
      return Promise.resolve([]);
    }
    return this.options.repository.bulkPatchCanonicalOrderStatus(input);
  }

  patchCanonicalOrder(input: PatchCanonicalOrderInput): Promise<CanonicalOrderRow | null> {
    if (this.options.repository.patchCanonicalOrder === undefined) {
      return Promise.resolve(null);
    }
    return this.options.repository.patchCanonicalOrder(input);
  }

  patchCanonicalOrderCoordinates(input: PatchCanonicalOrderCoordinatesInput): Promise<CanonicalOrderRow | null> {
    if (this.options.repository.patchCanonicalOrderCoordinates === undefined) {
      return Promise.resolve(null);
    }
    return this.options.repository.patchCanonicalOrderCoordinates(input);
  }

  patchCanonicalOrderGeocodeDiagnostics(input: PatchCanonicalOrderGeocodeDiagnosticsInput): Promise<CanonicalOrderRow | null> {
    if (this.options.repository.patchCanonicalOrderGeocodeDiagnostics === undefined) {
      return Promise.resolve(null);
    }
    return this.options.repository.patchCanonicalOrderGeocodeDiagnostics(input);
  }

  private async readCanonicalOrder(input: {
    appId?: string | undefined;
    orderId: string;
    shopDomain: string;
  }): Promise<CanonicalOrderRow | null> {
    if (this.options.repository.findCanonicalOrderById !== undefined) {
      return this.options.repository.findCanonicalOrderById(input);
    }

    const orders = await this.options.repository.listCanonicalOrders({
      appId: input.appId,
      shopDomain: input.shopDomain
    });
    return orders.find((order) => order.orderId === input.orderId) ?? null;
  }

  private async readCanonicalOrdersAfterSnapshot(input: {
    appId?: string | undefined;
    orderIds: string[];
    shopDomain: string;
    syncedOrders: SyncedOrderWithDeliveryStopInput[];
  }): Promise<CanonicalOrderRow[]> {
    if (this.options.repository.listCanonicalOrdersBySourceIdentity !== undefined) {
      const bySource = await this.options.repository.listCanonicalOrdersBySourceIdentity({
        appId: input.appId,
        identities: input.syncedOrders.map((synced) => ({
          shopifyOrderGid: synced.order.shopifyOrderGid,
          sourceOrderId: synced.order.sourceOrderId ?? null,
          sourcePlatform: synced.order.sourcePlatform,
          sourceSiteUrl: synced.order.sourceSiteUrl ?? null
        })),
        shopDomain: input.shopDomain
      });
      const byOrderId = new Map(bySource.map((order) => [order.orderId, order]));
      return input.orderIds.flatMap((orderId) => byOrderId.get(orderId) ?? []);
    }

    const orders: CanonicalOrderRow[] = [];
    for (const orderId of input.orderIds) {
      const canonical = await this.readCanonicalOrder({
        appId: input.appId,
        orderId,
        shopDomain: input.shopDomain
      });
      if (canonical !== null) orders.push(canonical);
    }
    return orders;
  }
}
