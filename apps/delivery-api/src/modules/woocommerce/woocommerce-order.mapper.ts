import type { SyncedDeliveryStopInput, SyncedOrderWithDeliveryStopInput, ShopifyOrderLineItem } from '../shopify/order-sync.mapper.js';
import { calculateDeliveryScope } from '../shopify/order-delivery-scope.js';
import type { WooCommerceAddress, WooCommerceLineItem, WooCommerceMetaData, WooCommerceOrder } from './woocommerce-order.types.js';

const DELIVERY_DATE_KEYS = [
  'delivery date',
  'delivery_date',
  'deliverydate',
  'tomatono_delivery_date',
  '_delivery_date',
  'order_delivery_date',
  'jckwds_date'
];
const DELIVERY_DAY_KEYS = [
  'delivery day',
  'delivery_day',
  'deliveryday',
  'tomatono_delivery_day',
  '_delivery_day',
  'order_delivery_day',
  'jckwds_timeslot'
];
const DELIVERY_AREA_KEYS = [
  'delivery area',
  'delivery_area',
  'deliveryarea',
  'tomatono_delivery_area',
  '_delivery_area'
];

export type MapWooCommerceOrderOptions = {
  siteUrl: string;
  shopTimezone?: string;
};

export function mapWooCommerceOrderToDeliveryInputs(
  order: WooCommerceOrder,
  options: MapWooCommerceOrderOptions
): SyncedOrderWithDeliveryStopInput {
  const siteUrl = normalizeSiteUrl(options.siteUrl);
  const host = new URL(siteUrl).host;
  const metadata = flattenMetaData([...(order.meta_data ?? []), ...lineItemMeta(order.line_items ?? [])]);
  const deliveryDateRaw = readMeta(metadata, DELIVERY_DATE_KEYS);
  const deliveryDayRaw = readMeta(metadata, DELIVERY_DAY_KEYS);
  const deliveryArea = readMeta(metadata, DELIVERY_AREA_KEYS) ?? normalizeString(order.shipping?.city) ?? normalizeString(order.billing?.city);
  const lineItems = normalizeLineItems(order.line_items ?? []);
  const createdAt = readWooDate(order.date_created_gmt, order.date_created);
  const modifiedAt = readWooDate(order.date_modified_gmt, order.date_modified) ?? createdAt ?? new Date(0);
  const scope = calculateDeliveryScope({
    createdAt: createdAt?.toISOString() ?? null,
    deliveryArea,
    deliveryDateRaw,
    deliveryDayRaw,
    lineItems,
    pickupDayRaw: null,
    processedAt: createdAt?.toISOString() ?? null,
    ...(options.shopTimezone === undefined ? {} : { shopTimezone: options.shopTimezone })
  });
  const shippingAddress = selectAddress(order.shipping ?? null, order.billing ?? null);
  const hasAddressValue = shippingAddress !== null && hasAddress(shippingAddress);
  const reviewReasons = buildReviewReasons({
    deliveryArea,
    deliveryDate: scope.deliveryDate,
    deliveryDateSource: scope.deliveryDateSource,
    hasAddress: hasAddressValue,
    hasCoordinates: false,
    orderCreatedAt: scope.orderCreatedAt,
    routeScopeKey: scope.routeScopeKey,
    status: normalizeString(order.status),
    serviceType: scope.serviceType
  });
  const readiness = scope.deliveryDate === null || scope.routeScopeKey === null || reviewReasons.length > 0 ? 'NEEDS_REVIEW' : 'READY_TO_PLAN';
  const phone = normalizeString(order.billing?.phone) ?? normalizeString(order.shipping?.phone) ?? null;
  const recipientName = shippingAddress === null ? null : formatAddressName(shippingAddress);
  const orderNumber = normalizeString(order.number) ?? String(order.id);
  const syntheticGid = `woocommerce://${host}/orders/${order.id}`;
  const rawPayload = buildRawPayload({
    deliveryArea,
    deliveryDateRaw,
    deliveryDayRaw,
    lineItems,
    metadataKeys: metadata.map((item) => item.key),
    order,
    readiness,
    reviewReasons,
    scope,
    shippingAddress
  });

  return {
    deliveryStop:
      shippingAddress === null
        ? null
        : mapAddressToDeliveryStop({
            address: shippingAddress,
            deliveryDate: scope.deliveryDate,
            instructions: normalizeString(order.customer_note),
            phone,
            recipientName,
            timeWindowEnd: scope.timeWindowEnd,
            timeWindowStart: scope.timeWindowStart
          }),
    order: {
      cancelledAt: isCancelledLike(order.status) ? modifiedAt : null,
      currencyCode: normalizeString(order.currency),
      deliveryArea,
      deliveryBatchEndDate: scope.deliveryBatchEndDate,
      deliveryBatchStartDate: scope.deliveryBatchStartDate,
      deliveryDate: scope.deliveryDate,
      deliveryDateSource: scope.deliveryDateSource,
      deliveryDayRaw,
      deliverySession: scope.deliverySession,
      deliveryWeekday: scope.deliveryWeekday,
      email: normalizeString(order.billing?.email),
      financialStatus: normalizeString(order.payment_method_title) ?? normalizeString(order.payment_method),
      fulfillmentStatus: normalizeString(order.status)?.toUpperCase() ?? null,
      name: `#${orderNumber.replace(/^#/u, '')}`,
      orderCreatedAt: scope.orderCreatedAt,
      orderDateLocal: scope.orderDateLocal,
      phone,
      pickup: false,
      planningGroupKey: scope.planningGroupKey,
      processedAt: createdAt,
      rawPayload,
      readiness,
      reviewReasons,
      routeScopeKey: scope.routeScopeKey,
      serviceType: scope.serviceType,
      shopifyOrderGid: syntheticGid,
      shopifyOrderLegacyId: null,
      sourceOrderId: String(order.id),
      sourceOrderNumber: orderNumber,
      sourcePlatform: 'WOOCOMMERCE',
      sourceSiteUrl: siteUrl,
      sourceUpdatedAt: modifiedAt,
      timeWindowEnd: scope.timeWindowEnd,
      timeWindowStart: scope.timeWindowStart,
      totalPriceAmount: normalizeString(order.total),
      updatedAtShopify: modifiedAt
    }
  } satisfies SyncedOrderWithDeliveryStopInput;
}

function buildRawPayload(input: {
  deliveryArea: string | null;
  deliveryDateRaw: string | null;
  deliveryDayRaw: string | null;
  lineItems: ShopifyOrderLineItem[];
  metadataKeys: string[];
  order: WooCommerceOrder;
  readiness: 'READY_TO_PLAN' | 'NEEDS_REVIEW' | 'SKIPPED';
  reviewReasons: string[];
  scope: ReturnType<typeof calculateDeliveryScope>;
  shippingAddress: WooCommerceAddress | null;
}): Record<string, unknown> {
  return {
    ...input.order,
    deliveryArea: input.deliveryArea,
    deliveryBatchEndDate: input.scope.deliveryBatchEndDate,
    deliveryBatchStartDate: input.scope.deliveryBatchStartDate,
    deliveryDate: input.scope.deliveryDate,
    deliveryDateRaw: input.deliveryDateRaw,
    deliveryDateSource: input.scope.deliveryDateSource,
    deliveryDayRaw: input.deliveryDayRaw,
    deliverySession: input.scope.deliverySession,
    deliveryWeekday: input.scope.deliveryWeekday,
    lineItems: input.lineItems,
    metadataKeys: input.metadataKeys,
    orderCreatedAt: input.scope.orderCreatedAt,
    orderDateLocal: input.scope.orderDateLocal,
    pickup: false,
    planningGroupKey: input.scope.planningGroupKey,
    readiness: input.readiness,
    reviewReasons: input.reviewReasons,
    routeScopeKey: input.scope.routeScopeKey,
    serviceType: input.scope.serviceType,
    shippingAddress: input.shippingAddress === null ? null : toCanonicalShippingAddress(input.shippingAddress),
    sourcePlatform: 'WOOCOMMERCE',
    timeWindowEnd: input.scope.timeWindowEnd,
    timeWindowStart: input.scope.timeWindowStart
  };
}

function mapAddressToDeliveryStop(input: {
  address: WooCommerceAddress;
  deliveryDate: string | null;
  instructions: string | null;
  phone: string | null;
  recipientName: string | null;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
}): SyncedDeliveryStopInput {
  return {
    address1: normalizeString(input.address.address_1),
    address2: normalizeString(input.address.address_2),
    city: normalizeString(input.address.city),
    countryCode: normalizeString(input.address.country),
    deliveryDate: input.deliveryDate,
    geocodeStatus: 'PENDING',
    instructions: input.instructions,
    latitude: null,
    longitude: null,
    phone: input.phone,
    postalCode: normalizeString(input.address.postcode),
    province: normalizeString(input.address.state),
    recipientName: input.recipientName,
    timeWindowEnd: input.timeWindowEnd,
    timeWindowStart: input.timeWindowStart
  };
}

function selectAddress(shipping: WooCommerceAddress | null, billing: WooCommerceAddress | null): WooCommerceAddress | null {
  if (shipping !== null && hasAddress(shipping)) return shipping;
  if (billing !== null && hasAddress(billing)) return billing;
  return shipping ?? billing;
}

function hasAddress(address: WooCommerceAddress): boolean {
  return [address.address_1, address.city, address.postcode, address.country].some((value) => normalizeString(value) !== null);
}

function toCanonicalShippingAddress(address: WooCommerceAddress): Record<string, string | null> {
  return {
    address1: normalizeString(address.address_1),
    address2: normalizeString(address.address_2),
    city: normalizeString(address.city),
    countryCode: normalizeString(address.country),
    postalCode: normalizeString(address.postcode),
    province: normalizeString(address.state)
  };
}

function formatAddressName(address: WooCommerceAddress): string | null {
  const firstName = normalizeString(address.first_name);
  const lastName = normalizeString(address.last_name);
  const joined = [firstName, lastName].flatMap((value) => (value === null ? [] : [value])).join(' ').trim();
  return joined === '' ? normalizeString(address.company) : joined;
}

function buildReviewReasons(input: {
  deliveryArea: string | null;
  deliveryDate: string | null;
  deliveryDateSource: string;
  hasAddress: boolean;
  hasCoordinates: boolean;
  orderCreatedAt: string | null;
  routeScopeKey: string | null;
  serviceType: string | null;
  status: string | null;
}): string[] {
  const reasons: string[] = [];
  if (!input.hasAddress) reasons.push('missing_address');
  if (input.deliveryArea === null) reasons.push('missing_delivery_area');
  if (input.orderCreatedAt === null && input.deliveryDateSource !== 'EXPLICIT_ATTRIBUTE') reasons.push('missing_order_date');
  if (input.deliveryDate === null) reasons.push('missing_delivery_date');
  if (input.routeScopeKey === null || input.serviceType === null) reasons.push('missing_route_scope');
  if (!input.hasCoordinates) reasons.push('missing_coordinates');
  if (isNonDeliverableStatus(input.status)) reasons.push(`non_deliverable_status:${input.status}`);
  return reasons;
}

function isCancelledLike(status: string | null | undefined): boolean {
  const normalized = normalizeString(status)?.toLowerCase() ?? null;
  return normalized === 'cancelled' || normalized === 'refunded' || normalized === 'failed' || normalized === 'trash';
}

function isNonDeliverableStatus(status: string | null): boolean {
  return status === 'cancelled' || status === 'refunded' || status === 'failed' || status === 'trash';
}

function lineItemMeta(items: WooCommerceLineItem[]): WooCommerceMetaData[] {
  return items.flatMap((item) => item.meta_data ?? []);
}

function normalizeLineItems(items: WooCommerceLineItem[]): ShopifyOrderLineItem[] {
  return items.map((item) => ({
    name: normalizeString(item.name),
    quantity: typeof item.quantity === 'number' && Number.isFinite(item.quantity) ? item.quantity : null,
    sku: normalizeString(item.sku),
    title: normalizeString(item.name),
    variantTitle: null
  }));
}

function flattenMetaData(items: WooCommerceMetaData[]): Array<{ key: string; value: string }> {
  return items.flatMap((item) => {
    const key = normalizeMetaKey(item.key);
    const value = normalizeMetaValue(item.value);
    if (key === null || value === null) return [];
    return [{ key, value }];
  });
}

function readMeta(items: Array<{ key: string; value: string }>, keys: string[]): string | null {
  const wanted = new Set(keys.map(normalizeMetaKey).filter((key): key is string => key !== null));
  return items.find((item) => wanted.has(normalizeMetaKey(item.key) ?? ''))?.value ?? null;
}

function normalizeMetaKey(value: string | null | undefined): string | null {
  return normalizeString(value)?.toLowerCase().replace(/[\s-]+/gu, '_') ?? null;
}

function normalizeMetaValue(value: unknown): string | null {
  if (typeof value === 'string') return normalizeString(value);
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return null;
}

function readWooDate(gmt: string | null | undefined, local: string | null | undefined): Date | null {
  const preferred = normalizeString(gmt) ?? normalizeString(local);
  if (preferred === null) return null;
  const withZone = preferred.includes('T') ? preferred : preferred.replace(' ', 'T');
  const normalized = /(?:z|[+-]\d{2}:?\d{2})$/iu.test(withZone) ? withZone : `${withZone}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeSiteUrl(value: string): string {
  const trimmed = value.trim();
  const withProtocol = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  url.pathname = url.pathname.replace(/\/+$/u, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

function normalizeString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
