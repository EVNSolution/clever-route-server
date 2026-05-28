import type { CanonicalOrderRow } from '../shopify/order-sync.mapper.js';
import type { DeliveryBatchCandidate, ListCanonicalOrdersFilters, ListDeliveryBatchCandidatesInput, UpsertOrderWithDeliveryStopInput, UpsertOrderWithDeliveryStopResult } from '../shopify/order-sync.repository.js';
import { mapWooCommerceOrderToDeliveryInputs, type WooOrderMappingConfig } from './woocommerce-order.mapper.js';
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
  listDeliveryBatchCandidates?(input: ListDeliveryBatchCandidatesInput): Promise<DeliveryBatchCandidate[]>;
  readOrderMappingConfig?(input: { commerceConnectionId: string }): Promise<Record<string, unknown> | null>;
  upsertOrderWithDeliveryStop(input: UpsertOrderWithDeliveryStopInput): Promise<UpsertOrderWithDeliveryStopResult>;
};

export class WooCommerceOrderSyncService {
  constructor(
    private readonly options: {
      client?: Pick<WooCommerceOrderClient, 'listOrdersPage'>;
      connectionId?: string | null;
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
    const mappingConfig = await this.readOrderMappingConfig();

    for (const order of input.orders) {
      const synced = mapWooCommerceOrderToDeliveryInputs(order, {
        connectionId: this.options.connectionId ?? null,
        mappingConfig,
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

  listDeliveryBatchCandidates(input: Omit<ListDeliveryBatchCandidatesInput, 'shopDomain'>): Promise<DeliveryBatchCandidate[]> {
    if (this.options.repository.listDeliveryBatchCandidates === undefined) return Promise.resolve([]);
    return this.options.repository.listDeliveryBatchCandidates({
      ...input,
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

  private async readOrderMappingConfig(): Promise<WooOrderMappingConfig | null> {
    if (this.options.connectionId === undefined || this.options.connectionId === null) return null;
    if (this.options.repository.readOrderMappingConfig === undefined) return null;
    const config = await this.options.repository.readOrderMappingConfig({ commerceConnectionId: this.options.connectionId });
    return config === null ? null : normalizeMappingConfig(config);
  }
}

function normalizeMappingConfig(value: Record<string, unknown>): WooOrderMappingConfig {
  const config: WooOrderMappingConfig = {};
  const areaPaths = readStringArray(value.areaPaths);
  if (areaPaths !== undefined) config.areaPaths = areaPaths;
  const datePaths = readStringArray(value.datePaths);
  if (datePaths !== undefined) config.datePaths = datePaths;
  const dayPaths = readStringArray(value.dayPaths);
  if (dayPaths !== undefined) config.dayPaths = dayPaths;
  if (value.grouping === 'date_session' || value.grouping === 'date_session_area') config.grouping = value.grouping;
  const instructionPaths = readStringArray(value.instructionPaths);
  if (instructionPaths !== undefined) config.instructionPaths = instructionPaths;
  const pickupPaths = readStringArray(value.pickupPaths);
  if (pickupPaths !== undefined) config.pickupPaths = pickupPaths;
  if (typeof value.serviceMinutesDefault === 'number' && Number.isFinite(value.serviceMinutesDefault)) {
    config.serviceMinutesDefault = value.serviceMinutesDefault;
  }
  const timeWindowPaths = readStringArray(value.timeWindowPaths);
  if (timeWindowPaths !== undefined) config.timeWindowPaths = timeWindowPaths;
  if (typeof value.version === 'number' && Number.isFinite(value.version)) config.version = value.version;
  return config;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}
