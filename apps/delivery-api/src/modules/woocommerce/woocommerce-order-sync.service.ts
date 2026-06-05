import type { CanonicalOrderRow } from '../shopify/order-sync.mapper.js';
import type { GeocodingAddress, GeocodingResult } from '../geocoding/geocoding.types.js';
import { summarizeGeocodeDiagnostic } from '../geocoding/geocoding.diagnostics.js';
import type { DeliveryBatchCandidate, ListCanonicalOrdersFilters, ListDeliveryBatchCandidatesInput, UpsertOrderWithDeliveryStopInput, UpsertOrderWithDeliveryStopResult } from '../shopify/order-sync.repository.js';
import { mapWooCommerceOrderToDeliveryInputs, type WooOrderMappingConfig, type WooWeekdayFallbackPolicy } from './woocommerce-order.mapper.js';
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
  reason: 'manual_backfill' | 'manual_single_order_refresh' | 'raw_push' | 'scheduled_incremental' | 'webhook';
};

export type WooCommerceSyncOrdersResult = {
  orders: CanonicalOrderRow[];
  sync: WooCommerceOrderSyncSummary;
};

export type WooCommerceSyncUpdatedOrdersInput = {
  modifiedAfter?: Date | null;
  overlapWindowMs?: number;
  pageSize: number;
  status?: string | null;
};

export type WooCommerceSyncUpdatedOrdersResult = WooCommerceSyncOrdersResult & {
  pagesRead: number;
};

export type WooCommerceSyncSingleOrderInput = {
  sourceOrderId: number | string;
};

export type WooCommerceSyncTier = 'hot' | 'cold';

export type WooCommerceSyncTierClassification = {
  reason: 'today_or_future_delivery' | 'past_delivery' | 'missing_delivery_date';
  review: boolean;
  tier: WooCommerceSyncTier;
};

type Repository = {
  findCanonicalOrderById?(input: { orderId: string; shopDomain: string }): Promise<CanonicalOrderRow | null>;
  listCanonicalOrders(input: { filters?: ListCanonicalOrdersFilters; shopDomain: string }): Promise<CanonicalOrderRow[]>;
  listDeliveryBatchCandidates?(input: ListDeliveryBatchCandidatesInput): Promise<DeliveryBatchCandidate[]>;
  readOrderMappingConfig?(input: { commerceConnectionId: string }): Promise<Record<string, unknown> | null>;
  upsertOrderWithDeliveryStop(input: UpsertOrderWithDeliveryStopInput): Promise<UpsertOrderWithDeliveryStopResult>;
};

type GeocodingServiceLike = {
  geocode(input: { address: GeocodingAddress; shopDomain: string }): Promise<GeocodingResult>;
  status?: {
    mode: 'disabled' | 'nominatim_compatible';
    persistentCacheEnabled: boolean;
    providerPolicy?: 'disabled' | 'private_nominatim_compatible' | 'public_nominatim';
  };
};

type WooCommerceOrderClientLike = {
  getOrder?: WooCommerceOrderClient['getOrder'];
  listOrdersPage?: WooCommerceOrderClient['listOrdersPage'];
};

export class WooCommerceOrderSyncService {
  constructor(
    private readonly options: {
      client?: WooCommerceOrderClientLike;
      connectionId?: string | null;
      geocodingService?: GeocodingServiceLike;
      repository: Repository;
      shopDomain: string;
      shopTimezone?: string;
      siteUrl: string;
    }
  ) {}

  async syncUpdatedOrders(input: WooCommerceSyncUpdatedOrdersInput): Promise<WooCommerceSyncUpdatedOrdersResult> {
    if (this.options.client?.listOrdersPage === undefined) {
      throw new Error('WooCommerce order client is not configured');
    }

    let page = 1;
    let pagesRead = 0;
    const allOrders: WooCommerceOrder[] = [];
    const modifiedAfter = applyWooModifiedAfterOverlap(
      input.modifiedAfter ?? null,
      input.overlapWindowMs ?? 0
    );
    while (true) {
      const result: WooCommerceOrdersPage = await this.options.client.listOrdersPage({
        modifiedAfter,
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

  async syncSingleOrder(input: WooCommerceSyncSingleOrderInput): Promise<WooCommerceSyncOrdersResult> {
    if (this.options.client?.getOrder === undefined) {
      throw new Error('WooCommerce order client is not configured');
    }

    const order = await this.options.client.getOrder({ orderId: input.sourceOrderId });
    return this.syncOrders({ orders: [order], reason: 'manual_single_order_refresh' });
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
      const synced = await this.geocodeBeforePersisting(
        mapWooCommerceOrderToDeliveryInputs(order, {
          connectionId: this.options.connectionId ?? null,
          mappingConfig,
          ...(this.options.shopTimezone === undefined ? {} : { shopTimezone: this.options.shopTimezone }),
          siteUrl: this.options.siteUrl
        }),
        input.reason,
      );
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

  private async geocodeBeforePersisting(
    synced: UpsertOrderWithDeliveryStopInput['synced'],
    reason: WooCommerceSyncOrdersInput['reason']
  ): Promise<UpsertOrderWithDeliveryStopInput['synced']> {
    const geocodingService = this.options.geocodingService;
    if (geocodingService === undefined || geocodingService.status?.mode === 'disabled') return synced;
    if (synced.deliveryStop === null || synced.deliveryStop.geocodeStatus === 'RESOLVED') return synced;
    if (reason !== 'webhook' && reason !== 'raw_push') return synced;

    const address = toGeocodingAddress(synced.deliveryStop);
    if (!hasGeocodableAddress(address)) return synced;

    const geocode = await geocodingService.geocode({
      address,
      shopDomain: this.options.shopDomain
    });
    if (!geocode.ok) {
      return withUpdatedDeliveryFact({
        ...synced,
        order: {
          ...synced.order,
          rawPayload: mergeRawPayloadGeocodeDiagnostics(
            synced.order.rawPayload,
            geocode
          )
        }
      }, geocode.code === 'BLANK_ADDRESS' ? 'PENDING' : 'FAILED', geocode);
    }

    return withUpdatedDeliveryFact({
      ...synced,
      deliveryStop: {
        ...synced.deliveryStop,
        geocodeStatus: 'RESOLVED',
        latitude: geocode.result.latitude.toFixed(7),
        longitude: geocode.result.longitude.toFixed(7)
      },
      order: {
        ...synced.order,
        rawPayload: mergeRawPayloadGeocodeDiagnostics(
          synced.order.rawPayload,
          geocode
        )
      }
    }, 'RESOLVED', geocode);
  }
}

export function applyWooModifiedAfterOverlap(
  modifiedAfter: Date | null,
  overlapWindowMs: number
): Date | null {
  if (modifiedAfter === null) return null;
  if (!Number.isFinite(overlapWindowMs) || overlapWindowMs <= 0) {
    return modifiedAfter;
  }
  return new Date(modifiedAfter.getTime() - Math.floor(overlapWindowMs));
}

export function classifyWooCommerceSyncTier(input: {
  deliveryDate: string | null;
  today: string;
}): WooCommerceSyncTierClassification {
  if (input.deliveryDate === null) {
    return { reason: 'missing_delivery_date', review: true, tier: 'cold' };
  }
  if (input.deliveryDate >= input.today) {
    return { reason: 'today_or_future_delivery', review: false, tier: 'hot' };
  }
  return { reason: 'past_delivery', review: false, tier: 'cold' };
}

function withUpdatedDeliveryFact(
  synced: UpsertOrderWithDeliveryStopInput['synced'],
  geocodeStatus: NonNullable<UpsertOrderWithDeliveryStopInput['synced']['deliveryFact']>['geocodeStatus'],
  geocode: GeocodingResult
): UpsertOrderWithDeliveryStopInput['synced'] {
  if (synced.deliveryFact === undefined) return synced;
  if (synced.deliveryFact === null) return { ...synced, deliveryFact: null };
  return {
    ...synced,
    deliveryFact: {
      ...synced.deliveryFact,
      geocodeStatus,
      mappingDiagnostics: mergeIngestGeocodeDiagnostics(
        synced.deliveryFact.mappingDiagnostics,
        geocode
      )
    }
  };
}

function toGeocodingAddress(
  stop: NonNullable<UpsertOrderWithDeliveryStopInput['synced']['deliveryStop']>
): GeocodingAddress {
  return {
    address1: stop.address1,
    address2: stop.address2,
    city: stop.city,
    countryCode: stop.countryCode,
    postalCode: stop.postalCode,
    province: stop.province
  };
}

function hasGeocodableAddress(address: GeocodingAddress): boolean {
  return [
    address.address1,
    address.city,
    address.province,
    address.postalCode,
    address.countryCode
  ].some((value) => typeof value === 'string' && value.trim() !== '');
}

function mergeIngestGeocodeDiagnostics(
  value: Record<string, unknown> | null | undefined,
  geocode: GeocodingResult
): Record<string, unknown> {
  return {
    ...(value ?? {}),
    ingestGeocode: summarizeIngestGeocode(geocode)
  };
}

function mergeRawPayloadGeocodeDiagnostics(
  value: Record<string, unknown>,
  geocode: GeocodingResult
): Record<string, unknown> {
  return {
    ...value,
    ingestGeocode: summarizeIngestGeocode(geocode)
  };
}

function summarizeIngestGeocode(geocode: GeocodingResult): Record<string, unknown> {
  return summarizeGeocodeDiagnostic(geocode, 'server_pre_persist');
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
  const policies = readRecord(value.policies);
  const weekdayFallbackPolicy = readWeekdayFallbackPolicy(
    policies?.weekdayFallbackPolicy,
  );
  if (weekdayFallbackPolicy !== undefined) {
    config.policies = { weekdayFallbackPolicy };
  }
  if (typeof value.serviceMinutesDefault === 'number' && Number.isFinite(value.serviceMinutesDefault)) {
    config.serviceMinutesDefault = value.serviceMinutesDefault;
  }
  const paymentMethods = readPaymentMethodMappingConfig(value.paymentMethods);
  if (paymentMethods !== undefined) config.paymentMethods = paymentMethods;
  const timeWindowPaths = readStringArray(value.timeWindowPaths);
  if (timeWindowPaths !== undefined) config.timeWindowPaths = timeWindowPaths;
  if (typeof value.version === 'number' && Number.isFinite(value.version)) config.version = value.version;
  return config;
}

function readPaymentMethodMappingConfig(value: unknown): WooOrderMappingConfig['paymentMethods'] | undefined {
  const record = readRecord(value);
  if (record === undefined) return undefined;
  const paymentMethods: NonNullable<WooOrderMappingConfig['paymentMethods']> = {};
  const cashMethodIds = readStringArray(record.cashMethodIds);
  if (cashMethodIds !== undefined) paymentMethods.cashMethodIds = cashMethodIds;
  const onlineMethodIds = readStringArray(record.onlineMethodIds);
  if (onlineMethodIds !== undefined) paymentMethods.onlineMethodIds = onlineMethodIds;
  const transferMethodIds = readStringArray(record.transferMethodIds);
  if (transferMethodIds !== undefined) paymentMethods.transferMethodIds = transferMethodIds;
  return Object.keys(paymentMethods).length === 0 ? undefined : paymentMethods;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readWeekdayFallbackPolicy(value: unknown): WooWeekdayFallbackPolicy | undefined {
  return value === 'ORDER_WEEK' || value === 'DELIVERY_CYCLE' ? value : undefined;
}
