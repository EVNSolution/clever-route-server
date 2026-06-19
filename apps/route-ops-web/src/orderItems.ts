import type { OrderItemDto, RouteItemSummaryDto } from './types';

export function getOrderItems(items: OrderItemDto[] | null | undefined): OrderItemDto[] {
  return Array.isArray(items) ? items : [];
}

export function getRouteItemSummary(
  summary: RouteItemSummaryDto | null | undefined,
): RouteItemSummaryDto {
  return summary ?? {
    changedSincePublish: false,
    fingerprint: '',
    itemTypes: 0,
    items: [],
    totalQuantity: 0,
  };
}

export function formatOrderItemName(item: Pick<OrderItemDto, 'name'>): string {
  return sanitizeOrderItemText(item.name) || '—';
}

export function formatOrderItemOptions(item: Pick<OrderItemDto, 'options'>): string {
  return getOrderItemOptions(item).join(' · ');
}

export function formatOrderItemLine(item: OrderItemDto): string {
  const name = formatOrderItemName(item);
  const options = formatOrderItemOptions(item);
  return `${name}${options.length === 0 ? '' : ` (${options})`} × ${item.quantity}`;
}

export function getOrderItemOptions(item: Pick<OrderItemDto, 'options'>): string[] {
  return getOrderItemsOptions(item.options).flatMap((option) => {
    const key = sanitizeOrderItemText(option.key);
    const value = sanitizeOrderItemText(option.value);
    return key.length === 0 || value.length === 0 ? [] : [`${key}: ${value}`];
  });
}

export function getOrderItemSemanticDisplayKey(item: Pick<OrderItemDto, 'productId' | 'variationId' | 'options'>): string {
  return `${item.productId}:${item.variationId}:${getOrderItemOptionsIdentity(item)}`;
}

export function getOrderItemDisplayKey(item: OrderItemDto, index: number): string {
  return `${getOrderItemSemanticDisplayKey(item)}:${index}`;
}

function getOrderItemOptionsIdentity(item: Pick<OrderItemDto, 'options'>): string {
  return JSON.stringify(
    getOrderItemsOptions(item.options)
      .map((option) => ({
        key: sanitizeOrderItemText(option.key),
        value: sanitizeOrderItemText(option.value),
      }))
      .filter((option) => option.key.length > 0 && option.value.length > 0)
      .sort((left, right) => left.key.localeCompare(right.key) || left.value.localeCompare(right.value)),
  );
}

function getOrderItemsOptions(options: OrderItemDto['options'] | null | undefined): OrderItemDto['options'] {
  return Array.isArray(options) ? options : [];
}

function sanitizeOrderItemText(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const decoded = decodeCommonHtmlEntities(value);
  return decoded
    .replace(/<\s*br\s*\/?\s*>/giu, ' ')
    .replace(/<\s*\/\s*(p|div|li|tr|td|th)\s*>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
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
