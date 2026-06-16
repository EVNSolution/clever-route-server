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

export function formatOrderItemOptions(item: Pick<OrderItemDto, 'options'>): string {
  return getOrderItemOptions(item).join(' · ');
}

export function formatOrderItemLine(item: OrderItemDto): string {
  const options = formatOrderItemOptions(item);
  return `${item.name}${options.length === 0 ? '' : ` (${options})`} × ${item.quantity}`;
}

export function getOrderItemOptions(item: Pick<OrderItemDto, 'options'>): string[] {
  return getOrderItemsOptions(item.options).map((option) => `${option.key}: ${option.value}`);
}

function getOrderItemsOptions(options: OrderItemDto['options'] | null | undefined): OrderItemDto['options'] {
  return Array.isArray(options) ? options : [];
}
