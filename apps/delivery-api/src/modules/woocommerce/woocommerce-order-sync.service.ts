import type { CanonicalOrderRow } from '../shopify/order-sync.mapper.js';
import type { ListCanonicalOrdersFilters, UpsertOrderWithDeliveryStopInput, UpsertOrderWithDeliveryStopResult } from '../shopify/order-sync.repository.js';
import { mapWooCommerceOrderToDeliveryInputs } from './woocommerce-order.mapper.js';
import type { WooCommerceOrder } from './woocommerce-order.types.js';
import type { WooCommerceOrderClient, WooCommerceOrdersPage } from './woocommerce-order.client.js';

export type WooCommerceOrderSyncSummary = {
  created: number;
  needsReview: number;
  readyToPlan: number;
  received: number;
  skipped: number;
  unchanged: number;
  updated: number;
};

export type WooCommerceSyncOrdersInput = {
  orders: WooCommerceOrder[];
  reason: 'manual_backfill' | 'scheduled_incremental' | 'webhook';
};

export type WooCommerceSyncOrdersResult = {
  orders: CanonicalOrderRow[];
  sync: WooCommerceOrderSyncSummary;
};

export type WooCommerceSyncUpdatedOrdersInput = {
  modifiedAfter?: Date | null;
  pageSize: number;
  status?: string | null;
};

export type WooCommerceSyncUpdatedOrdersResult = WooCommerceSyncOrdersResult & {
  pagesRead: number;
};

type Repository = {
  findCanonicalOrderById?(input: { orderId: string; shopDomain: string }): Promise<CanonicalOrderRow | null>;
  listCanonicalOrders(input: { filters?: ListCanonicalOrdersFilters; shopDomain: string }): Promise<CanonicalOrderRow[]>;
  upsertOrderWithDeliveryStop(input: UpsertOrderWithDeliveryStopInput): Promise<UpsertOrderWithDeliveryStopResult>;
};

export class WooCommerceOrderSyncService {
  constructor(
    private readonly options: {
      client?: Pick<WooCommerceOrderClient, 'listOrdersPage'>;
      repository: Repository;
      shopDomain: string;
      shopTimezone?: string;
      siteUrl: string;
    }
  ) {}

  async syncUpdatedOrders(input: WooCommerceSyncUpdatedOrdersInput): Promise<WooCommerceSyncUpdatedOrdersResult> {
    if (this.options.client === undefined) {
      throw new Error('WooCommerce order client is not configured');
    }

    let page = 1;
    let pagesRead = 0;
    const allOrders: WooCommerceOrder[] = [];
    while (true) {
      const result: WooCommerceOrdersPage = await this.options.client.listOrdersPage({
        modifiedAfter: input.modifiedAfter ?? null,
        page,
        perPage: input.pageSize,
        status: input.status ?? null
      });
      pagesRead += 1;
      allOrders.push(...result.orders);
      const totalPages = result.totalPages ?? (result.orders.length < input.pageSize ? page : page + 1);
      if (page >= totalPages || result.orders.length === 0) break;
      page += 1;
    }

    const synced = await this.syncOrders({ orders: allOrders, reason: 'scheduled_incremental' });
    return { ...synced, pagesRead };
  }

  async syncOrders(input: WooCommerceSyncOrdersInput): Promise<WooCommerceSyncOrdersResult> {
    const summary: WooCommerceOrderSyncSummary = {
      created: 0,
      needsReview: 0,
      readyToPlan: 0,
      received: input.orders.length,
      skipped: 0,
      unchanged: 0,
      updated: 0
    };
    const orders: CanonicalOrderRow[] = [];

    for (const order of input.orders) {
      const synced = mapWooCommerceOrderToDeliveryInputs(order, {
        ...(this.options.shopTimezone === undefined ? {} : { shopTimezone: this.options.shopTimezone }),
        siteUrl: this.options.siteUrl
      });
      const result = await this.options.repository.upsertOrderWithDeliveryStop({
        shopDomain: this.options.shopDomain,
        synced
      });
      summary[result.status] += 1;
      const canonical = await this.readCanonicalOrder(result.orderId);
      if (canonical !== null) {
        orders.push(canonical);
        if (canonical.readiness === 'READY_TO_PLAN') summary.readyToPlan += 1;
        if (canonical.readiness === 'NEEDS_REVIEW') summary.needsReview += 1;
      }
    }

    return { orders, sync: summary };
  }

  listCanonicalOrders(input: { filters?: ListCanonicalOrdersFilters }): Promise<CanonicalOrderRow[]> {
    return this.options.repository.listCanonicalOrders({
      ...(input.filters === undefined ? {} : { filters: input.filters }),
      shopDomain: this.options.shopDomain
    });
  }

  private async readCanonicalOrder(orderId: string): Promise<CanonicalOrderRow | null> {
    if (this.options.repository.findCanonicalOrderById !== undefined) {
      return this.options.repository.findCanonicalOrderById({ orderId, shopDomain: this.options.shopDomain });
    }
    const rows = await this.options.repository.listCanonicalOrders({ shopDomain: this.options.shopDomain });
    return rows.find((row) => row.orderId === orderId) ?? null;
  }
}
