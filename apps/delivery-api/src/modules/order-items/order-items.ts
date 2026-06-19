import { createHash } from 'node:crypto';

import type { WooCommerceLineItem, WooCommerceMetaData } from '../woocommerce/woocommerce-order.types.js';

export type OrderItemOptionDto = {
  key: string;
  value: string;
};

export type OrderItemDto = {
  productId: number;
  variationId: number;
  name: string;
  sku: string | null;
  options: OrderItemOptionDto[];
  quantity: number;
};

export type RouteItemSummary = {
  changedSincePublish: boolean;
  fingerprint: string;
  itemTypes: number;
  items: OrderItemDto[];
  totalQuantity: number;
};

export type OrderItemRecordLike = {
  productId: number;
  variationId: number;
  name: string;
  sku: string | null;
  options: unknown;
  quantity: number;
};

export const ITEM_REVIEW_REASONS = [
  'missing_order_items',
  'missing_item_product_id',
  'missing_item_name',
  'missing_item_quantity'
] as const;

const ITEM_REVIEW_REASON_SET = new Set<string>(ITEM_REVIEW_REASONS);

export function parseWooCommerceOrderItems(items: WooCommerceLineItem[] | null | undefined): {
  items: OrderItemDto[];
  reviewReasons: string[];
} {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: [], reviewReasons: ['missing_order_items'] };
  }

  const parsed: OrderItemDto[] = [];
  const reviewReasons: string[] = [];

  for (const item of items) {
    const productId = readPositiveInteger(item.product_id);
    const quantity = readPositiveInteger(item.quantity);
    const name = normalizeItemText(item.name);
    if (productId === null) reviewReasons.push('missing_item_product_id');
    if (quantity === null) reviewReasons.push('missing_item_quantity');
    if (name === null) reviewReasons.push('missing_item_name');
    if (productId === null || quantity === null || name === null) continue;

    parsed.push({
      productId,
      variationId: readNonNegativeInteger(item.variation_id) ?? 0,
      name,
      sku: normalizeString(item.sku),
      options: normalizeWooItemOptions(item.meta_data ?? []),
      quantity
    });
  }

  if (parsed.length === 0 && reviewReasons.length === 0) {
    reviewReasons.push('missing_order_items');
  }

  return { items: parsed, reviewReasons: uniqueStrings(reviewReasons) };
}

export function toOrderItemDto(item: OrderItemRecordLike): OrderItemDto {
  return {
    productId: item.productId,
    variationId: item.variationId,
    name: normalizeItemText(item.name) ?? item.name,
    sku: normalizeString(item.sku),
    options: readOrderItemOptions(item.options),
    quantity: item.quantity
  };
}

export function aggregateOrderItems(
  items: OrderItemDto[],
  storedFingerprint: string | null = null
): RouteItemSummary {
  const groups = new Map<string, OrderItemDto>();
  for (const item of items) {
    const normalized = normalizeOrderItemDto(item);
    const key = getOrderItemSemanticKey(normalized);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, normalized);
      continue;
    }
    existing.quantity += normalized.quantity;
  }

  const summaryItems = [...groups.values()].sort(compareOrderItems);
  const fingerprint = fingerprintOrderItems(summaryItems);
  return {
    changedSincePublish: storedFingerprint !== null && storedFingerprint !== fingerprint,
    fingerprint,
    itemTypes: summaryItems.length,
    items: summaryItems,
    totalQuantity: summaryItems.reduce((sum, item) => sum + item.quantity, 0)
  };
}

export function fingerprintOrderItems(items: OrderItemDto[]): string {
  const stable = [...items]
    .map(normalizeOrderItemDto)
    .sort(compareOrderItems)
    .map((item) => ({
      options: getCanonicalOptions(item.options),
      productId: item.productId,
      quantity: item.quantity,
      variationId: item.variationId
    }));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function mergeItemReviewReasons(existing: string[], itemReasons: string[]): string[] {
  const withoutItems = existing.filter((reason) => !ITEM_REVIEW_REASON_SET.has(reason));
  return uniqueStrings([...withoutItems, ...itemReasons]);
}

export function hasItemReviewReason(reasons: string[]): boolean {
  return reasons.some((reason) => ITEM_REVIEW_REASON_SET.has(reason));
}

function normalizeWooItemOptions(metaData: WooCommerceMetaData[]): OrderItemOptionDto[] {
  const options: OrderItemOptionDto[] = [];
  for (const item of metaData) {
    const key = normalizeItemText(item.key);
    if (key === null || key.startsWith('_')) continue;
    const value = normalizeMetaValue(item.value);
    if (value === null) continue;
    options.push({ key, value });
  }
  return options;
}

function readOrderItemOptions(value: unknown): OrderItemOptionDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const key = normalizeItemText(record.key);
    const optionValue = normalizeItemText(record.value);
    return key === null || optionValue === null ? [] : [{ key, value: optionValue }];
  });
}

function normalizeMetaValue(value: unknown): string | null {
  if (typeof value === 'string') return normalizeItemText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return normalizeItemText(record.display_value) ?? normalizeItemText(record.value) ?? null;
  }
  return null;
}

function readPositiveInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : null;
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : null;
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeItemText(value: unknown): string | null {
  const raw = normalizeString(value);
  if (raw === null) return null;
  const decoded = decodeCommonHtmlEntities(raw);
  const cleaned = decoded
    .replace(/<\s*br\s*\/?\s*>/giu, ' ')
    .replace(/<\s*\/\s*(p|div|li|tr|td|th)\s*>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned === '' ? null : cleaned;
}

function decodeCommonHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'");
}

function normalizeOrderItemDto(item: OrderItemDto): OrderItemDto {
  return {
    productId: item.productId,
    variationId: item.variationId,
    name: normalizeItemText(item.name) ?? item.name,
    sku: normalizeString(item.sku),
    options: getCanonicalOptions(item.options),
    quantity: item.quantity
  };
}

function getOrderItemSemanticKey(item: OrderItemDto): string {
  return JSON.stringify({
    options: getCanonicalOptions(item.options),
    productId: item.productId,
    variationId: item.variationId
  });
}

function getCanonicalOptions(options: OrderItemOptionDto[]): OrderItemOptionDto[] {
  return options
    .flatMap((option) => {
      const key = normalizeItemText(option.key);
      const value = normalizeItemText(option.value);
      return key === null || value === null ? [] : [{ key, value }];
    })
    .sort((left, right) => left.key.localeCompare(right.key) || left.value.localeCompare(right.value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function compareOrderItems(left: OrderItemDto, right: OrderItemDto): number {
  return (
    left.productId - right.productId ||
    left.variationId - right.variationId ||
    JSON.stringify(getCanonicalOptions(left.options)).localeCompare(JSON.stringify(getCanonicalOptions(right.options))) ||
    left.name.localeCompare(right.name)
  );
}
